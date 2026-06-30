-- Migration 081: expose permit centroid (lng/lat) on v_application_summary.
--
-- The GIS Officer, Environmental Officer, and Planning Clerk maps need REAL
-- coordinates to plot applications. permit_application.location is a
-- GEOMETRY(Point,4326); this surfaces it as lng/lat so the frontend stops
-- faking marker positions. NULL location → NULL lng/lat (honest: no pin).
--
-- CREATE OR REPLACE VIEW only allows APPENDING columns (070 + created_by from
-- 075), so lng/lat are appended last.
-- Depends on: migrations 070, 075.

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
  pa.created_by,
  ST_X(pa.location) AS lng,
  ST_Y(pa.location) AS lat
FROM spatial_planning.permit_application pa;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 081 — v_application_summary now exposes lng/lat';
END $$;
