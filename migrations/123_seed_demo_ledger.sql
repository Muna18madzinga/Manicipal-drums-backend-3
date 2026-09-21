-- 123_seed_demo_ledger.sql
--
-- Records which rows a seed-*-demo script created, so --undo can remove
-- exactly those and nothing else.
--
-- A side table rather than a demo_tag column on every table: demo data is a
-- testing concern and should not reshape the domain schema. Dropping this
-- table removes the tracking and nothing else.
--
-- row_id is TEXT because the tables it points at mix uuid and bigint keys.
-- The ledger's own id is the insertion order, which is the dependency order,
-- so deleting in reverse removes children before their parents.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.seed_demo_ledger (
  id          BIGSERIAL PRIMARY KEY,
  tag         TEXT        NOT NULL,
  table_name  TEXT        NOT NULL,
  row_id      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tag, table_name, row_id)
);

CREATE INDEX IF NOT EXISTS seed_demo_ledger_tag_idx
  ON public.seed_demo_ledger (tag);

COMMENT ON TABLE public.seed_demo_ledger IS
  'Rows created by scripts/seed-*-demo.js, so --undo can remove exactly those. Not domain data.';
