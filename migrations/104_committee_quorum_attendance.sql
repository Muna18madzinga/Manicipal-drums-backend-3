-- 104_committee_quorum_attendance.sql
-- Stage 4 (H2): committee membership, attendance + quorum, and soft-delete —
-- EXTENDS migration 083 (committee_meeting / agenda_item), does not replace it.
--
-- Why: a committee resolution is only statutorily valid if the meeting was
-- quorate. 083 recorded outcomes with no notion of who attended or whether
-- quorum was met. This adds:
--   committee_member    — the standing roster (councillors need not be app users)
--   meeting_attendance  — present/apology/absent per member per meeting
--   committee_meeting.quorum — minimum members present for a valid resolution
--   deleted_at/deleted_by on both 083 tables — Stage-1 soft-delete consistency
--
-- Idempotent: ADD COLUMN / CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS spatial_planning.committee_member (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   VARCHAR(160) NOT NULL,
  title       VARCHAR(120),                       -- e.g. 'Councillor', 'Town Planner'
  user_id     UUID REFERENCES public.users(id) ON DELETE SET NULL,  -- optional link
  active      BOOLEAN NOT NULL DEFAULT TRUE,       -- soft-retire a member
  created_by  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spatial_planning.meeting_attendance (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  UUID NOT NULL REFERENCES spatial_planning.committee_meeting(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES spatial_planning.committee_member(id) ON DELETE CASCADE,
  status      VARCHAR(12) NOT NULL DEFAULT 'present'
                CHECK (status IN ('present', 'apology', 'absent')),
  recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (meeting_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_meeting_attendance_meeting
  ON spatial_planning.meeting_attendance(meeting_id);

-- Minimum members present for a resolution to be valid. NULL = not enforced
-- (backwards compatible with meetings created before this migration).
ALTER TABLE spatial_planning.committee_meeting
  ADD COLUMN IF NOT EXISTS quorum INTEGER,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE spatial_planning.agenda_item
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

COMMENT ON TABLE spatial_planning.committee_member IS
  'Standing committee roster; members may be councillors without app accounts.';
COMMENT ON COLUMN spatial_planning.committee_meeting.quorum IS
  'Minimum members present for a valid resolution; NULL = not enforced.';
