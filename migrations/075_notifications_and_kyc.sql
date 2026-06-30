-- Migration 075: workflow_notifications + kyc_verifications tables
-- Provides cross-department document routing and identity verification.
-- Idempotent: CREATE TABLE IF NOT EXISTS throughout.

-- ── Workflow notifications ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_notifications (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_application_id  UUID REFERENCES spatial_planning.permit_applications(id) ON DELETE SET NULL,
  title                  TEXT NOT NULL,
  message                TEXT NOT NULL,
  kind                   TEXT NOT NULL DEFAULT 'info',  -- info | success | warning | error
  recipient_role         TEXT NOT NULL DEFAULT 'all',   -- role slug or 'all'
  recipient_user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  read_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wn_recipient_role ON workflow_notifications (recipient_role);
CREATE INDEX IF NOT EXISTS idx_wn_recipient_user ON workflow_notifications (recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_wn_created_at     ON workflow_notifications (created_at DESC);

-- ── KYC / identity verifications ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kyc_verifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  id_type         TEXT NOT NULL CHECK (id_type IN ('national_id','passport','drivers_licence')),
  id_number       TEXT NOT NULL,
  full_name       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewer_notes  TEXT,
  reviewed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kyc_status  ON kyc_verifications (status);
CREATE INDEX IF NOT EXISTS idx_kyc_user_id ON kyc_verifications (user_id);
