-- Migration 070: Zimbabwe Development Management (Control) Handbook 2021 — v1.2
--
-- Implements the five-phase Development Management lifecycle:
--   Phase 1  Application Registration & Processing
--   Phase 2  Enforcement Orders & Prohibition Orders
--   Phase 3  Building Plan Appraisal
--   Phase 4  Stage Inspections (9 stages, Annexure 12/14)
--   Phase 5  Certificate of Occupation
--
-- All tables live in the `spatial_planning` schema so they don't
-- collide with the existing public-schema tables (development_applications,
-- inspection_bookings, plan_reviews, etc.) which power the citizen portal.
--
-- FK conventions:
--   dev_app_id  → public.development_applications.id  (VARCHAR 20)
--   created_by  → public.users.id  (UUID)
--
-- Depends on: migration 042 (development_applications), 063 (inspection_bookings),
--             064 (citizen_documents), 065 (plan_reviews), PostGIS.
-- Apply with: psql -d <dbname> -f migrations/070_development_management_handbook_v1_2.sql

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- SCHEMA
-- ════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS spatial_planning;

-- ════════════════════════════════════════════════════════════════════
-- PHASE 1 — APPLICATION REGISTRATION & PROCESSING
-- ════════════════════════════════════════════════════════════════════

-- 1.1  Formal permit application record.
--      Extends the citizen portal's development_applications with
--      statutory fields: TPD reference, Development Register number,
--      stand details, and full DM Handbook 2021 workflow status.

CREATE TABLE IF NOT EXISTS spatial_planning.permit_application (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link to the citizen-portal application (optional for staff-captured apps).
  dev_app_id          VARCHAR(20) REFERENCES public.development_applications(id) ON DELETE SET NULL,

  -- Statutory identifiers (assigned by the Town Planning Directorate).
  tpd_reference       VARCHAR(40) UNIQUE,        -- e.g. TPD/HRE/2024/0001
  dev_register_no     VARCHAR(40),               -- Development Register entry

  -- Stand / site.
  stand_number        VARCHAR(40),
  suburb_ward         VARCHAR(80),
  street_address      TEXT,
  stand_area_sqm      NUMERIC(12,2),
  -- Centroid for map pinning. SRID 4326.
  location            GEOMETRY(Point, 4326),

  -- Applicant (denormalised snapshot at submission).
  applicant_name      VARCHAR(255) NOT NULL,
  applicant_id_number VARCHAR(40),
  applicant_phone     VARCHAR(32),
  applicant_email     VARCHAR(255),

  -- Application details.
  development_type    VARCHAR(60) NOT NULL
                        CHECK (development_type IN (
                          'new_building',
                          'alteration',
                          'extension',
                          'change_of_use',
                          'subdivision',
                          'consolidation',
                          'rezoning',
                          'other'
                        )),
  description         TEXT,
  site_plan_url       TEXT,

  -- Lifecycle.
  status              VARCHAR(30) NOT NULL DEFAULT 'registered'
                        CHECK (status IN (
                          'registered',
                          'acknowledged',
                          'circulation',
                          'objection_period',
                          'under_review',
                          'deferred',
                          'approved',
                          'approved_with_conditions',
                          'refused',
                          'withdrawn',
                          'appealed'
                        )),

  received_at         DATE NOT NULL DEFAULT CURRENT_DATE,
  acknowledged_at     DATE,
  decision_at         DATE,
  decision_conditions TEXT,
  decision_officer    UUID REFERENCES public.users(id) ON DELETE SET NULL,

  created_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_permit_app_dev_app
  ON spatial_planning.permit_application(dev_app_id);
CREATE INDEX IF NOT EXISTS idx_permit_app_status
  ON spatial_planning.permit_application(status);
CREATE INDEX IF NOT EXISTS idx_permit_app_tpd
  ON spatial_planning.permit_application(tpd_reference);
CREATE INDEX IF NOT EXISTS idx_permit_app_location
  ON spatial_planning.permit_application USING GIST(location)
  WHERE location IS NOT NULL;

COMMENT ON TABLE spatial_planning.permit_application IS
  'Statutory permit application with TPD reference and DM Handbook 2021 workflow.';

-- ────────────────────────────────────────────────────────────────────
-- 1.2  Statutory consultation.
--      Planner circulates the application to statutory bodies
--      (water, roads, fire, etc.) and records responses.

CREATE TABLE IF NOT EXISTS spatial_planning.application_consultation (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id       UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  body_name           VARCHAR(120) NOT NULL,
  body_type           VARCHAR(40)
                        CHECK (body_type IN (
                          'water_authority',
                          'roads_authority',
                          'environmental_agency',
                          'fire_brigade',
                          'electricity_utility',
                          'heritage_office',
                          'rural_district_council',
                          'military_authority',
                          'other'
                        )),
  contact_name        VARCHAR(120),
  contact_email       VARCHAR(255),

  circulated_at       DATE,
  response_due_at     DATE,

  response_status     VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (response_status IN (
                          'pending',
                          'no_objection',
                          'objection',
                          'conditional_approval',
                          'no_response'
                        )),
  response_received_at DATE,
  response_notes      TEXT,
  response_document_url TEXT,

  created_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consultation_permit_app
  ON spatial_planning.application_consultation(permit_app_id);
CREATE INDEX IF NOT EXISTS idx_consultation_status
  ON spatial_planning.application_consultation(response_status);

-- ────────────────────────────────────────────────────────────────────
-- 1.3  Public objections.
--      Received during the 30-day objection period (UDC Act).

CREATE TABLE IF NOT EXISTS spatial_planning.application_objection (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id       UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  objector_name       VARCHAR(255) NOT NULL,
  objector_address    TEXT,
  objector_id_number  VARCHAR(40),

  -- Grounds: JSONB array of codes e.g. ["traffic_impact","noise","privacy"]
  grounds             JSONB NOT NULL DEFAULT '[]'::JSONB,
  grounds_detail      TEXT,

  received_at         DATE NOT NULL DEFAULT CURRENT_DATE,
  document_url        TEXT,

  -- Planner consideration.
  consideration_notes TEXT,
  sustained           BOOLEAN,                   -- null = not yet considered
  considered_at       DATE,
  considered_by       UUID REFERENCES public.users(id) ON DELETE SET NULL,

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_objection_permit_app
  ON spatial_planning.application_objection(permit_app_id);

-- ────────────────────────────────────────────────────────────────────
-- 1.4  Appeals.
--      Applicant or objector may appeal to Administrative Court within 30 days.

CREATE TABLE IF NOT EXISTS spatial_planning.application_appeal (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id       UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  appellant_type      VARCHAR(20) NOT NULL
                        CHECK (appellant_type IN ('applicant', 'objector', 'third_party')),
  appellant_name      VARCHAR(255) NOT NULL,
  appellant_address   TEXT,
  appeal_grounds      TEXT NOT NULL,
  lodged_at           DATE NOT NULL DEFAULT CURRENT_DATE,
  document_url        TEXT,

  status              VARCHAR(20) NOT NULL DEFAULT 'lodged'
                        CHECK (status IN (
                          'lodged',
                          'acknowledged',
                          'hearing_scheduled',
                          'decided',
                          'withdrawn'
                        )),
  hearing_date        DATE,
  decision            VARCHAR(20)
                        CHECK (decision IN ('upheld', 'dismissed', 'remitted')),
  decision_notes      TEXT,
  decided_at          DATE,

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appeal_permit_app
  ON spatial_planning.application_appeal(permit_app_id);

-- ════════════════════════════════════════════════════════════════════
-- PHASE 2 — ENFORCEMENT ORDERS & PROHIBITION ORDERS
-- ════════════════════════════════════════════════════════════════════

-- 2.1  Enforcement order (Section 34 UDC Act).

CREATE TABLE IF NOT EXISTS spatial_planning.enforcement_order (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id       UUID REFERENCES spatial_planning.permit_application(id) ON DELETE SET NULL,

  order_reference     VARCHAR(40) UNIQUE,        -- e.g. ENF/HRE/2024/0042
  order_type          VARCHAR(30) NOT NULL
                        CHECK (order_type IN (
                          'enforcement_notice',
                          'stop_notice',
                          'breach_of_condition',
                          'retrospective_consent',
                          'reinstatement'
                        )),

  subject_name        VARCHAR(255) NOT NULL,
  subject_address     TEXT NOT NULL,
  stand_number        VARCHAR(40),
  location            GEOMETRY(Point, 4326),

  breach_description  TEXT NOT NULL,
  required_action     TEXT NOT NULL,
  compliance_period   INT  NOT NULL DEFAULT 30,  -- days

  issued_at           DATE NOT NULL DEFAULT CURRENT_DATE,
  compliance_due_at   DATE,
  served_at           DATE,

  status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN (
                          'draft',
                          'issued',
                          'served',
                          'complied',
                          'non_complied',
                          'withdrawn',
                          'appealed'
                        )),

  notes               TEXT,
  issued_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enforcement_order_status
  ON spatial_planning.enforcement_order(status);
CREATE INDEX IF NOT EXISTS idx_enforcement_order_permit_app
  ON spatial_planning.enforcement_order(permit_app_id);
CREATE INDEX IF NOT EXISTS idx_enforcement_order_location
  ON spatial_planning.enforcement_order USING GIST(location)
  WHERE location IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- 2.2  Prohibition order / Stop Works Notice (Section 36 UDC Act).

CREATE TABLE IF NOT EXISTS spatial_planning.prohibition_order (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enforcement_order_id  UUID REFERENCES spatial_planning.enforcement_order(id) ON DELETE SET NULL,

  order_reference       VARCHAR(40) UNIQUE,      -- e.g. PROH/HRE/2024/0011
  subject_name          VARCHAR(255) NOT NULL,
  subject_address       TEXT NOT NULL,
  stand_number          VARCHAR(40),
  location              GEOMETRY(Point, 4326),

  prohibited_activity   TEXT NOT NULL,
  reason                TEXT NOT NULL,

  issued_at             DATE NOT NULL DEFAULT CURRENT_DATE,
  served_at             DATE,
  lifted_at             DATE,

  status                VARCHAR(20) NOT NULL DEFAULT 'issued'
                          CHECK (status IN (
                            'issued',
                            'served',
                            'challenged',
                            'confirmed',
                            'lifted',
                            'withdrawn'
                          )),

  issued_by             UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prohibition_order_status
  ON spatial_planning.prohibition_order(status);
CREATE INDEX IF NOT EXISTS idx_prohibition_order_location
  ON spatial_planning.prohibition_order USING GIST(location)
  WHERE location IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
-- 2.3  Enforcement compliance check.
--      Inspector site visits to verify the required action has been taken.

CREATE TABLE IF NOT EXISTS spatial_planning.enforcement_compliance_check (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enforcement_order_id  UUID NOT NULL REFERENCES spatial_planning.enforcement_order(id) ON DELETE CASCADE,

  visited_at            DATE NOT NULL,
  complied              BOOLEAN,
  notes                 TEXT,
  photo_urls            JSONB NOT NULL DEFAULT '[]'::JSONB,

  inspector_id          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_check_order
  ON spatial_planning.enforcement_compliance_check(enforcement_order_id);

-- ════════════════════════════════════════════════════════════════════
-- PHASE 3 — BUILDING PLAN APPRAISAL
-- ════════════════════════════════════════════════════════════════════

-- 3.1  Building plan submission.
--      A permit_application may have one or more revisions, each
--      appraised by a plans examiner / building inspector.

CREATE TABLE IF NOT EXISTS spatial_planning.building_plan (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id         UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  revision              INT NOT NULL DEFAULT 1,
  revision_label        VARCHAR(20),             -- e.g. 'Rev A'

  plan_document_url     TEXT NOT NULL,
  site_plan_url         TEXT,
  structural_drawings_url TEXT,
  services_drawings_url   TEXT,

  architect_name        VARCHAR(120),
  architect_reg_no      VARCHAR(40),             -- ZIBACE registration
  engineer_name         VARCHAR(120),
  engineer_reg_no       VARCHAR(40),             -- ZICSM registration
  gross_floor_area_sqm  NUMERIC(10,2),
  number_of_storeys     INT,
  building_use          VARCHAR(60),

  submitted_at          DATE NOT NULL DEFAULT CURRENT_DATE,

  status                VARCHAR(30) NOT NULL DEFAULT 'submitted'
                          CHECK (status IN (
                            'submitted',
                            'under_appraisal',
                            'approved',
                            'approved_with_amendments',
                            'rejected',
                            'resubmitted'
                          )),
  appraised_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  appraised_at          DATE,
  appraisal_notes       TEXT,

  created_by            UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  UNIQUE (permit_app_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_building_plan_permit_app
  ON spatial_planning.building_plan(permit_app_id);
CREATE INDEX IF NOT EXISTS idx_building_plan_status
  ON spatial_planning.building_plan(status);

-- ────────────────────────────────────────────────────────────────────
-- 3.2  Building plan annotation (plans-examiner mark-up).

CREATE TABLE IF NOT EXISTS spatial_planning.building_plan_annotation (
  id               BIGSERIAL PRIMARY KEY,
  building_plan_id UUID NOT NULL REFERENCES spatial_planning.building_plan(id) ON DELETE CASCADE,

  page_number      INT,
  severity         VARCHAR(8) NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  code             VARCHAR(40),
  message          TEXT NOT NULL,
  -- Bounding box on page: {x0, y0, x1, y1} as fractions [0,1].
  bbox             JSONB,
  resolved         BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at      TIMESTAMP WITH TIME ZONE,

  created_by       UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_annotation_plan
  ON spatial_planning.building_plan_annotation(building_plan_id);

-- ════════════════════════════════════════════════════════════════════
-- PHASE 4 — STAGE INSPECTIONS
-- Annexure 12 (stamp) and Annexure 14 (checklist) — Manual 2021.
-- ════════════════════════════════════════════════════════════════════

-- 4.1  Inspection stage catalogue (lookup — 9 rows seeded below).

CREATE TABLE IF NOT EXISTS spatial_planning.inspection_stage (
  stage_number   INT PRIMARY KEY,
  stage_name     VARCHAR(80) NOT NULL,
  description    TEXT,
  prerequisites  INT[] NOT NULL DEFAULT '{}'::INT[],
  sort_order     INT NOT NULL DEFAULT 0
);

-- 4.2  Checklist category (lookup — 8 rows seeded below).

CREATE TABLE IF NOT EXISTS spatial_planning.checklist_category (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(20) UNIQUE NOT NULL,
  label      VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
);

-- 4.3  Checklist item (lookup — 38 rows seeded below).

CREATE TABLE IF NOT EXISTS spatial_planning.checklist_item (
  id               SERIAL PRIMARY KEY,
  category_id      INT NOT NULL REFERENCES spatial_planning.checklist_category(id),
  applicable_stages INT[] NOT NULL,
  code             VARCHAR(20) UNIQUE NOT NULL,
  description      TEXT NOT NULL,
  is_mandatory     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_checklist_item_category
  ON spatial_planning.checklist_item(category_id);

-- 4.4  Stage inspection record.
--      One row per (permit_app, stage, attempt).

CREATE TABLE IF NOT EXISTS spatial_planning.stage_inspection (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id    UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,
  building_plan_id UUID REFERENCES spatial_planning.building_plan(id) ON DELETE SET NULL,

  stage_number     INT NOT NULL REFERENCES spatial_planning.inspection_stage(stage_number),
  attempt          INT NOT NULL DEFAULT 1,

  inspector_id     UUID REFERENCES public.users(id) ON DELETE SET NULL,

  scheduled_at     TIMESTAMP WITH TIME ZONE,
  inspected_at     TIMESTAMP WITH TIME ZONE,

  -- Annexure 12 stamp fields.
  stamp_reference   VARCHAR(40),                 -- e.g. VI/HRE/2024/Stage3/0007
  weather_conditions VARCHAR(60),
  site_ready        BOOLEAN,

  result            VARCHAR(25)
                      CHECK (result IN (
                        'pass',
                        'fail',
                        'conditional_pass',
                        'reinspection_required'
                      )),
  result_notes      TEXT,
  photo_urls        JSONB NOT NULL DEFAULT '[]'::JSONB,
  signature_url     TEXT,

  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  UNIQUE (permit_app_id, stage_number, attempt)
);

CREATE INDEX IF NOT EXISTS idx_stage_inspection_permit_app
  ON spatial_planning.stage_inspection(permit_app_id);
CREATE INDEX IF NOT EXISTS idx_stage_inspection_inspector
  ON spatial_planning.stage_inspection(inspector_id);
CREATE INDEX IF NOT EXISTS idx_stage_inspection_stage
  ON spatial_planning.stage_inspection(stage_number);

-- ────────────────────────────────────────────────────────────────────
-- 4.5  Inspection checklist result (Annexure 14).
--      One row per (stage_inspection × checklist_item).

CREATE TABLE IF NOT EXISTS spatial_planning.inspection_checklist_result (
  id                  BIGSERIAL PRIMARY KEY,
  stage_inspection_id UUID NOT NULL REFERENCES spatial_planning.stage_inspection(id) ON DELETE CASCADE,
  checklist_item_id   INT  NOT NULL REFERENCES spatial_planning.checklist_item(id),

  result              VARCHAR(10) NOT NULL CHECK (result IN ('pass', 'fail', 'na')),
  notes               TEXT,

  UNIQUE (stage_inspection_id, checklist_item_id)
);

CREATE INDEX IF NOT EXISTS idx_checklist_result_inspection
  ON spatial_planning.inspection_checklist_result(stage_inspection_id);

-- ════════════════════════════════════════════════════════════════════
-- PHASE 5 — CERTIFICATE OF OCCUPATION
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS spatial_planning.occupation_certificate (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id    UUID NOT NULL UNIQUE REFERENCES spatial_planning.permit_application(id) ON DELETE RESTRICT,

  certificate_no   VARCHAR(40) UNIQUE NOT NULL,  -- e.g. OC/HRE/2024/00312
  issued_at        DATE NOT NULL DEFAULT CURRENT_DATE,

  occupant_name    VARCHAR(255),
  building_use     VARCHAR(60),
  gross_floor_area_sqm NUMERIC(10,2),

  issued_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  countersigned_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  certificate_pdf_url TEXT,
  notes            TEXT,

  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════════════
-- SEED DATA
-- ════════════════════════════════════════════════════════════════════

-- Inspection stages (Annexure 12, Manual 2021).
INSERT INTO spatial_planning.inspection_stage
  (stage_number, stage_name, description, prerequisites, sort_order)
VALUES
  (1, 'Setting out',
   'Verify peg positions, boundary pegs, building lines and setbacks before excavation.',
   '{}'::INT[], 1),
  (2, 'Foundation trenches and footing levels',
   'Inspect excavation depth, width, bearing capacity, and footing level pegs.',
   '{1}'::INT[], 2),
  (3, 'Foundation brickwork to floor level',
   'Check foundation walls, DPC course, backfill compaction, and floor slab preparation.',
   '{2}'::INT[], 3),
  (4, 'Brickwork and window level',
   'Inspect masonry quality, mortar joints, lintels, window frames and sill levels.',
   '{3}'::INT[], 4),
  (5, 'Brickwork to wall plate',
   'Check continued masonry, bond beams, wall plate anchoring, and gable construction.',
   '{4}'::INT[], 5),
  (6, 'Roof trusses',
   'Inspect truss installation, bracing, purlin spacing, and ridge alignment.',
   '{5}'::INT[], 6),
  (7, 'Drainage and sewerage work',
   'Verify drain gradients, pipe joints, inspection chambers, and sewer connection.',
   '{3}'::INT[], 7),
  (8, 'Final inspection',
   'Comprehensive inspection of completed structure: finishes, electrical, plumbing, site clearance.',
   '{6,7}'::INT[], 8),
  (9, 'Certificate of occupation',
   'Formal sign-off confirming the building is fit for occupation.',
   '{8}'::INT[], 9)
ON CONFLICT (stage_number) DO NOTHING;

-- Checklist categories.
INSERT INTO spatial_planning.checklist_category (code, label, sort_order)
VALUES
  ('SITE',   'Site and Setbacks',              1),
  ('FOUND',  'Foundations',                    2),
  ('MASON',  'Masonry and Concrete',           3),
  ('STRUCT', 'Structural Elements',            4),
  ('ROOF',   'Roof and Ceiling',               5),
  ('DRAIN',  'Drainage and Sewerage',          6),
  ('SERV',   'Services (Electrical/Plumbing)', 7),
  ('FINISH', 'Finishes and Site Clearance',    8)
ON CONFLICT (code) DO NOTHING;

-- Checklist items (Annexure 14 — 38 items).
INSERT INTO spatial_planning.checklist_item
  (category_id, applicable_stages, code, description, is_mandatory, sort_order)
SELECT c.id, item.stages, item.code, item.descr, item.mandatory, item.sort
FROM (VALUES
  ('SITE',   '{1}'::INT[],   'SITE-01', 'Boundary pegs correctly positioned per approved plan',                    TRUE, 1),
  ('SITE',   '{1}'::INT[],   'SITE-02', 'Building line setback complies with zone controls',                       TRUE, 2),
  ('SITE',   '{1}'::INT[],   'SITE-03', 'Side and rear setbacks verified',                                         TRUE, 3),
  ('SITE',   '{1}'::INT[],   'SITE-04', 'Levels established relative to datum peg',                                TRUE, 4),
  ('FOUND',  '{2}'::INT[],   'FOUND-01','Excavation depth and width per approved drawings',                        TRUE, 1),
  ('FOUND',  '{2}'::INT[],   'FOUND-02','Bearing capacity of subsoil acceptable',                                  TRUE, 2),
  ('FOUND',  '{2}'::INT[],   'FOUND-03','Footing peg levels set and approved',                                     TRUE, 3),
  ('FOUND',  '{2}'::INT[],   'FOUND-04','No standing water in trenches at inspection',                             TRUE, 4),
  ('FOUND',  '{3}'::INT[],   'FOUND-05','DPC course correctly installed at approved height',                       TRUE, 5),
  ('FOUND',  '{3}'::INT[],   'FOUND-06','Foundation walls plumb and square',                                       TRUE, 6),
  ('FOUND',  '{3}'::INT[],   'FOUND-07','Backfill properly compacted in 150 mm layers',                           TRUE, 7),
  ('MASON',  '{4}'::INT[],   'MASON-01','Mortar mix and joint thickness compliant',                                TRUE, 1),
  ('MASON',  '{4}'::INT[],   'MASON-02','Bond pattern correct (English / Flemish as per drawings)',                TRUE, 2),
  ('MASON',  '{4}'::INT[],   'MASON-03','Window and door frames plumb, square, and secured',                      TRUE, 3),
  ('MASON',  '{4,5}'::INT[], 'MASON-04','Lintels installed over all openings; bearing ≥ 150 mm each end',         TRUE, 4),
  ('MASON',  '{5}'::INT[],   'MASON-05','Bond beam / ring beam per structural drawings',                          TRUE, 5),
  ('MASON',  '{5}'::INT[],   'MASON-06','Gable masonry correctly bonded and plumbed',                             TRUE, 6),
  ('STRUCT', '{5}'::INT[],   'STRUCT-01','Wall plate anchored to bond beam at approved centres',                  TRUE, 1),
  ('STRUCT', '{6}'::INT[],   'STRUCT-02','Roof trusses match approved truss drawings',                            TRUE, 2),
  ('STRUCT', '{6}'::INT[],   'STRUCT-03','Truss bracing (longitudinal and diagonal) installed',                   TRUE, 3),
  ('STRUCT', '{6}'::INT[],   'STRUCT-04','Purlin spacing and size per design',                                    TRUE, 4),
  ('STRUCT', '{6}'::INT[],   'STRUCT-05','Ridge board/apex correctly aligned; no visible deflection',             TRUE, 5),
  ('ROOF',   '{6}'::INT[],   'ROOF-01', 'Roofing material and gauge per approved specification',                  TRUE, 1),
  ('ROOF',   '{6}'::INT[],   'ROOF-02', 'Roof pitch matches approved drawings',                                   TRUE, 2),
  ('ROOF',   '{6}'::INT[],   'ROOF-03', 'Fascia, barge boards, and gutters installed',                           FALSE,3),
  ('ROOF',   '{8}'::INT[],   'ROOF-04', 'Ceiling board type and fixing per specification',                       FALSE,4),
  ('ROOF',   '{8}'::INT[],   'ROOF-05', 'Roof valley and ridge cap flashings correctly installed',               TRUE, 5),
  ('DRAIN',  '{7}'::INT[],   'DRAIN-01','Drain gradients comply: min 1:60 for 110 mm pipes',                    TRUE, 1),
  ('DRAIN',  '{7}'::INT[],   'DRAIN-02','All pipe joints sealed; smoke test or water test passed',               TRUE, 2),
  ('DRAIN',  '{7}'::INT[],   'DRAIN-03','Inspection chambers at correct positions and depths',                   TRUE, 3),
  ('DRAIN',  '{7}'::INT[],   'DRAIN-04','Connection to public sewer approved by utility authority',              TRUE, 4),
  ('DRAIN',  '{7}'::INT[],   'DRAIN-05','Grease trap installed where required (commercial kitchen)',             FALSE,5),
  ('SERV',   '{8}'::INT[],   'SERV-01', 'Electrical installation certificate from ZESA / licensed contractor',  TRUE, 1),
  ('SERV',   '{8}'::INT[],   'SERV-02', 'Earth leakage protection installed',                                   TRUE, 2),
  ('SERV',   '{8}'::INT[],   'SERV-03', 'Water supply connected; no visible leaks',                             TRUE, 3),
  ('SERV',   '{8}'::INT[],   'SERV-04', 'Hot-water geyser installation complies with manufacturer spec',        FALSE,4),
  ('FINISH', '{8}'::INT[],   'FINISH-01','All surfaces rendered or painted per specification',                   FALSE,1),
  ('FINISH', '{8}'::INT[],   'FINISH-02','Site debris and construction waste removed',                          TRUE, 2),
  ('FINISH', '{8}'::INT[],   'FINISH-03','Access for persons with disability provided where required',          TRUE, 3)
) AS item(cat_code, stages, code, descr, mandatory, sort)
JOIN spatial_planning.checklist_category c ON c.code = item.cat_code
ON CONFLICT (code) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════
-- TRIGGERS — updated_at auto-maintenance
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION spatial_planning.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'permit_application',
    'application_consultation',
    'application_objection',
    'application_appeal',
    'enforcement_order',
    'prohibition_order',
    'building_plan',
    'stage_inspection'
  ] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_updated_at ON spatial_planning.%I;
       CREATE TRIGGER trg_%s_updated_at
       BEFORE UPDATE ON spatial_planning.%I
       FOR EACH ROW EXECUTE FUNCTION spatial_planning.set_updated_at()',
      tbl, tbl, tbl, tbl
    );
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- HELPER VIEWS
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW spatial_planning.v_application_summary AS
SELECT
  pa.id,
  pa.tpd_reference,
  pa.dev_register_no,
  pa.stand_number,
  pa.suburb_ward,
  pa.applicant_name,
  pa.development_type,
  pa.status,
  pa.received_at,
  pa.decision_at,
  (SELECT COUNT(*) FROM spatial_planning.application_consultation c WHERE c.permit_app_id = pa.id)  AS consultation_count,
  (SELECT COUNT(*) FROM spatial_planning.application_objection o   WHERE o.permit_app_id = pa.id)   AS objection_count,
  (SELECT COUNT(*) FROM spatial_planning.building_plan bp          WHERE bp.permit_app_id = pa.id)  AS building_plan_count,
  (SELECT COUNT(*) FROM spatial_planning.stage_inspection si       WHERE si.permit_app_id = pa.id)  AS inspection_count,
  EXISTS (
    SELECT 1 FROM spatial_planning.occupation_certificate oc WHERE oc.permit_app_id = pa.id
  ) AS has_occupation_certificate
FROM spatial_planning.permit_application pa;

CREATE OR REPLACE VIEW spatial_planning.v_inspection_progress AS
SELECT
  si.permit_app_id,
  ist.stage_number,
  ist.stage_name,
  ist.prerequisites,
  si.id           AS inspection_id,
  si.attempt,
  si.inspector_id,
  si.scheduled_at,
  si.inspected_at,
  si.result,
  (
    SELECT COUNT(*) FROM spatial_planning.inspection_checklist_result icr
    WHERE icr.stage_inspection_id = si.id AND icr.result = 'fail'
  ) AS failed_items,
  (
    SELECT COUNT(*) FROM spatial_planning.inspection_checklist_result icr
    WHERE icr.stage_inspection_id = si.id
  ) AS total_items
FROM spatial_planning.inspection_stage ist
LEFT JOIN spatial_planning.stage_inspection si ON si.stage_number = ist.stage_number;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 070 complete — DM Handbook v1.2 schema installed';
  RAISE NOTICE '   Schema : spatial_planning';
  RAISE NOTICE '   Tables : permit_application, application_consultation, application_objection,';
  RAISE NOTICE '            application_appeal, enforcement_order, prohibition_order,';
  RAISE NOTICE '            enforcement_compliance_check, building_plan, building_plan_annotation,';
  RAISE NOTICE '            inspection_stage, checklist_category, checklist_item,';
  RAISE NOTICE '            stage_inspection, inspection_checklist_result, occupation_certificate';
  RAISE NOTICE '   Seed   : 9 inspection stages, 8 checklist categories, 38 checklist items';
  RAISE NOTICE '   Views  : v_application_summary, v_inspection_progress';
END $$;
