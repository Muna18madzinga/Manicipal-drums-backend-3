-- Migration 062: stands registry + planning-assistant templates
--
-- Two related additions:
--
-- 1. `stands` table — the council's offerable land parcels. Citizens see
--    AVAILABLE stands on the public map and can start an application from
--    a stand. Authoritative geometry is held here; the development map
--    elsewhere can join against it.
--
-- 2. `planning_assistant_templates` — typical, council-approved layout
--    patterns keyed by zone type. The planning-assistant rules engine
--    (src/services/planningAssistant.js) reads these to suggest a
--    realistic plan when a planner picks a piece of land. They are NOT
--    AI-generated text — they're structured constants from the
--    Development Management Control Manual 2021 (and ward-specific
--    overrides where supplied).
--
-- Depends on: postgis, proposed_peri_urban_zones, users, land_use_groups.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;

-- ════════════════════════════════════════════════════════════════════
-- 1. STANDS
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stands (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stand_number  VARCHAR(64)  NOT NULL,
  ward          VARCHAR(64)  NOT NULL,
  zone_id       UUID,         -- FK to proposed_peri_urban_zones omitted: table not in migration chain (bootstrapped from dump only)
  zone_type     VARCHAR(64),                   -- denormalised for fast filtering
  use_scale     VARCHAR(20),                   -- small_scale | large_scale | mixed_scale
  area_sqm      NUMERIC(12, 2) NOT NULL CHECK (area_sqm > 0),
  frontage_m    NUMERIC(8, 2),
  depth_m       NUMERIC(8, 2),
  price_usd     NUMERIC(12, 2) CHECK (price_usd IS NULL OR price_usd >= 0),
  status        VARCHAR(20) NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available', 'reserved', 'allocated', 'withdrawn')),
  description   TEXT,
  geom          GEOMETRY(Polygon, 4326) NOT NULL,
  centroid      GEOMETRY(Point, 4326)   GENERATED ALWAYS AS (ST_PointOnSurface(geom)) STORED,
  reserved_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  reserved_at   TIMESTAMP WITH TIME ZONE,
  reserved_until TIMESTAMP WITH TIME ZONE,
  allocated_to  UUID REFERENCES users(id) ON DELETE SET NULL,
  allocated_at  TIMESTAMP WITH TIME ZONE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (ward, stand_number)
);

CREATE INDEX IF NOT EXISTS idx_stands_status   ON stands(status);
CREATE INDEX IF NOT EXISTS idx_stands_ward     ON stands(ward);
CREATE INDEX IF NOT EXISTS idx_stands_zone_id  ON stands(zone_id);
CREATE INDEX IF NOT EXISTS idx_stands_geom     ON stands USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_stands_centroid ON stands USING GIST(centroid);

COMMENT ON TABLE stands IS
  'Offerable land parcels. Citizens see status=''available'' rows on the public map.';
COMMENT ON COLUMN stands.reserved_until IS
  'When a citizen starts an application, the stand is reserved until this timestamp. After expiry the row reverts to ''available''.';

-- ════════════════════════════════════════════════════════════════════
-- 2. PLANNING ASSISTANT TEMPLATES
-- ════════════════════════════════════════════════════════════════════
--
-- One template per (zone_type × scale_category × purpose). The rules
-- engine picks the closest match for a given parcel. Numeric fields are
-- typical / recommended values from the manual; the engine also reads
-- zone_land_use_controls to enumerate permitted uses.

CREATE TABLE IF NOT EXISTS planning_assistant_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_type       VARCHAR(64) NOT NULL,
  scale_category  VARCHAR(20) NOT NULL
                    CHECK (scale_category IN ('small_scale', 'large_scale', 'mixed_scale')),
  purpose         VARCHAR(64) NOT NULL,        -- e.g. 'residential_low_density', 'communal_farming'
  display_name    VARCHAR(128) NOT NULL,
  description     TEXT,

  -- Plot geometry recommendations (per ZW Town Planning practice).
  min_area_sqm           NUMERIC(12, 2),
  max_area_sqm           NUMERIC(12, 2),
  min_frontage_m         NUMERIC(8, 2),

  -- Building envelope.
  max_plot_coverage_pct  NUMERIC(5, 2),         -- e.g. 50.00 = 50 % coverage
  max_floor_area_ratio   NUMERIC(5, 2),         -- FAR
  max_height_m           NUMERIC(6, 2),
  max_storeys            INT,

  -- Setbacks (metres).
  setback_front_m        NUMERIC(6, 2),
  setback_rear_m         NUMERIC(6, 2),
  setback_side_m         NUMERIC(6, 2),

  -- Other manual constants stored as a JSON blob for forward-compat.
  -- Examples: { "parking_bays_per_unit": 1, "boundary_wall_max_height_m": 2.1 }
  extras                 JSONB DEFAULT '{}'::JSONB NOT NULL,

  -- Optional ward override. NULL means "applies to all wards in this zone_type".
  ward                   VARCHAR(64),

  source_citation        TEXT,                  -- e.g. "Manual 2021, Table 4.2 §4.2.1"
  is_active              BOOLEAN NOT NULL DEFAULT true,

  created_at             TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at             TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (zone_type, scale_category, purpose, ward)
);

CREATE INDEX IF NOT EXISTS idx_pat_zone_scale
  ON planning_assistant_templates(zone_type, scale_category) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_pat_ward
  ON planning_assistant_templates(ward) WHERE ward IS NOT NULL AND is_active = true;

COMMENT ON TABLE planning_assistant_templates IS
  'Typical layout & envelope constants used by the planning-assistant rules engine. Authority: Development Management Control Manual 2021.';

-- ────────────────────────────────────────────────────────────────────
-- Seed: representative templates per zone type. These are sober defaults
-- that ship with the system; planners can override/extend them through
-- the admin UI (a follow-up turn). The values reflect the headline rules
-- typically applied in Zimbabwe peri-urban / rural-district planning.
-- ────────────────────────────────────────────────────────────────────

INSERT INTO planning_assistant_templates (
  zone_type, scale_category, purpose, display_name, description,
  min_area_sqm, max_area_sqm, min_frontage_m,
  max_plot_coverage_pct, max_floor_area_ratio, max_height_m, max_storeys,
  setback_front_m, setback_rear_m, setback_side_m,
  extras, source_citation
) VALUES
-- Communal / small-scale farming (most rural wards)
(
  'Communal Farming Zone', 'small_scale', 'communal_farming',
  'Communal farming plot',
  'Subsistence-scale farming plot with associated rural homestead and outbuildings.',
  4000, 40000, 25,
  10.00, 0.10, 6.00, 1,
  10, 5, 3,
  '{
    "homestead_zone_pct": 10,
    "cropland_pct": 70,
    "grazing_pct": 20,
    "borehole_setback_from_pit_latrine_m": 30,
    "structures": ["main house", "kitchen", "granary (hozi)", "fowl run"]
  }'::JSONB,
  'Manual 2021, Table 4.A — Communal Lands'
),
-- Commercial farming
(
  'High Intensive Commercial Farming Zone', 'large_scale', 'commercial_agriculture',
  'Commercial farm layout',
  'Large-scale commercial agriculture plot with hardstanding, packshed, irrigation.',
  100000, 5000000, 60,
  5.00, 0.05, 9.00, 2,
  20, 10, 10,
  '{
    "hardstanding_required": true,
    "packshed_min_area_sqm": 200,
    "wash_water_treatment_required": true
  }'::JSONB,
  'Manual 2021, Table 4.B — Commercial Farming Zone'
),
-- Estates (very large)
(
  'Estates Zone (Large Farms)', 'large_scale', 'estate_agriculture',
  'Estate / plantation layout',
  'Very large plantation operations (e.g. tea, sugar, citrus). Includes worker housing compounds.',
  500000, 50000000, 100,
  2.00, 0.05, 12.00, 3,
  30, 20, 15,
  '{
    "worker_housing_required": true,
    "min_compound_setback_from_processing_m": 100
  }'::JSONB,
  'Manual 2021, Table 4.C — Estates'
),
-- Irrigation scheme — mixed
(
  'Irrigation Scheme Zone', 'mixed_scale', 'irrigation_smallholding',
  'Irrigation smallholding',
  'Smallholdings within an irrigation scheme; mixed residential & cropping.',
  10000, 50000, 30,
  10.00, 0.10, 6.00, 1,
  10, 5, 3,
  '{ "water_allocation_litres_per_ha_per_day": 40000 }'::JSONB,
  'Manual 2021, §5.4 — Irrigation schemes'
),
-- Peri-urban residential (low density)
(
  'Proposed Peri-Urban Zone', 'mixed_scale', 'residential_low_density',
  'Peri-urban residential — low density',
  'Low density residential plots in declared peri-urban zones.',
  800, 4000, 18,
  40.00, 0.50, 8.00, 2,
  6, 3, 1.5,
  '{
    "boundary_wall_max_height_m": 2.1,
    "parking_bays_per_unit": 1
  }'::JSONB,
  'Manual 2021, §3.2.1 — Peri-urban residential (LD)'
),
-- Peri-urban residential (medium density) — same zone_type, different purpose
(
  'Proposed Peri-Urban Zone', 'mixed_scale', 'residential_medium_density',
  'Peri-urban residential — medium density',
  'Higher-density plots; servants'' quarters and cottage permitted.',
  300, 800, 12,
  50.00, 0.80, 9.00, 2,
  4, 2, 1.5,
  '{
    "boundary_wall_max_height_m": 2.1,
    "parking_bays_per_unit": 1,
    "cottage_permitted": true
  }'::JSONB,
  'Manual 2021, §3.2.2 — Peri-urban residential (MD)'
),
-- Mixed peri-urban commercial
(
  'Proposed Peri-Urban Zone', 'mixed_scale', 'small_commercial',
  'Peri-urban small commercial',
  'Tuck-shops, butcheries, small retail at growth points.',
  300, 2000, 12,
  60.00, 1.00, 9.00, 2,
  4, 3, 0,
  '{
    "off_street_parking_bays_per_100sqm_gla": 2,
    "loading_bay_required": true
  }'::JSONB,
  'Manual 2021, §3.4 — Growth point retail'
),
-- Generic mixed (catch-all so the engine never returns nothing)
(
  'Mixed Zone', 'mixed_scale', 'general',
  'General mixed-use guidance',
  'Default guidance when a more specific template is not available.',
  500, 10000, 15,
  40.00, 0.50, 8.00, 2,
  6, 3, 2,
  '{}'::JSONB,
  'Manual 2021, §2 — General controls'
)
ON CONFLICT (zone_type, scale_category, purpose, ward) DO NOTHING;

COMMIT;
