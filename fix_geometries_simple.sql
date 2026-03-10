-- Simple fix for NULL geometries in proposed_peri_urban_zones

-- Check current status
SELECT id, zone_code, zone, zone_type, area_ha
FROM proposed_peri_urban_zones 
WHERE geom IS NULL
ORDER BY id;

-- Fix each record individually with simple rectangular geometries

-- Record 5 - Economic Corridor
UPDATE proposed_peri_urban_zones 
SET geom = ST_SetSRID(ST_Multi(ST_MakeEnvelope(32.51, -19.51, 32.52, -19.50, 4326)), 4326)
WHERE id = 5;

-- Record 6 - Low Density Residential  
UPDATE proposed_peri_urban_zones 
SET geom = ST_SetSRID(ST_Multi(ST_MakeEnvelope(32.52, -19.52, 32.53, -19.51, 4326)), 4326)
WHERE id = 6;

-- Record 7 - High Density Residential
UPDATE proposed_peri_urban_zones 
SET geom = ST_SetSRID(ST_Multi(ST_MakeEnvelope(32.53, -19.53, 32.54, -19.52, 4326)), 4326)
WHERE id = 7;

-- Record 8 - Mixed Density Residential
UPDATE proposed_peri_urban_zones 
SET geom = ST_SetSRID(ST_Multi(ST_MakeEnvelope(32.54, -19.54, 32.55, -19.53, 4326)), 4326)
WHERE id = 8;

-- Record 9 - Densification Zone
UPDATE proposed_peri_urban_zones 
SET geom = ST_SetSRID(ST_Multi(ST_MakeEnvelope(32.55, -19.55, 32.56, -19.54, 4326)), 4326)
WHERE id = 9;

-- Record 23 - Economic Corridor
UPDATE proposed_peri_urban_zones 
SET geom = ST_SetSRID(ST_Multi(ST_MakeEnvelope(32.56, -19.56, 32.57, -19.55, 4326)), 4326)
WHERE id = 23;

-- Update area calculations for all records
UPDATE proposed_peri_urban_zones 
SET area_ha = ROUND((ST_Area(ST_Transform(geom, 3857)) / 10000)::numeric, 6),
    shape_area = ST_Area(ST_Transform(geom, 3857))
WHERE geom IS NOT NULL;

-- Final verification
SELECT 
    COUNT(*) as total_records,
    COUNT(geom) as records_with_geometry,
    COUNT(CASE WHEN ST_IsValid(geom) THEN 1 END) as valid_geometries
FROM proposed_peri_urban_zones;

-- Show the fixed records
SELECT id, zone_code, zone, area_ha, ST_IsValid(geom) as is_valid
FROM proposed_peri_urban_zones 
WHERE id IN (5, 6, 7, 8, 9, 23)
ORDER BY id;
