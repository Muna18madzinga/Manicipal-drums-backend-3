-- 131_page_view.sql
-- ─────────────────────────────────────────────────────────────────────────
-- First-party portal usage analytics: one row per page view.
--
-- WHY FIRST-PARTY
-- The frontend is self-hosted and loads nothing from a third party, so a
-- hosted analytics script is out. Views go to POST /api/analytics/pageview
-- and live here, beside the data they describe.
--
-- WHAT IS DELIBERATELY NOT STORED
-- No IP address, no user id, no user agent, no query string. `path` is the
-- route PATTERN (/applications/:id), never the concrete URL, so no record id
-- ends up here. `visitor_id` is a random uuid the browser keeps only after
-- the visitor accepts analytics cookies; it counts distinct visitors and
-- identifies nobody. Nothing is recorded without that consent.
--
-- Rollback: 131_page_view.down.sql (not in the allowlist).
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.page_view (
  id            bigserial PRIMARY KEY,
  path          text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 200),
  visitor_id    uuid,
  referrer_host text CHECK (referrer_host IS NULL OR char_length(referrer_host) <= 253),
  occurred_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_page_view_occurred_at ON public.page_view (occurred_at);

COMMIT;
