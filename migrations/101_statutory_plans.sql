-- 101_statutory_plans.sql
-- ────────────────────────────────────────────────────────────────────────
-- Statutory plan register (RTCP Act [Ch. 29:12] Parts II & IV): regional /
-- master / local plans with the s7/s16/s19 lifecycle. Queryable columns for
-- kind/status/effective date + GiST-indexed optional boundary (NULL means the
-- plan applies authority-wide); the full plan document (written statement,
-- objections, exhibition, audit trail) is the JSONB doc — the frontend
-- usePlans composable is its single writer.
-- Idempotent: CREATE … IF NOT EXISTS.
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS spatial_planning.statutory_plan (
  id             VARCHAR(60) PRIMARY KEY,          -- client-generated uid
  kind           VARCHAR(10)  NOT NULL CHECK (kind IN ('regional', 'master', 'local')),
  name           VARCHAR(255) NOT NULL,
  authority_id   VARCHAR(60)  NOT NULL DEFAULT 'lpa',
  status         VARCHAR(12)  NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'exhibition', 'objections', 'submitted',
                                   'approved', 'operative', 'altered', 'repealed')),
  effective_date TIMESTAMPTZ,                      -- set when operative (s71)
  doc            JSONB NOT NULL,                   -- full AnyPlan document
  boundary       geometry(MultiPolygon, 4326),     -- NULL = authority-wide
  created_by     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_statutory_plan_status
  ON spatial_planning.statutory_plan(status);
CREATE INDEX IF NOT EXISTS idx_statutory_plan_boundary
  ON spatial_planning.statutory_plan USING GIST(boundary);

COMMENT ON TABLE spatial_planning.statutory_plan IS
  'RTCP Parts II/IV plan register: regional/master/local plans, s7/16/19 lifecycle, s71 operative date.';
