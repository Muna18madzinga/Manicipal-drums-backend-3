-- 106_geometry_validation.sql
-- Stage 5 (H1): server-side geometry validation gate.
--
-- Client geometry was written raw (ST_SetSRID(ST_GeomFromGeoJSON(...))) at
-- every polygon writer — gis features, stands, zones, planning projects,
-- statutory-plan boundaries, survey parcels — with no validity check. Invalid
-- geometry (self-intersections, bad rings) was stored and only masked later by
-- ST_MakeValid at tile-render time. This adds ONE shared guard every writer
-- calls, so an invalid boundary is rejected at write time with a clear reason.
--
-- Deliberately REJECTS rather than silently repairs: a stand or parcel boundary
-- must never be quietly mutated (area/topology could shift). Bulk import may opt
-- into repair via allow_repair := true.
--
-- Idempotent: CREATE OR REPLACE.

CREATE SCHEMA IF NOT EXISTS spatial_planning;

CREATE OR REPLACE FUNCTION spatial_planning.geom_from_geojson_checked(
  geojson     text,
  srid        int      DEFAULT 4326,
  allow_repair boolean DEFAULT false
) RETURNS geometry AS $$
DECLARE
  g geometry;
BEGIN
  IF geojson IS NULL OR length(btrim(geojson)) = 0 THEN
    RAISE EXCEPTION 'invalid_geometry: empty geometry' USING ERRCODE = '22023';
  END IF;

  -- ST_GeomFromGeoJSON itself raises on malformed JSON / coordinates.
  g := ST_SetSRID(ST_GeomFromGeoJSON(geojson), srid);

  IF NOT ST_IsValid(g) THEN
    IF allow_repair THEN
      g := ST_MakeValid(g);
      IF NOT ST_IsValid(g) THEN
        RAISE EXCEPTION 'invalid_geometry: unrepairable (%)', ST_IsValidReason(g)
          USING ERRCODE = '22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid_geometry: %', ST_IsValidReason(g)
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN g;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION spatial_planning.geom_from_geojson_checked(text, int, boolean) IS
  'H1 geometry gate: parse client GeoJSON, set SRID, reject invalid geometry with ST_IsValidReason (ERRCODE 22023) unless allow_repair. Every polygon writer calls this instead of raw ST_GeomFromGeoJSON.';
