-- Import spatial data from existing tables into layer_data structure
-- This script uses the actual column names from the database

-- Import Health Facilities (using correct column names)
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Health Facilities' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(nameoffaci, 'Health Facility'),
        'type', COALESCE(typeoffaci, 'unknown'),
        'ownership', ownership,
        'district', district,
        'year_built', yearbuilt,
        'num_doctors', numofdocto,
        'num_nurses', numofnurse,
        'num_beds', numofbeds
    )
FROM gweru_health_centres
WHERE geom IS NOT NULL;

-- Import Educational Institutions (check structure first)
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Educational Institutions' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(name, 'Educational Institution'),
        'type', COALESCE(type, 'unknown'),
        'district', district
    )
FROM gweru_schools
WHERE geom IS NOT NULL;

-- Import Chief Homesteads as administrative points
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Urban Planning Zones' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(chief_name, 'Chief Homestead'),
        'type', 'administrative',
        'chiefdom', chiefdom_name
    )
FROM gweru_chief_homesteads
WHERE geom IS NOT NULL;

-- Import Business Centres
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Development Areas' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(name, 'Business Centre'),
        'type', 'commercial',
        'district', district
    )
FROM gweru_business_centres
WHERE geom IS NOT NULL;

-- Import Mines
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Environmental Zones' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(mine_name, 'Mine'),
        'type', 'mining',
        'commodity', commodity,
        'status', status
    )
FROM gweru_mines
WHERE geom IS NOT NULL;

-- Import Places for search/geocoding (using correct column names)
INSERT INTO places (name, type, geom, relevance, properties)
SELECT 
    COALESCE(nameoffaci, 'Health Facility'),
    'health_facility',
    geom,
    0.9,
    jsonb_build_object('source', 'gweru_health_centres', 'type', typeoffaci)
FROM gweru_health_centres
WHERE geom IS NOT NULL AND nameoffaci IS NOT NULL

UNION

SELECT 
    COALESCE(name, 'School'),
    'education',
    geom,
    0.8,
    jsonb_build_object('source', 'gweru_schools')
FROM gweru_schools
WHERE geom IS NOT NULL AND name IS NOT NULL

UNION

SELECT 
    COALESCE(chief_name, 'Chief Homestead'),
    'administrative',
    geom,
    0.7,
    jsonb_build_object('source', 'gweru_chief_homesteads')
FROM gweru_chief_homesteads
WHERE geom IS NOT NULL AND chief_name IS NOT NULL;

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
