-- 121_environmental_health_registers.sql
-- The Environmental Health Officer's four registers, on the server and on the map.
--
-- WHY THIS EXISTS
-- The EHO console shipped with a premises register, an outbreak log, a water
-- quality register and a nuisance complaint book — all of them held in the
-- browser's localStorage, on one workstation, with no coordinates on any
-- record. Three consequences, each worse than the last:
--
--   1. The records were not the council's. They lived in one officer's browser
--      profile. Clearing site data destroyed the district's cholera log.
--   2. Nobody else could see them. An EHO's outbreak was invisible to the
--      planner circulating a permit next to it.
--   3. They could not be asked a spatial question. An outbreak recorded as the
--      free text "Ward 3" cannot be clustered, cannot be drawn, and cannot
--      answer the only question that matters in the first hour of a cholera
--      report: which water sources and which food premises are inside the
--      catchment.
--
-- That last one is the reason this migration carries geometry rather than the
-- paired NUMERIC lat/lng of migration 120. For a building complaint a position
-- is descriptive — it says where to go. For an outbreak or a failed borehole
-- the position IS the analysis: every useful question is ST_DWithin against
-- the premises register and the hydrology layers. A functional index over two
-- numeric columns would work and would be the wrong shape to read.
--
-- POSITION PROVENANCE
-- Following migration 118, a position carries where it came from and how good
-- it is. A 500 m catchment drawn around a GPS fix and one drawn around a guess
-- someone clicked on a map are different claims, and an officer deciding
-- whether to close a borehole is entitled to know which one they are looking
-- at. Every position is optional — an EHO takes a report by telephone — but a
-- recorded one always says what it is.
--
-- ANONYMITY, AGAIN
-- Migration 120 made anonymity a first-class property of a building complaint
-- because the reporter has to go on living next to the person they reported.
-- A nuisance complaint is the same street and often the same neighbour, so it
-- gets the same constraint rather than a weaker version of it.
--
-- WHAT IS DELETABLE
-- Nothing, except a premises. Outbreaks, samples and complaints are statutory
-- records of events: they are closed, never removed. The premises register is
-- master data an officer genuinely does correct (a shop captured twice), so it
-- soft-deletes and keeps its history.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS spatial_planning.health_premises_seq;
CREATE SEQUENCE IF NOT EXISTS spatial_planning.health_outbreak_seq;
CREATE SEQUENCE IF NOT EXISTS spatial_planning.health_water_sample_seq;
CREATE SEQUENCE IF NOT EXISTS spatial_planning.health_nuisance_complaint_seq;

-- ── 1. Premises register ────────────────────────────────────────────────
-- Every place the Public Health Act makes the council inspect: food handling,
-- accommodation, schools, workshops. The base layer the other three registers
-- are queried against.
CREATE TABLE IF NOT EXISTS spatial_planning.health_premises (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(24) NOT NULL UNIQUE,

  name                VARCHAR(200) NOT NULL,
  premises_type       VARCHAR(24) NOT NULL CHECK (premises_type IN (
                        'bakery', 'butchery', 'restaurant', 'tea_room', 'boarding_house',
                        'hotel', 'general_dealer', 'bottle_store', 'beerhall', 'creche',
                        'school', 'hostel', 'tuck_shop', 'supermarket', 'factory',
                        'workshop', 'nightclub', 'lodge', 'abattoir', 'other')),

  stand_number        VARCHAR(40),
  suburb_ward         VARCHAR(120),
  operator_name       VARCHAR(160),
  operator_contact    VARCHAR(40),

  -- Set when the premises is the subject of a building-control case, which is
  -- how a joint health/building inspection gets onto one file.
  permit_app_id       UUID REFERENCES spatial_planning.permit_application(id) ON DELETE SET NULL,

  fitness_certificate_no      VARCHAR(40),
  fitness_certificate_expiry  DATE,
  last_inspected_at   TIMESTAMP WITH TIME ZONE,
  notes               TEXT,

  location            geometry(Point, 4326),
  location_source     VARCHAR(20),
  location_accuracy_m NUMERIC(8, 2),

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- Soft delete: a register entry removed as a duplicate must still be
  -- explicable a year later when its inspections are audited.
  deleted_at          TIMESTAMP WITH TIME ZONE,
  deleted_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,

  CONSTRAINT health_premises_location_source_check
    CHECK (location_source IS NULL OR location_source IN
           ('field_gps', 'map_pick', 'stand_register', 'permit_site')),
  CONSTRAINT health_premises_location_accuracy_check
    CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0),
  -- Provenance without a position is a claim about nothing.
  CONSTRAINT health_premises_location_paired
    CHECK (location IS NOT NULL OR (location_source IS NULL AND location_accuracy_m IS NULL))
);

-- ── 2. Outbreak / notifiable disease log ────────────────────────────────
CREATE TABLE IF NOT EXISTS spatial_planning.health_outbreak (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(24) NOT NULL UNIQUE,

  disease             VARCHAR(20) NOT NULL CHECK (disease IN (
                        'cholera', 'typhoid', 'dysentery', 'food_poisoning',
                        'measles', 'tb', 'covid', 'other')),
  first_reported_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  suspected_source    TEXT NOT NULL,
  cases_count         INTEGER NOT NULL DEFAULT 1 CHECK (cases_count >= 1),
  ward                VARCHAR(120) NOT NULL,
  status              VARCHAR(16) NOT NULL DEFAULT 'investigating'
                        CHECK (status IN ('investigating', 'contained', 'closed')),
  actions_taken       TEXT,

  -- Where the cluster is centred, or the suspected source. Not a patient
  -- address: this register is never the place for one.
  location            geometry(Point, 4326),
  location_source     VARCHAR(20),
  location_accuracy_m NUMERIC(8, 2),
  -- The radius the officer considers the catchment. Drives the standing
  -- "what is inside this outbreak" query, so it is a recorded decision and
  -- not a number retyped into the UI each time someone looks.
  catchment_m         INTEGER CHECK (catchment_m IS NULL OR catchment_m BETWEEN 10 AND 20000),

  reported_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMP WITH TIME ZONE,
  closed_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,

  CONSTRAINT health_outbreak_location_source_check
    CHECK (location_source IS NULL OR location_source IN ('field_gps', 'map_pick', 'ward_centroid')),
  CONSTRAINT health_outbreak_location_accuracy_check
    CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0),
  CONSTRAINT health_outbreak_location_paired
    CHECK (location IS NOT NULL OR (location_source IS NULL AND location_accuracy_m IS NULL)),
  -- A closed outbreak says when. An open one never carries a closing date.
  CONSTRAINT health_outbreak_closed_dated
    CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

-- ── 3. Water quality register ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spatial_planning.health_water_sample (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(24) NOT NULL UNIQUE,

  source_label        VARCHAR(200) NOT NULL,
  source_type         VARCHAR(20) CHECK (source_type IS NULL OR source_type IN (
                        'borehole', 'piped_supply', 'reservoir', 'well',
                        'river', 'dam', 'spring', 'other')),
  sampled_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- CFU per 100 ml; mg/L for chlorine. NULL means not tested, which is not
  -- the same as zero and must never be rendered as a pass.
  ecoli_count         INTEGER CHECK (ecoli_count IS NULL OR ecoli_count >= 0),
  faecal_coliform     INTEGER CHECK (faecal_coliform IS NULL OR faecal_coliform >= 0),
  free_chlorine       NUMERIC(6, 3) CHECK (free_chlorine IS NULL OR free_chlorine >= 0),
  ph                  NUMERIC(4, 2) CHECK (ph IS NULL OR ph BETWEEN 0 AND 14),

  result              VARCHAR(16) NOT NULL DEFAULT 'pending'
                        CHECK (result IN ('potable', 'not_potable', 'borderline', 'pending')),
  actions_taken       TEXT,

  location            geometry(Point, 4326),
  location_source     VARCHAR(20),
  location_accuracy_m NUMERIC(8, 2),

  sampled_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT health_water_sample_location_source_check
    CHECK (location_source IS NULL OR location_source IN ('field_gps', 'map_pick')),
  CONSTRAINT health_water_sample_location_accuracy_check
    CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0),
  CONSTRAINT health_water_sample_location_paired
    CHECK (location IS NOT NULL OR (location_source IS NULL AND location_accuracy_m IS NULL))
);

-- ── 4. Nuisance / public-health complaint register ──────────────────────
CREATE TABLE IF NOT EXISTS spatial_planning.health_nuisance_complaint (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(24) NOT NULL UNIQUE,

  category            VARCHAR(16) NOT NULL CHECK (category IN (
                        'smell', 'smoke', 'noise', 'vermin', 'waste', 'water', 'other')),
  description         TEXT NOT NULL,
  status              VARCHAR(16) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'investigating', 'abated', 'closed')),

  premises_id         UUID REFERENCES spatial_planning.health_premises(id) ON DELETE SET NULL,
  stand_number        VARCHAR(40),
  suburb_ward         VARCHAR(120),
  location_note       TEXT,

  complainant_name    VARCHAR(160),
  complainant_contact VARCHAR(40),
  anonymous           BOOLEAN NOT NULL DEFAULT FALSE,

  abatement_notice_ref VARCHAR(40),

  location            geometry(Point, 4326),
  location_source     VARCHAR(20),
  location_accuracy_m NUMERIC(8, 2),

  received_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  received_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMP WITH TIME ZONE,
  closed_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,

  CONSTRAINT health_complaint_location_source_check
    CHECK (location_source IS NULL OR location_source IN
           ('field_gps', 'map_pick', 'premises', 'stand_register')),
  CONSTRAINT health_complaint_location_accuracy_check
    CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0),
  CONSTRAINT health_complaint_location_paired
    CHECK (location IS NOT NULL OR (location_source IS NULL AND location_accuracy_m IS NULL)),
  -- Migration 120's rule, for the same reason: the council promised anonymity,
  -- so the column that would break it cannot hold anything.
  CONSTRAINT health_complaint_anonymity_kept
    CHECK (NOT anonymous OR (complainant_name IS NULL AND complainant_contact IS NULL)),
  CONSTRAINT health_complaint_closed_dated
    CHECK (status NOT IN ('abated', 'closed') OR closed_at IS NOT NULL)
);

-- ── Spatial indexes ─────────────────────────────────────────────────────
-- Every register is asked "what is within N metres of this point", so each
-- geometry column is indexed. Without these the catchment query degrades to a
-- sequential scan the moment the premises register grows past a demo.
CREATE INDEX IF NOT EXISTS idx_health_premises_location
  ON spatial_planning.health_premises USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_health_outbreak_location
  ON spatial_planning.health_outbreak USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_health_water_sample_location
  ON spatial_planning.health_water_sample USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_health_complaint_location
  ON spatial_planning.health_nuisance_complaint USING GIST (location);

-- ── Working indexes ─────────────────────────────────────────────────────
-- The live register excludes soft-deleted rows on every read, so the partial
-- index is the one that is actually used.
CREATE INDEX IF NOT EXISTS idx_health_premises_live
  ON spatial_planning.health_premises(premises_type, suburb_ward)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_health_premises_stand
  ON spatial_planning.health_premises(upper(btrim(stand_number)))
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_health_premises_permit
  ON spatial_planning.health_premises(permit_app_id);
-- Inspection-due sweep: oldest first, never-inspected first of all.
CREATE INDEX IF NOT EXISTS idx_health_premises_due
  ON spatial_planning.health_premises(last_inspected_at NULLS FIRST)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_health_outbreak_open
  ON spatial_planning.health_outbreak(status, first_reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_water_sample_recent
  ON spatial_planning.health_water_sample(sampled_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_water_sample_failing
  ON spatial_planning.health_water_sample(result, sampled_at DESC)
  WHERE result IN ('not_potable', 'borderline');
CREATE INDEX IF NOT EXISTS idx_health_complaint_queue
  ON spatial_planning.health_nuisance_complaint(status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_complaint_premises
  ON spatial_planning.health_nuisance_complaint(premises_id);

-- ── Documentation ───────────────────────────────────────────────────────
COMMENT ON TABLE spatial_planning.health_premises IS
  'Premises the Public Health Act requires the council to inspect. Soft-deletes; the base layer for EHO spatial queries.';
COMMENT ON TABLE spatial_planning.health_outbreak IS
  'Notifiable disease outbreak log. location is the cluster centre or suspected source, never a patient address.';
COMMENT ON TABLE spatial_planning.health_water_sample IS
  'Water quality register. A NULL count means not tested, which is not a pass.';
COMMENT ON TABLE spatial_planning.health_nuisance_complaint IS
  'Nuisance and public-health complaints. Anonymous reports are first-class and carry no contact details.';

COMMENT ON COLUMN spatial_planning.health_outbreak.catchment_m IS
  'Officer-recorded catchment radius in metres; drives the "what is inside this outbreak" query.';
COMMENT ON COLUMN spatial_planning.health_premises.location_source IS
  'Where the position came from. A map_pick is a guess and must not be read as a survey.';

COMMIT;
