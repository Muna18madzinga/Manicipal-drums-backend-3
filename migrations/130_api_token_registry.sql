-- 130_api_token_registry.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Registry of issued QGIS/API tokens, so each one can be revoked.
--
-- WHY THIS EXISTS
-- POST /auth/generate-api-token signs a stateless JWT (type:'api'). Before
-- this migration nothing recorded it, so a leaked token could only be killed
-- by deactivating the admin who issued it or rotating JWT_SECRET (which signs
-- out every user). 076 tried to add a revocation list but declared
-- user_id INTEGER against a uuid users.id, so it never applied anywhere.
--
-- Every token now carries a jti; verification requires a row here with
-- revoked_at NULL. A token with no row (including any minted before this
-- migration) is rejected and must be reissued.
--
-- Never stores the token itself, only its jti (a random uuid).
--
-- Rollback: 130_api_token_registry.down.sql (not in the allowlist).
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.api_token (
  jti          uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin       text,
  issued_at    timestamptz NOT NULL DEFAULT NOW(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_api_token_user ON public.api_token (user_id);

COMMIT;
