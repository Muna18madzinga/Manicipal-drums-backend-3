-- 083_committee_meetings.sql
-- ────────────────────────────────────────────────────────────────────────
-- Committee meeting agenda + hearing scheduling/recording. Lets the planner
-- table an application onto a town-planning committee meeting and record the
-- resolution (CityView-style "agenda control + hearing scheduling/recording").
-- Idempotent: CREATE … IF NOT EXISTS.
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS spatial_planning.committee_meeting (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        VARCHAR(160) NOT NULL,
  meeting_date DATE NOT NULL,
  location     VARCHAR(160),
  status       VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled', 'held', 'cancelled')),
  notes        TEXT,
  created_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_committee_meeting_date
  ON spatial_planning.committee_meeting(meeting_date DESC);

CREATE TABLE IF NOT EXISTS spatial_planning.agenda_item (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id    UUID NOT NULL REFERENCES spatial_planning.committee_meeting(id) ON DELETE CASCADE,
  permit_app_id UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,
  item_order    INTEGER,
  purpose       VARCHAR(40) NOT NULL DEFAULT 'determination'
                  CHECK (purpose IN ('determination', 'consideration', 'deputation', 'noting')),
  outcome       VARCHAR(30) NOT NULL DEFAULT 'pending'
                  CHECK (outcome IN ('pending', 'approved', 'approved_with_conditions',
                                     'refused', 'deferred', 'noted')),
  resolution    TEXT,
  heard_at      TIMESTAMP WITH TIME ZONE,
  created_by    UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (meeting_id, permit_app_id)
);

CREATE INDEX IF NOT EXISTS idx_agenda_item_meeting ON spatial_planning.agenda_item(meeting_id);
CREATE INDEX IF NOT EXISTS idx_agenda_item_permit  ON spatial_planning.agenda_item(permit_app_id);

COMMENT ON TABLE spatial_planning.committee_meeting IS
  'Town-planning committee meetings; agenda_item tables applications onto them for hearing.';
