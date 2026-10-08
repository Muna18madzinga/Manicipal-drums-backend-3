-- 152_layer_publication.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Which database tables the portal may expose, and to whom. Default DENY.
--
-- The layer catalogue is declared by the QGIS project (what layers, which groups, which are on).
-- A saved project must not be able to widen what the server exposes: anyone who can save the file
-- could otherwise name any table. So the project declares and this table approves. A layer in the
-- project whose table is not in this list is not shown; it appears in the reconciliation report.
--
-- audience: 'staff' = signed-in council staff; 'public' = anyone. Nothing is seeded 'public':
-- the catalogue is staff-facing for now, and making a table public is a decision someone records.
--
-- SEED: every table the old layer registry (spatial_layers) already exposed, plus the zones view the
-- project reads, so the planner's layer list does not shrink on the day this ships. Editing and
-- tile exposure keep their own controls (the WFS-T allowlist, config/spatialLayers.js); approval here
-- does not grant either.

BEGIN;

CREATE TABLE IF NOT EXISTS public.layer_publication (
  table_name  text PRIMARY KEY,
  audience    text NOT NULL DEFAULT 'staff' CHECK (audience IN ('staff', 'public')),
  approved_by text,
  approved_at timestamptz NOT NULL DEFAULT now(),
  note        text
);

DO $$
BEGIN
  IF to_regclass('public.spatial_layers') IS NOT NULL THEN
    INSERT INTO public.layer_publication (table_name, audience, approved_by, note)
    SELECT sl.table_name, 'staff', 'migration 152',
           'Seeded from the layer registry (spatial_layers) as it stood when this table was created.'
      FROM public.spatial_layers sl
     WHERE sl.is_visible
       AND EXISTS (SELECT 1 FROM information_schema.tables t
                    WHERE t.table_schema = 'public' AND t.table_name = sl.table_name)
    ON CONFLICT (table_name) DO NOTHING;
  END IF;

  INSERT INTO public.layer_publication (table_name, audience, approved_by, note)
  SELECT v.t, 'staff', 'migration 152', 'The zones view the QGIS project reads (docs/SSOT-spatial.md).'
    FROM (VALUES ('zones_master'), ('proposed_peri_urban_zones')) AS v(t)
   WHERE EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = 'public' AND t.table_name = v.t)
  ON CONFLICT (table_name) DO NOTHING;
END $$;

COMMIT;
