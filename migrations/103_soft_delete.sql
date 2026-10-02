-- 103_soft_delete.sql
-- Stage 1 (C1): soft delete for statutory / evidentiary records.
--
-- Charter rule: no planning record is ever permanently deleted. Routes that
-- previously issued DELETE FROM now set deleted_at/deleted_by instead, and
-- reads filter WHERE deleted_at IS NULL. Recovery = clearing deleted_at.
--
-- Tables covered here (each had a hard-DELETE endpoint):
--   users                              auth.js   DELETE /admin/users/:id
--   citizen_documents                  documents.js DELETE /documents/:id
--   inspection_photos                  inspections.js DELETE photo
--   zone_land_use_controls             zones.js + land-use-management-enhanced.js
--   spatial_planning.planning_project  planning.js DELETE /planning/projects/:id
--   spatial_planning.gis_feature       gis.js DELETE /gis/features/:id
--
-- Deliberately NOT covered:
--   application_drafts  — citizen's own pre-submission scratch, not a record
--   invites (unused)    — ephemeral tokens; revocation must destroy them
--   land_use_groups     — already has is_active; the delete route flips it
--   land_parcels        — survey-module working table with its own project
--                         cascade lifecycle; handled in the survey-module pass
--
-- Idempotent: safe to re-run.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE citizen_documents
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE inspection_photos
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE zone_land_use_controls
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- Guard: those tables are created by later allowlist items (095/091). On a
-- fresh build they do not exist yet; their deleted_at/deleted_by columns are
-- added by 095/091 themselves on the fresh path.
DO $$ BEGIN
  IF to_regclass('spatial_planning.planning_project') IS NOT NULL THEN
    ALTER TABLE spatial_planning.planning_project
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deleted_by UUID;
  END IF;
  IF to_regclass('spatial_planning.gis_feature') IS NOT NULL THEN
    ALTER TABLE spatial_planning.gis_feature
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS deleted_by UUID;
  END IF;
END $$;
