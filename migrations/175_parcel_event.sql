-- 175: a record of what happened to a parcel when the Surveyor-General's approved plan reached it.
--
-- When an approved general plan is imported for a township whose stands a council has already surveyed (authority-origin parcels imported from
-- SurveyPro), the matching stand is ADOPTED IN PLACE: it keeps its parcel_id (ERP account keys hang off it and parcel ids are never reused) and
-- gains the approval (sg_ref, general_plan_id, the plan's boundary, origin = custodian). docs/HARMONIZATION-SCOPE.md, piece B.
--
-- land.parcel_event keeps what it was before, so the change can be audited and, if it was wrong, put back by hand. Append-only: nothing is
-- updated or deleted.
--
--   event      'adopted'
--   details    what the parcel was before: origin, stand_no, township_code, parcel_kind, source_srid, area_m2, accuracy_basis, sg_ref, and how it
--              was matched (stand number, or its boundary for a plot) with the largest deviation between the two boundaries in metres
--   previous_geom  the boundary as it was (geom_source, in previous_srid)

CREATE TABLE IF NOT EXISTS land.parcel_event (
  event_id       bigserial   PRIMARY KEY,
  parcel_id      varchar(24) NOT NULL REFERENCES land.parcel(parcel_id),
  event          varchar(16) NOT NULL CHECK (event IN ('adopted')),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  general_plan_id bigint     REFERENCES land.general_plan(import_id),
  performed_by   uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  details        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  previous_geom  geometry,
  previous_srid  integer
);
CREATE INDEX IF NOT EXISTS idx_parcel_event_parcel ON land.parcel_event (parcel_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION land.parcel_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- gms.purge exists only to remove fictional sample and test parcels (see land.parcel_guard)
  IF TG_OP = 'DELETE' AND coalesce(current_setting('gms.purge', true), '') = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'land.parcel_event is append-only' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS parcel_event_append_only ON land.parcel_event;
CREATE TRIGGER parcel_event_append_only BEFORE UPDATE OR DELETE ON land.parcel_event
  FOR EACH ROW EXECUTE FUNCTION land.parcel_event_append_only();

SELECT tenancy.classify('land.parcel_event', 'national', 'what happened to a parcel when an approved plan reached it (migration 175)');
