-- 171: the date an application is acknowledged is recorded by the database, and it starts the clock.
--
-- Until now nothing on the server ever wrote permit_application.acknowledged_at (all 47 rows in the dev database have it NULL), so
-- the rule "the clock runs from acknowledgement" (s.26(7)) lived only in screens, and the deadline the clerk wrote on the letter
-- was receipt + 3 months. The Act counts from the date of acknowledgement. Now:
--
--   * when an acknowledgement letter is SENT (sent_at set, not voided) the permit's acknowledged_at is set to that date (Harare
--     time) if it has none, and the letter's determination_due_by becomes the Act's deadline from that date: three calendar months,
--     four for a subdivision or consolidation (spatial_planning.determination_deadline, migration 170), to the end of that day;
--   * when a permit is moved to the status 'acknowledged' without a date, today is recorded;
--   * the permit's statutory_due_date is set from acknowledged_at when it is first recorded. A later extension the applicant grants in
--     writing (s.26(7)) still overrides it through the clock events: this never overwrites a date that is already there.
-- Unsent drafts do not start the clock: the Act counts from the date the applicant is acknowledged to, not from drafting.

CREATE OR REPLACE FUNCTION spatial_planning.clerk_ack_sets_clock() RETURNS trigger AS $$
DECLARE
  dev_type text;
  sent_date date;
BEGIN
  IF NEW.sent_at IS NULL OR NEW.voided_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT development_type INTO dev_type FROM spatial_planning.permit_application WHERE id = NEW.permit_application_id;
  sent_date := (NEW.sent_at AT TIME ZONE 'Africa/Harare')::date;
  NEW.determination_due_by :=
    ((spatial_planning.determination_deadline(sent_date, dev_type) + 1)::timestamp - INTERVAL '1 second') AT TIME ZONE 'Africa/Harare';
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION spatial_planning.clerk_ack_records_date() RETURNS trigger AS $$
BEGIN
  IF NEW.sent_at IS NULL OR NEW.voided_at IS NOT NULL THEN RETURN NULL; END IF;
  UPDATE spatial_planning.permit_application
     SET acknowledged_at = (NEW.sent_at AT TIME ZONE 'Africa/Harare')::date
   WHERE id = NEW.permit_application_id AND acknowledged_at IS NULL;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION spatial_planning.permit_acknowledged_clock() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'acknowledged' AND NEW.acknowledged_at IS NULL THEN
    NEW.acknowledged_at := (now() AT TIME ZONE 'Africa/Harare')::date;
  END IF;
  IF NEW.acknowledged_at IS NOT NULL AND NEW.statutory_due_date IS NULL THEN
    NEW.statutory_due_date := spatial_planning.determination_deadline(NEW.acknowledged_at, NEW.development_type);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass('spatial_planning.clerk_acknowledgement') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_clerk_ack_sets_clock ON spatial_planning.clerk_acknowledgement;
    CREATE TRIGGER trg_clerk_ack_sets_clock BEFORE INSERT OR UPDATE OF sent_at, voided_at ON spatial_planning.clerk_acknowledgement
      FOR EACH ROW EXECUTE FUNCTION spatial_planning.clerk_ack_sets_clock();
    DROP TRIGGER IF EXISTS trg_clerk_ack_records_date ON spatial_planning.clerk_acknowledgement;
    CREATE TRIGGER trg_clerk_ack_records_date AFTER INSERT OR UPDATE OF sent_at, voided_at ON spatial_planning.clerk_acknowledgement
      FOR EACH ROW EXECUTE FUNCTION spatial_planning.clerk_ack_records_date();
    COMMENT ON COLUMN spatial_planning.clerk_acknowledgement.determination_due_by IS
      'Deemed-refusal deadline: three calendar months from the day the letter was SENT (s.26(7)), four for a subdivision (s.40(6)); set by trigger when sent_at is recorded. Before the letter is sent it is only the clerk''s estimate.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_permit_acknowledged_clock ON spatial_planning.permit_application;
CREATE TRIGGER trg_permit_acknowledged_clock BEFORE INSERT OR UPDATE ON spatial_planning.permit_application
  FOR EACH ROW EXECUTE FUNCTION spatial_planning.permit_acknowledged_clock();
