-- 170: the statutory clocks follow the Act, in one place.
--
-- Regional, Town and Country Planning Act [Chapter 29:12], checked against the Act's text:
--   s.26(7)  an application not determined within THREE MONTHS of the date of ACKNOWLEDGEMENT (or any extension the applicant
--            grants in writing) is deemed REFUSED;
--   s.40(6)  the same for a subdivision or consolidation, but FOUR months;
--   s.26(2)(a) acknowledge within two weeks of receipt;  s.38(1)(a) appeal within ONE MONTH of notification.
-- The EO inbox counted 90 days from RECEIPT (v_eo_decision_queue, migration 086): wrong in its start, its length (three months
-- is 89 to 92 days) and for every subdivision. The clock now starts at acknowledgement, counts calendar months, and an
-- application nobody has acknowledged has NO deemed-refusal date (days_to_deemed is NULL), because the Act has not started
-- counting; what it has is an acknowledgement deadline, ack_due_in_days.

CREATE OR REPLACE FUNCTION spatial_planning.determination_deadline(p_acknowledged date, p_development_type text)
RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_acknowledged IS NULL THEN NULL
              ELSE (p_acknowledged + CASE WHEN p_development_type IN ('subdivision', 'consolidation') THEN INTERVAL '4 months'
                                          ELSE INTERVAL '3 months' END)::date END
$$;
COMMENT ON FUNCTION spatial_planning.determination_deadline(date, text) IS
  'Date an application is deemed refused if undetermined: acknowledgement + 3 calendar months (s.26(7)), 4 for a subdivision or consolidation (s.40(6)). NULL until acknowledged. Interval addition clamps to month end (30 Nov + 3 months = 28 Feb).';

CREATE OR REPLACE VIEW spatial_planning.v_eo_decision_queue AS
  SELECT
    pa.id,
    pa.dev_register_no,
    pa.tpd_reference,
    pa.stand_number,
    pa.suburb_ward,
    pa.applicant_name,
    pa.development_type,
    pa.description,
    pa.status,
    (pa.fee_paid_at IS NOT NULL) AS fee_paid,
    pa.received_at,
    pa.statutory_due_date,
    pa.recommendation,
    pa.created_at,
    pa.updated_at,
    ST_X(pa.location) AS lng,
    ST_Y(pa.location) AS lat,
    hp.id             AS handoff_id,
    hp.status         AS handoff_status,
    hp.recommendation AS handoff_recommendation,
    hp.submitted_by   AS handoff_submitted_by,
    hp.created_at     AS handoff_submitted_at,
    hp.returned_to_role,
    -- Days to deemed refusal (negative = breached); NULL until the application is acknowledged.
    (spatial_planning.determination_deadline(pa.acknowledged_at, pa.development_type) - CURRENT_DATE)::int AS days_to_deemed,
    pa.acknowledged_at,
    -- Days left to acknowledge (s.26(2)(a): two weeks from receipt); NULL once acknowledged.
    CASE WHEN pa.acknowledged_at IS NULL AND pa.received_at IS NOT NULL
         THEN (pa.received_at::date + 14 - CURRENT_DATE)::int END AS ack_due_in_days
  FROM spatial_planning.permit_application pa
  LEFT JOIN LATERAL (
    SELECT * FROM spatial_planning.eo_handoff_package h
     WHERE h.permit_app_id = pa.id
     ORDER BY h.created_at DESC
     LIMIT 1
  ) hp ON TRUE
  WHERE pa.status IN (
    'awaiting_eo_decision', 'under_review', 'circulation',
    'objection_period', 'deferred'
  );

COMMENT ON VIEW spatial_planning.v_eo_decision_queue IS
  'EO Planner inbox: permits awaiting determination with latest handoff state. days_to_deemed counts from acknowledgement (s.26(7)); NULL until acknowledged, when ack_due_in_days applies. Read by GET /eo-planner/cases.';

-- CREATE OR REPLACE VIEW resets the view's options; the view must keep running as the caller so row-level security applies
-- (migrations 155 and 166, enforced by tenancy.violations).
ALTER VIEW spatial_planning.v_eo_decision_queue SET (security_invoker = true);
