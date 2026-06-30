-- Migration 094: editable site content (CMS) for the public council pages
--
-- The Vungu RDC public website (vungurdc.org.zw) was a static WordPress site.
-- The portal now carries that content itself (About, Our Profile, Executive
-- Arm, Deliberative Arm committees, departments, publications, stand
-- application, contact). So the IT Admin can change wording, staff lists,
-- tables and committee duties WITHOUT a code deploy, each page is stored here
-- as a slug + JSONB body of content blocks.
--
-- The frontend ships a bundled default ("seed") for every page, so the public
-- site renders fully even when this table is empty or the backend is offline.
-- A row here is an OVERRIDE that wins over the bundled default for that slug.
--
-- Idempotent: safe to re-run (CREATE … IF NOT EXISTS).
-- Apply with: node scripts/migrate-render.js  (094 is in the MIGRATIONS array)

BEGIN;

CREATE TABLE IF NOT EXISTS public.site_content (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  -- Full page object: { eyebrow, intro, blocks: [...] }. Rendered by the
  -- generic CouncilPageView on the frontend.
  body        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_by  UUID REFERENCES public.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.site_content IS
  'IT-Admin-editable content for the public council pages. One row per page slug; body holds the content blocks. Frontend falls back to a bundled default when a slug has no row here.';

-- Keep updated_at fresh on every edit.
CREATE OR REPLACE FUNCTION public.set_site_content_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_site_content_updated_at ON public.site_content;
CREATE TRIGGER trg_site_content_updated_at
  BEFORE UPDATE ON public.site_content
  FOR EACH ROW EXECUTE FUNCTION public.set_site_content_updated_at();

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 094 complete — site_content (editable council CMS)';
END $$;
