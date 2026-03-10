-- Final import script with correct column names

-- Import Educational Institutions (schools have 'name' column)
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Educational Institutions' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(name, 'Educational Institution'),
        'type', 'school'
    )
FROM gweru_schools
WHERE geom IS NOT NULL;

-- Import Business Centres (use admin3name as name)
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Development Areas' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(admin3name, 'Business Centre'),
        'type', 'commercial',
        'admin2', admin2name,
        'admin1', admin1name
    )
FROM gweru_business_centres
WHERE geom IS NOT NULL;

-- Import Chief Homesteads (use admin3name as name)
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Urban Planning Zones' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(admin3name, 'Chief Homestead'),
        'type', 'administrative',
        'admin2', admin2name,
        'admin1', admin1name
    )
FROM gweru_chief_homesteads
WHERE geom IS NOT NULL;

-- Import Mines (have 'name' column)
INSERT INTO layer_data (layer_id, geom, properties)
SELECT 
    (SELECT id FROM layers WHERE name = 'Environmental Zones' LIMIT 1),
    geom,
    jsonb_build_object(
        'name', COALESCE(name, 'Mine'),
        'type', 'mining'
    )
FROM gweru_mines
WHERE geom IS NOT NULL;

-- Update places for search/geocoding
INSERT INTO places (name, type, geom, relevance, properties)
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
    COALESCE(admin3name, 'Business Centre'),
    'commercial',
    geom,
    0.7,
    jsonb_build_object('source', 'gweru_business_centres')
FROM gweru_business_centres
WHERE geom IS NOT NULL AND admin3name IS NOT NULL

UNION

SELECT 
    COALESCE(admin3name, 'Chief Homestead'),
    'administrative',
    geom,
    0.7,
    jsonb_build_object('source', 'gweru_chief_homesteads')
FROM gweru_chief_homesteads
WHERE geom IS NOT NULL AND admin3name IS NOT NULL

UNION

SELECT 
    COALESCE(name, 'Mine'),
    'mining',
    geom,
    0.6,
    jsonb_build_object('source', 'gweru_mines')
FROM gweru_mines
WHERE geom IS NOT NULL AND name IS NOT NULL;

-- Update statistics
ANALYZE layer_data;
ANALYZE places;

-- Show final import results
SELECT 
    l.name as layer_name,
    COUNT(ld.id) as feature_count
FROM layers l
LEFT JOIN layer_data ld ON l.id = ld.layer_id
GROUP BY l.name
ORDER BY feature_count DESC;

-- Show places count
SELECT 'Places' as table_name, COUNT(*) as feature_count FROM places;
