-- 107_stands_topology.sql
-- Stage 5: topology rule — no two active stands may overlap.
--
-- Mirrors the overlap protection the survey module already enforces on
-- land_parcels, extended to the council stands cadastre. A BEFORE INSERT/UPDATE
-- trigger rejects a stand whose geometry has a real interior overlap (> 1 m²)
-- with any other non-withdrawn stand. Shared boundaries between adjacent stands
-- are fine (ST_Touches), and floating-point slivers below the tolerance are
-- ignored. The GiST index on stands.geom (migration 062) makes the && prefilter
-- fast, so only true bbox-overlap candidates are area-tested.
--
-- Trigger-based, not an EXCLUDE (geom WITH &&) constraint: bbox overlap is far
-- too coarse for a cadastre — adjacent stands' bounding boxes overlap constantly
-- while their interiors only touch. Precise ST_Intersection area is required.
--
-- Write-time only: existing rows are never re-validated, so pre-existing data
-- (seed / bootstrapped overlaps) does not break. Idempotent.

CREATE OR REPLACE FUNCTION spatial_planning.stands_no_overlap()
RETURNS trigger AS $$
DECLARE
  conflict record;
BEGIN
  -- Withdrawn stands are inactive ground; skip the check for/against them.
  IF NEW.geom IS NULL OR NEW.status = 'withdrawn' THEN
    RETURN NEW;
  END IF;

  SELECT s.stand_number, s.ward
    INTO conflict
    FROM stands s
   WHERE s.id <> NEW.id
     AND s.status <> 'withdrawn'
     AND s.geom && NEW.geom                                    -- GiST bbox prefilter
     AND ST_Intersects(s.geom, NEW.geom)
     AND NOT ST_Touches(s.geom, NEW.geom)                      -- shared edge is allowed
     AND ST_Area(ST_Intersection(s.geom, NEW.geom)::geography) > 1.0   -- > 1 m² interior overlap
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'stand_overlap: geometry overlaps active stand % (ward %)',
      conflict.stand_number, conflict.ward
      USING ERRCODE = '23P01';   -- exclusion_violation → mapped to HTTP 409
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stands_no_overlap ON stands;
CREATE TRIGGER trg_stands_no_overlap
  BEFORE INSERT OR UPDATE OF geom, status ON stands
  FOR EACH ROW EXECUTE FUNCTION spatial_planning.stands_no_overlap();

COMMENT ON FUNCTION spatial_planning.stands_no_overlap() IS
  'Topology gate: rejects a stand whose interior overlaps (>1 m²) another active stand. Adjacent shared boundaries allowed. Raises ERRCODE 23P01.';
