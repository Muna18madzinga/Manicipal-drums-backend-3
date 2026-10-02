-- 133_gms_editing.sql
-- ─────────────────────────────────────────────────────────────────────────
-- GIS Management System, phase 2: editable layers, edit sessions + QA, and
-- per-feature history.
--
--   gis_ops.layer            what can be edited, by which custodian, with
--                            which attribute schema and topology rules
--   gis_ops.feature          the PUBLISHED version of every GMS feature
--   gis_ops.feature_version  every version ever published (restore source)
--   gis_ops.edit_session     a user's pending edits to one layer; the QA
--                            queue is the sessions in status 'submitted'
--
-- Edits live only in the session until gis_data approves them, so a
-- departmental edit is invisible to other departments until QA (rule 3).
-- Parcels are not here: they stay in land.parcel and change only through a
-- survey import (migration 132).
--
-- spatial_planning.gis_feature (migration 091) is the pre-GMS digitising
-- store the older console writes to directly; it is left as it is.
--
-- Idempotent. Apply individually:
--   node scripts/apply-local-migration.js 133_gms_editing.sql
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS gis_ops.layer (
  layer_id        varchar(48) PRIMARY KEY,
  title           text        NOT NULL,
  grp             varchar(24) NOT NULL CHECK (grp IN (
                    'Administrative', 'Land & Cadastre', 'Planning', 'Revenue',
                    'Infrastructure', 'Social', 'Environment', 'Imagery')),
  geom_type       varchar(12) NOT NULL CHECK (geom_type IN ('Point', 'LineString', 'Polygon')),
  custodian_dept  text        NOT NULL,
  steward         text,
  -- [{ name, label, type: text|number|date|boolean, required, domain: [..], personal }]
  attributes      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- { point_in_ward, network, no_overlap }
  rules           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  access_level    varchar(12) NOT NULL DEFAULT 'internal'
                  CHECK (access_level IN ('public', 'internal', 'restricted')),
  editable        boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gis_ops.feature (
  feature_id      bigserial   PRIMARY KEY,
  layer_id        varchar(48) NOT NULL REFERENCES gis_ops.layer(layer_id),
  attrs           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  geom            geometry(Geometry, 4326) NOT NULL,
  -- Business rule 2: no feature without a custodian, a source and a class.
  accuracy_class  char(1)     NOT NULL CHECK (accuracy_class IN ('A', 'B', 'C', 'D')),
  source          text        NOT NULL CHECK (source <> ''),
  custodian_dept  text        NOT NULL,
  version         integer     NOT NULL DEFAULT 1,
  status          varchar(12) NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'retired')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gms_feature_geom  ON gis_ops.feature USING gist (geom);
CREATE INDEX IF NOT EXISTS idx_gms_feature_layer ON gis_ops.feature (layer_id) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS gis_ops.edit_session (
  session_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id        varchar(48) NOT NULL REFERENCES gis_ops.layer(layer_id),
  user_id         uuid        NOT NULL REFERENCES public.users(id),
  status          varchar(12) NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'submitted', 'approved', 'rejected', 'returned', 'abandoned')),
  -- [{ op: create|update|delete, ... }] — autosaved as the user works, so a
  -- power cut loses at most the last few seconds.
  edits           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  title           text,
  submitted_at    timestamptz,
  decided_by      uuid        REFERENCES public.users(id),
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_decision_has_note CHECK (status NOT IN ('rejected', 'returned') OR decision_note IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_edit_session_queue ON gis_ops.edit_session (submitted_at) WHERE status = 'submitted';
CREATE INDEX IF NOT EXISTS idx_edit_session_user  ON gis_ops.edit_session (user_id, status);
-- One live session per user and layer: reopening the layer resumes it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_edit_session_live
  ON gis_ops.edit_session (user_id, layer_id) WHERE status IN ('open', 'returned');

CREATE TABLE IF NOT EXISTS gis_ops.feature_version (
  feature_id      bigint      NOT NULL REFERENCES gis_ops.feature(feature_id),
  version         integer     NOT NULL,
  action          varchar(12) NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
  attrs           jsonb       NOT NULL,
  geom            geometry(Geometry, 4326) NOT NULL,
  accuracy_class  char(1)     NOT NULL,
  source          text        NOT NULL,
  session_id      uuid        REFERENCES gis_ops.edit_session(session_id),
  changed_by      uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  note            text,
  PRIMARY KEY (feature_id, version)
);

-- ── Starter layers ───────────────────────────────────────────────────────
-- Custodians follow the brief: Engineering owns infrastructure, Planning owns
-- layouts, Revenue owns premises, Social Services and Health their facilities.
INSERT INTO gis_ops.layer (layer_id, title, grp, geom_type, custodian_dept, attributes, rules, access_level) VALUES
  ('boreholes', 'Boreholes', 'Infrastructure', 'Point', 'Engineering',
   '[{"name":"name","label":"Name","type":"text","required":true},
     {"name":"status","label":"Status","type":"text","required":true,"domain":["functional","needs repair","broken","abandoned"]},
     {"name":"depth_m","label":"Depth (m)","type":"number"},
     {"name":"yield_lps","label":"Yield (l/s)","type":"number"}]',
   '{"point_in_ward":true}', 'public'),
  ('council_roads', 'Council roads', 'Infrastructure', 'LineString', 'Engineering',
   '[{"name":"name","label":"Name","type":"text"},
     {"name":"surface","label":"Surface","type":"text","required":true,"domain":["tar","gravel","earth"]},
     {"name":"road_class","label":"Class","type":"text","required":true,"domain":["district","feeder","access"]}]',
   '{"network":true}', 'public'),
  ('layout_stands', 'Proposed layout stands', 'Planning', 'Polygon', 'Planning',
   '[{"name":"stand_no","label":"Stand number","type":"text","required":true},
     {"name":"proposed_use","label":"Proposed use","type":"text","required":true,"domain":["residential","commercial","institutional","industrial","open space"]}]',
   '{"no_overlap":true}', 'internal'),
  ('business_premises', 'Business premises', 'Revenue', 'Point', 'Revenue',
   '[{"name":"trading_name","label":"Trading name","type":"text","required":true},
     {"name":"category","label":"Category","type":"text","required":true,"domain":["retail","bottle store","hair salon","grinding mill","workshop","eatery","other"]},
     {"name":"owner_name","label":"Owner name","type":"text","personal":true},
     {"name":"owner_phone","label":"Owner phone","type":"text","personal":true}]',
   '{"point_in_ward":true}', 'restricted'),
  ('schools', 'Schools', 'Social', 'Point', 'Social Services',
   '[{"name":"name","label":"Name","type":"text","required":true},
     {"name":"level","label":"Level","type":"text","required":true,"domain":["ECD","primary","secondary"]},
     {"name":"enrolment","label":"Enrolment","type":"number"}]',
   '{"point_in_ward":true}', 'public'),
  ('clinics', 'Clinics', 'Social', 'Point', 'Health',
   '[{"name":"name","label":"Name","type":"text","required":true},
     {"name":"type","label":"Type","type":"text","required":true,"domain":["clinic","rural health centre","hospital"]}]',
   '{"point_in_ward":true}', 'public')
ON CONFLICT (layer_id) DO NOTHING;

COMMIT;
