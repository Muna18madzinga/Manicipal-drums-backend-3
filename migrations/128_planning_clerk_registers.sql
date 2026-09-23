-- 125_planning_clerk_registers.sql
-- ─────────────────────────────────────────────────────────────────────────
-- The Planning Clerk's statutory registers.
--
-- WHY THIS EXISTS
-- The Planning Clerk Portal shipped with nine registers and kept seven of
-- them in the browser's localStorage: correspondence, fee receipts,
-- acknowledgement letters, permit dispatch, refusal letters, newspaper
-- certificates and abutter notifications. Every one of those is the council's
-- evidence that it did what the Regional, Town and Country Planning Act
-- requires it to do, and every one of them was one cleared cache away from
-- gone. A second clerk on a second machine saw an empty register. Nothing was
-- backed up, nothing was auditable, and nothing could be produced at an
-- appeal hearing.
--
-- These are the same registers on the server, plus two the portal did not
-- have and a clerk's office cannot work without: where the physical file
-- currently is, and who has inspected the public register.
--
-- NAMING
-- Prefixed `clerk_` in `spatial_planning`, beside permit_application, because
-- these ARE the planning record — not console furniture. An operator reading
-- \dt spatial_planning.* sees the clerk's registers as one group.
--
-- DELETION
-- There is none. A register the clerk can delete rows from is not evidence.
-- Every register carries `voided_at` + `voided_reason` instead: the entry
-- stays, struck through, with a reason and a name against it. The API has no
-- DELETE.
--
-- MONEY
-- `amount` + `currency IN ('USD','ZWG')`, matching migration 064's convention
-- for the council's books. The portal's `amount_zwl` was a third currency
-- that the council has not used since 2024.
--
-- Depends on: 070 (permit_application, spatial_planning.set_updated_at()).
-- Idempotent. Apply individually (docs/db-rebuild-2026-09-21.md):
--   node scripts/apply-local-migration.js migrations/125_planning_clerk_registers.sql
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. CORRESPONDENCE LOG
-- ═══════════════════════════════════════════════════════════════════════
-- Every letter, email, fax, phone call and counter visit in or out of the
-- Planning office. The permit link is nullable on purpose: a great deal of
-- the office's post arrives before there is a file to attach it to, and a log
-- that refuses those entries is a log the clerk keeps on paper instead.
CREATE TABLE IF NOT EXISTS spatial_planning.clerk_correspondence (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction             VARCHAR(3) NOT NULL CHECK (direction IN ('in', 'out')),
  logged_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  permit_application_id UUID REFERENCES spatial_planning.permit_application(id) ON DELETE SET NULL,
  ref_no                VARCHAR(60) NOT NULL,
  party                 VARCHAR(200) NOT NULL,
  subject               VARCHAR(300) NOT NULL,
  channel               VARCHAR(12) NOT NULL DEFAULT 'letter'
                          CHECK (channel IN ('letter', 'email', 'phone', 'in_person', 'fax')),
  attached_doc_ref      VARCHAR(120),
  notes                 TEXT,

  logged_by             UUID REFERENCES public.users(id) ON DELETE SET NULL,
  logged_by_name        VARCHAR(160) NOT NULL,
  voided_at             TIMESTAMP WITH TIME ZONE,
  voided_reason         TEXT,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT clerk_corr_void_reasoned
    CHECK (voided_at IS NULL OR (voided_reason IS NOT NULL AND length(trim(voided_reason)) > 0))
);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. FEE RECEIPT REGISTER
-- ═══════════════════════════════════════════════════════════════════════
-- The counter cashbook: what the clerk receipted by hand, which is then
-- reconciled against the payment gateway's own record. Distinct from
-- public.payments — that table is what the citizen paid online; this one is
-- what came over the counter in cash, EcoCash or a cheque.
CREATE TABLE IF NOT EXISTS spatial_planning.clerk_fee_receipt (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no            VARCHAR(40) NOT NULL UNIQUE,

  fee_kind              VARCHAR(20) NOT NULL CHECK (fee_kind IN (
                          'application', 'public_notice', 'plan_scrutiny', 'inspection',
                          'occupation', 'appeal', 'search', 'copies', 'other')),
  permit_application_id UUID REFERENCES spatial_planning.permit_application(id) ON DELETE SET NULL,

  payer_name            VARCHAR(200) NOT NULL,
  amount                NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
  currency              VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'ZWG')),
  paid_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  payment_method        VARCHAR(10) NOT NULL DEFAULT 'cash'
                          CHECK (payment_method IN ('cash', 'ecocash', 'eft', 'cheque', 'card')),
  reference             VARCHAR(120),
  notes                 TEXT,

  issued_by             UUID REFERENCES public.users(id) ON DELETE SET NULL,
  issued_by_name        VARCHAR(160) NOT NULL,
  voided_at             TIMESTAMP WITH TIME ZONE,
  voided_reason         TEXT,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- A cash or cheque entry with no reference is normal; an EFT or card entry
  -- with none cannot be reconciled against the bank statement, which is the
  -- only reason this register exists.
  CONSTRAINT clerk_receipt_electronic_referenced
    CHECK (payment_method NOT IN ('eft', 'card')
           OR (reference IS NOT NULL AND length(trim(reference)) > 0)),
  CONSTRAINT clerk_receipt_void_reasoned
    CHECK (voided_at IS NULL OR (voided_reason IS NOT NULL AND length(trim(voided_reason)) > 0))
);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. ACKNOWLEDGEMENT LETTERS  (5 working days)
-- ═══════════════════════════════════════════════════════════════════════
-- Every application must be acknowledged within five working days of
-- receipt, and the same letter starts the three-month determination clock.
-- `due_by` is stored rather than computed on read: the working-day count
-- depends on the public holidays in force at the time, and a deadline that
-- silently moves when the holiday table is edited is not a deadline.
CREATE TABLE IF NOT EXISTS spatial_planning.clerk_acknowledgement (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_no             VARCHAR(40) NOT NULL UNIQUE,

  permit_application_id UUID NOT NULL
                          REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,
  application_register_no VARCHAR(40),

  received_at           TIMESTAMP WITH TIME ZONE NOT NULL,
  due_by                TIMESTAMP WITH TIME ZONE NOT NULL,
  -- Receipt + 3 months: the date the authority is deemed to have refused if
  -- it has not determined. The clerk's single most consequential number.
  determination_due_by  TIMESTAMP WITH TIME ZONE,
  sent_at               TIMESTAMP WITH TIME ZONE,
  sent_method           VARCHAR(16) CHECK (sent_method IS NULL OR sent_method IN (
                          'registered_post', 'ordinary_post', 'email', 'hand', 'courier')),
  recipient             VARCHAR(300) NOT NULL,
  notes                 TEXT,

  drafted_by            UUID REFERENCES public.users(id) ON DELETE SET NULL,
  drafted_by_name       VARCHAR(160) NOT NULL,
  voided_at             TIMESTAMP WITH TIME ZONE,
  voided_reason         TEXT,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT clerk_ack_due_after_receipt CHECK (due_by >= received_at),
  CONSTRAINT clerk_ack_sent_has_method
    CHECK (sent_at IS NULL OR sent_method IS NOT NULL),
  CONSTRAINT clerk_ack_void_reasoned
    CHECK (voided_at IS NULL OR (voided_reason IS NOT NULL AND length(trim(voided_reason)) > 0))
);

-- One live acknowledgement per application. A second letter for the same
-- file means one of them is wrong, and the register should not hold both.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clerk_ack_live_per_permit
  ON spatial_planning.clerk_acknowledgement (permit_application_id)
  WHERE voided_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. PERMIT DISPATCH
-- ═══════════════════════════════════════════════════════════════════════
-- Handing the sealed instrument over, and the proof that it happened. The
-- appeal window runs from service, not from the Council resolution, so the
-- dispatch date is the one that decides whether an appeal is in time.
CREATE TABLE IF NOT EXISTS spatial_planning.clerk_dispatch (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_application_id UUID NOT NULL
                          REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  dispatched_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  delivery_method       VARCHAR(20) NOT NULL DEFAULT 'collected'
                          CHECK (delivery_method IN ('collected', 'registered_post', 'courier', 'email')),
  recipient             VARCHAR(300) NOT NULL,
  proof_of_delivery_ref VARCHAR(120),
  notes                 TEXT,

  dispatched_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  dispatched_by_name    VARCHAR(160) NOT NULL,
  voided_at             TIMESTAMP WITH TIME ZONE,
  voided_reason         TEXT,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Collected over the counter is proved by the signature in the book, which
  -- is the reference. Post and courier are proved by the tracking number.
  -- Neither is optional: "we sent it" without a reference loses the appeal.
  CONSTRAINT clerk_dispatch_posted_is_tracked
    CHECK (delivery_method NOT IN ('registered_post', 'courier')
           OR (proof_of_delivery_ref IS NOT NULL AND length(trim(proof_of_delivery_ref)) > 0)),
  CONSTRAINT clerk_dispatch_void_reasoned
    CHECK (voided_at IS NULL OR (voided_reason IS NOT NULL AND length(trim(voided_reason)) > 0))
);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. REFUSAL LETTERS  (7 days from the Council resolution)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS spatial_planning.clerk_refusal (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_no               VARCHAR(40) NOT NULL UNIQUE,
  permit_application_id   UUID NOT NULL
                            REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  council_resolution_date TIMESTAMP WITH TIME ZONE NOT NULL,
  due_by                  TIMESTAMP WITH TIME ZONE NOT NULL,
  sent_at                 TIMESTAMP WITH TIME ZONE,
  sent_method             VARCHAR(16) CHECK (sent_method IS NULL OR sent_method IN (
                            'registered_post', 'ordinary_post', 'email', 'hand', 'courier')),
  recipient               VARCHAR(300) NOT NULL,
  -- A refusal without reasons is void, and the applicant cannot appeal one.
  -- The database says so rather than trusting a form.
  reasons                 TEXT NOT NULL CHECK (length(trim(reasons)) > 0),
  notes                   TEXT,

  drafted_by              UUID REFERENCES public.users(id) ON DELETE SET NULL,
  drafted_by_name         VARCHAR(160) NOT NULL,
  voided_at               TIMESTAMP WITH TIME ZONE,
  voided_reason           TEXT,
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT clerk_refusal_due_after_resolution CHECK (due_by >= council_resolution_date),
  CONSTRAINT clerk_refusal_sent_has_method CHECK (sent_at IS NULL OR sent_method IS NOT NULL),
  CONSTRAINT clerk_refusal_void_reasoned
    CHECK (voided_at IS NULL OR (voided_reason IS NOT NULL AND length(trim(voided_reason)) > 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_clerk_refusal_live_per_permit
  ON spatial_planning.clerk_refusal (permit_application_id)
  WHERE voided_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. NEWSPAPER NOTICE CERTIFICATES
-- ═══════════════════════════════════════════════════════════════════════
-- The publisher's certificate that the notice ran, on the date it says. This
-- is the admissible proof of statutory advertisement; the objection period
-- is counted from `advert_date`.
CREATE TABLE IF NOT EXISTS spatial_planning.clerk_notice_certificate (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_application_id   UUID NOT NULL
                            REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  newspaper_name          VARCHAR(160) NOT NULL,
  advert_date             DATE NOT NULL,
  -- The second insertion, where the council advertises twice.
  second_advert_date      DATE,
  certificate_received_at DATE,
  objection_closes_on     DATE,
  filed_under_ref         VARCHAR(120) NOT NULL,
  notes                   TEXT,

  filed_by                UUID REFERENCES public.users(id) ON DELETE SET NULL,
  filed_by_name           VARCHAR(160) NOT NULL,
  voided_at               TIMESTAMP WITH TIME ZONE,
  voided_reason           TEXT,
  created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT clerk_cert_second_after_first
    CHECK (second_advert_date IS NULL OR second_advert_date >= advert_date),
  CONSTRAINT clerk_cert_void_reasoned
    CHECK (voided_at IS NULL OR (voided_reason IS NOT NULL AND length(trim(voided_reason)) > 0))
);

-- ═══════════════════════════════════════════════════════════════════════
-- 7. ABUTTING-OWNER NOTIFICATIONS
-- ═══════════════════════════════════════════════════════════════════════
-- One row per neighbour served. An objection from someone who was never
-- served is a live ground of appeal, so the register is per-person and keeps
-- the delivery receipt reference.
CREATE TABLE IF NOT EXISTS spatial_planning.clerk_abutter_notice (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_application_id UUID NOT NULL
                          REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  abutter_name          VARCHAR(200) NOT NULL,
  abutter_stand_number  VARCHAR(40),
  abutter_address       VARCHAR(300) NOT NULL,
  notified_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  method                VARCHAR(20) NOT NULL DEFAULT 'hand_delivered'
                          CHECK (method IN ('registered_post', 'courier', 'hand_delivered', 'email')),
  receipt_ref           VARCHAR(120),
  responded             BOOLEAN NOT NULL DEFAULT FALSE,
  notes                 TEXT,

  served_by             UUID REFERENCES public.users(id) ON DELETE SET NULL,
  served_by_name        VARCHAR(160) NOT NULL,
  voided_at             TIMESTAMP WITH TIME ZONE,
  voided_reason         TEXT,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT clerk_abutter_posted_is_tracked
    CHECK (method NOT IN ('registered_post', 'courier')
           OR (receipt_ref IS NOT NULL AND length(trim(receipt_ref)) > 0)),
  CONSTRAINT clerk_abutter_void_reasoned
    CHECK (voided_at IS NULL OR (voided_reason IS NOT NULL AND length(trim(voided_reason)) > 0))
);

-- ═══════════════════════════════════════════════════════════════════════
-- 8. FILE MOVEMENT REGISTER
-- ═══════════════════════════════════════════════════════════════════════
-- Where the physical file is. This system digitises the workflow, but the
-- signed plans, the title deed copy and the bondholder's consent are paper,
-- and a planning office loses a working week a month to files nobody can
-- find. One row per movement out; `returned_at` closes it. The live holder
-- is the newest open row.
CREATE TABLE IF NOT EXISTS spatial_planning.clerk_file_movement (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_application_id UUID NOT NULL
                          REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  issued_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  holder_name           VARCHAR(160) NOT NULL,
  holder_id             UUID REFERENCES public.users(id) ON DELETE SET NULL,
  destination           VARCHAR(40) NOT NULL CHECK (destination IN (
                          'planner', 'eo_planner', 'gis_officer', 'building_inspector',
                          'env_officer', 'committee', 'legal', 'treasury', 'registry',
                          'chief_executive', 'external', 'other')),
  purpose               VARCHAR(300) NOT NULL,
  due_back_on           DATE NOT NULL,
  returned_at           TIMESTAMP WITH TIME ZONE,
  returned_condition    VARCHAR(12) CHECK (returned_condition IS NULL
                          OR returned_condition IN ('intact', 'incomplete', 'damaged')),
  notes                 TEXT,

  issued_by             UUID REFERENCES public.users(id) ON DELETE SET NULL,
  issued_by_name        VARCHAR(160) NOT NULL,
  voided_at             TIMESTAMP WITH TIME ZONE,
  voided_reason         TEXT,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT clerk_movement_return_dated
    CHECK (returned_at IS NULL OR returned_condition IS NOT NULL),
  CONSTRAINT clerk_movement_void_reasoned
    CHECK (voided_at IS NULL OR (voided_reason IS NOT NULL AND length(trim(voided_reason)) > 0))
);

-- A file can be in one place at a time. Two open movements for one file is
-- the exact bookkeeping error this register exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clerk_movement_one_open_per_file
  ON spatial_planning.clerk_file_movement (permit_application_id)
  WHERE returned_at IS NULL AND voided_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. PUBLIC INSPECTION REGISTER
-- ═══════════════════════════════════════════════════════════════════════
-- The Development Register is open to public inspection, and the council
-- records who inspected what. It is also where a request for a certified
-- copy or a planning search is logged and priced.
CREATE TABLE IF NOT EXISTS spatial_planning.clerk_public_inspection (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspected_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  permit_application_id UUID REFERENCES spatial_planning.permit_application(id) ON DELETE SET NULL,
  -- Free text for a request against a stand with no application on file,
  -- which is most planning searches by a conveyancer.
  subject_description   VARCHAR(300) NOT NULL,

  requester_name        VARCHAR(200) NOT NULL,
  requester_contact     VARCHAR(120),
  requester_capacity    VARCHAR(20) NOT NULL DEFAULT 'member_of_public'
                          CHECK (requester_capacity IN (
                            'member_of_public', 'owner', 'agent', 'conveyancer',
                            'surveyor', 'developer', 'other_authority', 'media')),
  request_kind          VARCHAR(20) NOT NULL DEFAULT 'inspection'
                          CHECK (request_kind IN (
                            'inspection', 'certified_copy', 'planning_search', 'plan_copy')),
  copies_issued         INTEGER NOT NULL DEFAULT 0 CHECK (copies_issued >= 0),
  fee_receipt_id        UUID REFERENCES spatial_planning.clerk_fee_receipt(id) ON DELETE SET NULL,
  notes                 TEXT,

  attended_by           UUID REFERENCES public.users(id) ON DELETE SET NULL,
  attended_by_name      VARCHAR(160) NOT NULL,
  voided_at             TIMESTAMP WITH TIME ZONE,
  voided_reason         TEXT,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Copies are a charged service. Issuing them without a receipt is how a
  -- counter loses money, so the register will not record it.
  CONSTRAINT clerk_inspection_copies_receipted
    CHECK (copies_issued = 0 OR fee_receipt_id IS NOT NULL),
  CONSTRAINT clerk_inspection_void_reasoned
    CHECK (voided_at IS NULL OR (voided_reason IS NOT NULL AND length(trim(voided_reason)) > 0))
);

-- ═══════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════
-- Every register is read two ways: newest-first for the register view, and
-- by file for the case view. Those are the two indexes each one gets.
-- The deadline indexes are partial on the open rows, because the overdue
-- query is the one the dashboard runs on every load and the sent letters
-- are the overwhelming majority of the table within a month.

CREATE INDEX IF NOT EXISTS idx_clerk_corr_recent
  ON spatial_planning.clerk_correspondence (logged_at DESC) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clerk_corr_permit
  ON spatial_planning.clerk_correspondence (permit_application_id, logged_at DESC);

CREATE INDEX IF NOT EXISTS idx_clerk_receipt_recent
  ON spatial_planning.clerk_fee_receipt (paid_at DESC) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clerk_receipt_permit
  ON spatial_planning.clerk_fee_receipt (permit_application_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_clerk_ack_outstanding
  ON spatial_planning.clerk_acknowledgement (due_by) WHERE sent_at IS NULL AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clerk_ack_determination
  ON spatial_planning.clerk_acknowledgement (determination_due_by)
  WHERE determination_due_by IS NOT NULL AND voided_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_clerk_dispatch_permit
  ON spatial_planning.clerk_dispatch (permit_application_id, dispatched_at DESC);
CREATE INDEX IF NOT EXISTS idx_clerk_dispatch_recent
  ON spatial_planning.clerk_dispatch (dispatched_at DESC) WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_clerk_refusal_outstanding
  ON spatial_planning.clerk_refusal (due_by) WHERE sent_at IS NULL AND voided_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_clerk_cert_permit
  ON spatial_planning.clerk_notice_certificate (permit_application_id, advert_date DESC);
CREATE INDEX IF NOT EXISTS idx_clerk_cert_objection_window
  ON spatial_planning.clerk_notice_certificate (objection_closes_on)
  WHERE objection_closes_on IS NOT NULL AND voided_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_clerk_abutter_permit
  ON spatial_planning.clerk_abutter_notice (permit_application_id, notified_at DESC);

CREATE INDEX IF NOT EXISTS idx_clerk_movement_open
  ON spatial_planning.clerk_file_movement (due_back_on)
  WHERE returned_at IS NULL AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clerk_movement_permit
  ON spatial_planning.clerk_file_movement (permit_application_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_clerk_inspection_recent
  ON spatial_planning.clerk_public_inspection (inspected_at DESC) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clerk_inspection_permit
  ON spatial_planning.clerk_public_inspection (permit_application_id, inspected_at DESC);

-- ═══════════════════════════════════════════════════════════════════════
-- TRIGGERS — updated_at, via the function migration 070 already defines
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'clerk_correspondence',
    'clerk_fee_receipt',
    'clerk_acknowledgement',
    'clerk_dispatch',
    'clerk_refusal',
    'clerk_notice_certificate',
    'clerk_abutter_notice',
    'clerk_file_movement',
    'clerk_public_inspection'
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

-- ═══════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════════
COMMENT ON TABLE spatial_planning.clerk_correspondence IS
  'Planning office correspondence log: every letter, email, fax, call and counter visit in or out.';
COMMENT ON TABLE spatial_planning.clerk_fee_receipt IS
  'Counter cashbook. Manual receipts issued at the Planning desk, reconciled against public.payments.';
COMMENT ON TABLE spatial_planning.clerk_acknowledgement IS
  'Acknowledgement letters. Five working days from receipt; also carries the three-month determination date.';
COMMENT ON TABLE spatial_planning.clerk_dispatch IS
  'Permit dispatch and proof of delivery. The appeal window runs from service, recorded here.';
COMMENT ON TABLE spatial_planning.clerk_refusal IS
  'Refusal letters. Seven days from the Council resolution; reasons are mandatory.';
COMMENT ON TABLE spatial_planning.clerk_notice_certificate IS
  'Newspaper publication certificates — the admissible proof of statutory advertisement.';
COMMENT ON TABLE spatial_planning.clerk_abutter_notice IS
  'Abutting-owner notifications, one row per neighbour served, with the delivery receipt.';
COMMENT ON TABLE spatial_planning.clerk_file_movement IS
  'Physical file movement register. One open row per file: where the paper is and who has it.';
COMMENT ON TABLE spatial_planning.clerk_public_inspection IS
  'Public inspection of the Development Register, plus certified copies and planning searches.';

COMMIT;
