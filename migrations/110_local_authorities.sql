-- Migration 110: local_authorities contact register
--
-- src/routes/parcels.js (jurisdictionResolver) reads this table to attach
-- the responsible authority's contact details to a located point, but no
-- migration ever created it — it existed only as a hand-made table on the
-- original dev machine, so every fresh install 500'd on /parcels/locate.
--
-- Idempotent: safe to re-run.
-- Apply locally with: node scripts/apply-local-migration.js 110_local_authorities.sql

BEGIN;

CREATE TABLE IF NOT EXISTS local_authorities (
  id             SERIAL PRIMARY KEY,
  authority_name TEXT NOT NULL UNIQUE,
  telephone      TEXT,
  email          TEXT,
  address        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO local_authorities (authority_name, telephone, email, address)
VALUES (
  'Vungu Rural District Council',
  '+263 54 222 741',
  'info@vungurdc.co.zw',
  'Stand 1246, Hertfordshire, Gweru, Zimbabwe'
)
ON CONFLICT (authority_name) DO NOTHING;

COMMIT;
