-- 119_permit_document_uploads.sql
-- File metadata for permit documents uploaded directly against a permit.
--
-- Migration 085 created spatial_planning.permit_document as a polymorphic LINK
-- table — (document_id, source) pointing at citizen_documents, application
-- documents or generated_document — and its own comment says it exists "so
-- GET /permit-applications/:id/documents can list them". Those routes were
-- never written, so every upload path in the app (citizen supporting documents,
-- planner intake, planning-clerk receipt, inspector case file) failed.
--
-- A direct upload has no row in any of those source tables, and it does not
-- belong in citizen_documents: that table is identity/KYC-shaped, its doc_kind
-- CHECK has no 'site_plan' or 'building_plan', and it carries a verification
-- workflow that a site plan should not enter. So `source = 'external'` uploads
-- keep their metadata here. Linked rows leave these columns NULL and the route
-- resolves their metadata from the source table.

BEGIN;

ALTER TABLE spatial_planning.permit_document
  ADD COLUMN IF NOT EXISTS file_name  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS mime_type  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS bytes      BIGINT,
  ADD COLUMN IF NOT EXISTS sha256_hex CHAR(64);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'permit_document_bytes_check'
       AND conrelid = 'spatial_planning.permit_document'::regclass
  ) THEN
    ALTER TABLE spatial_planning.permit_document
      ADD CONSTRAINT permit_document_bytes_check CHECK (bytes IS NULL OR bytes > 0);
  END IF;
END $$;

-- The same file attached twice to one permit is a duplicate, not a second
-- document. Partial: linked rows have no hash and are deduplicated by the
-- existing UNIQUE (permit_app_id, document_id, source).
CREATE UNIQUE INDEX IF NOT EXISTS uq_permit_document_hash
  ON spatial_planning.permit_document(permit_app_id, sha256_hex)
  WHERE sha256_hex IS NOT NULL;

COMMENT ON COLUMN spatial_planning.permit_document.sha256_hex IS
  'Content hash of a directly uploaded file (source = external). NULL for rows that link an existing document.';

COMMIT;
