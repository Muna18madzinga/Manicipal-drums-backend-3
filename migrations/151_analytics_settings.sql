-- 151_analytics_settings.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Two council-controlled settings for the first-party usage analytics
-- (page_view, migration 131; POST /api/analytics/pageview; GET /api/admin/usage).
--
--   analytics.enabled         the server-side kill switch. Off: the endpoint accepts and
--                             discards, nothing is stored. The cookie banner still works.
--   analytics.retention_days  how long page views are kept. The maximum is 395 days (13
--                             months) because the privacy notice promises no longer than
--                             that; the console cannot set a longer period than the notice.
--
-- Both are enforced: the server reads them (routes/analytics.js). Metadata is refreshed on
-- re-apply; the council's chosen value never is.

BEGIN;

INSERT INTO public.admin_setting (key, value, value_type, category, label, description, constraints, enforced) VALUES
  ('analytics.enabled', 'true', 'boolean', 'system',
   'Usage analytics',
   'When off, page views are accepted and discarded: nothing is stored. Only visitors who accepted analytics on the cookie banner are ever counted.',
   '{}', true),
  ('analytics.retention_days', '395', 'number', 'system',
   'Usage analytics retention (days)',
   'Page views older than this are deleted automatically. The privacy notice promises no longer than 13 months, so 395 days is the ceiling.',
   '{"min":30,"max":395}', true)
ON CONFLICT (key) DO UPDATE SET
  value_type  = EXCLUDED.value_type,
  category    = EXCLUDED.category,
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  constraints = EXCLUDED.constraints,
  enforced    = EXCLUDED.enforced;

COMMIT;
