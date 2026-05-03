-- Migration 063: notification outbox, inspection bookings, inspection photos.
--
-- Encodes the inspection-stage rules from the Development Management /
-- Control Manual 2021 (Annexure 12 specimen stamp + Annexure 14 checklist):
--
--   Stage   1.  Setting out
--           2.  Foundation trenches and footing levels
--           3.  Foundation brickwork to floor level
--           4.  Brickwork and window level
--           5.  Brickwork to wall plate
--           6.  Roof trusses
--           7.  Drainage / sewerage work
--           8.  Final inspection
--           9.  Certificate of occupation
--
-- The booking system supports a single source of truth for the citizen,
-- the planner and the building inspector: one row per stage per
-- application, transitioned by the inspector. When the inspector
-- reschedules, a row is appended to inspection_status_events and the
-- notifier writes an outbox row to email the citizen.
--
-- Depends on: postgis (already enabled), users, development_applications.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. NOTIFICATION OUTBOX
-- ════════════════════════════════════════════════════════════════════
--
-- Outbox pattern: every notification is first written to this table so
-- it survives restarts and SMTP outages. A worker (out of scope for
-- this turn) drains 'pending' rows and dispatches them. If you have no
-- worker, the rows still serve as an audit trail.

CREATE TABLE IF NOT EXISTS notifications_outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Recipient (denormalised so the row remains useful even if the user
  -- record is deleted). user_id is VARCHAR to match development_applications.
  user_id      VARCHAR(64),
  email        VARCHAR(255),
  channel      VARCHAR(16) NOT NULL DEFAULT 'email'
                  CHECK (channel IN ('email', 'sms', 'in_app')),

  -- Categorisation lets us throttle / aggregate.
  kind         VARCHAR(64) NOT NULL,            -- e.g. application_status_change
  subject      VARCHAR(255) NOT NULL,
  body_text    TEXT NOT NULL,
  body_html    TEXT,

  -- Free-form payload (application_id, stage_number, photo_count, …).
  payload      JSONB NOT NULL DEFAULT '{}'::JSONB,

  status       VARCHAR(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,

  scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMP WITH TIME ZONE,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_scheduled
  ON notifications_outbox(status, scheduled_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_user
  ON notifications_outbox(user_id);
CREATE INDEX IF NOT EXISTS idx_outbox_kind
  ON notifications_outbox(kind);

COMMENT ON TABLE notifications_outbox IS
  'Outbox-pattern queue. Every email/SMS/in-app notification is written here first; a worker drains pending rows.';

-- ════════════════════════════════════════════════════════════════════
-- 2. APPLICATION STATUS HISTORY
-- ════════════════════════════════════════════════════════════════════
--
-- We keep full history (vs only the current status on
-- development_applications) so the citizen can see the timeline and so
-- the notifier can emit one outbox row per transition. Existing
-- application_timeline serves a similar purpose but is a free-text
-- audit log; this table is structured (from/to status pair).

CREATE TABLE IF NOT EXISTS application_status_history (
  id              BIGSERIAL PRIMARY KEY,
  application_id  VARCHAR(32) NOT NULL,
  from_status     VARCHAR(64),
  to_status       VARCHAR(64) NOT NULL,
  changed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  notes           TEXT,
  changed_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_status_hist_app
  ON application_status_history(application_id);
CREATE INDEX IF NOT EXISTS idx_app_status_hist_changed_at
  ON application_status_history(changed_at DESC);

-- ════════════════════════════════════════════════════════════════════
-- 3. INSPECTION BOOKINGS
-- ════════════════════════════════════════════════════════════════════
--
-- One row per stage per application. The citizen books a stage; an
-- inspector may be auto-assigned, re-assigned, or accept from a
-- waitlist. Reschedules append to inspection_status_events.
--
-- The 9 stages match Annexure 12 / 14 of the manual.

CREATE TABLE IF NOT EXISTS inspection_bookings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id VARCHAR(32) NOT NULL,

  stage_number   INT NOT NULL CHECK (stage_number BETWEEN 1 AND 9),
  -- Denormalised so the queue UI doesn't need a JOIN.
  stage_name     VARCHAR(64) NOT NULL,

  citizen_id     VARCHAR(64),                              -- matches dev_apps.user_id
  inspector_id   UUID REFERENCES users(id) ON DELETE SET NULL,

  status         VARCHAR(20) NOT NULL DEFAULT 'pending_payment'
                   CHECK (status IN (
                     'pending_payment',  -- citizen paid the fee? not yet
                     'waitlisted',       -- paid, waiting for an inspector slot
                     'scheduled',        -- date set, inspector assigned
                     'rescheduled',      -- date moved
                     'in_progress',      -- inspector on site
                     'passed',
                     'failed',
                     'cancelled'
                   )),

  fee_paid_at    TIMESTAMP WITH TIME ZONE,
  scheduled_for  TIMESTAMP WITH TIME ZONE,                  -- inspection date/time
  completed_at   TIMESTAMP WITH TIME ZONE,
  passed         BOOLEAN,                                   -- null = not yet completed

  citizen_notes  TEXT,                                      -- "site is wet, bring boots"
  inspector_notes TEXT,                                     -- private staff notes

  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- A citizen can only have ONE non-terminal booking per (app, stage).
  UNIQUE (application_id, stage_number)
);

CREATE INDEX IF NOT EXISTS idx_inspection_bookings_app
  ON inspection_bookings(application_id);
CREATE INDEX IF NOT EXISTS idx_inspection_bookings_inspector
  ON inspection_bookings(inspector_id);
CREATE INDEX IF NOT EXISTS idx_inspection_bookings_status_sched
  ON inspection_bookings(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_inspection_bookings_waitlist
  ON inspection_bookings(status, fee_paid_at)
  WHERE status = 'waitlisted';

COMMENT ON TABLE inspection_bookings IS
  'Per-stage inspection bookings. Stage names from Manual 2021 Annexure 12.';

-- Status events (audit log) — one row per transition.
CREATE TABLE IF NOT EXISTS inspection_status_events (
  id           BIGSERIAL PRIMARY KEY,
  booking_id   UUID NOT NULL REFERENCES inspection_bookings(id) ON DELETE CASCADE,
  from_status  VARCHAR(20),
  to_status    VARCHAR(20) NOT NULL,
  scheduled_for TIMESTAMP WITH TIME ZONE,                   -- captured at the time of the event
  actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role   VARCHAR(32),
  notes        TEXT,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inspection_events_booking
  ON inspection_status_events(booking_id);

-- ════════════════════════════════════════════════════════════════════
-- 4. INSPECTION PHOTOS
-- ════════════════════════════════════════════════════════════════════
--
-- One row per uploaded photo. Files live on disk under uploads/inspection-photos/<booking_id>/<id>.jpg
-- We keep dimensions + sha256 so:
--   - we can de-dup uploads (e.g. inspector accidentally retries)
--   - the frontend can render a placeholder grid before the image fully decodes.
-- We DO NOT store EXIF here — privacy: strip on upload (the route handler
-- pipes through sharp/exiftool — TODO when image-processing dep added).

CREATE TABLE IF NOT EXISTS inspection_photos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   UUID NOT NULL REFERENCES inspection_bookings(id) ON DELETE CASCADE,
  uploaded_by  UUID REFERENCES users(id) ON DELETE SET NULL,

  storage_url  TEXT    NOT NULL,
  mime_type    VARCHAR(64) NOT NULL,
  bytes        BIGINT  NOT NULL CHECK (bytes > 0),
  width_px     INT,
  height_px    INT,
  sha256_hex   VARCHAR(64),

  caption      VARCHAR(255),
  -- Optional GPS captured by the camera. Stored as separate columns so
  -- we can spatially query "photos within X metres of the stand".
  taken_at     TIMESTAMP WITH TIME ZONE,
  taken_lng    DOUBLE PRECISION,
  taken_lat    DOUBLE PRECISION,

  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Same image (by hash) can only appear once per booking.
  UNIQUE (booking_id, sha256_hex)
);

CREATE INDEX IF NOT EXISTS idx_inspection_photos_booking
  ON inspection_photos(booking_id);

COMMIT;
