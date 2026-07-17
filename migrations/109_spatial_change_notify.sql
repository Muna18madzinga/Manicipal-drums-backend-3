-- Migration 109: real-time spatial change notification (QGIS <-> web live sync)
--
-- Any INSERT / UPDATE / DELETE on a spatial table fires
-- pg_notify('spatial_change', {...}) — no matter WHO wrote the row: the
-- Fastify API, a planner editing the PostGIS layer directly from QGIS
-- Desktop, an ogr2ogr import, or a psql session. The backend holds a
-- dedicated LISTEN connection (src/services/spatialChangeListener.js),
-- invalidates the affected tile-cache layer and pushes an SSE event to every
-- open browser tab. This closes the gap where only API writes refreshed the
-- web map and direct QGIS edits sat invisible until the next tile request.
--
-- Payload is deliberately tiny (table, op, pk) — geometry never rides the
-- NOTIFY queue (8000-byte payload limit; the browser re-pulls tiles anyway).
--
-- Idempotent: safe to re-run.
-- Apply locally with: node scripts/apply-local-migration.js 109_spatial_change_notify.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.notify_spatial_change() RETURNS trigger AS $$
DECLARE
  rec JSONB;
BEGIN
  rec := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  PERFORM pg_notify('spatial_change', json_build_object(
    'schema', TG_TABLE_SCHEMA,
    'table',  TG_TABLE_NAME,
    'op',     TG_OP,
    'id',     COALESCE(rec->>'id', rec->>'fid', rec->>'gid')
  )::text);
  RETURN NULL; -- AFTER trigger: return value is ignored
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.notify_spatial_change IS
  'Row trigger: pg_notify(spatial_change) with {schema,table,op,id}. Consumed by the backend LISTEN connection for live map refresh.';

-- Attach the trigger to one table, idempotently. Called here for every
-- existing geometry table, and by the QGIS push endpoint whenever it
-- creates a fresh qgis_* staging table.
CREATE OR REPLACE FUNCTION public.ensure_spatial_notify_trigger(tbl regclass) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = tbl AND tgname = 'trg_notify_spatial_change' AND NOT tgisinternal
  ) THEN
    EXECUTE format(
      'CREATE TRIGGER trg_notify_spatial_change
         AFTER INSERT OR UPDATE OR DELETE ON %s
         FOR EACH ROW EXECUTE FUNCTION public.notify_spatial_change()', tbl);
  END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.ensure_spatial_notify_trigger IS
  'Attach trg_notify_spatial_change to a table if missing. Safe to call repeatedly.';

-- Attach to every ordinary table that has a geometry column (public schema
-- plus spatial_planning). Views are skipped: writes hit their base tables.
DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN
    SELECT (quote_ident(g.f_table_schema) || '.' || quote_ident(g.f_table_name))::regclass AS tbl
      FROM geometry_columns g
      JOIN pg_class c ON c.relname = g.f_table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = g.f_table_schema
     WHERE g.f_table_schema IN ('public', 'spatial_planning')
       AND c.relkind = 'r'
  LOOP
    PERFORM public.ensure_spatial_notify_trigger(t.tbl);
  END LOOP;
END $$;

COMMIT;
