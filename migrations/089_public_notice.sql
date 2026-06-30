-- Migration 089: public-notification tracking + objection response evidence
--
-- Section 26(3) of the RTCP Act [Ch. 29:12] requires the council to advertise a
-- development application, notify abutting owners, post a site notice, and run
-- an objection period. Until now the EO Planner's Public Notification screen
-- listed objections but had nowhere to RECORD that those statutory steps were
-- done. This migration adds:
--
--   1. spatial_planning.public_notice — one row per permit capturing each
--      verification (advert / abutting owners / site notice) with who/when,
--      the objection-period window, and whether the period has been closed.
--   2. application_objection.resolution_document_url — evidence attached when an
--      objection is resolved (the applicant's response / council's record).
--
-- Depends on: 070 (permit_application, application_objection, set_updated_at()).
-- Idempotent: safe to re-run (CREATE/ALTER … IF [NOT] EXISTS).
-- Apply with: node scripts/migrate-render.js  (089 is in the MIGRATIONS array)

BEGIN;

CREATE TABLE IF NOT EXISTS spatial_planning.public_notice (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id UUID NOT NULL UNIQUE REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  -- Newspaper advert (s.26(3)).
  advert_verified            BOOLEAN NOT NULL DEFAULT FALSE,
  advert_reference           TEXT,
  advert_verified_at         TIMESTAMP WITH TIME ZONE,
  advert_verified_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,

  -- Registered-post notification of all abutting owners.
  abutting_owners_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  abutting_owners_verified_at TIMESTAMP WITH TIME ZONE,
  abutting_owners_verified_by UUID REFERENCES public.users(id) ON DELETE SET NULL,

  -- On-site notice posted and visible from the road.
  site_notice_verified       BOOLEAN NOT NULL DEFAULT FALSE,
  site_notice_verified_at    TIMESTAMP WITH TIME ZONE,
  site_notice_verified_by    UUID REFERENCES public.users(id) ON DELETE SET NULL,

  -- Objection period window + closure.
  objection_period_start     DATE,
  objection_period_end       DATE,
  objection_period_closed    BOOLEAN NOT NULL DEFAULT FALSE,
  objection_period_closed_at TIMESTAMP WITH TIME ZONE,
  objection_period_closed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,

  notes         TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_notice_permit
  ON spatial_planning.public_notice(permit_app_id);

COMMENT ON TABLE spatial_planning.public_notice IS
  'Section 26(3) public-notification record: advert / abutting-owner / site-notice verification + objection-period window and closure. One row per permit.';

-- Reuse the shared updated_at trigger from migration 070.
DROP TRIGGER IF EXISTS trg_public_notice_updated_at ON spatial_planning.public_notice;
CREATE TRIGGER trg_public_notice_updated_at
  BEFORE UPDATE ON spatial_planning.public_notice
  FOR EACH ROW EXECUTE FUNCTION spatial_planning.set_updated_at();

-- Evidence attached when an objection is resolved.
ALTER TABLE spatial_planning.application_objection
  ADD COLUMN IF NOT EXISTS resolution_document_url TEXT;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 089 complete — public_notice + objection resolution evidence';
END $$;
