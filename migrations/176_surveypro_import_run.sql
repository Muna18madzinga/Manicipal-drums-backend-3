-- 176: a record of every run of the SurveyPro importer (src/services/surveyproSchedule.js).
--
-- The importer used to be run by hand. Scheduled, it must leave a trail: when it last ran, whether it found anything, whether it is stuck on a
-- council that cannot be reached or a layout the register refuses. One row per run (all councils' readers together):
--   status    ok         ran, nothing refused
--             attention  ran, but a layout was refused or a boundary diverged: a person needs to look (the totals and the report say which)
--             failed     a council's SurveyPro could not be read at all, or the run broke
--   trigger   schedule (the timer in the server), manual (the integration console), cli (scripts/import-surveypro.js --apply)
--   report    only what happened: statuses moved, parcels imported, diverged, refused, warnings, and per-council failures. Never a connection string.
-- Quiet runs (ok, nothing at all done) are pruned after a week; the rest are kept for a year.

CREATE TABLE IF NOT EXISTS integration.surveypro_import_run (
  id           bigserial   PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  trigger      varchar(12) NOT NULL CHECK (trigger IN ('schedule', 'manual', 'cli')),
  applied      boolean     NOT NULL,
  status       varchar(10) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'attention', 'failed')),
  councils     integer     NOT NULL DEFAULT 0,
  totals       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  report       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  error        text
);
CREATE INDEX IF NOT EXISTS idx_surveypro_import_run_started ON integration.surveypro_import_run (started_at DESC);

SELECT tenancy.classify('integration.surveypro_import_run', 'system', 'internal plumbing: when the SurveyPro importer ran and what it found (migration 176)');
