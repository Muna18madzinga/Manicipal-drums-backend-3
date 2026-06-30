-- 084_property_register.sql
-- ────────────────────────────────────────────────────────────────────────
-- Parcel-centric Property File / land register (the TownSuite-style gap):
-- a permanent record per stand with owners, zoning-designation history,
-- existing uses, assessment/rates linkage and subdivision/consolidation
-- lineage. Keyed by stand_number (text) — stand identifiers vary across the
-- spatial sources, so no hard FK to a single parcel table.
-- Idempotent: CREATE … IF NOT EXISTS.
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS spatial_planning.property (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stand_number  VARCHAR(60) NOT NULL UNIQUE,
  suburb_ward   VARCHAR(120),
  street_address TEXT,
  aan           VARCHAR(40),     -- assessment account number
  pid           VARCHAR(40),     -- property id
  area_sqm      NUMERIC(12,2),
  frontage_m    NUMERIC(10,2),
  units         INTEGER,
  dwellings     INTEGER,
  corner_lot    BOOLEAN NOT NULL DEFAULT false,
  dev_agreement BOOLEAN NOT NULL DEFAULT false,
  follow_up_date DATE,
  heritage_conservation_district BOOLEAN NOT NULL DEFAULT false,
  heritage_municipal             BOOLEAN NOT NULL DEFAULT false,
  heritage_national              BOOLEAN NOT NULL DEFAULT false,
  heritage_notes TEXT,
  created_by    UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_property_stand ON spatial_planning.property(stand_number);

CREATE TABLE IF NOT EXISTS spatial_planning.parcel_owner (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES spatial_planning.property(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  company      VARCHAR(255),
  role         VARCHAR(20) NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'occupier', 'agent')),
  postal_address TEXT,
  phone        VARCHAR(40),
  email        VARCHAR(255),
  since        DATE,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parcel_owner_property ON spatial_planning.parcel_owner(property_id);

CREATE TABLE IF NOT EXISTS spatial_planning.zoning_designation (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID NOT NULL REFERENCES spatial_planning.property(id) ON DELETE CASCADE,
  designation    VARCHAR(80) NOT NULL,
  effective_date DATE,
  notes          TEXT,
  reference      VARCHAR(120),
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zoning_designation_property ON spatial_planning.zoning_designation(property_id);

CREATE TABLE IF NOT EXISTS spatial_planning.existing_use (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES spatial_planning.property(id) ON DELETE CASCADE,
  land_use    VARCHAR(120) NOT NULL,   -- "use" is awkward; exposed as `use` by the API
  recorded_at DATE,
  notes       TEXT,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_existing_use_property ON spatial_planning.existing_use(property_id);

CREATE TABLE IF NOT EXISTS spatial_planning.property_assessment (
  property_id    UUID PRIMARY KEY REFERENCES spatial_planning.property(id) ON DELETE CASCADE,
  aan            VARCHAR(40),
  roll_number    VARCHAR(40),
  valuation      NUMERIC(14,2),
  rateable_value NUMERIC(14,2),
  rates_balance  NUMERIC(14,2),
  last_paid_at   DATE,
  updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spatial_planning.parcel_lineage (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_property_id UUID NOT NULL REFERENCES spatial_planning.property(id) ON DELETE CASCADE,
  child_property_id  UUID NOT NULL REFERENCES spatial_planning.property(id) ON DELETE CASCADE,
  action             VARCHAR(20) NOT NULL CHECK (action IN ('subdivision', 'consolidation')),
  created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (parent_property_id, child_property_id)
);
CREATE INDEX IF NOT EXISTS idx_parcel_lineage_parent ON spatial_planning.parcel_lineage(parent_property_id);
CREATE INDEX IF NOT EXISTS idx_parcel_lineage_child  ON spatial_planning.parcel_lineage(child_property_id);

COMMENT ON TABLE spatial_planning.property IS
  'Parcel-centric land register: permanent property record keyed by stand_number.';
