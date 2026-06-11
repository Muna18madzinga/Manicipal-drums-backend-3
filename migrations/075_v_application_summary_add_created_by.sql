-- migrations/075_v_application_summary_add_created_by.sql
-- Add pa.created_by to v_application_summary so the list handler can filter
-- citizen requests to their own rows without bypassing the view.
-- Postgres CREATE OR REPLACE VIEW requires unchanged column positions and
-- only allows appending columns. The original 070 view ends at
-- has_occupation_certificate, so created_by must be appended at the end —
-- inserting it earlier would shift later column names and Postgres rejects.
CREATE OR REPLACE VIEW spatial_planning.v_application_summary AS
SELECT
  pa.id, pa.tpd_reference, pa.dev_register_no, pa.stand_number, pa.suburb_ward,
  pa.applicant_name, pa.development_type, pa.status, pa.received_at, pa.decision_at,
  (SELECT COUNT(*) FROM spatial_planning.application_consultation c WHERE c.permit_app_id = pa.id) AS consultation_count,
  (SELECT COUNT(*) FROM spatial_planning.application_objection o   WHERE o.permit_app_id = pa.id)  AS objection_count,
  (SELECT COUNT(*) FROM spatial_planning.building_plan bp          WHERE bp.permit_app_id = pa.id) AS building_plan_count,
  (SELECT COUNT(*) FROM spatial_planning.stage_inspection si       WHERE si.permit_app_id = pa.id) AS inspection_count,
  EXISTS (
    SELECT 1 FROM spatial_planning.occupation_certificate oc WHERE oc.permit_app_id = pa.id
  ) AS has_occupation_certificate,
  pa.created_by
FROM spatial_planning.permit_application pa;
