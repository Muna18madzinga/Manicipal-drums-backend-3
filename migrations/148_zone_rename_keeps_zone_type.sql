-- 148_zone_rename_keeps_zone_type.sql
-- ─────────────────────────────────────────────────────────────────────────
-- A zone polygon's name is edited in QGIS (for example to correct a typo). The polygon
-- row changed, but its zone TYPE in the plan kept the old name, so the plan, the blank
-- matrix sheet and the recorded snapshots disagreed with the map.
--
-- Rule, applied when a polygon's zone name changes:
--   * if the plan already has a zone type with the new name, the polygon moves to it;
--   * else if the polygon's zone type was named for the old name, and no other polygon uses
--     it, and it has no decisions or standards, the zone type is RENAMED (a typo fix);
--   * else a new zone type with the new name is created and the polygon moves to it, leaving
--     the old zone type and its rules for a person to deal with. Rules are never carried
--     across a rename automatically when anything else depends on the old type.
-- Only edits to a polygon's name trigger this; polygons inserted with an explicit zone type
-- are left as given.
--
-- One-off repair: Vungu's zone type "Cemetry" (corrected to "Cemetery" on the map).

BEGIN;

CREATE OR REPLACE FUNCTION zones_sync_plan_refs() RETURNS trigger AS $$
DECLARE
  inst uuid;
  cur plan_zone_type%ROWTYPE;
  existing uuid;
  other_polys integer;
  has_rules boolean;
BEGIN
  IF NEW.plan_instrument_id IS NULL THEN
    SELECT id INTO inst FROM plan_instrument WHERE title = 'Vungu RDC peri-urban local plan (as mapped)' LIMIT 1;
    NEW.plan_instrument_id := inst;
  END IF;

  -- The polygon's name was edited: keep its zone type in step (see header).
  IF TG_OP = 'UPDATE' AND NEW.zone IS DISTINCT FROM OLD.zone AND NEW.zone IS NOT NULL
     AND OLD.plan_zone_type_id IS NOT NULL AND NEW.plan_zone_type_id IS NOT DISTINCT FROM OLD.plan_zone_type_id
     AND NEW.plan_instrument_id IS NOT DISTINCT FROM OLD.plan_instrument_id THEN
    SELECT * INTO cur FROM plan_zone_type WHERE id = OLD.plan_zone_type_id;
    IF FOUND AND cur.plan_instrument_id = NEW.plan_instrument_id AND cur.code = OLD.zone AND cur.name = cur.code THEN
      SELECT id INTO existing FROM plan_zone_type WHERE plan_instrument_id = NEW.plan_instrument_id AND code = NEW.zone;
      IF existing IS NOT NULL THEN
        NEW.plan_zone_type_id := existing;
      ELSE
        SELECT COUNT(*) INTO other_polys FROM proposed_peri_urban_zones z
         WHERE z.plan_zone_type_id = cur.id AND z.id IS DISTINCT FROM NEW.id;
        has_rules := EXISTS (SELECT 1 FROM zone_land_use_controls c WHERE c.plan_zone_type_id = cur.id AND c.deleted_at IS NULL)
                  OR EXISTS (SELECT 1 FROM plan_zone_standard s WHERE s.plan_zone_type_id = cur.id);
        IF other_polys = 0 AND NOT has_rules THEN
          UPDATE plan_zone_type SET code = NEW.zone, name = NEW.zone WHERE id = cur.id;
        ELSE
          NEW.plan_zone_type_id := NULL;   -- falls through to creating a type with the new name
        END IF;
      END IF;
    END IF;
  END IF;

  IF NEW.plan_zone_type_id IS NULL AND NEW.plan_instrument_id IS NOT NULL AND NEW.zone IS NOT NULL THEN
    INSERT INTO plan_zone_type (plan_instrument_id, code, name)
    VALUES (NEW.plan_instrument_id, NEW.zone, NEW.zone)
    ON CONFLICT (plan_instrument_id, code) DO NOTHING;
    SELECT id INTO NEW.plan_zone_type_id FROM plan_zone_type
     WHERE plan_instrument_id = NEW.plan_instrument_id AND code = NEW.zone;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- One-off repair of the typo corrected on the map: rename the type only if nothing depends on it.
UPDATE plan_zone_type t SET code = 'Cemetery', name = 'Cemetery'
 WHERE t.code = 'Cemetry' AND t.name = 'Cemetry'
   AND t.plan_instrument_id = (SELECT id FROM plan_instrument WHERE title = 'Vungu RDC peri-urban local plan (as mapped)' AND NOT is_template)
   AND NOT EXISTS (SELECT 1 FROM plan_zone_type o WHERE o.plan_instrument_id = t.plan_instrument_id AND o.code = 'Cemetery')
   AND NOT EXISTS (SELECT 1 FROM zone_land_use_controls c WHERE c.plan_zone_type_id = t.id AND c.deleted_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM plan_zone_standard s WHERE s.plan_zone_type_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM proposed_peri_urban_zones z WHERE z.plan_zone_type_id = t.id AND z.zone <> 'Cemetery');

COMMIT;
