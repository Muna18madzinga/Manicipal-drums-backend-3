-- 146_permit_parcel_and_rule_snapshots.sql
-- ─────────────────────────────────────────────────────────────────────────
-- The real intake is POST /permit-applications into spatial_planning.permit_application.
-- (public.development_applications is a retired duplicate with no rows and no caller;
-- the snapshot columns migration 145 put there are removed below.)
--
-- 1. The permit gets an authority and a link to the parcel it concerns, with how that link
--    was made, and the plan found to govern it.
-- 2. permit_rule_snapshot: an append-only history of the rules the permit was judged under.
--      lodgement         taken by the server when the permit is registered: parcel, zone(s)
--                        and plan(s), with NO land use (the citizen form does not name one)
--      parcel_corrected  taken when staff correct or set the parcel
--      assessment        taken when the planner picks the specific land use: the decision,
--                        pathway and standards from the plan recorded at lodgement
--    Nothing is overwritten: a corrected assessment is a new row. The latest of each kind
--    is the current one.
-- 3. Lodgement never fails because of the land: a stand number that matches nothing (or
--    several things) is recorded as 'unmatched' / 'ambiguous', not rejected and not guessed.
--
-- TRANSITIONAL: authority_id defaults to Vungu (as development_applications does) until the
-- request carries an authority. Plan effective dates are not yet applied, so "the plan in
-- force at lodgement" is the plan(s) whose zones cover the parcel at that moment.

BEGIN;

-- 0. Retire the duplicate application table's snapshot columns ------------------------------
DROP TRIGGER IF EXISTS trg_development_applications_keep_snapshot ON development_applications;
DROP FUNCTION IF EXISTS development_applications_keep_snapshot();
ALTER TABLE development_applications
  DROP COLUMN IF EXISTS plan_instrument_id,
  DROP COLUMN IF EXISTS rules_snapshot,
  DROP COLUMN IF EXISTS snapshot_at;
COMMENT ON TABLE development_applications IS
  'RETIRED: no caller. The canonical intake is spatial_planning.permit_application (POST /permit-applications).';

-- 1. Authority, parcel link and governing plan on the permit ---------------------------------
ALTER TABLE spatial_planning.permit_application
  ADD COLUMN IF NOT EXISTS authority_id       integer REFERENCES public.local_authorities (id),
  ADD COLUMN IF NOT EXISTS parcel_layer       text,
  ADD COLUMN IF NOT EXISTS parcel_id          text,
  ADD COLUMN IF NOT EXISTS parcel_match       text,
  ADD COLUMN IF NOT EXISTS plan_instrument_id uuid REFERENCES public.plan_instrument (id);

UPDATE spatial_planning.permit_application
   SET authority_id = (SELECT id FROM public.local_authorities WHERE code = 'VUNGU')
 WHERE authority_id IS NULL;
ALTER TABLE spatial_planning.permit_application ALTER COLUMN authority_id SET DEFAULT 1;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'permit_application_parcel_chk') THEN
    ALTER TABLE spatial_planning.permit_application ADD CONSTRAINT permit_application_parcel_chk CHECK (
      (parcel_layer IS NULL) = (parcel_id IS NULL)
      AND (parcel_layer IS NULL OR parcel_layer IN ('stands', 'vungu_parcels', 'land.parcel'))
      AND (parcel_match IS NULL OR parcel_match IN ('matched', 'by_location', 'ambiguous', 'unmatched', 'manual')));
  END IF;
END $$;

-- 2. The append-only snapshot history -------------------------------------------------------
CREATE TABLE IF NOT EXISTS spatial_planning.permit_rule_snapshot (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id          uuid NOT NULL REFERENCES spatial_planning.permit_application (id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('lodgement', 'parcel_corrected', 'assessment')),
  land_use_code      text,
  plan_instrument_id uuid REFERENCES public.plan_instrument (id),
  snapshot           jsonb NOT NULL,
  taken_by           uuid,
  taken_at           timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_permit_rule_snapshot_permit ON spatial_planning.permit_rule_snapshot (permit_id, taken_at);

CREATE OR REPLACE FUNCTION spatial_planning.permit_rule_snapshot_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'permit rule snapshots are append-only: record a new snapshot instead of changing one'
    USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_permit_rule_snapshot_append_only ON spatial_planning.permit_rule_snapshot;
CREATE TRIGGER trg_permit_rule_snapshot_append_only
  BEFORE UPDATE ON spatial_planning.permit_rule_snapshot
  FOR EACH ROW EXECUTE FUNCTION spatial_planning.permit_rule_snapshot_append_only();

-- 3. Finding the parcel for a stand number ------------------------------------------------------
-- (layer, id, match). Exactly one candidate by number is 'matched'; several is 'ambiguous'
-- (nothing chosen) unless the ward leaves exactly one; none falls back to a location, where
-- exactly one stand containing the point is 'by_location'; otherwise 'unmatched'.
CREATE OR REPLACE FUNCTION public.resolve_stand_parcel(p_stand text, p_ward text, p_lng double precision, p_lat double precision)
RETURNS TABLE (layer text, id text, match text) AS $$
DECLARE
  cands jsonb := '[]'::jsonb;
  narrowed jsonb;
  n integer;
  r record;
  pt geometry;
BEGIN
  IF p_stand IS NOT NULL AND btrim(p_stand) <> '' THEN
    IF to_regclass('public.stands') IS NOT NULL THEN
      FOR r IN EXECUTE 'SELECT id::text AS pid, ward FROM public.stands WHERE upper(btrim(stand_number)) = upper(btrim($1))' USING p_stand LOOP
        cands := cands || jsonb_build_array(jsonb_build_object('layer', 'stands', 'id', r.pid, 'ward', coalesce(r.ward, '')));
      END LOOP;
    END IF;
    IF to_regclass('land.parcel') IS NOT NULL THEN
      FOR r IN EXECUTE 'SELECT parcel_id AS pid, ward_code AS ward FROM land.parcel WHERE upper(btrim(stand_no)) = upper(btrim($1)) AND valid_to IS NULL' USING p_stand LOOP
        cands := cands || jsonb_build_array(jsonb_build_object('layer', 'land.parcel', 'id', r.pid, 'ward', coalesce(r.ward, '')));
      END LOOP;
    END IF;

    n := jsonb_array_length(cands);
    IF n > 1 AND p_ward IS NOT NULL AND btrim(p_ward) <> '' THEN
      SELECT coalesce(jsonb_agg(c), '[]'::jsonb) INTO narrowed
        FROM jsonb_array_elements(cands) c WHERE upper(btrim(c->>'ward')) = upper(btrim(p_ward));
      IF jsonb_array_length(narrowed) = 1 THEN cands := narrowed; n := 1; END IF;
    END IF;
    IF n = 1 THEN
      RETURN QUERY SELECT cands->0->>'layer', cands->0->>'id', 'matched'::text; RETURN;
    END IF;
    IF n > 1 THEN
      RETURN QUERY SELECT NULL::text, NULL::text, 'ambiguous'::text; RETURN;
    END IF;
  END IF;

  IF p_lng IS NOT NULL AND p_lat IS NOT NULL AND to_regclass('public.stands') IS NOT NULL THEN
    pt := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
    SELECT count(*) INTO n FROM public.stands s WHERE ST_Intersects(s.geom, pt);
    IF n = 1 THEN
      RETURN QUERY SELECT 'stands'::text, (SELECT s.id::text FROM public.stands s WHERE ST_Intersects(s.geom, pt)), 'by_location'::text;
      RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT NULL::text, NULL::text, 'unmatched'::text;
END $$ LANGUAGE plpgsql STABLE;

-- 4. Lodgement: link the parcel and record the zoning at that moment ---------------------------
-- Idempotent: a permit that already has a lodgement snapshot is left alone. Returns the match.
CREATE OR REPLACE FUNCTION spatial_planning.lodge_permit_zoning(p_permit uuid) RETURNS text AS $$
DECLARE
  p spatial_planning.permit_application%ROWTYPE;
  m record;
  snap jsonb;
  one_plan uuid;
BEGIN
  SELECT * INTO p FROM spatial_planning.permit_application WHERE id = p_permit;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown permit %', p_permit; END IF;
  IF EXISTS (SELECT 1 FROM spatial_planning.permit_rule_snapshot WHERE permit_id = p_permit AND kind = 'lodgement') THEN
    RETURN p.parcel_match;
  END IF;

  SELECT * INTO m FROM public.resolve_stand_parcel(
    p.stand_number, p.suburb_ward,
    CASE WHEN p.location IS NULL THEN NULL ELSE ST_X(p.location) END,
    CASE WHEN p.location IS NULL THEN NULL ELSE ST_Y(p.location) END);

  IF m.layer IS NULL THEN
    UPDATE spatial_planning.permit_application SET parcel_match = m.match WHERE id = p_permit;
    RETURN m.match;
  END IF;

  snap := public.rule_snapshot(m.layer, m.id, NULL);
  SELECT CASE WHEN count(DISTINCT r->'plan'->>'id') = 1 THEN min(r->'plan'->>'id')::uuid END INTO one_plan
    FROM jsonb_array_elements(snap->'results') r WHERE (r->>'governing')::boolean;

  UPDATE spatial_planning.permit_application
     SET parcel_layer = m.layer, parcel_id = m.id, parcel_match = m.match, plan_instrument_id = one_plan
   WHERE id = p_permit;
  INSERT INTO spatial_planning.permit_rule_snapshot (permit_id, kind, plan_instrument_id, snapshot)
  VALUES (p_permit, 'lodgement', one_plan, snap);
  RETURN m.match;
END $$ LANGUAGE plpgsql;

-- 5. Staff set or correct the parcel ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION spatial_planning.set_permit_parcel(p_permit uuid, p_layer text, p_id text, p_by uuid DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE snap jsonb; one_plan uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM spatial_planning.permit_application WHERE id = p_permit) THEN
    RAISE EXCEPTION 'unknown permit %', p_permit;
  END IF;
  IF public.parcel_geometry(p_layer, p_id) IS NULL THEN
    RAISE EXCEPTION 'no parcel % in layer %', p_id, p_layer USING ERRCODE = 'invalid_parameter_value';
  END IF;
  snap := public.rule_snapshot(p_layer, p_id, NULL);
  SELECT CASE WHEN count(DISTINCT r->'plan'->>'id') = 1 THEN min(r->'plan'->>'id')::uuid END INTO one_plan
    FROM jsonb_array_elements(snap->'results') r WHERE (r->>'governing')::boolean;
  UPDATE spatial_planning.permit_application
     SET parcel_layer = p_layer, parcel_id = p_id, parcel_match = 'manual', plan_instrument_id = one_plan
   WHERE id = p_permit;
  INSERT INTO spatial_planning.permit_rule_snapshot (permit_id, kind, plan_instrument_id, snapshot, taken_by)
  VALUES (p_permit, 'parcel_corrected', one_plan, snap, p_by);
  RETURN snap;
END $$ LANGUAGE plpgsql;

-- 6. The planner picks the land use: record the decision under the plan recorded at lodgement --
CREATE OR REPLACE FUNCTION spatial_planning.take_permit_assessment_snapshot(p_permit uuid, p_use text, p_by uuid DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE p spatial_planning.permit_application%ROWTYPE; snap jsonb;
BEGIN
  SELECT * INTO p FROM spatial_planning.permit_application WHERE id = p_permit;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown permit %', p_permit; END IF;
  IF p.parcel_layer IS NULL THEN
    RAISE EXCEPTION 'permit % has no parcel: set the parcel first', p_permit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  snap := public.rule_snapshot(p.parcel_layer, p.parcel_id, p_use);
  IF p.plan_instrument_id IS NOT NULL THEN
    -- judge under the plan recorded for this permit, not whichever plan also covers the parcel
    snap := jsonb_set(snap, '{results}', COALESCE((
      SELECT jsonb_agg(r) FROM jsonb_array_elements(snap->'results') r
       WHERE (r->'plan'->>'id')::uuid = p.plan_instrument_id), '[]'::jsonb));
  END IF;
  INSERT INTO spatial_planning.permit_rule_snapshot (permit_id, kind, land_use_code, plan_instrument_id, snapshot, taken_by)
  VALUES (p_permit, 'assessment', p_use, p.plan_instrument_id, snap, p_by);
  RETURN snap;
END $$ LANGUAGE plpgsql;

COMMIT;
