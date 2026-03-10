-- ============================================
-- Migration: Populate Development Matrix (FIXED)
-- Populates the development_matrix and land_use_groups tables
-- with comprehensive land use permissions based on the
-- Chipinge Rural District Council development control matrix
-- ============================================

-- Set session timezone for consistent timestamps
SET timezone = 'UTC';

-- ============================================
-- STEP 1: Ensure Permission Types Exist
-- ============================================
INSERT INTO permission_types (permission_code, description, color, icon) VALUES
('P', 'Permitted', '#22c55e', 'check'),
('SC', 'Special Consent', '#f59e0b', 'alert'),
('X', 'Prohibited', '#ef4444', 'close')
ON CONFLICT (permission_code) DO NOTHING;

-- ============================================
-- STEP 2: Populate Land Use Groups
-- Based on the development matrix image provided
-- ============================================
INSERT INTO land_use_groups (group_code, description, group_category, notes, is_active) VALUES
-- Residential Uses
('R1', 'Single Family Residential', 'Residential', 'Detached single family dwelling', true),
('R2', 'Duplex Residential', 'Residential', 'Two-family dwelling in one building', true),
('R3', 'Multi-Family Residential', 'Residential', 'Apartment buildings and flats', true),
('R4', 'Cluster Housing', 'Residential', 'Housing clusters with shared amenities', true),
('R5', 'High Density Residential', 'Residential', 'High density apartment complexes', true),
('R6', 'Traditional Settlement', 'Residential', 'Traditional village/settlement pattern', true),

-- Commercial Uses
('C1', 'General Retail', 'Commercial', 'General retail shops and stores', true),
('C2', 'Service Commercial', 'Commercial', 'Service-oriented commercial activities', true),
('C3', 'Office Buildings', 'Commercial', 'Office and administrative buildings', true),
('C4', 'Financial Services', 'Commercial', 'Banks and financial institutions', true),
('C5', 'Hospitality', 'Commercial', 'Hotels, lodges, restaurants', true),
('C6', 'Markets', 'Commercial', 'Formal and informal market places', true),

-- Industrial Uses
('I1', 'Light Industry', 'Industrial', 'Light manufacturing and assembly', true),
('I2', 'Heavy Industry', 'Industrial', 'Heavy manufacturing and processing', true),
('I3', 'Warehousing', 'Industrial', 'Storage and warehousing facilities', true),
('I4', 'Agro-Industry', 'Industrial', 'Agricultural processing industries', true),

-- Agricultural Uses
('A1', 'Crop Farming', 'Agricultural', 'Commercial crop cultivation', true),
('A2', 'Livestock Farming', 'Agricultural', 'Livestock rearing and ranching', true),
('A3', 'Mixed Farming', 'Agricultural', 'Combined crop and livestock farming', true),
('A4', 'Horticulture', 'Agricultural', 'Specialized horticultural production', true),
('A5', 'Agro-Forestry', 'Agricultural', 'Integrated agriculture and forestry', true),

-- Institutional Uses
('INS1', 'Educational', 'Institutional', 'Schools, colleges, training centers', true),
('INS2', 'Health', 'Institutional', 'Hospitals, clinics, health centers', true),
('INS3', 'Religious', 'Institutional', 'Churches, mosques, religious centers', true),
('INS4', 'Community', 'Institutional', 'Community halls and social centers', true),

-- Infrastructure Uses
('INF1', 'Transport', 'Infrastructure', 'Transport facilities and terminals', true),
('INF2', 'Utilities', 'Infrastructure', 'Water, electricity, communication utilities', true),
('INF3', 'Public Services', 'Infrastructure', 'Government service facilities', true),

-- Recreation Uses
('REC1', 'Active Recreation', 'Recreation', 'Sports facilities and active recreation', true),
('REC2', 'Passive Recreation', 'Recreation', 'Parks, gardens, passive recreation', true),
('REC3', 'Tourism', 'Recreation', 'Tourism and recreational facilities', true),

-- Special Uses
('S1', 'Mining', 'Special', 'Mining and quarrying operations', true),
('S2', 'Conservation', 'Special', 'Environmental conservation areas', true),
('S3', 'Cultural Heritage', 'Special', 'Cultural and heritage sites', true)
ON CONFLICT (group_code) DO NOTHING;

-- ============================================
-- STEP 3: Populate Development Matrix
-- Using chipinge_land_zones (id column, not zone_id)
-- ============================================

-- Note: This is a comprehensive matrix based on typical Zimbabwean rural district planning
-- Adjust zone mappings and permissions based on actual chipinge_land_zones data

-- Residential Zone 1 (Low Density)
INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, max_units, max_height_meters, min_lot_size_sqm, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%residential%' AND (zone ILIKE '%1%' OR zone ILIKE '%low%') LIMIT 1),
    g.group_id, 'P', 
    'Single dwelling per plot, maximum 8m height, minimum 300m² lot', 
    1, 8, 300, true
FROM land_use_groups g WHERE g.group_code IN ('R1', 'A1', 'A2', 'INS1', 'INS2', 'INS3', 'INS4', 'INF2', 'INF3', 'REC2')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%residential%' AND (zone ILIKE '%1%' OR zone ILIKE '%low%') LIMIT 1),
    g.group_id, 'SC', 
    'Requires special consent, site plan approval required', 
    true
FROM land_use_groups g WHERE g.group_code IN ('R2', 'C1', 'C2', 'REC1')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%residential%' AND (zone ILIKE '%1%' OR zone ILIKE '%low%') LIMIT 1),
    g.group_id, 'X', 
    'Prohibited in residential low density zone', 
    true
FROM land_use_groups g WHERE g.group_code IN ('R3', 'R4', 'R5', 'C3', 'C4', 'C5', 'C6', 'I1', 'I2', 'I3', 'I4', 'S1')
ON CONFLICT (zone_id, group_id) DO NOTHING;

-- Residential Zone 2 (Medium Density)
INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, max_units, max_height_meters, min_lot_size_sqm, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%residential%' AND (zone ILIKE '%2%' OR zone ILIKE '%medium%') LIMIT 1),
    g.group_id, 'P', 
    'Multi-family dwelling permitted, maximum 12m height, minimum 200m² lot', 
    4, 12, 200, true
FROM land_use_groups g WHERE g.group_code IN ('R1', 'R2', 'R3', 'A1', 'A2', 'INS1', 'INS2', 'INS3', 'INS4', 'INF2', 'INF3', 'REC1', 'REC2')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%residential%' AND (zone ILIKE '%2%' OR zone ILIKE '%medium%') LIMIT 1),
    g.group_id, 'SC', 
    'Requires special consent, comprehensive development plan required', 
    true
FROM land_use_groups g WHERE g.group_code IN ('R4', 'C1', 'C2', 'C3', 'C5', 'I1')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%residential%' AND (zone ILIKE '%2%' OR zone ILIKE '%medium%') LIMIT 1),
    g.group_id, 'X', 
    'Prohibited in residential medium density zone', 
    true
FROM land_use_groups g WHERE g.group_code IN ('R5', 'R6', 'C4', 'C6', 'I2', 'I3', 'I4', 'S1')
ON CONFLICT (zone_id, group_id) DO NOTHING;

-- Commercial Zone
INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, max_units, max_height_meters, min_lot_size_sqm, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%commercial%' OR zone ILIKE '%business%' LIMIT 1),
    g.group_id, 'P', 
    'Commercial activities permitted, maximum 20m height, adequate parking required', 
    NULL, 20, 150, true
FROM land_use_groups g WHERE g.group_code IN ('C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'INS1', 'INS2', 'INF1', 'INF2', 'INF3', 'REC1', 'REC3')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%commercial%' OR zone ILIKE '%business%' LIMIT 1),
    g.group_id, 'SC', 
    'Requires special consent, mixed-use development allowed', 
    true
FROM land_use_groups g WHERE g.group_code IN ('R1', 'R2', 'R3', 'I1', 'I3')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%commercial%' OR zone ILIKE '%business%' LIMIT 1),
    g.group_id, 'X', 
    'Prohibited in commercial zone', 
    true
FROM land_use_groups g WHERE g.group_code IN ('R4', 'R5', 'R6', 'I2', 'I4', 'A1', 'A2', 'A3', 'A4', 'A5', 'S1', 'S2')
ON CONFLICT (zone_id, group_id) DO NOTHING;

-- Industrial Zone
INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, max_units, max_height_meters, min_lot_size_sqm, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%industrial%' LIMIT 1),
    g.group_id, 'P', 
    'Industrial activities permitted, environmental assessment required, buffer zones mandatory', 
    NULL, 25, 500, true
FROM land_use_groups g WHERE g.group_code IN ('I1', 'I2', 'I3', 'I4', 'INF1', 'INF2', 'A4')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%industrial%' LIMIT 1),
    g.group_id, 'SC', 
    'Requires special consent, strict environmental compliance required', 
    true
FROM land_use_groups g WHERE g.group_code IN ('C2', 'C6', 'INF3')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%industrial%' LIMIT 1),
    g.group_id, 'X', 
    'Prohibited in industrial zone for health and safety reasons', 
    true
FROM land_use_groups g WHERE g.group_code IN ('R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'C1', 'C3', 'C4', 'C5', 'INS1', 'INS2', 'INS3', 'INS4', 'REC1', 'REC2', 'REC3', 'A1', 'A2', 'A3', 'A5', 'S2', 'S3')
ON CONFLICT (zone_id, group_id) DO NOTHING;

-- Agricultural Zone
INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, max_units, max_height_meters, min_lot_size_sqm, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%agricultural%' OR zone ILIKE '%farming%' LIMIT 1),
    g.group_id, 'P', 
    'Agricultural activities permitted, maximum farm dwelling 8m height, minimum 2000m²', 
    1, 8, 2000, true
FROM land_use_groups g WHERE g.group_code IN ('A1', 'A2', 'A3', 'A4', 'A5', 'R1', 'R6', 'I4', 'INS3', 'INS4', 'INF2', 'REC2')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%agricultural%' OR zone ILIKE '%farming%' LIMIT 1),
    g.group_id, 'SC', 
    'Requires special consent, agricultural viability assessment required', 
    true
FROM land_use_groups g WHERE g.group_code IN ('R2', 'C6', 'I1', 'INS1', 'INF3')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%agricultural%' OR zone ILIKE '%farming%' LIMIT 1),
    g.group_id, 'X', 
    'Prohibited in agricultural zone to preserve prime agricultural land', 
    true
FROM land_use_groups g WHERE g.group_code IN ('R3', 'R4', 'R5', 'C1', 'C2', 'C3', 'C4', 'C5', 'I2', 'I3', 'INS2', 'REC1', 'REC3', 'S1')
ON CONFLICT (zone_id, group_id) DO NOTHING;

-- Conservation Zone
INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%conservation%' OR zone ILIKE '%protected%' OR zone ILIKE '%environmental%' LIMIT 1),
    g.group_id, 'P', 
    'Conservation and environmental protection activities only', 
    true
FROM land_use_groups g WHERE g.group_code IN ('S2', 'S3', 'REC2', 'INS3', 'INS4')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%conservation%' OR zone ILIKE '%protected%' OR zone ILIKE '%environmental%' LIMIT 1),
    g.group_id, 'SC', 
    'Requires special consent and environmental impact assessment', 
    true
FROM land_use_groups g WHERE g.group_code IN ('REC1', 'REC3', 'INF2', 'INF3', 'A4', 'A5', 'R6')
ON CONFLICT (zone_id, group_id) DO NOTHING;

INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    (SELECT id FROM chipinge_land_zones WHERE zone ILIKE '%conservation%' OR zone ILIKE '%protected%' OR zone ILIKE '%environmental%' LIMIT 1),
    g.group_id, 'X', 
    'Prohibited in conservation zone to protect environmental values', 
    true
FROM land_use_groups g WHERE g.group_code IN ('R1', 'R2', 'R3', 'R4', 'R5', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'I1', 'I2', 'I3', 'I4', 'INS1', 'INS2', 'INF1', 'A1', 'A2', 'A3', 'S1')
ON CONFLICT (zone_id, group_id) DO NOTHING;

-- ============================================
-- STEP 4: Verification Queries
-- ============================================

-- Count total matrix entries created
SELECT 
    'Development Matrix Summary' as summary_type,
    COUNT(*) as total_entries,
    COUNT(CASE WHEN permission_code = 'P' THEN 1 END) as permitted,
    COUNT(CASE WHEN permission_code = 'SC' THEN 1 END) as special_consent,
    COUNT(CASE WHEN permission_code = 'X' THEN 1 END) as prohibited,
    COUNT(DISTINCT zone_id) as zones_covered,
    COUNT(DISTINCT group_id) as land_uses_covered
FROM development_matrix WHERE is_active = true;

-- Show sample of matrix data
SELECT 
    cz.zone,
    cz.zone_code,
    lg.group_code,
    lg.description,
    lg.group_category,
    dm.permission_code,
    pt.description as permission_description,
    dm.conditions,
    dm.max_units,
    dm.max_height_meters,
    dm.min_lot_size_sqm
FROM development_matrix dm
JOIN land_use_groups lg ON dm.group_id = lg.group_id
JOIN permission_types pt ON dm.permission_code = pt.permission_code
JOIN chipinge_land_zones cz ON dm.zone_id = cz.id
WHERE dm.is_active = true
ORDER BY cz.zone, lg.group_category, lg.group_code
LIMIT 20;

-- Show available zones from chipinge_land_zones
SELECT 
    id,
    zone,
    zone_code,
    zone_type,
    area_ha
FROM chipinge_land_zones 
WHERE is_active = true
ORDER BY display_order, zone;

-- ============================================
-- Migration Complete
-- ============================================

-- This migration populates the development matrix with comprehensive
-- land use permissions based on typical Zimbabwean rural district planning
-- The script now correctly uses the actual database schema
