-- Migration 065: plan-review submissions + machine-readable findings.
--
-- Citizens upload a building plan (PDF or CAD). The system runs a
-- deterministic rules pre-check (file type, size, presence of expected
-- text annotations such as "north arrow", "scale", "site plan") and
-- writes one row per finding to plan_review_findings. A planner
-- reviews the findings before approving or returning the plan.
--
-- The seam for deep CAD geometric checks (dwg parsing, setback
-- measurements off the drawing) is at src/services/planReview.js
-- behind the runDeterministicChecks() function.

BEGIN;

CREATE TABLE IF NOT EXISTS plan_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  VARCHAR(32) NOT NULL,
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,

  storage_url     TEXT     NOT NULL,
  mime_type       VARCHAR(64) NOT NULL,
  bytes           BIGINT   NOT NULL CHECK (bytes > 0),
  sha256_hex      VARCHAR(64),

  -- High-level outcome of the deterministic checks. Final approval
  -- still requires staff sign-off; this lets the citizen see whether
  -- their submission is even worth reviewing.
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending',         -- file uploaded, checks running
                      'auto_passed',     -- no errors found
                      'auto_warnings',   -- warnings only
                      'auto_failed',     -- errors found; cannot be submitted
                      'staff_approved',
                      'staff_rejected'
                    )),
  notes           TEXT,

  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_reviews_app
  ON plan_reviews(application_id);
CREATE INDEX IF NOT EXISTS idx_plan_reviews_status
  ON plan_reviews(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_reviews_hash_app
  ON plan_reviews(application_id, sha256_hex)
  WHERE sha256_hex IS NOT NULL;

CREATE TABLE IF NOT EXISTS plan_review_findings (
  id            BIGSERIAL PRIMARY KEY,
  review_id     UUID NOT NULL REFERENCES plan_reviews(id) ON DELETE CASCADE,

  severity      VARCHAR(8) NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
  -- Stable code so the frontend can localise without reading prose.
  code          VARCHAR(64) NOT NULL,
  -- Plain-English message. Manual citation included where applicable.
  message       TEXT NOT NULL,
  -- Optional pointer to the rule's source: { manualSection: '4.2.1', page: 18 }
  source        JSONB,
  -- Optional bounding box on the page for the frontend to highlight:
  -- { page: 1, x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.4 } in PDF user-space %.
  bbox          JSONB,

  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_review_findings_review
  ON plan_review_findings(review_id);
CREATE INDEX IF NOT EXISTS idx_plan_review_findings_severity
  ON plan_review_findings(review_id, severity);

COMMIT;
