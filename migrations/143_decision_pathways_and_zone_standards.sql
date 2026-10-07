-- 143_decision_pathways_and_zone_standards.sql
-- ─────────────────────────────────────────────────────────────────────────
-- 1. Decision pathways: what a decision such as "special consent" actually triggers.
-- 2. Zone standards: the numeric limits a zone type imposes (stand size, coverage, height,
--    setbacks...), per plan.
--
-- WHAT IS SEEDED, AND WHAT IS NOT.
--  * One pathway: Section 26(3) special consent. Only two facts are recorded, both confirmed
--    from the council's Development Management/Control Manual 2021 in this repository:
--    public notice at the applicant's expense, and adjacent landowners notified. The
--    objection period, the decision body and the statutory text are NOT known and stay NULL.
--    That 26(3) is the special-consent route comes from secondary sources and is marked so.
--  * NO permit pathway for "permitted" uses: whether the s26(1) permit process still runs
--    for a permitted use is a process question not yet answered (standards review, settled
--    points).
--  * Standards: the table and a vocabulary of kinds (stand area, coverage...), and NO values.
--    The numbers in planning_assistant_templates have no known source and are not migrated.

BEGIN;

-- 1. Pathways ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_pathway (
  code                       text PRIMARY KEY,
  name                       text NOT NULL,
  decision                   text NOT NULL CHECK (decision IN ('permitted', 'special_consent', 'prohibited')),
  requires_public_notice     boolean,          -- NULL = not known
  notice_at_applicant_cost   boolean,
  adjacent_owners_notified   boolean,
  objection_days             integer CHECK (objection_days IS NULL OR objection_days >= 0),
  decision_body              text,
  statutory_ref              text,
  evidence_status            text NOT NULL DEFAULT 'unverified'
                               CHECK (evidence_status IN ('unverified', 'secondary_source', 'confirmed')),
  evidence                   text,
  is_default_for_decision    boolean NOT NULL DEFAULT FALSE,
  created_at                 timestamptz NOT NULL DEFAULT NOW()
);

-- At most one default pathway per decision value.
CREATE UNIQUE INDEX IF NOT EXISTS uq_decision_pathway_default
  ON decision_pathway (decision) WHERE is_default_for_decision;

INSERT INTO decision_pathway
  (code, name, decision, requires_public_notice, notice_at_applicant_cost, adjacent_owners_notified,
   objection_days, decision_body, statutory_ref, evidence_status, evidence, is_default_for_decision)
VALUES
  ('s26_3_special_consent', 'Special consent (RTCP Act s26(3))', 'special_consent',
   TRUE, TRUE, TRUE, NULL, NULL, 'Regional, Town and Country Planning Act, s26(3)', 'secondary_source',
   'Notice at the applicant''s expense and notification of adjacent landowners: council letter in the Development Management/Control Manual 2021 (this repository). That s26(3) is the special-consent route: secondary sources; check the Act text. Objection period, decision body: not known.',
   TRUE)
ON CONFLICT (code) DO NOTHING;

-- A decision may name its pathway; blank means "the default for that decision, if any".
ALTER TABLE zone_land_use_controls ADD COLUMN IF NOT EXISTS pathway_code text REFERENCES decision_pathway (code);

-- 2. Zone standards -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS standard_kind (
  code  text PRIMARY KEY,
  name  text NOT NULL,
  unit  text NOT NULL
);

INSERT INTO standard_kind (code, name, unit) VALUES
  ('min_stand_area',     'Minimum stand area',          'm2'),
  ('max_stand_area',     'Maximum stand area',          'm2'),
  ('min_frontage',       'Minimum frontage',            'm'),
  ('max_coverage',       'Maximum plot coverage',       '%'),
  ('max_floor_area_ratio','Maximum floor area ratio',   'ratio'),
  ('max_height',         'Maximum building height',     'm'),
  ('max_storeys',        'Maximum storeys',             'storeys'),
  ('setback_front',      'Front building line',         'm'),
  ('setback_rear',       'Rear building line',          'm'),
  ('setback_side',       'Side building line',          'm'),
  ('parking_per_unit',   'Parking spaces per unit',     'spaces')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS plan_zone_standard (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_zone_type_id  uuid NOT NULL REFERENCES plan_zone_type (id) ON DELETE CASCADE,
  kind_code          text NOT NULL REFERENCES standard_kind (code),
  land_use_group_id  uuid REFERENCES land_use_groups (id) ON DELETE CASCADE,  -- NULL = any use
  min_value          numeric,
  max_value          numeric,
  conditions         text,
  source_ref         text,
  status             text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'confirmed')),
  derived_from_id    uuid,
  created_at         timestamptz NOT NULL DEFAULT NOW(),
  CHECK (min_value IS NOT NULL OR max_value IS NOT NULL),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_zone_standard
  ON plan_zone_standard (plan_zone_type_id, kind_code, COALESCE(land_use_group_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- A standard tied to a land use must use that zone type's own plan's land use.
CREATE OR REPLACE FUNCTION plan_zone_standard_same_plan() RETURNS trigger AS $$
BEGIN
  IF NEW.land_use_group_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM plan_zone_type t JOIN land_use_groups g ON g.plan_instrument_id = t.plan_instrument_id
        WHERE t.id = NEW.plan_zone_type_id AND g.id = NEW.land_use_group_id) THEN
    RAISE EXCEPTION 'land use % belongs to a different plan than the zone type', NEW.land_use_group_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_plan_zone_standard_same_plan ON plan_zone_standard;
CREATE TRIGGER trg_plan_zone_standard_same_plan
  BEFORE INSERT OR UPDATE OF plan_zone_type_id, land_use_group_id ON plan_zone_standard
  FOR EACH ROW EXECUTE FUNCTION plan_zone_standard_same_plan();

-- 3. The effective-controls view carries the pathway (added at the end) -------------------------
CREATE OR REPLACE VIEW zone_effective_controls AS
SELECT DISTINCT ON (z.id, c.land_use_group_id)
       c.id,
       z.id AS zone_id,
       c.land_use_group_id,
       c.control_type,
       c.authority,
       c.notes,
       c.conditions,
       c.created_at,
       c.updated_at,
       c.deleted_at,
       c.deleted_by,
       CASE WHEN c.zone_id IS NOT NULL THEN 'zone' ELSE 'zone_type' END AS source,
       c.pathway_code
  FROM proposed_peri_urban_zones z
  JOIN zone_land_use_controls c
    ON c.deleted_at IS NULL
   AND (c.zone_id = z.id
        OR (c.zone_id IS NULL
            AND (c.plan_zone_type_id = z.plan_zone_type_id OR c.zone_type = z.zone_type)))
 ORDER BY z.id, c.land_use_group_id, (c.zone_id IS NULL);

-- 4. Adopting a template also copies pathways named on decisions, and standards -----------------
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
    (plan_zone_type_id, land_use_group_id, control_type, authority, conditions, notes, pathway_code, derived_from_id)
  SELECT nz.id, ng.id, c.control_type, auth.authority_name, c.conditions, c.notes, c.pathway_code, c.id
    FROM zone_land_use_controls c
    JOIN plan_zone_type oz ON oz.id = c.plan_zone_type_id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code
    JOIN land_use_groups og ON og.id = c.land_use_group_id
    JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code
   WHERE c.plan_instrument_id = tmpl.id AND c.deleted_at IS NULL;

  INSERT INTO plan_zone_type_class (plan_zone_type_id, scheme, code, relation, status)
  SELECT nz.id, k.scheme, k.code, k.relation, k.status
    FROM plan_zone_type_class k
    JOIN plan_zone_type oz ON oz.id = k.plan_zone_type_id AND oz.plan_instrument_id = tmpl.id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code;

  INSERT INTO land_use_group_class (land_use_group_id, scheme, code, relation, status)
  SELECT ng.id, k.scheme, k.code, k.relation, k.status
    FROM land_use_group_class k
    JOIN land_use_groups og ON og.id = k.land_use_group_id AND og.plan_instrument_id = tmpl.id
    JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code;

  INSERT INTO plan_zone_standard
    (plan_zone_type_id, kind_code, land_use_group_id, min_value, max_value, conditions, source_ref, status, derived_from_id)
  SELECT nz.id, s.kind_code, ng.id, s.min_value, s.max_value, s.conditions, s.source_ref, s.status, s.id
    FROM plan_zone_standard s
    JOIN plan_zone_type oz ON oz.id = s.plan_zone_type_id AND oz.plan_instrument_id = tmpl.id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code
    LEFT JOIN land_use_groups og ON og.id = s.land_use_group_id
    LEFT JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code
   WHERE s.land_use_group_id IS NULL OR ng.id IS NOT NULL;

  RETURN new_id;
END $$ LANGUAGE plpgsql;

COMMIT;
