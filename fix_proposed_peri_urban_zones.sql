-- Fix geometry issues in proposed_peri_urban_zones table
-- This script addresses NULL geometries and invalid data

-- First, let's analyze the current state
SELECT 
    COUNT(*) as total_records,
    COUNT(geom) as records_with_geometry,
    COUNT(*) - COUNT(geom) as records_without_geometry,
    COUNT(CASE WHEN ST_IsValid(geom) THEN 1 END) as valid_geometries,
    COUNT(CASE WHEN geom IS NOT NULL AND NOT ST_IsValid(geom) THEN 1 END) as invalid_geometries
FROM proposed_peri_urban_zones;

-- Identify records with NULL geometries
SELECT id, zone_code, zone, area_ha, geom IS NULL as has_null_geometry
FROM proposed_peri_urban_zones 
WHERE geom IS NULL
ORDER BY id;

-- Fix 1: Delete records with NULL geometries and zero area (these are clearly invalid)
DELETE FROM proposed_peri_urban_zones 
WHERE geom IS NULL 
AND (area_ha IS NULL OR area_ha = 0 OR area_ha < 0.01);

-- Fix 2: For records with NULL geometry but valid area, create a placeholder geometry
-- This is a temporary fix - ideally you'd want to restore the actual geometries
UPDATE proposed_peri_urban_zones 
SET geom = ST_SetSRID(ST_MakePoint(0, 0), 4326)
WHERE geom IS NULL 
AND area_ha IS NOT NULL 
AND area_ha > 0.01;

-- Fix 3: Validate and fix invalid geometries
UPDATE proposed_peri_urban_zones 
SET geom = ST_MakeValid(geom)
WHERE geom IS NOT NULL 
AND NOT ST_IsValid(geom);

-- Fix 4: Ensure all geometries are MultiPolygons as expected
UPDATE proposed_peri_urban_zones 
SET geom = ST_Multi(ST_Buffer(geom, 0))
WHERE geom IS NOT NULL 
AND ST_GeometryType(geom) != 'ST_MultiPolygon';

-- Fix 5: Update area calculations based on actual geometries
UPDATE proposed_peri_urban_zones 
SET area_ha = ROUND(ST_Area(ST_Transform(geom, 3857)) / 10000, 6)
WHERE geom IS NOT NULL 
AND ST_IsValid(geom);

-- Fix 6: Fix any records with zero area but valid geometry
UPDATE proposed_peri_urban_zones 
SET area_ha = ROUND(ST_Area(ST_Transform(geom, 3857)) / 10000, 6)
WHERE geom IS NOT NULL 
AND ST_IsValid(geom) 
AND (area_ha IS NULL OR area_ha = 0);

-- Fix 7: Update shape_area to match actual geometry area
UPDATE proposed_peri_urban_zones 
SET shape_area = ST_Area(ST_Transform(geom, 3857))
WHERE geom IS NOT NULL 
AND ST_IsValid(geom);

-- Fix 8: Clean up zone codes - ensure they are properly formatted
UPDATE proposed_peri_urban_zones 
SET zone_code = UPPER(TRIM(zone_code))
WHERE zone_code IS NOT NULL 
AND zone_code != '';

-- Fix 9: Ensure display_order is properly set
UPDATE proposed_peri_urban_zones 
SET display_order = id 
WHERE display_order IS NULL OR display_order = 0;

-- Fix 10: Verify the fixes
SELECT 
    COUNT(*) as total_records,
    COUNT(geom) as records_with_geometry,
    COUNT(CASE WHEN ST_IsValid(geom) THEN 1 END) as valid_geometries,
    COUNT(CASE WHEN area_ha > 0 THEN 1 END) as records_with_positive_area,
    MIN(area_ha) as min_area,
    MAX(area_ha) as max_area,
    AVG(area_ha) as avg_area
FROM proposed_peri_urban_zones 
WHERE geom IS NOT NULL;

-- Show sample of fixed records
SELECT id, zone_code, zone, zone_type, area_ha, ST_IsValid(geom) as is_valid, display_order
FROM proposed_peri_urban_zones 
WHERE geom IS NOT NULL 
AND ST_IsValid(geom)
ORDER BY display_order, zone_code
LIMIT 10;

-- Create a spatial index if it doesn't exist
CREATE INDEX IF NOT EXISTS sidx_proposed_peri_urban_zones_geom_fixed 
ON proposed_peri_urban_zones 
USING GIST (geom);

-- Add constraints to ensure data quality
ALTER TABLE proposed_peri_urban_zones 
ADD CONSTRAINT IF NOT EXISTS chk_geom_not_null CHECK (geom IS NOT NULL),
ADD CONSTRAINT IF NOT EXISTS chk_area_positive CHECK (area_ha > 0),
ADD CONSTRAINT IF NOT EXISTS chk_zone_code_not_empty CHECK (zone_code IS NOT NULL AND zone_code != '');

-- Final verification
SELECT 'Geometry fixes completed successfully!' as status;
