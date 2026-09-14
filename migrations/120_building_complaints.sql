-- 120_building_complaints.sql
-- Public reports of unauthorised or dangerous building work.
--
-- The register held permits, plans, stage inspections and enforcement orders —
-- every case that begins with an APPLICATION. It held nothing for the other
-- half of a rural building inspector's inbox: the neighbour who walks into the
-- council offices to report a wall going up over a boundary, or the ward
-- councillor telephoning about a fire-damaged shop still open for trade.
--
-- Those reports were being written in a paper daybook, which is precisely what
-- this system exists to replace. Without them the inspector's queue, workload
-- returns and enforcement trail all silently understate the work done.
--
-- SHAPE
-- One table, not three. A complaint is received, triaged, visited once, and
-- either closed or carried into an enforcement order — which already has its
-- own table and its own compliance clock. A separate visit log would only earn
-- its place if complaints routinely needed several recorded attendances; today
-- they do not, and the finding column plus the enforcement order covers it.
--
-- ANONYMITY IS A FEATURE
-- People report a neighbour's illegal building and then have to live next to
-- that neighbour. reporter_name and reporter_phone are nullable on purpose and
-- an anonymous report is a first-class record, not a lesser one. What is never
-- optional is the description and where it is.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS spatial_planning.building_complaint_seq;

CREATE TABLE IF NOT EXISTS spatial_planning.building_complaint (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human reference the public is given over the counter: BC-2026-0007.
  reference           VARCHAR(24) NOT NULL UNIQUE,

  category            VARCHAR(30) NOT NULL CHECK (category IN (
                        'building_without_permit',
                        'deviation_from_plan',
                        'dangerous_structure',
                        'building_line_encroachment',
                        'unsafe_site',
                        'occupation_without_certificate',
                        'other')),
  -- Emergency is reserved for danger to life: a structure liable to collapse,
  -- an unbarricaded excavation on a footpath. It drives the queue order, so it
  -- is a small vocabulary and not a free number.
  severity            VARCHAR(12) NOT NULL DEFAULT 'routine'
                        CHECK (severity IN ('routine', 'urgent', 'emergency')),
  status              VARCHAR(20) NOT NULL DEFAULT 'received' CHECK (status IN (
                        'received', 'assigned', 'inspected',
                        'substantiated', 'unsubstantiated', 'closed')),

  description         TEXT NOT NULL,
  stand_number        VARCHAR(40),
  suburb_ward         VARCHAR(120),
  -- Free-text directions for where there is no stand number, which is the
  -- ordinary case in a communal ward.
  location_note       TEXT,
  observed_lat        NUMERIC(10, 7),
  observed_lng        NUMERIC(10, 7),

  reporter_name       VARCHAR(160),
  reporter_phone      VARCHAR(40),
  anonymous           BOOLEAN NOT NULL DEFAULT FALSE,

  -- Filled in during triage, once the complaint is matched to the register.
  permit_app_id       UUID REFERENCES spatial_planning.permit_application(id) ON DELETE SET NULL,

  received_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  received_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_to         UUID REFERENCES public.users(id) ON DELETE SET NULL,

  -- What the inspector found on site, and when. Never pre-filled.
  inspected_at        TIMESTAMP WITH TIME ZONE,
  inspected_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  finding             TEXT,

  closed_at           TIMESTAMP WITH TIME ZONE,
  closed_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,

  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Same rule as the field-event log: a position is optional but never half
  -- present, because half a coordinate on an official record is a wrong one.
  CONSTRAINT building_complaint_coords_paired
    CHECK ((observed_lat IS NULL) = (observed_lng IS NULL)),
  -- An anonymous report carries no contact details. Storing a name against a
  -- report the council promised was anonymous is the failure worth preventing
  -- in the schema rather than in a form handler.
  CONSTRAINT building_complaint_anonymity_kept
    CHECK (NOT anonymous OR (reporter_name IS NULL AND reporter_phone IS NULL)),
  -- A finding and the status that depends on it move together.
  CONSTRAINT building_complaint_finding_present
    CHECK (status NOT IN ('substantiated', 'unsubstantiated') OR finding IS NOT NULL)
);

-- The inspector's queue: open work, worst first.
CREATE INDEX IF NOT EXISTS idx_building_complaint_queue
  ON spatial_planning.building_complaint(status, severity, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_building_complaint_assigned
  ON spatial_planning.building_complaint(assigned_to, status);
-- Case-insensitive so a complaint captured at the counter as 'somabula 412'
-- still joins the stand the register calls 'Somabula 412'.
CREATE INDEX IF NOT EXISTS idx_building_complaint_stand
  ON spatial_planning.building_complaint(upper(btrim(stand_number)));
CREATE INDEX IF NOT EXISTS idx_building_complaint_permit
  ON spatial_planning.building_complaint(permit_app_id);

COMMENT ON TABLE spatial_planning.building_complaint IS
  'Public reports of unauthorised or dangerous building work. Anonymous reports are first-class.';
COMMENT ON COLUMN spatial_planning.building_complaint.severity IS
  'emergency = danger to life; drives queue order, not a free-text priority.';

COMMIT;
