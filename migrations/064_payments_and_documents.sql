-- Migration 064: payments + exchange rates + verifiable documents.
--
-- Three concerns, one migration so the FK relationships stay coherent:
--
-- 1. exchange_rates — interbank USD↔ZiG rate, cached by (rate_date, source).
--    Citizens pay in USD or ZiG; we always store both legs of the
--    transaction so an amount paid is unambiguous regardless of how
--    the rate moves. The `source` column lets us record where we got
--    the quote (e.g. RBZ public rate, fallback manual override).
--
-- 2. payments — header rows. One per citizen-initiated transaction.
--    Provider integration (Paynow / Stripe) lives behind the
--    src/services/paymentDriver.js interface; this table records what
--    the system asked for, the provider's reference, and the eventual
--    outcome.
--
-- 3. citizen_documents — the citizen's national ID, proof of residence,
--    deeds copy, etc. Each row goes through verification_status:
--    pending → under_review → verified | rejected. The actual
--    biometric / OCR check is performed by an external SDK
--    (src/services/idVerifier.js); this table holds the verdict.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. EXCHANGE RATES
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS exchange_rates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_date    DATE         NOT NULL,
  base_ccy     VARCHAR(8)   NOT NULL DEFAULT 'USD',
  quote_ccy   VARCHAR(8)    NOT NULL DEFAULT 'ZWG',
  -- 1 USD = `rate` ZWG. NUMERIC for exactness; never use FLOAT for money.
  rate         NUMERIC(20, 8) NOT NULL CHECK (rate > 0),
  source       VARCHAR(64)  NOT NULL,                    -- 'rbz', 'manual_override', etc.
  source_url   TEXT,
  fetched_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (rate_date, base_ccy, quote_ccy, source)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_lookup
  ON exchange_rates(base_ccy, quote_ccy, rate_date DESC);

COMMENT ON TABLE exchange_rates IS
  'Daily interbank rates. The system selects the most recent (rate_date DESC) '
  'when computing ZiG↔USD conversion. Authority defaults to RBZ.';

-- ════════════════════════════════════════════════════════════════════
-- 2. PAYMENTS
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What the payment is FOR. We persist the foreign-key as a string so
  -- the same payments table can settle inspection bookings, application
  -- fees, and other future kinds without DDL each time.
  purpose         VARCHAR(32) NOT NULL
                    CHECK (purpose IN (
                      'application_fee',
                      'inspection_fee',
                      'permit_fee',
                      'occupation_certificate',
                      'other'
                    )),
  related_kind    VARCHAR(32),                      -- 'inspection_booking', 'development_application', ...
  related_id      VARCHAR(64),                      -- the related row id

  payer_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  payer_email     VARCHAR(255),
  payer_phone     VARCHAR(32),

  -- Money. We store BOTH legs at the moment the payment was initiated
  -- so a customer cannot be charged a different amount when the rate
  -- changes mid-transaction. The wallet currency is what the citizen
  -- actually pays in; the canonical USD column is the council's books.
  amount_usd      NUMERIC(14, 2) NOT NULL CHECK (amount_usd >= 0),
  amount_zwg      NUMERIC(16, 2) NOT NULL CHECK (amount_zwg >= 0),
  rate_used       NUMERIC(20, 8) NOT NULL CHECK (rate_used > 0),
  rate_id         UUID REFERENCES exchange_rates(id) ON DELETE SET NULL,
  wallet_ccy      VARCHAR(8) NOT NULL CHECK (wallet_ccy IN ('USD','ZWG')),

  -- Provider integration.
  driver          VARCHAR(32) NOT NULL DEFAULT 'manual'
                    CHECK (driver IN ('manual','paynow','stripe','ecocash','onemoney')),
  provider_ref    VARCHAR(255),                     -- e.g. Paynow poll URL or Stripe pi_...
  provider_status VARCHAR(64),                      -- raw last status from provider

  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending',           -- created but not yet paid
                      'awaiting_provider', -- handed off to provider
                      'paid',              -- confirmed
                      'failed',
                      'cancelled',
                      'refunded'
                    )),

  -- Receipt. issued_receipt_no is created on confirmation and is what
  -- the citizen sees on the front-end (council prefers a human-readable
  -- monotonic number rather than a UUID).
  issued_receipt_no VARCHAR(32),
  paid_at         TIMESTAMP WITH TIME ZONE,
  receipt_url     TEXT,                              -- generated PDF URL

  metadata        JSONB NOT NULL DEFAULT '{}'::JSONB,

  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_payer        ON payments(payer_id);
CREATE INDEX IF NOT EXISTS idx_payments_related      ON payments(related_kind, related_id);
CREATE INDEX IF NOT EXISTS idx_payments_status       ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_provider_ref ON payments(provider_ref) WHERE provider_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_receipt_no
  ON payments(issued_receipt_no) WHERE issued_receipt_no IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════
-- 3. DOCUMENTS (verifiable / verified)
-- ════════════════════════════════════════════════════════════════════
--
-- Replaces nothing — application_documents already exists for the
-- generic "PDF attached to an application" case. This table is for
-- IDENTITY / OWNERSHIP documents that need verification before they
-- can be trusted by the workflow. Examples: National ID, passport,
-- proof of residence, title deed.

CREATE TABLE IF NOT EXISTS citizen_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  doc_kind        VARCHAR(32) NOT NULL
                    CHECK (doc_kind IN (
                      'national_id',
                      'passport',
                      'drivers_licence',
                      'proof_of_residence',
                      'title_deed',
                      'company_registration',
                      'tax_clearance',
                      'other'
                    )),

  storage_url     TEXT     NOT NULL,
  mime_type       VARCHAR(64) NOT NULL,
  bytes           BIGINT   NOT NULL CHECK (bytes > 0),
  sha256_hex      VARCHAR(64),

  -- Optional structured fields once OCR succeeds. NULL until verified.
  extracted_name  VARCHAR(255),
  extracted_id_number VARCHAR(64),
  extracted_dob   DATE,

  -- Verification lifecycle.
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (verification_status IN (
                          'pending',         -- newly uploaded; not yet checked
                          'under_review',    -- staff or auto-check in progress
                          'verified',        -- accepted, may be used as evidence
                          'rejected',        -- failed; reason in verification_notes
                          'expired'          -- previously verified but now stale
                        )),
  verification_notes  TEXT,
  verified_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at        TIMESTAMP WITH TIME ZONE,
  verifier_provider  VARCHAR(32),                          -- 'manual', 'smile_id', 'onfido', ...
  verifier_payload   JSONB,                                 -- raw provider response
  -- Confidence score in [0,1] when the verifier reports one.
  verifier_confidence NUMERIC(5,4),

  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_citizen_documents_user
  ON citizen_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_citizen_documents_status
  ON citizen_documents(verification_status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_citizen_documents_hash_user
  ON citizen_documents(user_id, sha256_hex)
  WHERE sha256_hex IS NOT NULL;

COMMIT;
