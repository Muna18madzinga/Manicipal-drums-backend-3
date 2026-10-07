-- Migration 139: plan-model foundation (Phase 1 of docs/architecture/02-data-model-proposal.md)
--
-- The portal was built around one council. This migration adds the structure for
-- many: authorities (rural, urban, combination), plan profiles, and plan
-- instruments that own zone types, land uses and decisions. It is ADDITIVE: no
-- table is renamed or dropped, and every existing reader keeps working. Existing
-- rows are attached to the new structure, and triggers keep the new references
-- filled for writers that have not moved yet (the matrix loader, QGIS zone
-- edits). Readers move to the new structure in Phase 2.
--
-- Shape:
--   local_authorities   one row per authority; kind = rural | urban | combination
--   authority_member    a combination authority's members, with dates
--   plan_profile        a reusable template for a kind of plan (rural, urban)
--   plan_instrument     a versioned plan document: owned by an authority, or a
--                       profile template (is_template, no authority)
--   plan_zone_type      zone types, per plan instrument
--   + plan_instrument_id on land_use_groups, zone_land_use_controls and
--     proposed_peri_urban_zones; plan_zone_type_id on the latter two.
--
-- It also repairs local_authorities: three routes select authority_id,
-- authority_type, application_fee and is_active from it, columns migration 110
-- never created, so GET /development-control/local-authorities returned 500.
--
-- Idempotent; safe to re-run. Avoids syntax newer than PostgreSQL 14.

BEGIN;

-- 1. Authority -----------------------------------------------------------------
ALTER TABLE local_authorities
  ADD COLUMN IF NOT EXISTS code            text,
  ADD COLUMN IF NOT EXISTS kind            text,
  ADD COLUMN IF NOT EXISTS authority_type  text,
  ADD COLUMN IF NOT EXISTS province        text,
  ADD COLUMN IF NOT EXISTS jurisdiction    geometry(MultiPolygon, 4326),
  ADD COLUMN IF NOT EXISTS application_fee numeric(12, 2),
  ADD COLUMN IF NOT EXISTS is_active       boolean NOT NULL DEFAULT TRUE;

-- authority_id is what the older routes call the key.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'local_authorities' AND column_name = 'authority_id') THEN
    ALTER TABLE local_authorities ADD COLUMN authority_id integer GENERATED ALWAYS AS (id) STORED;
  END IF;
END $$;

UPDATE local_authorities
   SET code = 'VUNGU', kind = 'rural', authority_type = 'Rural District Council', province = 'Midlands'
 WHERE authority_name = 'Vungu Rural District Council' AND code IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'local_authorities_kind_check') THEN
    ALTER TABLE local_authorities
      ADD CONSTRAINT local_authorities_kind_check CHECK (kind IN ('rural', 'urban', 'combination'));
  END IF;
  -- Every authority must say what kind it is, once existing rows have been classified.
  IF NOT EXISTS (SELECT 1 FROM local_authorities WHERE kind IS NULL) THEN
    ALTER TABLE local_authorities ALTER COLUMN kind SET NOT NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_local_authorities_code ON local_authorities (code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_local_authorities_jurisdiction ON local_authorities USING GIST (jurisdiction);

-- 2. Combination authorities ---------------------------------------------------
-- Created where two (or more) local authorities' areas overlap. It is an authority
-- in its own right: its own code, jurisdiction (the overlap) and plans. Members
-- keep their own plans elsewhere. A combination needs at least two members; that
-- is checked by the application, since a row-level constraint cannot count rows.
CREATE TABLE IF NOT EXISTS authority_member (
  combination_id integer NOT NULL REFERENCES local_authorities (id) ON DELETE CASCADE,
  member_id      integer NOT NULL REFERENCES local_authorities (id) ON DELETE RESTRICT,
  valid_from     date    NOT NULL DEFAULT CURRENT_DATE,
  valid_to       date,
  PRIMARY KEY (combination_id, member_id, valid_from),
  CHECK (combination_id <> member_id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE OR REPLACE FUNCTION authority_member_check() RETURNS trigger AS $$
DECLARE ck text; mk text;
BEGIN
  SELECT kind INTO ck FROM local_authorities WHERE id = NEW.combination_id;
  SELECT kind INTO mk FROM local_authorities WHERE id = NEW.member_id;
  IF ck IS DISTINCT FROM 'combination' THEN
    RAISE EXCEPTION 'authority % is not a combination authority', NEW.combination_id;
  END IF;
  IF mk = 'combination' THEN
    RAISE EXCEPTION 'a combination authority cannot be a member of another (authority %)', NEW.member_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_authority_member_check ON authority_member;
CREATE TRIGGER trg_authority_member_check
  BEFORE INSERT OR UPDATE ON authority_member
  FOR EACH ROW EXECUTE FUNCTION authority_member_check();

-- 3. Profiles ------------------------------------------------------------------
-- A profile is a template for a kind of plan: its zone types, land uses and
-- default decisions. It attaches to a plan instrument, not to an authority: one
-- rural authority can hold an urban-style plan (Vungu's peri-urban zones).
CREATE TABLE IF NOT EXISTS plan_profile (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('rural', 'urban')),
  description text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('skeleton', 'draft', 'approved')),
  version     integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plan_profile (code, name, kind, description, status, version) VALUES
  ('rural', 'Rural district profile', 'rural',
   'Draft v0: zone types and land uses from one sample district development control matrix (11 zones x 32 uses). To be tested against further rural samples before it is called generic.',
   'draft', 0),
  ('urban', 'Urban profile', 'urban',
   'Skeleton: no zone types, uses or decisions yet. Reserved for urban samples (density, floor-area ratio, plot coverage, height, setbacks, parking, precincts).',
   'skeleton', 0)
ON CONFLICT (code) DO NOTHING;

-- 4. Plan instruments ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_instrument (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authority_id    integer REFERENCES local_authorities (id),
  profile_id      uuid NOT NULL REFERENCES plan_profile (id),
  plan_type       text NOT NULL CHECK (plan_type IN ('district_master', 'local', 'layout', 'scheme')),
  title           text NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'unknown'
                  CHECK (status IN ('unknown', 'draft', 'public_notice', 'approved', 'gazetted', 'superseded')),
  effective_from  date,
  effective_to    date,
  gazette_ref     text,
  source_document text,
  is_template     boolean NOT NULL DEFAULT FALSE,
  derived_from_id uuid REFERENCES plan_instrument (id),
  supersedes_id   uuid REFERENCES plan_instrument (id),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A profile template belongs to no authority; every other plan belongs to one.
  CHECK ((is_template AND authority_id IS NULL) OR (NOT is_template AND authority_id IS NOT NULL)),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_instrument
  ON plan_instrument (COALESCE(authority_id, 0), plan_type, title, version);
CREATE INDEX IF NOT EXISTS idx_plan_instrument_authority ON plan_instrument (authority_id);

CREATE TABLE IF NOT EXISTS plan_zone_type (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_instrument_id uuid NOT NULL REFERENCES plan_instrument (id) ON DELETE CASCADE,
  code               text NOT NULL,
  name               text NOT NULL,
  display_no         integer,
  category           text,
  colour             text,
  std_zone_class     text,
  UNIQUE (plan_instrument_id, code)
);

-- The rural profile's template plan, seeded from the sample matrix.
INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title, version, status, is_template, source_document, notes)
SELECT NULL, p.id, 'district_master', 'Rural profile v0: district development control matrix (sample)', 1, 'draft', TRUE,
       'development matrix sample.pdf',
       'Seeded from one sample district matrix (11 zone types x 32 coded land uses). A starting template, not any authority''s adopted plan.'
  FROM plan_profile p
 WHERE p.code = 'rural'
   AND NOT EXISTS (SELECT 1 FROM plan_instrument
                    WHERE is_template AND title = 'Rural profile v0: district development control matrix (sample)');

-- Vungu RDC's local plan, as digitised in proposed_peri_urban_zones.
INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title, version, status, is_template, notes)
SELECT a.id, p.id, 'local', 'Vungu RDC peri-urban local plan (as mapped)', 1, 'unknown', FALSE,
       'Zones as digitised in proposed_peri_urban_zones. Status, gazette reference and effective date are not yet confirmed. The urban profile assignment is provisional.'
  FROM local_authorities a, plan_profile p
 WHERE a.code = 'VUNGU' AND p.code = 'urban'
   AND NOT EXISTS (SELECT 1 FROM plan_instrument WHERE title = 'Vungu RDC peri-urban local plan (as mapped)');

-- Zone types for the template: the 11 district zones, in the matrix's column order.
INSERT INTO plan_zone_type (plan_instrument_id, code, name, display_no, category)
SELECT i.id, r.code, r.label, r.display_order, r.category
  FROM ref_zone_types r
  JOIN plan_instrument i ON i.is_template AND i.title = 'Rural profile v0: district development control matrix (sample)'
 WHERE r.display_order IS NOT NULL
ON CONFLICT (plan_instrument_id, code) DO NOTHING;

-- Zone types for Vungu's plan: the distinct zone names on its polygons.
INSERT INTO plan_zone_type (plan_instrument_id, code, name)
SELECT DISTINCT i.id, z.zone, z.zone
  FROM proposed_peri_urban_zones z
  JOIN plan_instrument i ON i.title = 'Vungu RDC peri-urban local plan (as mapped)'
 WHERE z.zone IS NOT NULL
ON CONFLICT (plan_instrument_id, code) DO NOTHING;

-- 5. Attach existing zone polygons --------------------------------------------
ALTER TABLE proposed_peri_urban_zones
  ADD COLUMN IF NOT EXISTS plan_instrument_id uuid REFERENCES plan_instrument (id),
  ADD COLUMN IF NOT EXISTS plan_zone_type_id  uuid REFERENCES plan_zone_type (id);

UPDATE proposed_peri_urban_zones z
   SET plan_instrument_id = i.id, plan_zone_type_id = t.id
  FROM plan_instrument i
  JOIN plan_zone_type t ON t.plan_instrument_id = i.id
 WHERE i.title = 'Vungu RDC peri-urban local plan (as mapped)'
   AND t.code = z.zone
   AND z.plan_instrument_id IS NULL;

-- A zone drawn in QGIS (which writes this table through zones_master) arrives with no
-- plan references: file it under Vungu's plan, creating its zone type if the name is new.
CREATE OR REPLACE FUNCTION zones_sync_plan_refs() RETURNS trigger AS $$
DECLARE inst uuid;
BEGIN
  IF NEW.plan_instrument_id IS NULL THEN
    SELECT id INTO inst FROM plan_instrument WHERE title = 'Vungu RDC peri-urban local plan (as mapped)' LIMIT 1;
    NEW.plan_instrument_id := inst;
  END IF;
  IF NEW.plan_zone_type_id IS NULL AND NEW.plan_instrument_id IS NOT NULL AND NEW.zone IS NOT NULL THEN
    INSERT INTO plan_zone_type (plan_instrument_id, code, name)
    VALUES (NEW.plan_instrument_id, NEW.zone, NEW.zone)
    ON CONFLICT (plan_instrument_id, code) DO NOTHING;
    SELECT id INTO NEW.plan_zone_type_id FROM plan_zone_type
     WHERE plan_instrument_id = NEW.plan_instrument_id AND code = NEW.zone;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_zones_sync_plan_refs ON proposed_peri_urban_zones;
CREATE TRIGGER trg_zones_sync_plan_refs
  BEFORE INSERT OR UPDATE OF zone, plan_instrument_id ON proposed_peri_urban_zones
  FOR EACH ROW EXECUTE FUNCTION zones_sync_plan_refs();

-- 6. Attach land uses and decisions --------------------------------------------
-- The 32 coded uses belong to the rural template. The ten retired legacy groups stay
-- unattached. (Code stays unique across the table until a second plan brings its own
-- uses in Phase 2.)
ALTER TABLE land_use_groups
  ADD COLUMN IF NOT EXISTS plan_instrument_id uuid REFERENCES plan_instrument (id);

UPDATE land_use_groups g
   SET plan_instrument_id = i.id
  FROM plan_instrument i
 WHERE i.is_template AND i.title = 'Rural profile v0: district development control matrix (sample)'
   AND g.is_active AND g.plan_instrument_id IS NULL;

ALTER TABLE zone_land_use_controls
  ADD COLUMN IF NOT EXISTS plan_instrument_id uuid REFERENCES plan_instrument (id),
  ADD COLUMN IF NOT EXISTS plan_zone_type_id  uuid REFERENCES plan_zone_type (id);

UPDATE zone_land_use_controls c
   SET plan_instrument_id = t.plan_instrument_id, plan_zone_type_id = t.id
  FROM plan_zone_type t
  JOIN plan_instrument i ON i.id = t.plan_instrument_id AND i.is_template
 WHERE c.zone_type IS NOT NULL AND t.code = c.zone_type AND c.plan_zone_type_id IS NULL;

UPDATE zone_land_use_controls c
   SET plan_instrument_id = z.plan_instrument_id
  FROM proposed_peri_urban_zones z
 WHERE c.zone_id IS NOT NULL AND z.id = c.zone_id AND c.plan_instrument_id IS NULL;

-- Writers that still use the older columns (the matrix loader writes zone_type; the zone
-- API writes zone_id) get the new references filled in. Transitional: a zone-type row
-- written the old way lands in the rural template. Removed once writers pass a plan.
CREATE OR REPLACE FUNCTION zlc_sync_plan_refs() RETURNS trigger AS $$
DECLARE tmpl uuid;
BEGIN
  IF NEW.zone_type IS NOT NULL THEN
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
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_zlc_sync_plan_refs ON zone_land_use_controls;
CREATE TRIGGER trg_zlc_sync_plan_refs
  BEFORE INSERT OR UPDATE OF zone_id, zone_type ON zone_land_use_controls
  FOR EACH ROW EXECUTE FUNCTION zlc_sync_plan_refs();

CREATE INDEX IF NOT EXISTS idx_zlc_plan_zone_type ON zone_land_use_controls (plan_zone_type_id);

-- 7. Applications know their authority ------------------------------------------
-- Transitional default: every application so far is Vungu's. Dropped when row-level
-- security arrives (Phase 4) and the application passes the authority explicitly.
ALTER TABLE development_applications
  ADD COLUMN IF NOT EXISTS authority_id integer REFERENCES local_authorities (id);

UPDATE development_applications SET authority_id = (SELECT id FROM local_authorities WHERE code = 'VUNGU')
 WHERE authority_id IS NULL;
ALTER TABLE development_applications
  ALTER COLUMN authority_id SET DEFAULT 1;

-- 8. Effective controls also follow the new zone-type reference ------------------
-- Same columns as migration 138's view. A polygon takes its own rules first, then those
-- of its zone type (matched by the new plan_zone_type_id, or by the older text code).
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
       CASE WHEN c.zone_id IS NOT NULL THEN 'zone' ELSE 'zone_type' END AS source
  FROM proposed_peri_urban_zones z
  JOIN zone_land_use_controls c
    ON c.deleted_at IS NULL
   AND (c.zone_id = z.id
        OR (c.zone_id IS NULL
            AND (c.plan_zone_type_id = z.plan_zone_type_id OR c.zone_type = z.zone_type)))
 ORDER BY z.id, c.land_use_group_id, (c.zone_id IS NULL);

-- 9. A readable summary of every plan -------------------------------------------
CREATE OR REPLACE VIEW plan_instrument_summary AS
SELECT i.id,
       i.title,
       i.plan_type,
       i.version,
       i.status,
       i.is_template,
       i.effective_from,
       i.effective_to,
       i.gazette_ref,
       a.id             AS authority_id,
       a.code           AS authority_code,
       a.authority_name AS authority_name,
       a.kind           AS authority_kind,
       p.code           AS profile_code,
       (SELECT COUNT(*) FROM plan_zone_type t WHERE t.plan_instrument_id = i.id)::int AS zone_types,
       (SELECT COUNT(*) FROM land_use_groups g WHERE g.plan_instrument_id = i.id AND g.is_active)::int AS land_uses,
       (SELECT COUNT(*) FROM zone_land_use_controls c WHERE c.plan_instrument_id = i.id AND c.deleted_at IS NULL)::int AS decisions,
       (SELECT COUNT(*) FROM proposed_peri_urban_zones z WHERE z.plan_instrument_id = i.id)::int AS zone_polygons
  FROM plan_instrument i
  JOIN plan_profile p ON p.id = i.profile_id
  LEFT JOIN local_authorities a ON a.id = i.authority_id;

COMMIT;
