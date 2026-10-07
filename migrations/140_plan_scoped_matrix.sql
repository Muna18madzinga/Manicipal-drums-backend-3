-- Migration 140: a plan owns its own land uses and decisions (Phase 2, first slice)
--
-- Phase 1 attached the existing matrix to the rural template, but kept land-use
-- codes unique across the whole table, so a second plan could not have its own
-- 'A' or 'D1'. This migration lets every plan carry its own vocabulary:
--
--   1. land-use codes are unique PER PLAN (retired legacy groups form one bucket);
--   2. a decision may target a plan's zone type directly (plan_zone_type_id),
--      instead of the global text code, so two plans can both have a zone type
--      with the same name;
--   3. a trigger keeps a decision's zone type and land use in the same plan;
--   4. adopt_plan_template() gives an authority its own COPY of a template, with
--      provenance (derived_from_id) on every copied row;
--   5. plan_diff() lists how a plan has drifted from the template it was adopted
--      from.
--
-- Adopt-by-copy replaces the "template plus overrides, resolved at read time"
-- design in the first proposal. A plan is a dated legal document: it must be
-- complete in itself and must not change because a template is edited later. A
-- diff shows the drift instead.
--
-- Note: migrations 081 and 138 upsert on land_use_groups(group_code). Both run
-- before this one in any chain, so a fresh database is unaffected; re-running
-- them by hand afterwards would fail, because the global constraint is gone.
--
-- Idempotent; safe to re-run.

BEGIN;

-- 1. Land-use codes: unique per plan ---------------------------------------------
ALTER TABLE land_use_groups DROP CONSTRAINT IF EXISTS land_use_groups_group_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_land_use_plan_code
  ON land_use_groups (COALESCE(plan_instrument_id, '00000000-0000-0000-0000-000000000000'::uuid), group_code);

ALTER TABLE land_use_groups ADD COLUMN IF NOT EXISTS derived_from_id uuid REFERENCES land_use_groups (id);
ALTER TABLE plan_zone_type  ADD COLUMN IF NOT EXISTS derived_from_id uuid REFERENCES plan_zone_type (id);

-- 2. A decision targets a polygon, or a plan's own zone type ------------------------
ALTER TABLE zone_land_use_controls ADD COLUMN IF NOT EXISTS derived_from_id uuid REFERENCES zone_land_use_controls (id);

ALTER TABLE zone_land_use_controls DROP CONSTRAINT IF EXISTS zlc_one_target;
ALTER TABLE zone_land_use_controls
  ADD CONSTRAINT zlc_one_target
  CHECK ((zone_id IS NOT NULL) <> (zone_type IS NOT NULL OR plan_zone_type_id IS NOT NULL));

-- One decision per zone type and land use, within a plan.
CREATE UNIQUE INDEX IF NOT EXISTS uq_zlc_plan_zone_type_group
  ON zone_land_use_controls (plan_zone_type_id, land_use_group_id)
  WHERE plan_zone_type_id IS NOT NULL;

-- 3. Keep a decision inside one plan --------------------------------------------
CREATE OR REPLACE FUNCTION zlc_sync_plan_refs() RETURNS trigger AS $$
DECLARE tmpl uuid; grp_plan uuid; grp_template boolean;
BEGIN
  IF NEW.plan_zone_type_id IS NOT NULL THEN
    -- A decision on a plan's own zone type belongs to that plan.
    SELECT t.plan_instrument_id INTO NEW.plan_instrument_id
      FROM plan_zone_type t WHERE t.id = NEW.plan_zone_type_id;
  ELSIF NEW.zone_type IS NOT NULL THEN
    -- Older writers pass the text code: it lands in the rural template (transitional).
    SELECT i.id INTO tmpl
      FROM plan_instrument i JOIN plan_profile p ON p.id = i.profile_id
     WHERE i.is_template AND p.code = 'rural' AND i.plan_type = 'district_master'
     ORDER BY i.created_at LIMIT 1;
    NEW.plan_instrument_id := tmpl;
    SELECT t.id INTO NEW.plan_zone_type_id
      FROM plan_zone_type t WHERE t.plan_instrument_id = tmpl AND t.code = NEW.zone_type;
  ELSIF NEW.zone_id IS NOT NULL THEN
    SELECT z.plan_instrument_id INTO NEW.plan_instrument_id
      FROM proposed_peri_urban_zones z WHERE z.id = NEW.zone_id;
  END IF;

  SELECT g.plan_instrument_id, COALESCE(i.is_template, FALSE) INTO grp_plan, grp_template
    FROM land_use_groups g LEFT JOIN plan_instrument i ON i.id = g.plan_instrument_id
   WHERE g.id = NEW.land_use_group_id;

  IF NEW.plan_zone_type_id IS NOT NULL THEN
    IF grp_plan IS DISTINCT FROM NEW.plan_instrument_id THEN
      RAISE EXCEPTION 'land use % belongs to a different plan than the zone type', NEW.land_use_group_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.zone_id IS NOT NULL THEN
    -- A polygon decision may use its own plan's land uses, or a template's shared vocabulary.
    IF grp_plan IS NOT NULL AND grp_plan IS DISTINCT FROM NEW.plan_instrument_id AND NOT grp_template THEN
      RAISE EXCEPTION 'land use % belongs to a different plan than the zone polygon', NEW.land_use_group_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_zlc_sync_plan_refs ON zone_land_use_controls;
CREATE TRIGGER trg_zlc_sync_plan_refs
  BEFORE INSERT OR UPDATE OF zone_id, zone_type, plan_zone_type_id, land_use_group_id ON zone_land_use_controls
  FOR EACH ROW EXECUTE FUNCTION zlc_sync_plan_refs();

-- 4. Adopt a template: the authority gets its own complete copy -------------------
CREATE OR REPLACE FUNCTION adopt_plan_template(
  p_template  uuid,
  p_authority integer,
  p_title     text,
  p_plan_type text DEFAULT 'local',
  p_status    text DEFAULT 'draft'
) RETURNS uuid AS $$
DECLARE tmpl plan_instrument%ROWTYPE; auth local_authorities%ROWTYPE; new_id uuid;
BEGIN
  SELECT * INTO tmpl FROM plan_instrument WHERE id = p_template;
  IF NOT FOUND OR NOT tmpl.is_template THEN
    RAISE EXCEPTION '% is not a plan template', p_template;
  END IF;
  SELECT * INTO auth FROM local_authorities WHERE id = p_authority;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority % does not exist', p_authority;
  END IF;

  INSERT INTO plan_instrument
    (authority_id, profile_id, plan_type, title, version, status, is_template, derived_from_id, notes)
  VALUES
    (auth.id, tmpl.profile_id, p_plan_type, p_title, 1, p_status, FALSE, tmpl.id,
     format('Adopted from template "%s" on %s. Edit this copy; plan_diff() shows how it differs from the template.', tmpl.title, CURRENT_DATE))
  RETURNING id INTO new_id;

  INSERT INTO plan_zone_type (plan_instrument_id, code, name, display_no, category, colour, std_zone_class, derived_from_id)
  SELECT new_id, code, name, display_no, category, colour, std_zone_class, id
    FROM plan_zone_type WHERE plan_instrument_id = tmpl.id;

  INSERT INTO land_use_groups
    (group_code, description, group_category, development_category, use_scale, notes, is_active, display_order, plan_instrument_id, derived_from_id)
  SELECT group_code, description, group_category, development_category, use_scale, notes, TRUE, display_order, new_id, id
    FROM land_use_groups WHERE plan_instrument_id = tmpl.id AND is_active;

  INSERT INTO zone_land_use_controls
    (plan_zone_type_id, land_use_group_id, control_type, authority, conditions, notes, derived_from_id)
  SELECT nz.id, ng.id, c.control_type, auth.authority_name, c.conditions, c.notes, c.id
    FROM zone_land_use_controls c
    JOIN plan_zone_type oz ON oz.id = c.plan_zone_type_id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code
    JOIN land_use_groups og ON og.id = c.land_use_group_id
    JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code
   WHERE c.plan_instrument_id = tmpl.id AND c.deleted_at IS NULL;

  RETURN new_id;
END $$ LANGUAGE plpgsql;

-- 5. How a plan differs from the template it was adopted from ----------------------
CREATE OR REPLACE FUNCTION plan_diff(p_plan uuid)
RETURNS TABLE (zone_type_code text, land_use_code text, template_decision text, plan_decision text, change text) AS $$
  WITH src AS (SELECT derived_from_id AS tmpl FROM plan_instrument WHERE id = p_plan),
  own AS (
    SELECT zt.code AS zt, g.group_code AS lu, c.control_type AS d
      FROM zone_land_use_controls c
      JOIN plan_zone_type zt ON zt.id = c.plan_zone_type_id
      JOIN land_use_groups g ON g.id = c.land_use_group_id
     WHERE c.plan_instrument_id = p_plan AND c.deleted_at IS NULL),
  base AS (
    SELECT zt.code AS zt, g.group_code AS lu, c.control_type AS d
      FROM zone_land_use_controls c
      JOIN plan_zone_type zt ON zt.id = c.plan_zone_type_id
      JOIN land_use_groups g ON g.id = c.land_use_group_id
     WHERE c.plan_instrument_id = (SELECT tmpl FROM src) AND c.deleted_at IS NULL)
  SELECT COALESCE(o.zt, b.zt), COALESCE(o.lu, b.lu), b.d, o.d,
         CASE WHEN b.d IS NULL THEN 'added' WHEN o.d IS NULL THEN 'removed' ELSE 'changed' END
    FROM own o
    FULL JOIN base b ON o.zt = b.zt AND o.lu = b.lu
   WHERE b.d IS DISTINCT FROM o.d
   ORDER BY 1, 2
$$ LANGUAGE sql STABLE;

COMMIT;
