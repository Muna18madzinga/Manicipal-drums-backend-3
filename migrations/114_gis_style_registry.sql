-- Migration 114: enterprise GIS symbology registry
--
-- WHY THIS EXISTS
-- ---------------
-- Before this migration the platform had six competing symbology authorities:
--   1. frontend src/map/masterplanSymbology.ts     (statutory colour schedule)
--   2. qgis-projects/vungu-project.qgs renderers   (10 of 24 layers)
--   3. spatial_layers.style_config JSONB           (QGIS Desktop plugin push, mig 111)
--   4. frontend src/map/vunguBasemapStyle.ts PALETTE (21 basemap layers, hard-coded hex)
--   5. symbology-style.db                          (stray sqlite)
--   6. five *QGISStyleExtractor services           (ad-hoc JSON shapes)
-- Any two of them could disagree, and #2 provably did (High Density Residential
-- and Economic Corridor were both #ffff00, breaking "one symbol = one thing").
--
-- This table is now the ONE authority. A style is a renderer-neutral JSON
-- document (schema `vungu.gis.style/1`, see src/services/gis/styleDoc.js) that
-- every client compiles from: QGIS Desktop/Server via QML, the web map via
-- MapLibre layer specs, and any future mobile/ArcGIS client.
--
-- DATA vs STYLE: this migration creates NO geometry columns and touches NO
-- spatial table. PostGIS remains the sole authority for spatial data; this is
-- the sole authority for how that data is drawn.
--
-- Idempotent: safe to re-run.
-- Apply locally with: node scripts/apply-local-migration.js 114_gis_style_registry.sql

BEGIN;

-- ── Lifecycle ──────────────────────────────────────────────────────────────
-- draft -> review -> approved -> published -> deprecated -> archived
-- Only `published` may be served to production map clients.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gis_style_status') THEN
    CREATE TYPE gis_style_status AS ENUM
      ('draft', 'review', 'approved', 'published', 'deprecated', 'archived');
  END IF;
END $$;

-- ── Layer catalogue ────────────────────────────────────────────────────────
-- One row per enterprise GIS layer. Deliberately separate from `spatial_layers`
-- (migration 111): that table is the QGIS-plugin push target and carries the
-- legacy `style_config` blob. This one is the governed catalogue and holds NO
-- symbology of its own -- it only points at the registry.
CREATE TABLE IF NOT EXISTS gis_layer (
  layer_id        TEXT PRIMARY KEY,
  display_name    TEXT        NOT NULL,
  description     TEXT,
  geometry        TEXT        NOT NULL
                    CHECK (geometry IN ('polygon', 'line', 'point', 'raster')),
  -- provenance of the DATA (not the style)
  data_source     TEXT,                       -- PostGIS table or view
  data_srid       INTEGER,
  data_synced_at  TIMESTAMPTZ,                -- last spatial-data sync
  -- provenance of the STYLE authoring source
  qgis_project    TEXT,                       -- e.g. qgis-projects/vungu-project.qgs
  qgis_layer      TEXT,                       -- <layername> inside that project
  -- governance
  owner           TEXT,
  steward         TEXT,
  access_roles    TEXT[]      NOT NULL DEFAULT ARRAY['admin', 'gis_officer', 'planner'],
  min_zoom        INTEGER,
  max_zoom        INTEGER,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  gis_layer IS 'Governed enterprise GIS layer catalogue. Carries no symbology - see gis_style.';
COMMENT ON COLUMN gis_layer.data_synced_at IS 'When spatial DATA last synced. Independent of style publication.';

-- ── Style versions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gis_style (
  style_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id        TEXT        NOT NULL REFERENCES gis_layer(layer_id) ON DELETE CASCADE,
  style_name      TEXT        NOT NULL,
  style_version   INTEGER     NOT NULL CHECK (style_version >= 1),
  status          gis_style_status NOT NULL DEFAULT 'draft',

  -- Where this style came from. `qgis` means it was parsed out of a .qgs/.qml
  -- and QGIS is the cartographic author for this layer. `statutory_schedule`
  -- means it derives from the Zimbabwe town-planning map-notation schedule
  -- (the 21 basemap layers, which no QGIS project styles).
  source          TEXT        NOT NULL DEFAULT 'qgis'
                    CHECK (source IN ('qgis', 'statutory_schedule', 'manual', 'imported_sld')),
  source_path     TEXT,                       -- file the style was read from
  source_checksum TEXT,                       -- sha256 of the source fragment

  -- Renderer-neutral normalised style document (schema vungu.gis.style/1).
  -- THE authoritative payload. All renderer configs are compiled from this.
  definition      JSONB       NOT NULL,
  -- Denormalised for cheap catalogue queries / validation reporting.
  renderer_type   TEXT        NOT NULL
                    CHECK (renderer_type IN ('single', 'categorized', 'graduated', 'rule_based')),
  classification_attribute TEXT,
  classification_method    TEXT,              -- e.g. equal_interval, quantile, unique_values
  scale_min_zoom  INTEGER,
  scale_max_zoom  INTEGER,
  opacity         NUMERIC(4,3) NOT NULL DEFAULT 1.000
                    CHECK (opacity >= 0 AND opacity <= 1),

  -- How faithfully MapLibre can draw this. Drives the renderer strategy:
  -- `direct`/`converted` -> vector tiles; `server` -> QGIS Server WMS raster;
  -- `unsupported` -> must not be published.
  fidelity        TEXT        NOT NULL DEFAULT 'direct'
                    CHECK (fidelity IN ('direct', 'converted', 'server', 'unsupported')),
  fidelity_notes  JSONB       NOT NULL DEFAULT '[]',

  -- Integrity: sha256 over the canonical JSON of `definition`.
  checksum        TEXT        NOT NULL,

  metadata        JSONB       NOT NULL DEFAULT '{}',
  change_summary  TEXT,
  created_by      TEXT,
  approved_by     TEXT,
  published_by    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at     TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,

  CONSTRAINT gis_style_layer_version_uniq UNIQUE (layer_id, style_version),
  -- Approval must be recorded before publication is possible.
  CONSTRAINT gis_style_approved_fields CHECK (
    status <> 'published' OR (approved_by IS NOT NULL AND published_at IS NOT NULL)
  ),
  -- An unsupported style can never reach production.
  CONSTRAINT gis_style_no_unsupported_publish CHECK (
    fidelity <> 'unsupported' OR status <> 'published'
  )
);

-- AT MOST ONE published version per layer. This is the guarantee that
-- "one layer -> one approved production style" is structurally enforced,
-- not merely respected by application code.
CREATE UNIQUE INDEX IF NOT EXISTS gis_style_one_published_per_layer
  ON gis_style (layer_id) WHERE status = 'published';

CREATE INDEX IF NOT EXISTS gis_style_layer_status_idx ON gis_style (layer_id, status);
CREATE INDEX IF NOT EXISTS gis_style_checksum_idx     ON gis_style (checksum);

COMMENT ON COLUMN gis_style.definition IS 'Renderer-neutral style doc (vungu.gis.style/1). Immutable once published.';
COMMENT ON COLUMN gis_style.fidelity   IS 'MapLibre representability. `server` routes the layer to QGIS Server WMS instead of vector tiles.';

-- ── Audit log ──────────────────────────────────────────────────────────────
-- Append-only. Every lifecycle transition and every publish/rollback lands here.
CREATE TABLE IF NOT EXISTS gis_style_audit (
  audit_id      BIGSERIAL   PRIMARY KEY,
  layer_id      TEXT        NOT NULL,
  style_id      UUID,
  event         TEXT        NOT NULL,   -- created | submitted | approved | published | rolled_back | deprecated | rejected
  from_status   gis_style_status,
  to_status     gis_style_status,
  from_version  INTEGER,
  to_version    INTEGER,
  reason        TEXT,
  change_summary TEXT,
  source_path   TEXT,
  checksum      TEXT,
  actor         TEXT,
  actor_role    TEXT,
  detail        JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gis_style_audit_layer_idx ON gis_style_audit (layer_id, created_at DESC);

-- The audit trail is evidence. Block edits and deletes at the database.
CREATE OR REPLACE FUNCTION gis_style_audit_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'gis_style_audit is append-only (attempted %)', TG_OP;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gis_style_audit_immutable ON gis_style_audit;
CREATE TRIGGER gis_style_audit_immutable
  BEFORE UPDATE OR DELETE ON gis_style_audit
  FOR EACH ROW EXECUTE FUNCTION gis_style_audit_append_only();

-- ── Immutability of published styles ───────────────────────────────────────
-- The single most important rule in the architecture: once a version is
-- PUBLISHED its cartography is frozen. Changes require a NEW version. Enforced
-- in the database so no route, script, psql session or future developer can
-- bypass it.
--
-- Permitted updates on a published row: status transitions onward
-- (published -> deprecated/archived) and bookkeeping columns. Any change to
-- definition / checksum / renderer / classification / opacity / fidelity is
-- rejected.
CREATE OR REPLACE FUNCTION gis_style_guard_published() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'published' THEN
    IF NEW.definition::text        IS DISTINCT FROM OLD.definition::text
       OR NEW.checksum             IS DISTINCT FROM OLD.checksum
       OR NEW.renderer_type        IS DISTINCT FROM OLD.renderer_type
       OR NEW.classification_attribute IS DISTINCT FROM OLD.classification_attribute
       OR NEW.classification_method    IS DISTINCT FROM OLD.classification_method
       OR NEW.opacity              IS DISTINCT FROM OLD.opacity
       OR NEW.fidelity             IS DISTINCT FROM OLD.fidelity
       OR NEW.style_version        IS DISTINCT FROM OLD.style_version
       OR NEW.layer_id             IS DISTINCT FROM OLD.layer_id
    THEN
      RAISE EXCEPTION
        'gis_style %/v% is PUBLISHED and immutable; create a new version instead',
        OLD.layer_id, OLD.style_version
        USING ERRCODE = 'read_only_sql_transaction';
    END IF;
    -- Rolling forward is allowed; reverting a published row to an earlier
    -- lifecycle stage is not (rollback publishes the older version instead).
    IF NEW.status IN ('draft', 'review', 'approved') THEN
      RAISE EXCEPTION
        'gis_style %/v% cannot return to % from published; publish another version',
        OLD.layer_id, OLD.style_version, NEW.status
        USING ERRCODE = 'read_only_sql_transaction';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gis_style_published_immutable ON gis_style;
CREATE TRIGGER gis_style_published_immutable
  BEFORE UPDATE ON gis_style
  FOR EACH ROW EXECUTE FUNCTION gis_style_guard_published();

-- A style that has ever reached production is part of the audit record.
CREATE OR REPLACE FUNCTION gis_style_block_published_delete() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('published', 'deprecated', 'archived') THEN
    RAISE EXCEPTION
      'gis_style %/v% has been published; it is part of the audit record and cannot be deleted',
      OLD.layer_id, OLD.style_version
      USING ERRCODE = 'read_only_sql_transaction';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gis_style_no_delete_published ON gis_style;
CREATE TRIGGER gis_style_no_delete_published
  BEFORE DELETE ON gis_style
  FOR EACH ROW EXECUTE FUNCTION gis_style_block_published_delete();

-- ── Resolution view ────────────────────────────────────────────────────────
-- What every production client resolves against. One row per layer, carrying
-- the published style version and both provenance timestamps so a client can
-- tell a style change from a data change.
CREATE OR REPLACE VIEW gis_published_style AS
SELECT
  l.layer_id,
  l.display_name,
  l.description,
  l.geometry,
  l.data_source,
  l.data_srid,
  l.data_synced_at,
  l.qgis_project,
  l.qgis_layer,
  l.owner,
  l.steward,
  l.access_roles,
  COALESCE(s.scale_min_zoom, l.min_zoom) AS min_zoom,
  COALESCE(s.scale_max_zoom, l.max_zoom) AS max_zoom,
  s.style_id,
  s.style_name,
  s.style_version,
  s.source,
  s.source_path,
  s.definition,
  s.renderer_type,
  s.classification_attribute,
  s.classification_method,
  s.opacity,
  s.fidelity,
  s.fidelity_notes,
  s.checksum,
  s.approved_by,
  s.published_by,
  s.published_at AS style_published_at
FROM gis_layer l
LEFT JOIN gis_style s
  ON s.layer_id = l.layer_id AND s.status = 'published'
WHERE l.is_active;

COMMENT ON VIEW gis_published_style IS 'Production style resolution. LEFT JOIN: a layer with no published style resolves to NULL and the client must fall back, never guess.';

COMMIT;
