-- ============================================
-- Migration: Fix Missing Permitted Uses
-- Adds basic permitted uses to zones that only have SC entries
-- ============================================

-- Set session timezone for consistent timestamps
SET timezone = 'UTC';

-- ============================================
-- STEP 1: Add basic permitted uses for existing zones
-- ============================================

-- For Cemetry zone (29) - Add basic permitted uses
INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    29, -- Cemetry zone_id
    g.group_id, 'P', 
    'Permitted in cemetry zone with proper approval', 
    true
FROM land_use_groups g 
WHERE g.group_code IN ('INS3', 'INS4', 'REC2', 'S2', 'S3')
ON CONFLICT (zone_id, group_id) DO NOTHING;

-- For Urban Expansion zone (43) - Add basic permitted uses
INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    43, -- Urban Expansion zone_id
    g.group_id, 'P', 
    'Permitted in urban expansion area', 
    true
FROM land_use_groups g 
WHERE g.group_code IN ('R1', 'R2', 'C1', 'C2', 'INS1', 'INS2', 'INF2', 'INF3', 'REC1', 'REC2')
ON CONFLICT (zone_id, group_id) DO NOTHING;

-- For Estates zone (26) - Add basic permitted uses
INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, is_active)
SELECT 
    26, -- Estates zone_id
    g.group_id, 'P', 
    'Permitted in estates area', 
    true
FROM land_use_groups g 
WHERE g.group_code IN ('R1', 'R2', 'R3', 'A1', 'A2', 'INS3', 'INS4', 'INF2', 'REC2')
ON CONFLICT (zone_id, group_id) DO NOTHING;

-- ============================================
-- STEP 2: Show updated results
-- ============================================

-- Check the updated matrix for these zones
SELECT 
    dm.zone_id, 
    z.zone, 
    z.zone_code, 
    COUNT(*) as total_entries,
    COUNT(CASE WHEN dm.permission_code = 'P' THEN 1 END) as permitted,
    COUNT(CASE WHEN dm.permission_code = 'SC' THEN 1 END) as consent,
    COUNT(CASE WHEN dm.permission_code = 'X' THEN 1 END) as prohibited
FROM development_matrix dm 
JOIN chipinge_land_zones z ON dm.zone_id = z.id 
WHERE dm.zone_id IN (29, 43, 26) 
GROUP BY dm.zone_id, z.zone, z.zone_code 
ORDER BY dm.zone_id;

-- Show sample permitted uses for each zone
SELECT 
    z.zone as zone_name,
    lg.group_code,
    lg.description,
    dm.permission_code,
    dm.conditions
FROM development_matrix dm
JOIN chipinge_land_zones z ON dm.zone_id = z.id
JOIN land_use_groups lg ON dm.group_id = lg.group_id
WHERE dm.zone_id IN (29, 43, 26) AND dm.permission_code = 'P'
ORDER BY z.zone, lg.group_code;

-- ============================================
-- Migration Complete
-- ============================================

-- This migration adds basic permitted uses to zones that previously
-- only had special consent entries, making the development matrix
-- more functional for testing and demonstration
