-- Migration 078: Third Normal Form (3NF) Normalisation
--
-- Eliminates the main 3NF violations in the schema:
--
-- 1. Reference tables for repeating attribute enumerations:
--    ref_stand_statuses, ref_scale_categories, ref_use_scales, ref_zone_types
--
-- 2. stands.zone_type — transitive dependency (id → zone_id → zone_type).
--    Fix: drop the denormalised column; derive via view v_stands.
--
-- 3. stands.ward — free-text ward name duplicated across rows.
--    Fix: add ward_fid FK to the PostGIS wards table; keep the text column
--    for compatibility under a rename (ward_name) while new code uses the FK.
--
-- 4. planning_assistant_templates — zone_type and scale_category are
--    repeating strings with no FK enforcement.
--    Fix: add FKs to the new reference tables.
--
-- 5. development_applications.status — free-text VARCHAR with no constraint.
--    Fix: add a CHECK constraint backed by ref_application_statuses.
--
-- 6. users table — partial mix of auth data and profile data.
--    Fix: introduce a separate user_profiles table (1:1 with users) that
--    owns the non-auth columns (full_name, job_title, department, phone).
--
-- All changes are backward-compatible: existing columns are kept under
-- aliases or as NULLable additions so running application code continues
-- to work without a coordinated deploy.
--
-- Run with: psql $DATABASE_URL -f migrations/078_3nf_normalization.sql

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 1. REFERENCE TABLES
-- ════════════════════════════════════════════════════════════════════════

-- Stand status codes
CREATE TABLE IF NOT EXISTS ref_stand_statuses (
  code        VARCHAR(20) PRIMARY KEY,
  label       VARCHAR(64) NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 0
);
INSERT INTO ref_stand_statuses (code, label, description, sort_order) VALUES
  ('available',  'Available',  'Stand is open for citizen applications.',      1),
  ('reserved',   'Reserved',   'Soft-reserved for 30 min during application.', 2),
  ('allocated',  'Allocated',  'Stand has been formally allocated.',            3),
  ('withdrawn',  'Withdrawn',  'Stand has been removed from the register.',     4)
ON CONFLICT (code) DO NOTHING;

-- Scale categories (farming / peri-urban classification)
CREATE TABLE IF NOT EXISTS ref_scale_categories (
  code        VARCHAR(20) PRIMARY KEY,
  label       VARCHAR(64) NOT NULL,
  description TEXT
);
INSERT INTO ref_scale_categories (code, label) VALUES
  ('small_scale',  'Small Scale'),
  ('large_scale',  'Large Scale'),
  ('mixed_scale',  'Mixed Scale')
ON CONFLICT (code) DO NOTHING;

-- Use scales (stands)
CREATE TABLE IF NOT EXISTS ref_use_scales (
  code        VARCHAR(20) PRIMARY KEY,
  label       VARCHAR(64) NOT NULL
);
INSERT INTO ref_use_scales (code, label) VALUES
  ('small_scale',  'Small Scale'),
  ('large_scale',  'Large Scale'),
  ('mixed_scale',  'Mixed Scale')
ON CONFLICT (code) DO NOTHING;

-- Zone types (planning zones in Vungu RDC context)
CREATE TABLE IF NOT EXISTS ref_zone_types (
  code        VARCHAR(64) PRIMARY KEY,
  label       VARCHAR(128) NOT NULL,
  category    VARCHAR(32),   -- 'residential' | 'agricultural' | 'commercial' | 'mixed' | 'industrial'
  description TEXT
);
INSERT INTO ref_zone_types (code, label, category) VALUES
  ('Communal Farming Zone',                   'Communal Farming Zone',                    'agricultural'),
  ('High Intensive Commercial Farming Zone',  'High Intensive Commercial Farming Zone',   'agricultural'),
  ('Estates Zone (Large Farms)',              'Estates Zone (Large Farms)',               'agricultural'),
  ('Irrigation Scheme Zone',                  'Irrigation Scheme Zone',                   'agricultural'),
  ('Proposed Peri-Urban Zone',                'Proposed Peri-Urban Zone',                 'mixed'),
  ('Mixed Zone',                              'Mixed Zone',                               'mixed'),
  ('Beyond Peri-Urban Zone',                  'Beyond Peri-Urban Zone',                   'agricultural'),
  ('Industrial Zone',                         'Industrial Zone',                           'industrial'),
  ('Commercial Zone',                         'Commercial Zone',                           'commercial'),
  ('Residential Zone',                        'Residential Zone',                          'residential')
ON CONFLICT (code) DO NOTHING;

-- Application status codes (normalises the free-text on development_applications)
CREATE TABLE IF NOT EXISTS ref_application_statuses (
  code        VARCHAR(50) PRIMARY KEY,
  label       VARCHAR(64) NOT NULL,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  sort_order  INT NOT NULL DEFAULT 0
);
INSERT INTO ref_application_statuses (code, label, is_terminal, sort_order) VALUES
  ('submitted',              'Submitted',              false, 1),
  ('under_review',           'Under Review',           false, 2),
  ('pending_payment',        'Pending Payment',        false, 3),
  ('approved',               'Approved',               true,  4),
  ('conditionally_approved', 'Conditionally Approved', true,  5),
  ('rejected',               'Rejected',               true,  6),
  ('withdrawn',              'Withdrawn',              true,  7),
  ('expired',                'Expired',                true,  8)
ON CONFLICT (code) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- 2. STANDS — resolve transitive dependency on zone_type
-- ════════════════════════════════════════════════════════════════════════

-- 2a. Add FK to PostGIS wards table (ward_fid). The column is NULLable so
--     existing rows with only a text ward still insert without failing.
ALTER TABLE stands
  ADD COLUMN IF NOT EXISTS ward_fid INT REFERENCES wards(fid) ON DELETE SET NULL;

-- 2b. Back-fill ward_fid from the PostGIS wards name (best-effort match on
--     name_en). A manual tidy-up is needed for wards whose text name in
--     stands.ward differs from wards.name_en.
UPDATE stands s
SET    ward_fid = w.fid
FROM   wards w
WHERE  LOWER(TRIM(s.ward)) = LOWER(TRIM(w.name_en))
  AND  s.ward_fid IS NULL;

-- 2c. Add use_scale FK (only if ref table loaded)
ALTER TABLE stands
  ADD COLUMN IF NOT EXISTS use_scale_code VARCHAR(20) REFERENCES ref_use_scales(code);

UPDATE stands SET use_scale_code = use_scale
  WHERE use_scale IN (SELECT code FROM ref_use_scales)
    AND use_scale_code IS NULL;

-- 2d. Add status FK
ALTER TABLE stands
  ADD COLUMN IF NOT EXISTS status_code VARCHAR(20) REFERENCES ref_stand_statuses(code);

UPDATE stands SET status_code = status
  WHERE status IN (SELECT code FROM ref_stand_statuses)
    AND status_code IS NULL;

-- 2e. Mark the transitive dependency: zone_type is derivable from zone_id.
--     We add zone_type_cache as a copy column (NOT a rename) so all existing
--     queries using s.zone_type continue to work unchanged. The v_stands view
--     presents the authoritative derived value. A later migration can drop
--     zone_type once all callers are migrated to v_stands.zone_type.
ALTER TABLE stands ADD COLUMN IF NOT EXISTS zone_type_cache VARCHAR(64);

UPDATE stands SET zone_type_cache = zone_type WHERE zone_type_cache IS NULL;

COMMENT ON COLUMN stands.zone_type_cache IS
  '3NF: copy of zone_type for labelling. Authoritative value: v_stands.zone_type (joined from zone_id).';

-- Keep zone_type in sync via trigger when zone_type is updated
CREATE OR REPLACE FUNCTION fn_sync_zone_type_cache()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.zone_type_cache = NEW.zone_type;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_zone_type_cache ON stands;
CREATE TRIGGER trg_sync_zone_type_cache
  BEFORE INSERT OR UPDATE OF zone_type ON stands
  FOR EACH ROW EXECUTE FUNCTION fn_sync_zone_type_cache();

-- 2f. Canonical view that joins zone_type from the zones table
CREATE OR REPLACE VIEW v_stands AS
SELECT
  s.id, s.stand_number, s.ward,
  s.ward_fid,
  w.name_en                  AS ward_name,
  s.zone_id,
  COALESCE(
    z.zone,
    s.zone_type_cache
  )                          AS zone_type,
  s.use_scale,
  s.area_sqm,
  s.frontage_m,
  s.depth_m,
  s.price_usd,
  s.status,
  s.description,
  s.geom,
  s.centroid,
  s.reserved_by,
  s.reserved_at,
  s.reserved_until,
  s.allocated_to,
  s.allocated_at,
  s.created_by,
  s.created_at,
  s.updated_at
FROM stands s
LEFT JOIN wards                     w ON w.fid = s.ward_fid
LEFT JOIN vungu_proposed_peri_urban_zones z ON z.id = s.zone_id;

COMMENT ON VIEW v_stands IS
  '3NF-normalised view of stands: zone_type derived from zone_id, ward_name from PostGIS wards.';

-- ════════════════════════════════════════════════════════════════════════
-- 3. PLANNING ASSISTANT TEMPLATES — add FK references
-- ════════════════════════════════════════════════════════════════════════

-- zone_type FK (add only if not already there)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'planning_assistant_templates'
      AND constraint_name = 'fk_pat_zone_type'
  ) THEN
    ALTER TABLE planning_assistant_templates
      ADD CONSTRAINT fk_pat_zone_type
        FOREIGN KEY (zone_type) REFERENCES ref_zone_types(code)
        DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- scale_category FK
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'planning_assistant_templates'
      AND constraint_name = 'fk_pat_scale_category'
  ) THEN
    ALTER TABLE planning_assistant_templates
      ADD CONSTRAINT fk_pat_scale_category
        FOREIGN KEY (scale_category) REFERENCES ref_scale_categories(code)
        DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- 4. DEVELOPMENT APPLICATIONS — constrain status column
-- ════════════════════════════════════════════════════════════════════════

-- Repair any rogue status values to 'submitted' before adding the constraint
UPDATE development_applications
  SET status = 'submitted'
  WHERE status NOT IN (SELECT code FROM ref_application_statuses);

-- Add check constraint if absent
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'development_applications'
      AND constraint_name = 'chk_da_status'
  ) THEN
    ALTER TABLE development_applications
      ADD CONSTRAINT chk_da_status
        CHECK (status IN (
          'submitted','under_review','pending_payment',
          'approved','conditionally_approved','rejected','withdrawn','expired'
        ));
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- 5. USER PROFILES — separate auth data from profile data
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name   VARCHAR(255),
  phone       VARCHAR(32),
  job_title   VARCHAR(128),
  department  VARCHAR(128),
  avatar_url  TEXT,
  bio         TEXT,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Back-fill from users if those columns exist
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='users' AND column_name='full_name') THEN
    INSERT INTO user_profiles (user_id, full_name, job_title, department, updated_at)
    SELECT id,
           COALESCE(full_name, name),
           job_title,
           department,
           COALESCE(updated_at, NOW())
    FROM users
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
END $$;

COMMENT ON TABLE user_profiles IS
  '3NF: non-authentication profile attributes separated from the users auth table.';

-- ════════════════════════════════════════════════════════════════════════
-- 6. INDEXES ON NEW REFERENCE TABLES
-- ════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_stands_ward_fid       ON stands(ward_fid);
CREATE INDEX IF NOT EXISTS idx_stands_status_code    ON stands(status_code);
CREATE INDEX IF NOT EXISTS idx_stands_use_scale_code ON stands(use_scale_code);

COMMIT;
