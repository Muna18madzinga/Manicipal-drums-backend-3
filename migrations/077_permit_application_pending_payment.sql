BEGIN;

ALTER TABLE spatial_planning.permit_application
  DROP CONSTRAINT IF EXISTS permit_application_status_check;

ALTER TABLE spatial_planning.permit_application
  ADD  CONSTRAINT permit_application_status_check
  CHECK (status IN (
    'pending_payment',
    'registered',
    'acknowledged',
    'circulation',
    'objection_period',
    'under_review',
    'deferred',
    'approved',
    'approved_with_conditions',
    'refused',
    'withdrawn',
    'appealed'
  ));

ALTER TABLE spatial_planning.permit_application
  ADD COLUMN IF NOT EXISTS fee_paid_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_permit_app_status_received
  ON spatial_planning.permit_application(status, received_at DESC);

COMMIT;
