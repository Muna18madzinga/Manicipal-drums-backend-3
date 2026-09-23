-- 126_password_reset.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Self-service password reset.
--
-- WHY THIS EXISTS
-- The portal shipped with no way to recover an account. The sign-in screen's
-- "Forgot?" link was a `mailto:` to support@vungurdc.gov.zw, and the only
-- real reset in the system is POST /admin/users/:id/reset-password — an IT
-- admin typing a new password for someone and then telling it to them.
--
-- For a council with nine staff roles and a public register of citizens that
-- is three separate failures at once:
--   1. Every forgotten password is a support ticket and a phone call.
--   2. The new password travels by voice or by chat, in the clear, and is
--      usually not changed afterwards.
--   3. The admin who resets it knows it. Separation of duties is gone: the
--      IT desk can sign in as a planner and approve a permit.
-- Sign-in lockout (124) makes it worse, not better — a locked-out officer
-- now has no route back at all without IT.
--
-- WHAT IS STORED
-- Never the token. The emailed secret is 32 random bytes, base64url; what
-- lands here is its SHA-256. A dump of this table cannot be used to take an
-- account, and the token exists in exactly one place: the email.
--
-- Rows are kept after use (used_at stamped) rather than deleted, for the same
-- reason the clerk's registers have no DELETE: "who asked to reset this
-- account, from where, and was it used" is a security record. The sweep in
-- step 3 removes only rows that are long dead.
--
-- Idempotent. Apply individually (docs/db-rebuild-2026-09-21.md):
--   node scripts/apply-local-migration.js migrations/126_password_reset.sql
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.password_reset_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- SHA-256 of the emailed secret, hex. UNIQUE so a token can never be
  -- issued twice, and so the lookup is an index probe on a fixed-width key.
  token_hash    char(64) NOT NULL UNIQUE,

  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,

  -- Who asked. Recorded because a burst of requests against one account from
  -- one address is the signal that someone is working on that account, and
  -- the IT console's Sign-in security section has nowhere else to read it.
  requested_ip  text,
  requested_ua  text,

  created_at    timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT password_reset_window CHECK (expires_at > created_at)
);

-- The two queries this table serves: "the live token for this user" (issue
-- invalidates the previous ones) and the sweep.
CREATE INDEX IF NOT EXISTS password_reset_token_user_idx
  ON public.password_reset_token (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS password_reset_token_expiry_idx
  ON public.password_reset_token (expires_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE public.password_reset_token IS
  'Self-service password reset. Stores SHA-256 of the emailed secret, never the secret.';

COMMIT;
