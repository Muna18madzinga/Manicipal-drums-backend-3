-- 153_farm_zone_remap.down.sql — undoes 153_farm_zone_remap.sql
-- Puts every farm's original zone_id back from zone_id_legacy and clears the remap marks.
-- The audit table is kept (it is the record of what was done); drop it by hand if it is not wanted.
BEGIN;
DO $$
BEGIN
  IF to_regclass('public.gweru_rural_farms') IS NULL THEN RETURN; END IF;
  UPDATE public.gweru_rural_farms
     SET zone_id = zone_id_legacy, zone_id_legacy = NULL, zone_remap_status = NULL
   WHERE zone_remap_status IS NOT NULL;
  DELETE FROM public.farm_zone_remap;   -- lets the migration run again if it is re-applied
END $$;
COMMIT;
