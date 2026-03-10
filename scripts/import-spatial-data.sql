-- Import spatial data from existing tables into layer_data structure
-- This script automatically maps existing tables to the layer_data format

-- Import Transportation Network (roads)
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Transportation Network' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(name, 'Unnamed Road'),
        'osm_id', osm_id,
        'fclass', fclass,
        'ref', ref,
        'oneway', oneway,
        'maxspeed', maxspeed,
        'bridge', bridge,
        'tunnel', tunnel
    )
FROM gweru_roads
WHERE name IS NOT NULL OR osm_id IS NOT NULL;

-- Import Health Facilities
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Health Facilities' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(name, 'Health Facility'),
        'type', COALESCE(facility_type, 'unknown'),
        'authority', authority
    )
FROM gweru_health_centres
WHERE geom IS NOT NULL;

-- Import Educational Institutions
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Educational Institutions' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(name, 'Educational Institution'),
        'type', COALESCE(institution_type, 'unknown'),
        'level', COALESCE(education_level, 'unknown')
    )
FROM gweru_educational_institutions
WHERE geom IS NOT NULL;

-- Import Urban Planning Zones
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Urban Planning Zones' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(zone_name, 'Planning Zone'),
        'zone_type', COALESCE(zone_type, 'unknown'),
        'status', COALESCE(status, 'active')
    )
FROM gweru_urban_master_plan_boundary
WHERE geom IS NOT NULL;

-- Import Development Areas
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Development Areas' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(area_name, 'Development Area'),
        'development_type', COALESCE(development_type, 'unknown'),
        'status', COALESCE(status, 'proposed')
    )
FROM gweru_proposed_peri_urban_plots
WHERE geom IS NOT NULL;

-- Import Environmental Zones
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Environmental Zones' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(zone_name, 'Environmental Zone'),
        'zone_type', COALESCE(zone_type, 'conservation'),
        'protection_level', COALESCE(protection_level, 'standard')
    )
FROM combined_land_use_zones
WHERE land_use LIKE '%environmental%' OR land_use LIKE '%conservation%'
AND geom IS NOT NULL;

-- Import Places for search/geocoding
INSERT INTO places (name, type, geom, relevance, properties)
SELECT 
    COALESCE(name, 'Unnamed Place'),
    CASE 
        WHEN name ILIKE '%hospital%' OR name ILIKE '%clinic%' THEN 'health_facility'
        WHEN name ILIKE '%school%' OR name ILIKE '%college%' THEN 'education'
        WHEN name ILIKE '%market%' THEN 'commercial'
        WHEN name ILIKE '%chief%' THEN 'administrative'
        ELSE 'settlement'
    END,
    geom,
    0.8,
    jsonb_build_object('source', 'gweru_data')
FROM (
    SELECT name, geom FROM gweru_health_centres WHERE name IS NOT NULL
    UNION
    SELECT name, geom FROM gweru_schools WHERE name IS NOT NULL
    UNION
    SELECT name, geom FROM gweru_chief_homesteads WHERE name IS NOT NULL
    UNION
    SELECT name, geom FROM gweru_business_centres WHERE name IS NOT NULL
) AS combined_places
WHERE geom IS NOT NULL;

-- Update statistics
ANALYZE layer_data;
ANALYZE places;

-- Show import results
SELECT 
    l.name as layer_name,
    COUNT(ld.id) as feature_count
FROM layers l
LEFT JOIN layer_data ld ON l.id = ld.layer_id
GROUP BY l.name
ORDER BY feature_count DESC;
