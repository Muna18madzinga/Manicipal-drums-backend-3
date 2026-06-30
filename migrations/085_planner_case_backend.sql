-- Migration 085: Planner case backend — tasks, messages, documents, clock, handoff, analysis
--
-- Fills the data-model gaps for the Planner Console so the statutory case file is
-- fully backend-backed (no more browser-local or demo state). FEDERATE approach:
-- we keep the existing role-specific tables (application_consultation, survey_task,
-- plan_review, stage_inspection) and add only the genuinely-missing pieces, plus a
-- read-only UNION view that gives the planner one place to see every specialist's
-- finding.
--
-- What this migration adds:
--   1. permit_application      — EO-handoff status + statutory-clock state columns
--   2. application_consultation — promoted to the canonical "case task" (priority,
--                                 task lifecycle, task_type) — POST /:id/tasks etc.
--   3. case_message            — the shared per-permit conversation (visibility model)
--   4. permit_document / document_request / document_review — permit-scoped documents
--   5. statutory_clock_event   — pause/resume/extend/breach ledger
--   6. generated_document      — server-stored, versioned PDFs (reports, letters, permit)
--   7. spatial_analysis_result — persisted PostGIS overlay/conflict output
--   8. eo_handoff_package      — the "Submit to EO Planner" bundle
--   9. v_specialist_findings   — UNION view across consultation / survey / plan / inspection
--
-- FK conventions (mirror 070/080):
--   permit_app_id          → spatial_planning.permit_application(id) ON DELETE CASCADE
--   *_by / *_to / author_id → public.users(id) ON DELETE SET NULL
--   Document references are SOFT (UUID + source discriminator), mirroring the
--   payments.related_kind/related_id polymorphic pattern (064): citizen_documents,
--   application_documents and generated_document live in different tables/schemas.
--
-- Depends on: 070 (permit_application, application_consultation, set_updated_at(),
--             stage_inspection), 080 (survey_task/survey_finding), 065 (plan_reviews),
--             082 (planner case columns), PostGIS.
-- Idempotent: safe to re-run (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS).
-- Apply with: node scripts/migrate-render.js   (085 is in the MIGRATIONS array)

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. permit_application — EO-handoff status + statutory-clock state
-- ════════════════════════════════════════════════════════════════════
-- Add 'awaiting_eo_decision' to the status CHECK so the planner's
-- "Submit to EO Planner" action has a distinct lifecycle state.
-- (The route's VALID_STATUSES list in development-management.js must be
-- updated to match in the route-implementation pass.)
ALTER TABLE spatial_planning.permit_application
  DROP CONSTRAINT IF EXISTS permit_application_status_check;
ALTER TABLE spatial_planning.permit_application
  ADD CONSTRAINT permit_application_status_check CHECK (status IN (
    'registered',
    'acknowledged',
    'circulation',
    'objection_period',
    'under_review',
    'awaiting_eo_decision',
    'deferred',
    'approved',
    'approved_with_conditions',
    'refused',
    'withdrawn',
    'appealed'
  ));

-- Fast-read clock state. statutory_due_date (migration 082) stays the
-- authoritative *current* due date; statutory_clock_event (below) is the
-- ledger that explains how it got there. clock_paused_days accumulates the
-- total paused duration so the due date can be recomputed deterministically.
ALTER TABLE spatial_planning.permit_application
  ADD COLUMN IF NOT EXISTS clock_state       VARCHAR(10) NOT NULL DEFAULT 'running'
                             CHECK (clock_state IN ('running', 'paused', 'stopped')),
  ADD COLUMN IF NOT EXISTS clock_paused_days INTEGER NOT NULL DEFAULT 0;

-- ════════════════════════════════════════════════════════════════════
-- 2. application_consultation → canonical "case task"
-- ════════════════════════════════════════════════════════════════════
-- The referral already carries assigned_to (082) + response_due_at (070).
-- Promote it to a real task: a priority, a task lifecycle distinct from the
-- finding outcome (response_status), and a task_type so the UI can deep-link
-- to the right specialist workspace (gis / surveyor / env / building / eo).
ALTER TABLE spatial_planning.application_consultation
  ADD COLUMN IF NOT EXISTS priority    VARCHAR(10) NOT NULL DEFAULT 'normal'
                             CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  ADD COLUMN IF NOT EXISTS task_status VARCHAR(16) NOT NULL DEFAULT 'open'
                             CHECK (task_status IN (
                               'open', 'in_progress', 'responded',
                               'accepted', 'returned', 'cancelled'
                             )),
  ADD COLUMN IF NOT EXISTS task_type   VARCHAR(40);

COMMENT ON COLUMN spatial_planning.application_consultation.task_status IS
  'Task lifecycle (who/where it is). Distinct from response_status, which is the specialist''s finding outcome.';
COMMENT ON COLUMN spatial_planning.application_consultation.task_type IS
  'Routes the task to a specialist workspace: gis_review | survey | environmental | building_plan | eo_review | statutory_body | other.';

CREATE INDEX IF NOT EXISTS idx_consultation_task_status
  ON spatial_planning.application_consultation(permit_app_id, task_status);

-- ════════════════════════════════════════════════════════════════════
-- 3. case_message — the shared per-permit conversation
-- ════════════════════════════════════════════════════════════════════
-- One thread per permit. message_type classifies intent; visibility is the
-- access model (mirrors survey_comment.audience from migration 080): who is
-- allowed to read this message. The route layer enforces it per requester role.
CREATE TABLE IF NOT EXISTS spatial_planning.case_message (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id  UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  author_id      UUID REFERENCES public.users(id) ON DELETE SET NULL,
  author_role    VARCHAR(40),

  message_type   VARCHAR(30) NOT NULL DEFAULT 'internal_note'
                   CHECK (message_type IN (
                     'internal_note',       -- staff-only working note
                     'citizen_message',     -- to/from the applicant
                     'specialist_comment',  -- from a tasked specialist
                     'decision_comment',    -- attached to a recommendation/decision
                     'document_request'     -- narrative tied to a document_request
                   )),
  -- Access model (message_visibility). 'internal' = council staff only;
  -- 'specialist' = staff + tasked specialists; 'citizen' = + the applicant;
  -- 'public' = also disclosable (e.g. objection-period correspondence).
  visibility     VARCHAR(20) NOT NULL DEFAULT 'internal'
                   CHECK (visibility IN ('internal', 'specialist', 'citizen', 'public')),

  body           TEXT NOT NULL,
  in_reply_to    UUID REFERENCES spatial_planning.case_message(id) ON DELETE SET NULL,
  attachments    JSONB NOT NULL DEFAULT '[]'::JSONB,   -- [{url,name,mime,bytes}]
  related_request_id UUID,                              -- soft ref → document_request.id when message_type='document_request'

  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  edited_at      TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_case_message_permit
  ON spatial_planning.case_message(permit_app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_case_message_visibility
  ON spatial_planning.case_message(permit_app_id, visibility);

COMMENT ON TABLE spatial_planning.case_message IS
  'Shared per-permit conversation: internal notes, citizen messages, specialist comments, decision/document-request notes. visibility column is the read-access model.';

-- ════════════════════════════════════════════════════════════════════
-- 4. Documents — link, requests, reviews (permit-scoped)
-- ════════════════════════════════════════════════════════════════════
-- 4a. permit_document — associates an existing document with a permit so
--     GET /permit-applications/:id/documents can list them. SOFT reference:
--     (document_id, source) is polymorphic across citizen_documents (UUID),
--     application_documents, and generated_document.
CREATE TABLE IF NOT EXISTS spatial_planning.permit_document (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id  UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  document_id    UUID NOT NULL,                          -- soft ref to the source row
  source         VARCHAR(20) NOT NULL
                   CHECK (source IN ('citizen', 'application', 'generated', 'external')),
  doc_role       VARCHAR(40),                            -- title_deed | site_plan | id | plan | other
  storage_url    TEXT,                                   -- denormalised for fast listing
  added_by       UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  UNIQUE (permit_app_id, document_id, source)
);
CREATE INDEX IF NOT EXISTS idx_permit_document_permit
  ON spatial_planning.permit_document(permit_app_id);

-- 4b. document_request — planner asks the applicant for a (replacement) document.
CREATE TABLE IF NOT EXISTS spatial_planning.document_request (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id  UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  requested_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  doc_kind       VARCHAR(40) NOT NULL,                   -- national_id|title_deed|site_plan|plan|... (open set)
  reason         TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'fulfilled', 'waived', 'cancelled')),
  due_at         DATE,
  -- When fulfilled, points at the uploaded document (paired with permit_document).
  fulfilled_document_id UUID,
  fulfilled_at   TIMESTAMP WITH TIME ZONE,
  resolved_by    UUID REFERENCES public.users(id) ON DELETE SET NULL,

  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_request_permit
  ON spatial_planning.document_request(permit_app_id, status);

-- 4c. document_review — a planner's review decision on a permit document.
--     Separate from citizen_documents identity-verification (/documents/:id/verify):
--     this is "is this document acceptable for THIS application?".
CREATE TABLE IF NOT EXISTS spatial_planning.document_review (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_document_id UUID NOT NULL REFERENCES spatial_planning.permit_document(id) ON DELETE CASCADE,

  reviewer_id        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  decision           VARCHAR(24) NOT NULL
                       CHECK (decision IN ('approved', 'rejected', 'replacement_requested')),
  notes              TEXT,
  -- When decision='replacement_requested', the request it spawned.
  document_request_id UUID REFERENCES spatial_planning.document_request(id) ON DELETE SET NULL,
  reviewed_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_review_doc
  ON spatial_planning.document_review(permit_document_id, reviewed_at DESC);

-- ════════════════════════════════════════════════════════════════════
-- 5. statutory_clock_event — pause / resume / extend / breach ledger
-- ════════════════════════════════════════════════════════════════════
-- Append-only. The planner pauses the 90-day clock (e.g. awaiting documents),
-- resumes it, or grants an extension; each writes a row with the reason. The
-- new_due_date / days_delta let the UI show a "clock history" and recompute
-- statutory_due_date deterministically.
CREATE TABLE IF NOT EXISTS spatial_planning.statutory_clock_event (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id  UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  event_type     VARCHAR(16) NOT NULL
                   CHECK (event_type IN ('started', 'paused', 'resumed', 'extended', 'breached', 'reset')),
  reason         TEXT,
  days_delta     INTEGER,                                -- + for extensions/pauses, informational
  new_due_date   DATE,                                   -- resulting statutory_due_date after this event
  actor_id       UUID REFERENCES public.users(id) ON DELETE SET NULL,
  effective_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clock_event_permit
  ON spatial_planning.statutory_clock_event(permit_app_id, effective_at);

-- ════════════════════════════════════════════════════════════════════
-- 6. generated_document — server-stored, versioned outputs
-- ════════════════════════════════════════════════════════════════════
-- Persists the PDFs that are currently produced client-side, so the council
-- has an authoritative copy: due-diligence report, committee report, decision
-- memo, the permit itself, refusal/outcome letters, acknowledgements.
CREATE TABLE IF NOT EXISTS spatial_planning.generated_document (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id  UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  doc_type       VARCHAR(30) NOT NULL
                   CHECK (doc_type IN (
                     'due_diligence_report', 'committee_report', 'decision_memo',
                     'permit', 'refusal_letter', 'outcome_letter', 'acknowledgement'
                   )),
  storage_url    TEXT NOT NULL,
  mime_type      VARCHAR(64) NOT NULL DEFAULT 'application/pdf',
  bytes          BIGINT CHECK (bytes IS NULL OR bytes > 0),
  sha256_hex     VARCHAR(64),
  version        INTEGER NOT NULL DEFAULT 1,
  supersedes     UUID REFERENCES spatial_planning.generated_document(id) ON DELETE SET NULL,
  -- Snapshot of the data the document was rendered from (for reproducibility).
  payload        JSONB,
  generated_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_generated_document_permit
  ON spatial_planning.generated_document(permit_app_id, doc_type, version DESC);

-- ════════════════════════════════════════════════════════════════════
-- 7. spatial_analysis_result — persisted PostGIS overlay / conflict output
-- ════════════════════════════════════════════════════════════════════
-- Output of POST /spatial-analysis: intersect a drawn geometry against the
-- registry layers (landuse, roads, wetlands, etc.) and record what it hit.
-- Replaces the deleted demo /api/analyze. permit_app_id NULL = ad-hoc scratch.
CREATE TABLE IF NOT EXISTS spatial_planning.spatial_analysis_result (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id  UUID REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  requested_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  analysis_type  VARCHAR(40) NOT NULL DEFAULT 'overlay'
                   CHECK (analysis_type IN ('overlay', 'conflict_check', 'buffer_intersect', 'setback', 'other')),
  input_geom     GEOMETRY(Geometry, 4326),
  -- { layers:[{layer,featureCount,areaSqm,classes:[...]}], conflicts:[...], summary:{...} }
  result         JSONB NOT NULL DEFAULT '{}'::JSONB,
  result_geom    GEOMETRY(Geometry, 4326),
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spatial_analysis_permit
  ON spatial_planning.spatial_analysis_result(permit_app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spatial_analysis_input_geom
  ON spatial_planning.spatial_analysis_result USING GIST(input_geom);

-- ════════════════════════════════════════════════════════════════════
-- 8. eo_handoff_package — the "Submit to EO Planner" bundle
-- ════════════════════════════════════════════════════════════════════
-- One row per submission. Captures the planner's recommendation + reasons +
-- structured conditions + attachments (generated_document ids) + a snapshot of
-- the specialist findings at submission time, then the EO Planner's decision.
CREATE TABLE IF NOT EXISTS spatial_planning.eo_handoff_package (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id     UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  submitted_by      UUID REFERENCES public.users(id) ON DELETE SET NULL,
  recommendation    VARCHAR(40),                          -- approve | approve_conditions | refuse | defer
  reasons           TEXT,
  conditions        JSONB NOT NULL DEFAULT '[]'::JSONB,   -- [{id,text,...}]
  attachments       JSONB NOT NULL DEFAULT '[]'::JSONB,   -- [generated_document.id, ...]
  findings_snapshot JSONB,                                -- frozen v_specialist_findings at submit time

  status            VARCHAR(20) NOT NULL DEFAULT 'submitted'
                      CHECK (status IN ('submitted', 'accepted', 'returned', 'decided')),
  eo_decision       VARCHAR(40),                          -- approved | approved_with_conditions | refused | deferred
  eo_notes          TEXT,
  decided_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at        TIMESTAMP WITH TIME ZONE,

  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eo_handoff_permit
  ON spatial_planning.eo_handoff_package(permit_app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eo_handoff_status
  ON spatial_planning.eo_handoff_package(status);

-- ════════════════════════════════════════════════════════════════════
-- 9. updated_at triggers (reuse spatial_planning.set_updated_at() from 070)
-- ════════════════════════════════════════════════════════════════════
DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['document_request', 'eo_handoff_package'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_updated_at ON spatial_planning.%I;
       CREATE TRIGGER trg_%s_updated_at
       BEFORE UPDATE ON spatial_planning.%I
       FOR EACH ROW EXECUTE FUNCTION spatial_planning.set_updated_at()',
      tbl, tbl, tbl, tbl
    );
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- 10. v_specialist_findings — one place the planner sees every finding
-- ════════════════════════════════════════════════════════════════════
-- FEDERATED read: UNION the four sources that already hold specialist output,
-- keyed on permit_app_id. The route GET /permit-applications/:id/specialist-findings
-- reads this. plan_review joins via permit_application.dev_app_id (plan_reviews is
-- keyed by the citizen-portal application_id VARCHAR, not permit_app_id).
CREATE OR REPLACE VIEW spatial_planning.v_specialist_findings AS
  -- Statutory body / generic referral responses
  SELECT
    c.permit_app_id,
    'consultation'::text                         AS finding_type,
    c.id                                         AS source_id,
    c.body_name                                  AS source_label,
    c.assigned_to                                AS specialist_id,
    c.response_status                            AS outcome,
    c.response_notes                             AS summary,
    c.task_status,
    c.priority,
    c.response_received_at::timestamptz          AS received_at,
    c.created_at
  FROM spatial_planning.application_consultation c

  UNION ALL
  -- Surveyor findings (via survey_task)
  SELECT
    st.permit_app_id,
    'survey'::text                               AS finding_type,
    sf.id                                         AS source_id,
    'Surveyor'::text                              AS source_label,
    sf.submitted_by                               AS specialist_id,
    sf.recommendation                             AS outcome,
    sf.summary,
    st.status                                     AS task_status,
    st.priority,
    sf.submitted_at                               AS received_at,
    sf.created_at
  FROM spatial_planning.survey_finding sf
  JOIN spatial_planning.survey_task st ON st.id = sf.survey_task_id
  WHERE st.permit_app_id IS NOT NULL

  UNION ALL
  -- Stage inspection outcomes (building inspector)
  SELECT
    si.permit_app_id,
    'inspection'::text                            AS finding_type,
    si.id                                          AS source_id,
    ('Stage ' || si.stage_number::text)::text      AS source_label,
    si.inspector_id                                AS specialist_id,
    si.result                                      AS outcome,
    si.result_notes                                AS summary,
    NULL::varchar                                  AS task_status,
    NULL::varchar                                  AS priority,
    si.inspected_at                                AS received_at,
    si.created_at
  FROM spatial_planning.stage_inspection si
  WHERE si.result IS NOT NULL

  UNION ALL
  -- Plan-review findings (joined to the permit via dev_app_id)
  SELECT
    pa.id                                          AS permit_app_id,
    'plan_review'::text                            AS finding_type,
    prf.id::text::uuid                             AS source_id,
    ('Plan review: ' || prf.code)::text            AS source_label,
    pr.uploaded_by                                 AS specialist_id,
    prf.severity                                   AS outcome,
    prf.message                                    AS summary,
    pr.status                                      AS task_status,
    NULL::varchar                                  AS priority,
    prf.created_at                                 AS received_at,
    prf.created_at
  FROM public.plan_review_findings prf
  JOIN public.plan_reviews pr ON pr.id = prf.review_id
  JOIN spatial_planning.permit_application pa ON pa.dev_app_id = pr.application_id;

COMMENT ON VIEW spatial_planning.v_specialist_findings IS
  'Federated, read-only roll-up of every specialist finding for a permit: statutory consultations, surveyor findings, stage inspections, and plan-review findings — keyed on permit_app_id.';

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 085 complete — planner case backend installed';
  RAISE NOTICE '   Tables : case_message, permit_document, document_request, document_review,';
  RAISE NOTICE '            statutory_clock_event, generated_document, spatial_analysis_result,';
  RAISE NOTICE '            eo_handoff_package';
  RAISE NOTICE '   Altered: permit_application (+awaiting_eo_decision, clock_state, clock_paused_days)';
  RAISE NOTICE '            application_consultation (+priority, task_status, task_type)';
  RAISE NOTICE '   View   : v_specialist_findings';
END $$;
