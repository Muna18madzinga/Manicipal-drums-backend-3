-- Migration 087: persist generated decision documents in the database
--
-- Migration 085 created spatial_planning.generated_document to hold the
-- council's authoritative copies of letters/reports that were previously only
-- produced client-side. It modelled storage_url as a NOT NULL file pointer —
-- but the production deploy (Render) has an EPHEMERAL filesystem, so a file on
-- disk is lost on every redeploy. For the EO decision letters (approval,
-- conditional approval, refusal) we therefore store the rendered document
-- CONTENT in the database and serve it through an API route, rather than
-- writing a file.
--
-- This migration:
--   1. Adds generated_document.content — the rendered letter (HTML).
--   2. Adds generated_document.title   — a human title for listings.
--   3. Drops the NOT NULL on storage_url so a DB-stored document needs no file.
--
-- Depends on: 085 (generated_document), 086.
-- Idempotent: safe to re-run.
-- Apply with: node scripts/migrate-render.js  (087 is in the MIGRATIONS array)

BEGIN;

ALTER TABLE spatial_planning.generated_document
  ADD COLUMN IF NOT EXISTS content TEXT,
  ADD COLUMN IF NOT EXISTS title   VARCHAR(200);

-- A DB-stored document (content present) needs no external file pointer.
ALTER TABLE spatial_planning.generated_document
  ALTER COLUMN storage_url DROP NOT NULL;

COMMENT ON COLUMN spatial_planning.generated_document.content IS
  'Rendered document body (HTML) stored in-DB. Used when storage_url is NULL (ephemeral-filesystem deploys). Served via GET /generated-documents/:id.';
COMMENT ON COLUMN spatial_planning.generated_document.title IS
  'Human-readable document title for listings (e.g. "Development Permit — Conditional Approval").';

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 087 complete — generated_document content storage installed';
  RAISE NOTICE '   Altered: generated_document (+content, +title, storage_url now nullable)';
END $$;
