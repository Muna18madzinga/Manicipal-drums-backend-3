-- 124_planning_clerk_registers.sql
-- Planning Clerk operational registers — correspondence, fees, acknowledgements,
-- permit dispatch, refusals, notice certificates, abutter notifications.
-- Empty until clerks record real work. No seed data.

BEGIN;

CREATE SCHEMA IF NOT EXISTS planning_clerk;

-- ── Correspondence log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planning_clerk.correspondence (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction               VARCHAR(8) NOT NULL
                            CHECK (direction IN ('in', 'out')),
  date                    TIMESTAMPTZ NOT NULL,
  permit_application_id   UUID,
  ref_no                  VARCHAR(120) NOT NULL DEFAULT '',
  party                   VARCHAR(255) NOT NULL DEFAULT '',
  subject                 VARCHAR(500) NOT NULL DEFAULT '',
  channel                 VARCHAR(16) NOT NULL
                            CHECK (channel IN ('letter', 'email', 'phone', 'in_person', 'fax')),
  attached_doc_ref        VARCHAR(255) NOT NULL DEFAULT '',
  notes                   TEXT NOT NULL DEFAULT '',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS correspondence_date_idx
  ON planning_clerk.correspondence (date DESC);
CREATE INDEX IF NOT EXISTS correspondence_permit_idx
  ON planning_clerk.correspondence (permit_application_id)
  WHERE permit_application_id IS NOT NULL;

-- ── Fee receipts register ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planning_clerk.fee_receipt (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no              VARCHAR(64) NOT NULL,
  fee_kind                VARCHAR(24) NOT NULL
                            CHECK (fee_kind IN (
                              'application', 'public_notice', 'plan_scrutiny',
                              'inspection', 'occupation', 'appeal', 'other')),
  permit_application_id   UUID,
  payer_name              VARCHAR(255) NOT NULL DEFAULT '',
  amount_zwl              NUMERIC(14, 2) NOT NULL CHECK (amount_zwl >= 0),
  paid_at                 TIMESTAMPTZ NOT NULL,
  payment_method          VARCHAR(16) NOT NULL
                            CHECK (payment_method IN ('cash', 'ecocash', 'eft', 'cheque', 'card')),
  reference               VARCHAR(120) NOT NULL DEFAULT '',
  issued_by               VARCHAR(160) NOT NULL DEFAULT '',
  notes                   TEXT NOT NULL DEFAULT '',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS fee_receipt_no_uidx
  ON planning_clerk.fee_receipt (receipt_no);
CREATE INDEX IF NOT EXISTS fee_receipt_paid_at_idx
  ON planning_clerk.fee_receipt (paid_at DESC);
CREATE INDEX IF NOT EXISTS fee_receipt_permit_idx
  ON planning_clerk.fee_receipt (permit_application_id)
  WHERE permit_application_id IS NOT NULL;

-- ── Acknowledgement letters (5-day rule) ────────────────────────────────
CREATE TABLE IF NOT EXISTS planning_clerk.acknowledgement_letter (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_no               VARCHAR(64) NOT NULL,
  permit_application_id   UUID NOT NULL,
  application_register_no VARCHAR(120) NOT NULL DEFAULT '',
  application_received_at TIMESTAMPTZ NOT NULL,
  due_by                  TIMESTAMPTZ NOT NULL,
  sent_at                 TIMESTAMPTZ,
  recipient               VARCHAR(255) NOT NULL DEFAULT '',
  notes                   TEXT NOT NULL DEFAULT '',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS acknowledgement_letter_no_uidx
  ON planning_clerk.acknowledgement_letter (letter_no);
CREATE INDEX IF NOT EXISTS acknowledgement_due_idx
  ON planning_clerk.acknowledgement_letter (due_by)
  WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS acknowledgement_permit_idx
  ON planning_clerk.acknowledgement_letter (permit_application_id);

-- ── Permit dispatch register ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planning_clerk.permit_dispatch (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_application_id   UUID NOT NULL,
  dispatched_at           TIMESTAMPTZ NOT NULL,
  dispatched_by           VARCHAR(160) NOT NULL DEFAULT '',
  delivery_method         VARCHAR(24) NOT NULL
                            CHECK (delivery_method IN (
                              'collected', 'registered_post', 'courier', 'email')),
  recipient               VARCHAR(255) NOT NULL DEFAULT '',
  proof_of_delivery_ref   VARCHAR(255) NOT NULL DEFAULT '',
  notes                   TEXT NOT NULL DEFAULT '',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS permit_dispatch_at_idx
  ON planning_clerk.permit_dispatch (dispatched_at DESC);
CREATE INDEX IF NOT EXISTS permit_dispatch_permit_idx
  ON planning_clerk.permit_dispatch (permit_application_id);

-- ── Refusal letters (7-day rule after Council resolution) ───────────────
CREATE TABLE IF NOT EXISTS planning_clerk.refusal_letter (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_no               VARCHAR(64) NOT NULL,
  permit_application_id   UUID NOT NULL,
  council_resolution_date TIMESTAMPTZ NOT NULL,
  due_by                  TIMESTAMPTZ NOT NULL,
  sent_at                 TIMESTAMPTZ,
  recipient               VARCHAR(255) NOT NULL DEFAULT '',
  reasons                 TEXT NOT NULL DEFAULT '',
  notes                   TEXT NOT NULL DEFAULT '',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS refusal_letter_no_uidx
  ON planning_clerk.refusal_letter (letter_no);
CREATE INDEX IF NOT EXISTS refusal_due_idx
  ON planning_clerk.refusal_letter (due_by)
  WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS refusal_permit_idx
  ON planning_clerk.refusal_letter (permit_application_id);

-- ── Notice certificate register ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planning_clerk.notice_certificate (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_application_id   UUID NOT NULL,
  newspaper_name          VARCHAR(255) NOT NULL DEFAULT '',
  advert_date             TIMESTAMPTZ NOT NULL,
  certificate_received_at TIMESTAMPTZ NOT NULL,
  filed_under_ref         VARCHAR(120) NOT NULL DEFAULT '',
  notes                   TEXT NOT NULL DEFAULT '',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notice_certificate_permit_idx
  ON planning_clerk.notice_certificate (permit_application_id);
CREATE INDEX IF NOT EXISTS notice_certificate_advert_idx
  ON planning_clerk.notice_certificate (advert_date DESC);

-- ── Abutter notification log ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planning_clerk.abutter_notification (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_application_id   UUID NOT NULL,
  abutter_name            VARCHAR(255) NOT NULL DEFAULT '',
  abutter_address         VARCHAR(500) NOT NULL DEFAULT '',
  notified_at             TIMESTAMPTZ NOT NULL,
  method                  VARCHAR(24) NOT NULL
                            CHECK (method IN ('registered_post', 'courier', 'hand_delivered')),
  receipt_ref             VARCHAR(120) NOT NULL DEFAULT '',
  notes                   TEXT NOT NULL DEFAULT '',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS abutter_notification_permit_idx
  ON planning_clerk.abutter_notification (permit_application_id);
CREATE INDEX IF NOT EXISTS abutter_notification_at_idx
  ON planning_clerk.abutter_notification (notified_at DESC);

COMMIT;
