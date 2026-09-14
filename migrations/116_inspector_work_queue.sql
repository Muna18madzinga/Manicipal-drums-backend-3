-- 116_inspector_work_queue.sql
-- Building Inspector work queue.
--
-- Reconstructed 2026-09-13 from the live Vungu_spatial333 schema: the view and
-- the assignment columns were created on the local database but the migration
-- never reached this repository. Idempotent — safe on a database that already
-- has them, and required on a fresh one (GET /api/inspector/work-queue reads
-- this view).

BEGIN;

ALTER TABLE spatial_planning.stage_inspection
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS assigned_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

-- Citizen bookings are linked to the statutory permit so the queue can show a
-- paid booking against the right case.
ALTER TABLE public.inspection_bookings
  ADD COLUMN IF NOT EXISTS permit_app_id UUID
    REFERENCES spatial_planning.permit_application(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inspection_bookings_permit_app
  ON public.inspection_bookings(permit_app_id)
  WHERE permit_app_id IS NOT NULL;

-- One row per permit: its latest stage inspection and the booking for that stage.
CREATE OR REPLACE VIEW spatial_planning.v_inspector_queue AS
SELECT pa.id AS permit_app_id,
       pa.dev_app_id,
       pa.tpd_reference,
       pa.dev_register_no,
       pa.stand_number,
       pa.suburb_ward,
       pa.street_address,
       pa.applicant_name,
       pa.development_type,
       pa.description,
       pa.status AS permit_status,
       pa.assigned_to AS permit_assigned_to,
       pa.statutory_due_date,
       pa.received_at,
       pa.updated_at AS permit_updated_at,
       ST_X(pa.location) AS lng,
       ST_Y(pa.location) AS lat,
       si.id AS stage_inspection_id,
       si.stage_number,
       si.attempt,
       si.inspector_id,
       si.scheduled_at,
       si.inspected_at,
       si.assigned_at,
       si.assigned_by,
       si.result,
       b.id AS booking_id,
       b.application_id AS booking_application_id,
       b.status AS booking_status,
       b.scheduled_for AS booking_scheduled_for,
       b.fee_paid_at,
       EXISTS (
         SELECT 1 FROM spatial_planning.occupation_certificate oc
          WHERE oc.permit_app_id = pa.id
       ) AS has_occupation_certificate
  FROM spatial_planning.permit_application pa
  LEFT JOIN LATERAL (
    SELECT s.* FROM spatial_planning.stage_inspection s
     WHERE s.permit_app_id = pa.id
     ORDER BY s.stage_number DESC, s.attempt DESC
     LIMIT 1
  ) si ON TRUE
  LEFT JOIN LATERAL (
    SELECT bk.* FROM public.inspection_bookings bk
     WHERE bk.permit_app_id = pa.id
       AND (si.stage_number IS NULL OR bk.stage_number = si.stage_number)
     ORDER BY bk.scheduled_for DESC NULLS LAST
     LIMIT 1
  ) b ON TRUE;

COMMIT;
