-- Migration 088: allow map evidence as a generated document type
--
-- The EO decision workspace can capture a GIS map snapshot (the application on
-- the basemap with zoning / land-use / environmental / infrastructure layers)
-- and save it to the decision record. We persist it as a generated_document
-- (PNG data URL in content, migration 087) — but generated_document.doc_type
-- has a CHECK constraint that does not yet include a map-evidence type.
--
-- This migration extends that CHECK to add 'map_evidence'.
--
-- Depends on: 085 (generated_document + its doc_type CHECK), 087 (content column).
-- Idempotent: safe to re-run (DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT).
-- Apply with: node scripts/migrate-render.js  (088 is in the MIGRATIONS array)

BEGIN;

ALTER TABLE spatial_planning.generated_document
  DROP CONSTRAINT IF EXISTS generated_document_doc_type_check;

ALTER TABLE spatial_planning.generated_document
  ADD CONSTRAINT generated_document_doc_type_check CHECK (doc_type IN (
    'due_diligence_report',
    'committee_report',
    'decision_memo',
    'permit',
    'refusal_letter',
    'outcome_letter',
    'acknowledgement',
    'map_evidence'
  ));

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 088 complete — map_evidence doc_type allowed';
END $$;
