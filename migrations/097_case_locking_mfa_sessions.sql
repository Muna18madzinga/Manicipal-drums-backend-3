-- Migration 097: optimistic locking, document status, MFA, session revocation
-- ────────────────────────────────────────────────────────────────────────
-- Closes four statutory-defensibility gaps identified in the hardening audit:
--
--   1. permit_application had no revision counter, so two officers editing
--      the same case (migration 082/085's /case and /status PATCH routes)
--      could silently overwrite each other. planning_project already solved
--      this (migration 096) with a `revision` column — same pattern here,
--      without the full snapshot table (permit_event, migration 082, already
--      gives per-field audit history; a second snapshot table would duplicate it).
--
--   2. generated_document (migration 085/087) had no lifecycle status, so a
--      draft and an issued/superseded record were indistinguishable.
--
--   3. No MFA columns existed anywhere — TOTP for staff/admin accounts.
--
--   4. Refresh tokens were stateless JWTs with no server-side record, so
--      logout / suspension / "revoke this device" could not invalidate an
--      already-issued refresh token before its 14-day expiry.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT EXISTS).
-- Apply with: node scripts/migrate-render.js (097 is in the MIGRATIONS array)

BEGIN;

-- 1. Optimistic locking on permit_application ----------------------------
ALTER TABLE spatial_planning.permit_application
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN spatial_planning.permit_application.revision IS
  'Optimistic-lock counter. Case/status PATCH routes require the caller''s expectedRevision to match before writing, and bump this by 1 on success. Mismatch => 409 conflict, not a silent overwrite.';

-- 2. Document lifecycle status -------------------------------------------
ALTER TABLE spatial_planning.generated_document
  ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'issued'
    CHECK (status IN ('draft', 'approved', 'issued', 'superseded', 'voided'));

COMMENT ON COLUMN spatial_planning.generated_document.status IS
  'Lifecycle of this document version: draft (not yet finalised) | approved (signed off, not yet sent) | issued (the authoritative copy) | superseded (a later version now takes precedence) | voided (withdrawn, never valid).';

-- Existing rows (decision letters, map evidence) were always written at the
-- moment of issuance, so they backfill as 'issued' via the column default —
-- no explicit UPDATE needed.

-- 3. MFA (TOTP) for staff/admin accounts ----------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS mfa_enabled      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mfa_secret       TEXT,
  ADD COLUMN IF NOT EXISTS mfa_backup_codes JSONB;

COMMENT ON COLUMN public.users.mfa_secret IS
  'Base32 TOTP secret. Only present while mfa_enabled=true or between /mfa/setup and /mfa/verify. Never returned to the client after enrolment.';
COMMENT ON COLUMN public.users.mfa_backup_codes IS
  'Array of bcrypt-hashed one-time backup codes, consumed on use. Regenerated whenever MFA is re-enabled.';

-- 4. Session table for refresh-token rotation/revocation ------------------
CREATE TABLE IF NOT EXISTS public.user_session (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(64) NOT NULL,   -- sha256 hex of the refresh JWT; never the raw token
  user_agent        TEXT,
  ip                VARCHAR(64),
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_used_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at        TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_session_token_hash
  ON public.user_session(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_user_session_user
  ON public.user_session(user_id, revoked_at);

COMMENT ON TABLE public.user_session IS
  'One row per issued refresh token (device/session). Login/refresh insert or rotate a row; logout and admin "revoke session" set revoked_at. /auth/refresh rejects a token whose session row is missing, revoked, or past expires_at, giving real (not just stateless-JWT) logout invalidation and device revocation.';

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 097 complete — case locking, document status, MFA, session revocation installed';
  RAISE NOTICE '   Altered: permit_application (+revision), generated_document (+status), users (+mfa_*)';
  RAISE NOTICE '   Table  : user_session';
END $$;
