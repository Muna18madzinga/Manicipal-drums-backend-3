-- 144_parcel_zoning.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Which zone governs a parcel. A parcel is a row in one of several layers (stands, the
-- Vungu farm parcels, the surveyed-parcel register), so it is named by (layer, id) rather
-- than by merging those tables.
--
--   compute_parcel_zoning(layer, id)  live: intersect the parcel with every non-template
--                                     plan's zone polygons; share of the parcel in each zone;
--                                     the largest share in each plan is its governing zone
--   parcel_zoning                     stored rows: manual assignments (a person's decision
--                                     wins) and a cache of intersections
--   set_manual_parcel_zoning(...)     record a manual assignment
--   refresh_parcel_zoning(layer, id)  re-cache the intersections for one parcel
--   parcel_zoning_for(layer, id)      what to use: a plan's manual assignment if it has one,
--                                     otherwise the live intersection
--
-- LIMITS, stated plainly:
--  * Shares are areas on the geography (spheroid) of the parcel and zone polygons, in %.
--    Zone polygons that overlap each other in one plan can make shares add to over 100.
--  * "Governing" is the largest share within each PLAN. Which PLAN governs where plans of two
--    authorities overlap (the combination authority question) is not decided here: every
--    plan is returned and the caller must not pick silently.
--  * A parcel inside no zone polygon returns no rows: it is unzoned, not "permitted".
--  * Plans' effective dates are not yet applied.

BEGIN;

CREATE TABLE IF NOT EXISTS parcel_zoning (
  parcel_layer       text    NOT NULL CHECK (parcel_layer IN ('stands', 'vungu_parcels', 'land.parcel')),
  parcel_id          text    NOT NULL,
  zone_id            integer NOT NULL REFERENCES proposed_peri_urban_zones (id) ON DELETE CASCADE,
  plan_instrument_id uuid    NOT NULL REFERENCES plan_instrument (id),
  plan_zone_type_id  uuid    REFERENCES plan_zone_type (id),
  share_pct          numeric CHECK (share_pct IS NULL OR (share_pct >= 0 AND share_pct <= 100.5)),
  method             text    NOT NULL CHECK (method IN ('intersection', 'manual')),
  is_governing       boolean NOT NULL DEFAULT FALSE,
  assigned_on        date    NOT NULL DEFAULT CURRENT_DATE,
  note               text,
  PRIMARY KEY (parcel_layer, parcel_id, zone_id)
);

CREATE INDEX IF NOT EXISTS idx_parcel_zoning_zone ON parcel_zoning (zone_id);

-- The parcel's geometry, from whichever layer holds it (WGS 84). NULL if the layer or the
-- row does not exist in this database.
CREATE OR REPLACE FUNCTION parcel_geometry(p_layer text, p_id text) RETURNS geometry AS $$
DECLARE g geometry;
BEGIN
  IF p_layer = 'stands' AND to_regclass('public.stands') IS NOT NULL THEN
    EXECUTE 'SELECT geom FROM public.stands WHERE id::text = $1' INTO g USING p_id;
  ELSIF p_layer = 'vungu_parcels' AND to_regclass('public.vungu_parcels') IS NOT NULL THEN
    EXECUTE 'SELECT geom FROM public.vungu_parcels WHERE fid::text = $1' INTO g USING p_id;
  ELSIF p_layer = 'land.parcel' AND to_regclass('land.parcel') IS NOT NULL THEN
    EXECUTE 'SELECT geom_wgs84 FROM land.parcel WHERE parcel_id = $1' INTO g USING p_id;
  ELSE
    RAISE EXCEPTION 'unknown parcel layer %', p_layer USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN g;
END $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION compute_parcel_zoning(p_layer text, p_id text)
RETURNS TABLE (zone_id integer, plan_instrument_id uuid, plan_zone_type_id uuid, zone_name text,
               share_pct numeric, is_governing boolean) AS $$
  WITH g AS (SELECT parcel_geometry(p_layer, p_id) AS geom),
  x AS (
    SELECT z.id, z.plan_instrument_id AS plan, z.plan_zone_type_id AS ztype, z.zone,
           ST_Area(ST_CollectionExtract(ST_Intersection(g.geom, z.geom), 3)::geography) AS a,
           ST_Area(g.geom::geography) AS parcel_area
      FROM g
      JOIN proposed_peri_urban_zones z ON g.geom IS NOT NULL AND ST_Intersects(g.geom, z.geom)
      JOIN plan_instrument i ON i.id = z.plan_instrument_id AND NOT i.is_template)
  SELECT x.id, x.plan, x.ztype, x.zone,
         ROUND((100 * x.a / NULLIF(x.parcel_area, 0))::numeric, 2),
         ROW_NUMBER() OVER (PARTITION BY x.plan ORDER BY x.a DESC, x.id) = 1
    FROM x
   WHERE x.a > 0
   ORDER BY x.plan, x.a DESC, x.id
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION set_manual_parcel_zoning(p_layer text, p_id text, p_zone integer, p_note text DEFAULT NULL)
RETURNS void AS $$
DECLARE z proposed_peri_urban_zones%ROWTYPE;
BEGIN
  SELECT * INTO z FROM proposed_peri_urban_zones WHERE id = p_zone;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown zone polygon %', p_zone; END IF;
  IF parcel_geometry(p_layer, p_id) IS NULL THEN RAISE EXCEPTION 'no parcel % in layer %', p_id, p_layer; END IF;
  UPDATE parcel_zoning SET is_governing = FALSE
   WHERE parcel_layer = p_layer AND parcel_id = p_id AND plan_instrument_id = z.plan_instrument_id;
  INSERT INTO parcel_zoning (parcel_layer, parcel_id, zone_id, plan_instrument_id, plan_zone_type_id, method, is_governing, note)
  VALUES (p_layer, p_id, p_zone, z.plan_instrument_id, z.plan_zone_type_id, 'manual', TRUE, p_note)
  ON CONFLICT (parcel_layer, parcel_id, zone_id)
  DO UPDATE SET method = 'manual', is_governing = TRUE, note = EXCLUDED.note, assigned_on = CURRENT_DATE;
END $$ LANGUAGE plpgsql;

-- Re-cache the intersections for one parcel. Manual rows are never removed or overwritten.
CREATE OR REPLACE FUNCTION refresh_parcel_zoning(p_layer text, p_id text) RETURNS integer AS $$
DECLARE n integer;
BEGIN
  DELETE FROM parcel_zoning WHERE parcel_layer = p_layer AND parcel_id = p_id AND method = 'intersection';
  INSERT INTO parcel_zoning (parcel_layer, parcel_id, zone_id, plan_instrument_id, plan_zone_type_id, share_pct, method, is_governing)
  SELECT p_layer, p_id, c.zone_id, c.plan_instrument_id, c.plan_zone_type_id, c.share_pct, 'intersection',
         c.is_governing AND NOT EXISTS (SELECT 1 FROM parcel_zoning m
                                         WHERE m.parcel_layer = p_layer AND m.parcel_id = p_id
                                           AND m.plan_instrument_id = c.plan_instrument_id AND m.method = 'manual')
    FROM compute_parcel_zoning(p_layer, p_id) c
  ON CONFLICT (parcel_layer, parcel_id, zone_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$ LANGUAGE plpgsql;

-- What to use: a plan's manual assignment if it has one, otherwise the live intersection.
CREATE OR REPLACE FUNCTION parcel_zoning_for(p_layer text, p_id text)
RETURNS TABLE (zone_id integer, plan_instrument_id uuid, plan_zone_type_id uuid, zone_name text,
               share_pct numeric, is_governing boolean, method text) AS $$
  WITH manual AS (
    SELECT m.zone_id, m.plan_instrument_id, m.plan_zone_type_id, z.zone AS zone_name, m.share_pct, m.is_governing
      FROM parcel_zoning m JOIN proposed_peri_urban_zones z ON z.id = m.zone_id
     WHERE m.parcel_layer = p_layer AND m.parcel_id = p_id AND m.method = 'manual'),
  live AS (SELECT * FROM compute_parcel_zoning(p_layer, p_id))
  SELECT m.zone_id, m.plan_instrument_id, m.plan_zone_type_id, m.zone_name, m.share_pct, m.is_governing, 'manual'::text FROM manual m
  UNION ALL
  SELECT l.zone_id, l.plan_instrument_id, l.plan_zone_type_id, l.zone_name, l.share_pct, l.is_governing, 'intersection'::text
    FROM live l WHERE NOT EXISTS (SELECT 1 FROM manual m WHERE m.plan_instrument_id = l.plan_instrument_id)
$$ LANGUAGE sql STABLE;

COMMIT;
