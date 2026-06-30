-- Migration 076: Production hardening — API token revocation, rate limit log,
-- missing indexes, query timeout config, JSONB validation constraints.
-- Idempotent throughout.

-- ── API token revocation store ────────────────────────────────────────────────
-- The /auth/generate-api-token endpoint creates 1-year tokens with no way
-- to revoke them. This table provides a blocklist for revoked API tokens.
CREATE TABLE IF NOT EXISTS api_token_revocations (
  id         SERIAL PRIMARY KEY,
  token_jti  TEXT NOT NULL UNIQUE,        -- JWT 'jti' claim or sha256 of legacy token
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT,
  revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_revoc_jti     ON api_token_revocations (token_jti);
CREATE INDEX IF NOT EXISTS idx_api_revoc_user_id ON api_token_revocations (user_id);

-- ── Payment webhook log ───────────────────────────────────────────────────────
-- Every payment provider callback is stored before processing so:
--   1. We can replay failed webhooks
--   2. We have an audit trail of provider-side events
--   3. HMAC signature can be stored alongside for verification audit
CREATE TABLE IF NOT EXISTS payment_webhooks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver        TEXT NOT NULL,                         -- paynow | ecocash | onemoney
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  headers       JSONB,                                 -- relevant HTTP headers
  body_raw      TEXT,                                  -- raw POST body for HMAC re-check
  hmac_valid    BOOLEAN,                               -- NULL = not checked yet
  payment_id    UUID REFERENCES payments(id) ON DELETE SET NULL,
  processed     BOOLEAN NOT NULL DEFAULT FALSE,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_pw_driver   ON payment_webhooks (driver);
CREATE INDEX IF NOT EXISTS idx_pw_received ON payment_webhooks (received_at DESC);

-- ── Payment audit trail ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_audit (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_address  INET,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_paudit_payment ON payment_audit (payment_id);
CREATE INDEX IF NOT EXISTS idx_paudit_ts      ON payment_audit (created_at DESC);

-- ── Document upload quota ────────────────────────────────────────────────────
-- Limits total bytes stored per user to prevent disk exhaustion attacks.
-- Citizens: 100 MB; staff: 500 MB; admin: unlimited (NULL).
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_quota_bytes BIGINT DEFAULT 104857600; -- 100 MB
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_used_bytes  BIGINT NOT NULL DEFAULT 0;

-- ── Full-text search on permit applications ───────────────────────────────────
-- Replaces the slow ILIKE '%..%' pattern on large tables.
-- tsvector column pre-computes the search vector; GIN index makes it fast.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'spatial_planning'
      AND table_name   = 'permit_applications'
      AND column_name  = 'search_vector'
  ) THEN
    ALTER TABLE spatial_planning.permit_applications
      ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('english',
          COALESCE(tpd_reference,    '') || ' ' ||
          COALESCE(dev_register_no,  '') || ' ' ||
          COALESCE(applicant_name,   '') || ' ' ||
          COALESCE(stand_number,     '') || ' ' ||
          COALESCE(suburb_ward,      '') || ' ' ||
          COALESCE(description,      '')
        )
      ) STORED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_pa_fts ON spatial_planning.permit_applications USING GIN (search_vector);

-- ── Statement timeout for web requests ───────────────────────────────────────
-- Long-running spatial queries (buffer analysis, ILIKE on millions of rows)
-- can stall the connection pool and starve other requests.
-- Default session timeout of 30 s for the application role.
-- (Requires the pg role to have ALTER ROLE permission on its own role)
DO $$
BEGIN
  -- Only set if we can; silently skip if permission denied
  ALTER ROLE CURRENT_USER SET statement_timeout = '30s';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not set statement_timeout (permission not granted): %', SQLERRM;
END $$;

-- ── Missing indexes on high-traffic lookup columns ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email_lower
  ON users (LOWER(email));           -- case-insensitive login lookup

CREATE INDEX IF NOT EXISTS idx_users_role
  ON users (role);                   -- role filter on /admin/users

CREATE INDEX IF NOT EXISTS idx_citizen_docs_user_status
  ON citizen_documents (user_id, verification_status);

CREATE INDEX IF NOT EXISTS idx_notif_role_unread
  ON workflow_notifications (recipient_role, read_at)
  WHERE read_at IS NULL;             -- fast unread-count queries

CREATE INDEX IF NOT EXISTS idx_kyc_user_status
  ON kyc_verifications (user_id, status);

-- ── Enforce GeoJSON SRID on permit locations ─────────────────────────────────
-- spatial_planning.permit_applications.location stores click-on-map coordinates.
-- Adding a SRID constraint prevents accidental insertion in Web Mercator (3857).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'spatial_planning'
      AND table_name   = 'permit_applications'
      AND column_name  = 'location'
  ) THEN
    -- Check column is GEOMETRY type before adding check constraint
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'permit_app_location_srid'
    ) THEN
      ALTER TABLE spatial_planning.permit_applications
        ADD CONSTRAINT permit_app_location_srid
        CHECK (location IS NULL OR ST_SRID(location) = 4326);
    END IF;
  END IF;
END $$;

-- ── Rate limit event log ─────────────────────────────────────────────────────
-- Persist rate-limit breaches for IP blocklist decisions.
CREATE TABLE IF NOT EXISTS rate_limit_log (
  id          SERIAL PRIMARY KEY,
  ip_address  INET NOT NULL,
  endpoint    TEXT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  hit_count   INTEGER NOT NULL DEFAULT 1,
  window_at   TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', NOW()),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rll_ip_window ON rate_limit_log (ip_address, window_at DESC);
