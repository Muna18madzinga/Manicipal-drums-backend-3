-- 150_plan_workbench.sql
-- ─────────────────────────────────────────────────────────────────────────
-- What an onboarding workbench needs underneath it (proposal §7, steps 6 and 7):
--
--   plan_event            append-only history of what was done to a plan, by whom
--   plan_signoff          the authority's planner signs off a plan; the sign-off records a
--                         hash of the plan's content, so ANY later edit makes it stale
--   set_plan_status()     draft -> public notice -> approved -> gazetted, one step at a time
--                         (the allowed steps are data: plan_status_transition). Approval needs
--                         a CURRENT sign-off; gazetting needs a gazette reference and an
--                         effective date
--   plan freeze           an approved, gazetted or superseded plan's land uses, decisions and
--                         standards cannot be edited; a change is a new version
--   new_plan_version()    copy a frozen plan as the next draft version (supersedes the old)
--   plan_decision_diff()  how the decisions of any two plans differ (previous version, template)
--
-- ASSUMPTION TO CONFIRM: the status chain, in particular that public notice precedes approval.
-- The allowed steps are rows in plan_status_transition, so the project lead can change them
-- without code.
--
-- When a new version is gazetted the superseded version's zone POLYGONS move to the new
-- version's zone types of the same name, so parcels are judged under the plan in force.
-- Polygons whose zone has no counterpart stay where they were and the event says so.
-- Earlier applications keep the plan recorded at their lodgement.

BEGIN;

-- 1. Events --------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_instrument_id uuid NOT NULL REFERENCES plan_instrument (id) ON DELETE CASCADE,
  event_type         text NOT NULL,
  actor_id           uuid,
  actor_role         text,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  at                 timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_plan_event_plan ON plan_event (plan_instrument_id, at);

CREATE OR REPLACE FUNCTION plan_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'plan events are append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_event_append_only ON plan_event;
CREATE TRIGGER trg_plan_event_append_only BEFORE UPDATE ON plan_event
  FOR EACH ROW EXECUTE FUNCTION plan_event_append_only();

CREATE OR REPLACE FUNCTION log_plan_event(p_plan uuid, p_type text, p_actor uuid, p_role text, p_detail jsonb DEFAULT '{}')
RETURNS void AS $$
  INSERT INTO plan_event (plan_instrument_id, event_type, actor_id, actor_role, detail)
  VALUES (p_plan, p_type, p_actor, p_role, COALESCE(p_detail, '{}'::jsonb))
$$ LANGUAGE sql;

-- 2. Content hash and sign-off ----------------------------------------------------------------
-- A fingerprint of everything a sign-off vouches for: the decisions (with conditions and
-- pathways) and the standards. Order-independent.
CREATE OR REPLACE FUNCTION plan_content_hash(p_plan uuid) RETURNS text AS $$
  SELECT md5(COALESCE(string_agg(line, E'\n' ORDER BY line), ''))
    FROM (
      SELECT format('D|%s|%s|%s|%s|%s', zt.code, g.group_code, c.control_type,
                    COALESCE(c.conditions, ''), COALESCE(c.pathway_code, '')) AS line
        FROM zone_land_use_controls c
        JOIN plan_zone_type zt ON zt.id = c.plan_zone_type_id
        JOIN land_use_groups g ON g.id = c.land_use_group_id
       WHERE c.plan_instrument_id = p_plan AND c.deleted_at IS NULL
      UNION ALL
      SELECT format('S|%s|%s|%s|%s|%s', zt.code, s.kind_code, COALESCE(g.group_code, ''),
                    COALESCE(s.min_value::text, ''), COALESCE(s.max_value::text, ''))
        FROM plan_zone_standard s
        JOIN plan_zone_type zt ON zt.id = s.plan_zone_type_id
        LEFT JOIN land_use_groups g ON g.id = s.land_use_group_id
       WHERE zt.plan_instrument_id = p_plan
    ) x
$$ LANGUAGE sql STABLE;

CREATE TABLE IF NOT EXISTS plan_signoff (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_instrument_id uuid NOT NULL REFERENCES plan_instrument (id) ON DELETE CASCADE,
  signed_by          uuid,
  signer_name        text NOT NULL,
  signer_role        text,
  comment            text,
  content_hash       text NOT NULL,
  signed_at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_plan_signoff_plan ON plan_signoff (plan_instrument_id, signed_at);

CREATE OR REPLACE FUNCTION plan_signoff_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'plan sign-offs are append-only' USING ERRCODE = 'check_violation';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_signoff_append_only ON plan_signoff;
CREATE TRIGGER trg_plan_signoff_append_only BEFORE UPDATE ON plan_signoff
  FOR EACH ROW EXECUTE FUNCTION plan_signoff_append_only();

-- Is the latest sign-off still describing the plan as it is now?
CREATE OR REPLACE FUNCTION plan_signoff_is_current(p_plan uuid) RETURNS boolean AS $$
  SELECT COALESCE((SELECT content_hash = plan_content_hash(p_plan)
                     FROM plan_signoff WHERE plan_instrument_id = p_plan
                    ORDER BY signed_at DESC, id LIMIT 1), FALSE)
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION sign_off_plan(p_plan uuid, p_actor uuid, p_name text, p_role text, p_comment text DEFAULT NULL)
RETURNS uuid AS $$
DECLARE pl plan_instrument%ROWTYPE; sid uuid;
BEGIN
  SELECT * INTO pl FROM plan_instrument WHERE id = p_plan;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown plan %', p_plan; END IF;
  IF pl.is_template THEN RAISE EXCEPTION 'a template is not signed off'; END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'a sign-off needs the signer''s name'; END IF;
  INSERT INTO plan_signoff (plan_instrument_id, signed_by, signer_name, signer_role, comment, content_hash)
  VALUES (p_plan, p_actor, btrim(p_name), p_role, p_comment, plan_content_hash(p_plan))
  RETURNING id INTO sid;
  PERFORM log_plan_event(p_plan, 'signed_off', p_actor, p_role, jsonb_build_object('signer', btrim(p_name), 'comment', p_comment));
  RETURN sid;
END $$ LANGUAGE plpgsql;

-- 3. Status transitions ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_status_transition (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO plan_status_transition (from_status, to_status) VALUES
  ('unknown', 'draft'),
  ('draft', 'public_notice'),
  ('public_notice', 'draft'),
  ('public_notice', 'approved'),
  ('approved', 'gazetted')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION plan_is_frozen(p_plan uuid) RETURNS boolean AS $$
  SELECT COALESCE((SELECT status IN ('approved', 'gazetted', 'superseded') FROM plan_instrument WHERE id = p_plan), FALSE)
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION set_plan_status(
  p_plan uuid, p_to text, p_actor uuid, p_role text,
  p_gazette_ref text DEFAULT NULL, p_effective_from date DEFAULT NULL
) RETURNS text AS $$
DECLARE pl plan_instrument%ROWTYPE; prev plan_instrument%ROWTYPE; moved integer := 0; stayed integer := 0;
BEGIN
  SELECT * INTO pl FROM plan_instrument WHERE id = p_plan FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown plan %', p_plan; END IF;
  IF pl.is_template THEN RAISE EXCEPTION 'a template has no status to change'; END IF;
  IF NOT EXISTS (SELECT 1 FROM plan_status_transition WHERE from_status = pl.status AND to_status = p_to) THEN
    RAISE EXCEPTION 'a plan cannot go from % to %', pl.status, p_to USING ERRCODE = 'check_violation';
  END IF;

  IF p_to = 'approved' AND NOT plan_signoff_is_current(p_plan) THEN
    RAISE EXCEPTION 'approval needs a current sign-off: the plan has been signed off, and not changed since'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_to = 'gazetted' THEN
    IF COALESCE(NULLIF(btrim(COALESCE(p_gazette_ref, pl.gazette_ref, '')), ''), NULL) IS NULL THEN
      RAISE EXCEPTION 'gazetting needs a gazette reference' USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(p_effective_from, pl.effective_from) IS NULL THEN
      RAISE EXCEPTION 'gazetting needs an effective date' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE plan_instrument
       SET gazette_ref = COALESCE(NULLIF(btrim(p_gazette_ref), ''), gazette_ref),
           effective_from = COALESCE(p_effective_from, effective_from)
     WHERE id = p_plan;
  END IF;

  UPDATE plan_instrument SET status = p_to, updated_at = NOW() WHERE id = p_plan;

  -- A new version in force: the version it replaces is superseded, and the zone polygons
  -- follow to the new version's zone types of the same name.
  IF p_to = 'gazetted' AND pl.supersedes_id IS NOT NULL THEN
    SELECT * INTO prev FROM plan_instrument WHERE id = pl.supersedes_id;
    UPDATE plan_instrument
       SET status = 'superseded', updated_at = NOW(),
           effective_to = CASE WHEN effective_from IS NULL
                                 OR (SELECT effective_from FROM plan_instrument WHERE id = p_plan) > effective_from
                               THEN (SELECT effective_from FROM plan_instrument WHERE id = p_plan) - 1
                               ELSE effective_to END
     WHERE id = pl.supersedes_id;
    UPDATE proposed_peri_urban_zones z
       SET plan_instrument_id = p_plan, plan_zone_type_id = nt.id
      FROM plan_zone_type ot
      JOIN plan_zone_type nt ON nt.plan_instrument_id = p_plan AND nt.code = ot.code
     WHERE z.plan_zone_type_id = ot.id AND ot.plan_instrument_id = pl.supersedes_id;
    GET DIAGNOSTICS moved = ROW_COUNT;
    SELECT COUNT(*) INTO stayed FROM proposed_peri_urban_zones WHERE plan_instrument_id = pl.supersedes_id;
    PERFORM log_plan_event(pl.supersedes_id, 'superseded', p_actor, p_role,
      jsonb_build_object('by', p_plan, 'polygons_moved', moved, 'polygons_left_behind', stayed));
  END IF;

  PERFORM log_plan_event(p_plan, 'status_changed', p_actor, p_role,
    jsonb_build_object('from', pl.status, 'to', p_to, 'gazette_ref', p_gazette_ref, 'effective_from', p_effective_from,
                       'polygons_moved', moved, 'polygons_left_behind', stayed));
  RETURN p_to;
END $$ LANGUAGE plpgsql;

-- 4. An approved, gazetted or superseded plan's rules cannot be edited --------------------------
CREATE OR REPLACE FUNCTION plan_freeze_guard() RETURNS trigger AS $$
DECLARE plan uuid; old_plan uuid;
BEGIN
  IF TG_TABLE_NAME = 'plan_zone_standard' THEN
    SELECT plan_instrument_id INTO plan FROM plan_zone_type WHERE id = COALESCE(NEW.plan_zone_type_id, OLD.plan_zone_type_id);
  ELSE
    plan := CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_instrument_id ELSE NEW.plan_instrument_id END;
    IF TG_OP = 'UPDATE' THEN old_plan := OLD.plan_instrument_id; END IF;
    -- a decision's plan may not be filled in yet (it is derived from its zone type)
    IF plan IS NULL AND TG_TABLE_NAME = 'zone_land_use_controls' THEN
      SELECT plan_instrument_id INTO plan FROM plan_zone_type
       WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_zone_type_id ELSE NEW.plan_zone_type_id END;
    END IF;
  END IF;
  IF plan_is_frozen(plan) OR (old_plan IS NOT NULL AND plan_is_frozen(old_plan)) THEN
    RAISE EXCEPTION 'this plan is approved and cannot be edited: create a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_zz_freeze_decisions ON zone_land_use_controls;
CREATE TRIGGER trg_zz_freeze_decisions BEFORE INSERT OR UPDATE OR DELETE ON zone_land_use_controls
  FOR EACH ROW EXECUTE FUNCTION plan_freeze_guard();
DROP TRIGGER IF EXISTS trg_zz_freeze_land_uses ON land_use_groups;
CREATE TRIGGER trg_zz_freeze_land_uses BEFORE INSERT OR UPDATE OR DELETE ON land_use_groups
  FOR EACH ROW EXECUTE FUNCTION plan_freeze_guard();
DROP TRIGGER IF EXISTS trg_zz_freeze_standards ON plan_zone_standard;
CREATE TRIGGER trg_zz_freeze_standards BEFORE INSERT OR UPDATE OR DELETE ON plan_zone_standard
  FOR EACH ROW EXECUTE FUNCTION plan_freeze_guard();

-- 5. Diff between any two plans; plan_diff keeps its meaning (a plan against its template) ------
CREATE OR REPLACE FUNCTION plan_decision_diff(p_from uuid, p_to uuid)
RETURNS TABLE (zone_type_code text, land_use_code text, from_decision text, to_decision text, change text) AS $$
  WITH own AS (
    SELECT zt.code AS zt, g.group_code AS lu, c.control_type AS d
      FROM zone_land_use_controls c
      JOIN plan_zone_type zt ON zt.id = c.plan_zone_type_id
      JOIN land_use_groups g ON g.id = c.land_use_group_id
     WHERE c.plan_instrument_id = p_to AND c.deleted_at IS NULL),
  base AS (
    SELECT zt.code AS zt, g.group_code AS lu, c.control_type AS d
      FROM zone_land_use_controls c
      JOIN plan_zone_type zt ON zt.id = c.plan_zone_type_id
      JOIN land_use_groups g ON g.id = c.land_use_group_id
     WHERE c.plan_instrument_id = p_from AND c.deleted_at IS NULL)
  SELECT COALESCE(o.zt, b.zt), COALESCE(o.lu, b.lu), b.d, o.d,
         CASE WHEN b.d IS NULL THEN 'added' WHEN o.d IS NULL THEN 'removed' ELSE 'changed' END
    FROM own o
    FULL JOIN base b ON o.zt = b.zt AND o.lu = b.lu
   WHERE b.d IS DISTINCT FROM o.d
   ORDER BY 1, 2
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION plan_diff(p_plan uuid)
RETURNS TABLE (zone_type_code text, land_use_code text, template_decision text, plan_decision text, change text) AS $$
  SELECT * FROM plan_decision_diff((SELECT derived_from_id FROM plan_instrument WHERE id = p_plan), p_plan)
$$ LANGUAGE sql STABLE;

-- 6. The next version of a plan --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION new_plan_version(p_plan uuid, p_actor uuid, p_role text) RETURNS uuid AS $$
DECLARE src plan_instrument%ROWTYPE; new_id uuid;
BEGIN
  SELECT * INTO src FROM plan_instrument WHERE id = p_plan;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown plan %', p_plan; END IF;
  IF src.is_template THEN RAISE EXCEPTION 'a template is not versioned this way'; END IF;
  IF src.status NOT IN ('approved', 'gazetted') THEN
    RAISE EXCEPTION 'only an approved or gazetted plan needs a new version (this one is %: edit it directly)', src.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM plan_instrument WHERE supersedes_id = p_plan AND status <> 'superseded') THEN
    RAISE EXCEPTION 'a newer version of this plan already exists' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO plan_instrument
    (authority_id, profile_id, plan_type, title, version, status, is_template, derived_from_id, supersedes_id, source_document, notes)
  VALUES
    (src.authority_id, src.profile_id, src.plan_type, src.title,
     (SELECT MAX(version) + 1 FROM plan_instrument WHERE authority_id = src.authority_id AND title = src.title),
     'draft', FALSE, src.derived_from_id, src.id, src.source_document,
     format('Version %s of "%s", copied from version %s on %s.', src.version + 1, src.title, src.version, CURRENT_DATE))
  RETURNING id INTO new_id;

  INSERT INTO plan_zone_type (plan_instrument_id, code, name, display_no, category, colour, std_zone_class, derived_from_id)
  SELECT new_id, code, name, display_no, category, colour, std_zone_class, id
    FROM plan_zone_type WHERE plan_instrument_id = src.id;

  INSERT INTO land_use_groups
    (group_code, description, group_category, development_category, use_scale, notes, is_active, display_order, plan_instrument_id, derived_from_id)
  SELECT group_code, description, group_category, development_category, use_scale, notes, TRUE, display_order, new_id, id
    FROM land_use_groups WHERE plan_instrument_id = src.id AND is_active;

  INSERT INTO zone_land_use_controls
    (plan_zone_type_id, land_use_group_id, control_type, authority, conditions, notes, pathway_code, derived_from_id)
  SELECT nz.id, ng.id, c.control_type, c.authority, c.conditions, c.notes, c.pathway_code, c.id
    FROM zone_land_use_controls c
    JOIN plan_zone_type oz ON oz.id = c.plan_zone_type_id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code
    JOIN land_use_groups og ON og.id = c.land_use_group_id
    JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code
   WHERE c.plan_instrument_id = src.id AND c.deleted_at IS NULL;

  INSERT INTO plan_zone_type_class (plan_zone_type_id, scheme, code, relation, status)
  SELECT nz.id, k.scheme, k.code, k.relation, k.status
    FROM plan_zone_type_class k
    JOIN plan_zone_type oz ON oz.id = k.plan_zone_type_id AND oz.plan_instrument_id = src.id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code;

  INSERT INTO land_use_group_class (land_use_group_id, scheme, code, relation, status)
  SELECT ng.id, k.scheme, k.code, k.relation, k.status
    FROM land_use_group_class k
    JOIN land_use_groups og ON og.id = k.land_use_group_id AND og.plan_instrument_id = src.id
    JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code;

  INSERT INTO plan_zone_standard
    (plan_zone_type_id, kind_code, land_use_group_id, min_value, max_value, conditions, source_ref, status, derived_from_id)
  SELECT nz.id, s.kind_code, ng.id, s.min_value, s.max_value, s.conditions, s.source_ref, s.status, s.id
    FROM plan_zone_standard s
    JOIN plan_zone_type oz ON oz.id = s.plan_zone_type_id AND oz.plan_instrument_id = src.id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code
    LEFT JOIN land_use_groups og ON og.id = s.land_use_group_id
    LEFT JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code
   WHERE s.land_use_group_id IS NULL OR ng.id IS NOT NULL;

  PERFORM log_plan_event(new_id, 'version_created', p_actor, p_role, jsonb_build_object('from', src.id, 'version', src.version + 1));
  PERFORM log_plan_event(src.id, 'new_version_started', p_actor, p_role, jsonb_build_object('new', new_id));
  RETURN new_id;
END $$ LANGUAGE plpgsql;

COMMIT;
