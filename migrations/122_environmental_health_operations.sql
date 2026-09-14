-- 122_environmental_health_operations.sql
-- The rest of the Environmental Health Officer's record: the work done, the
-- documents issued, and the programmes run across the district.
--
-- WHY THIS EXISTS
-- Migration 121 moved the EHO's four *registers* onto the server and left the
-- console's other five record types where it found them - in localStorage.
-- Three of those five are not working notes. They are the council's record of
-- a statutory act:
--
--   * A premises inspection is the evidence behind an abatement notice. When
--     the operator appeals, the council has to produce the inspection that
--     grounded it. "It was on the officer's old laptop" is not a defence.
--   * A food-handler certificate is a document a person carries and an
--     inspector demands. If the council cannot verify one it issued, the
--     certificate means nothing and the forgery is undetectable.
--   * A burial permit is issued to a grieving family, often at speed, and is
--     then the only paper trail for an interment. It cannot live in a browser.
--
-- A fourth was worse than local - it could not be recorded at all:
--
--   * An abatement notice. The console posted Public Health Act notices to
--     the planning enforcement-order endpoint, which refuses the env_officer
--     role, requires fields the form never sent and whose CHECK constraint
--     rejects the order types it used. Every notice an EHO "issued" failed.
--     It was also the wrong register: a Public Health Act s. 83 notice to
--     abate a nuisance is not an RTCP Act enforcement order, and mixing them
--     would put a blocked drain into the planning enforcement statistics.
--
-- The remaining two are duties the console had no home for at all:
--
--   * Licence health clearance - under the Shop Licences Act and the liquor
--     licensing regime, a licence is not granted until the EHO certifies the
--     premises fit. The council was making that decision on paper.
--   * Field programmes - refuse rounds, VIP/Blair latrine construction,
--     indoor residual spraying, larviciding, rodent baiting and health
--     education. In a rural district this is the bulk of an EHO's year and
--     the substance of every report to the Ministry, and none of it was
--     recorded anywhere.
--
-- WHY FIELD PROGRAMMES ARE ONE TABLE
-- A spray round, a refuse round and a latrine campaign are the same record:
-- a type, a ward, a date planned, a date executed, a target, an achievement,
-- a team and notes. Five tables holding identical columns would be five
-- migrations, five endpoints and five screens for one idea. The discriminator
-- is `programme_type`; the shape is shared because the shape genuinely is.
--
-- WHAT IS DELETABLE
-- Nothing. Inspections and issued documents are statutory records - a
-- certificate is revoked, never unissued, so it carries revoked_at rather than
-- deleted_at. A programme round is cancelled, not erased: a round the council
-- planned and did not run is exactly the fact a report must be able to state.
--
-- POSITION PROVENANCE
-- Same rule as 121 and 118. A position is optional, and a recorded one always
-- says where it came from. Only the two record types that happen somewhere in
-- particular carry one: an inspection and a programme round. A certificate is
-- issued at the office about a premises that already has a position of its
-- own, so copying that position here would create a second, staler copy of it.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS spatial_planning.health_abatement_notice_seq;
CREATE SEQUENCE IF NOT EXISTS spatial_planning.health_premises_inspection_seq;
CREATE SEQUENCE IF NOT EXISTS spatial_planning.health_food_handler_seq;
CREATE SEQUENCE IF NOT EXISTS spatial_planning.health_burial_permit_seq;
CREATE SEQUENCE IF NOT EXISTS spatial_planning.health_licence_clearance_seq;
CREATE SEQUENCE IF NOT EXISTS spatial_planning.health_field_programme_seq;

-- -- 0. Public Health Act notice ------------------------------------------
-- A notice served on an owner or occupier: to abate a nuisance (s. 83), that
-- premises are unfit and closed (s. 87), that the council will do the works in
-- default and recover the cost (s. 84), or prohibiting a food business from
-- trading until it is re-inspected. Compliance is established by inspection,
-- so a re-inspection links to the notice (health_premises_inspection.notice_id)
-- rather than living in a second visits table.
CREATE TABLE IF NOT EXISTS spatial_planning.health_abatement_notice (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(24) NOT NULL UNIQUE,

  notice_type         VARCHAR(20) NOT NULL CHECK (notice_type IN (
                        'abatement', 'closure', 'works_in_default', 'prohibition')),

  premises_id         UUID REFERENCES spatial_planning.health_premises(id) ON DELETE SET NULL,
  complaint_id        UUID REFERENCES spatial_planning.health_nuisance_complaint(id) ON DELETE SET NULL,
  stand_number        VARCHAR(40),
  suburb_ward         VARCHAR(120),

  -- The person the notice binds. A notice with no named recipient cannot be
  -- enforced, so the name is required; the address is where it was served.
  subject_name        VARCHAR(160) NOT NULL,
  subject_address     VARCHAR(300),
  subject_contact     VARCHAR(40),

  nuisance_description TEXT NOT NULL,
  required_action     TEXT NOT NULL,
  compliance_days     INTEGER NOT NULL CHECK (compliance_days BETWEEN 1 AND 180),

  served_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  served_method       VARCHAR(16) NOT NULL DEFAULT 'hand'
                        CHECK (served_method IN ('hand', 'registered_post', 'affixed', 'email')),

  status              VARCHAR(16) NOT NULL DEFAULT 'served' CHECK (status IN (
                        'served', 'extended', 'complied', 'non_complied', 'escalated', 'withdrawn')),
  extended_to         DATE,
  escalation          VARCHAR(20) CHECK (escalation IS NULL OR escalation IN (
                        'works_in_default', 'prosecution', 'closure')),
  outcome_notes       TEXT,
  closed_at           TIMESTAMP WITH TIME ZONE,

  issued_by_name      VARCHAR(160) NOT NULL,
  issued_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- An extension without a new date is not an extension.
  CONSTRAINT health_notice_extension_dated
    CHECK (status <> 'extended' OR extended_to IS NOT NULL),
  -- Escalating says to what; a closed outcome is dated and explained.
  CONSTRAINT health_notice_escalation_named
    CHECK (status <> 'escalated' OR escalation IS NOT NULL),
  CONSTRAINT health_notice_outcome_closed
    CHECK (status NOT IN ('complied', 'withdrawn', 'escalated') OR closed_at IS NOT NULL),
  CONSTRAINT health_notice_withdrawal_reasoned
    CHECK (status <> 'withdrawn'
           OR (outcome_notes IS NOT NULL AND length(trim(outcome_notes)) > 0))
);

-- -- 1. Operational premises inspection ----------------------------------
-- The routine inspection of a premises already in use, as distinct from the
-- construction-stage inspection the Building Inspector books. One row per
-- visit; the premises register's last_inspected_at is maintained from these.
CREATE TABLE IF NOT EXISTS spatial_planning.health_premises_inspection (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(24) NOT NULL UNIQUE,

  premises_id         UUID NOT NULL
                        REFERENCES spatial_planning.health_premises(id) ON DELETE CASCADE,

  inspected_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- The name as written on the day. The user id below says who keyed it in;
  -- this says who signed the inspection, and those are not always one person
  -- (a trainee inspects, the district officer signs).
  inspector_name      VARCHAR(160) NOT NULL,

  scope               VARCHAR(20) NOT NULL CHECK (scope IN (
                        'food_hygiene', 'sanitation', 'water_supply',
                        'pest_control', 'staff_hygiene', 'general')),
  verdict             VARCHAR(16) NOT NULL CHECK (verdict IN
                        ('pass', 'fail', 'conditional', 'pending')),

  findings            TEXT NOT NULL,
  action_required     TEXT,
  follow_up_date      DATE,

  -- The notice this inspection grounded, or the notice it re-inspects for
  -- compliance. The link is what lets an appeal hearing put the two side by side.
  notice_id           UUID REFERENCES spatial_planning.health_abatement_notice(id)
                        ON DELETE SET NULL,

  location            geometry(Point, 4326),
  location_source     VARCHAR(20),
  location_accuracy_m NUMERIC(8, 2),

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- A verdict that is not a pass has to say what must be done about it,
  -- because the notice that follows quotes this column.
  CONSTRAINT health_inspection_action_stated
    CHECK (verdict = 'pass' OR verdict = 'pending'
           OR (action_required IS NOT NULL AND length(trim(action_required)) > 0)),
  CONSTRAINT health_inspection_location_source_check
    CHECK (location_source IS NULL OR location_source IN ('field_gps', 'map_pick', 'premises')),
  CONSTRAINT health_inspection_location_accuracy_check
    CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0),
  CONSTRAINT health_inspection_location_paired
    CHECK (location IS NOT NULL OR (location_source IS NULL AND location_accuracy_m IS NULL))
);

-- -- 2. Food-handler health certificate -----------------------------------
-- Issued to a named person for a named premises, valid for a fixed term. The
-- certificate number is the council's; the national ID is the holder's.
CREATE TABLE IF NOT EXISTS spatial_planning.health_food_handler_cert (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(24) NOT NULL UNIQUE,

  premises_id         UUID NOT NULL
                        REFERENCES spatial_planning.health_premises(id) ON DELETE CASCADE,

  handler_name        VARCHAR(160) NOT NULL,
  handler_id_number   VARCHAR(40),

  issued_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at          DATE NOT NULL,
  -- The certificate exists only because a clinic cleared the holder. Storing
  -- it as a boolean that could be false would allow a certificate that
  -- contradicts its own precondition; this column records WHERE the clearance
  -- came from, and NOT NULL makes the clearance itself non-optional.
  medical_clearance_source VARCHAR(200) NOT NULL,

  notes               TEXT,

  -- Revoked, never deleted. A certificate that was issued and then withdrawn
  -- is a different fact from one that was never issued, and an inspector in
  -- the field checking a produced certificate needs to tell them apart.
  revoked_at          TIMESTAMP WITH TIME ZONE,
  revoked_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  revoked_reason      TEXT,

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  issued_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,

  CONSTRAINT health_handler_expiry_after_issue
    CHECK (expires_at > issued_at::date),
  CONSTRAINT health_handler_revocation_reasoned
    CHECK (revoked_at IS NULL
           OR (revoked_reason IS NOT NULL AND length(trim(revoked_reason)) > 0))
);

-- -- 3. Burial / exhumation permit ----------------------------------------
-- Issued under the Public Health Act, usually within hours of a death. The
-- permit number is quoted by the cemetery before an interment.
CREATE TABLE IF NOT EXISTS spatial_planning.health_burial_permit (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(24) NOT NULL UNIQUE,

  permit_kind         VARCHAR(12) NOT NULL DEFAULT 'burial'
                        CHECK (permit_kind IN ('burial', 'exhumation', 'reburial')),

  deceased_name       VARCHAR(160) NOT NULL,
  deceased_id_number  VARCHAR(40),
  date_of_death       DATE NOT NULL,
  cause_of_death      VARCHAR(200),

  cemetery            VARCHAR(160) NOT NULL,
  ward                VARCHAR(120),
  interment_at        TIMESTAMP WITH TIME ZONE,

  applicant_name      VARCHAR(160),
  applicant_relation  VARCHAR(60),
  applicant_contact   VARCHAR(40),

  -- The name on the permit, which is the officer answerable for it.
  issued_by_name      VARCHAR(160) NOT NULL,
  issued_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  issued_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,

  notes               TEXT,

  -- A permit is cancelled (wrong cemetery, duplicate application), never
  -- deleted: the number has already been quoted to a family.
  cancelled_at        TIMESTAMP WITH TIME ZONE,
  cancelled_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  cancelled_reason    TEXT,

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- A death cannot postdate the permit issued for it.
  CONSTRAINT health_burial_death_before_issue
    CHECK (date_of_death <= issued_at::date),
  CONSTRAINT health_burial_cancellation_reasoned
    CHECK (cancelled_at IS NULL
           OR (cancelled_reason IS NOT NULL AND length(trim(cancelled_reason)) > 0))
);

-- -- 4. Licence health clearance ------------------------------------------
-- The EHO's certification that premises are fit, which a shop, liquor or
-- hawker licence cannot be granted without. A clearance is a decision with a
-- date and an officer behind it, not a tick on someone's list.
CREATE TABLE IF NOT EXISTS spatial_planning.health_licence_clearance (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(24) NOT NULL UNIQUE,

  licence_type        VARCHAR(20) NOT NULL CHECK (licence_type IN (
                        'shop', 'liquor', 'hawker', 'food_outlet', 'lodging',
                        'abattoir', 'creche', 'transport_of_food', 'other')),

  applicant_name      VARCHAR(160) NOT NULL,
  applicant_contact   VARCHAR(40),
  trading_name        VARCHAR(200),

  premises_id         UUID REFERENCES spatial_planning.health_premises(id) ON DELETE SET NULL,
  stand_number        VARCHAR(40),
  suburb_ward         VARCHAR(120),

  received_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- The inspection the decision rests on. A clearance granted with no
  -- inspection behind it is the thing this column exists to make visible.
  inspection_id       UUID REFERENCES spatial_planning.health_premises_inspection(id)
                        ON DELETE SET NULL,

  status              VARCHAR(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'cleared', 'conditional', 'refused', 'withdrawn')),
  conditions          TEXT,
  refusal_reason      TEXT,
  decided_at          TIMESTAMP WITH TIME ZONE,
  decided_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  decided_by_name     VARCHAR(160),
  -- A clearance is not permanent. Most councils tie it to the licence year.
  valid_until         DATE,

  notes               TEXT,

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Every decided outcome is dated; a pending one is not.
  CONSTRAINT health_clearance_decision_dated
    CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT health_clearance_refusal_reasoned
    CHECK (status <> 'refused'
           OR (refusal_reason IS NOT NULL AND length(trim(refusal_reason)) > 0)),
  CONSTRAINT health_clearance_conditions_stated
    CHECK (status <> 'conditional'
           OR (conditions IS NOT NULL AND length(trim(conditions)) > 0))
);

-- -- 5. Field programme round ---------------------------------------------
-- One planned-and-executed round of a recurring public-health programme.
CREATE TABLE IF NOT EXISTS spatial_planning.health_field_programme (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           VARCHAR(24) NOT NULL UNIQUE,

  programme_type      VARCHAR(24) NOT NULL CHECK (programme_type IN (
                        'refuse_collection',
                        'illegal_dump_clearance',
                        'disposal_site_check',
                        'latrine_construction',
                        'indoor_residual_spray',
                        'larviciding',
                        'rodent_control',
                        'health_education',
                        'water_point_maintenance',
                        'other')),

  title               VARCHAR(200) NOT NULL,
  ward                VARCHAR(120) NOT NULL,
  village_or_area     VARCHAR(200),

  scheduled_for       DATE NOT NULL,
  executed_at         TIMESTAMP WITH TIME ZONE,

  status              VARCHAR(16) NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),

  -- Coverage in whatever unit the programme counts: households sprayed,
  -- latrines built, bins emptied, people reached. The unit is stated rather
  -- than assumed, because a bare "412" in a Ministry report means nothing.
  target_quantity     INTEGER CHECK (target_quantity IS NULL OR target_quantity >= 0),
  achieved_quantity   INTEGER CHECK (achieved_quantity IS NULL OR achieved_quantity >= 0),
  quantity_unit       VARCHAR(40),

  team_lead           VARCHAR(160),
  team_size           INTEGER CHECK (team_size IS NULL OR team_size BETWEEN 0 AND 500),

  notes               TEXT,
  cancelled_reason    TEXT,

  location            geometry(Point, 4326),
  location_source     VARCHAR(20),
  location_accuracy_m NUMERIC(8, 2),

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT health_programme_completion_dated
    CHECK (status <> 'completed' OR executed_at IS NOT NULL),
  CONSTRAINT health_programme_cancellation_reasoned
    CHECK (status <> 'cancelled'
           OR (cancelled_reason IS NOT NULL AND length(trim(cancelled_reason)) > 0)),
  -- A quantity with no unit cannot be reported, so the two travel together.
  CONSTRAINT health_programme_quantity_has_unit
    CHECK ((target_quantity IS NULL AND achieved_quantity IS NULL)
           OR (quantity_unit IS NOT NULL AND length(trim(quantity_unit)) > 0)),
  CONSTRAINT health_programme_location_source_check
    CHECK (location_source IS NULL OR location_source IN
           ('field_gps', 'map_pick', 'ward_centroid')),
  CONSTRAINT health_programme_location_accuracy_check
    CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0),
  CONSTRAINT health_programme_location_paired
    CHECK (location IS NOT NULL OR (location_source IS NULL AND location_accuracy_m IS NULL))
);

-- -- Indexes ---------------------------------------------------------------
-- Every one of these backs a query the console makes on load, not a query
-- someone might make one day.

-- "the inspection history of this premises, newest first" - the case sheet.
CREATE INDEX IF NOT EXISTS idx_health_inspection_premises
  ON spatial_planning.health_premises_inspection (premises_id, inspected_at DESC);
-- "everything inspected in this reporting window" - the periodic report.
CREATE INDEX IF NOT EXISTS idx_health_inspection_window
  ON spatial_planning.health_premises_inspection (inspected_at DESC);
-- "what is due back" - the follow-up queue.
CREATE INDEX IF NOT EXISTS idx_health_inspection_followup
  ON spatial_planning.health_premises_inspection (follow_up_date)
  WHERE follow_up_date IS NOT NULL AND verdict <> 'pass';
CREATE INDEX IF NOT EXISTS idx_health_inspection_location
  ON spatial_planning.health_premises_inspection USING GIST (location);

-- The notice book: "what is still open, soonest due first".
CREATE INDEX IF NOT EXISTS idx_health_notice_open
  ON spatial_planning.health_abatement_notice (status, served_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_notice_premises
  ON spatial_planning.health_abatement_notice (premises_id)
  WHERE premises_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_health_inspection_notice
  ON spatial_planning.health_premises_inspection (notice_id)
  WHERE notice_id IS NOT NULL;

-- "the handlers at this premises" and "who expires this month".
CREATE INDEX IF NOT EXISTS idx_health_handler_premises
  ON spatial_planning.health_food_handler_cert (premises_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_handler_expiring
  ON spatial_planning.health_food_handler_cert (expires_at)
  WHERE revoked_at IS NULL;
-- Verifying a certificate produced in the field is a lookup by national ID.
CREATE INDEX IF NOT EXISTS idx_health_handler_id_number
  ON spatial_planning.health_food_handler_cert (handler_id_number)
  WHERE handler_id_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_health_burial_issued
  ON spatial_planning.health_burial_permit (issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_burial_deceased
  ON spatial_planning.health_burial_permit (lower(deceased_name));

-- The clearance queue is "what is waiting on me", which is the whole screen.
CREATE INDEX IF NOT EXISTS idx_health_clearance_queue
  ON spatial_planning.health_licence_clearance (status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_clearance_premises
  ON spatial_planning.health_licence_clearance (premises_id)
  WHERE premises_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_health_programme_schedule
  ON spatial_planning.health_field_programme (scheduled_for DESC, programme_type);
CREATE INDEX IF NOT EXISTS idx_health_programme_ward
  ON spatial_planning.health_field_programme (ward, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_health_programme_open
  ON spatial_planning.health_field_programme (scheduled_for)
  WHERE status IN ('planned', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_health_programme_location
  ON spatial_planning.health_field_programme USING GIST (location);

COMMENT ON TABLE spatial_planning.health_abatement_notice IS
  'Public Health Act notices: abatement (s. 83), closure (s. 87), works in default (s. 84), prohibition.';
COMMENT ON TABLE spatial_planning.health_premises_inspection IS
  'Routine EHO inspection of premises in use. The evidence an abatement notice rests on.';
COMMENT ON TABLE spatial_planning.health_food_handler_cert IS
  'Food-handler health certificates issued by the council. Revoked, never deleted.';
COMMENT ON TABLE spatial_planning.health_burial_permit IS
  'Burial, exhumation and reburial permits under the Public Health Act [Ch. 15:09].';
COMMENT ON TABLE spatial_planning.health_licence_clearance IS
  'EHO health clearance a shop, liquor or hawker licence cannot be granted without.';
COMMENT ON TABLE spatial_planning.health_field_programme IS
  'One round of a recurring public-health field programme: refuse, sanitation, vector control, education.';

COMMIT;
