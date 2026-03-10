-- ============================================
-- Migration: Update Farm Zones Using Spatial Relationships
-- Assigns zone_id to gweru_rural_farms based on geometric intersection
-- with chipinge_land_zones
-- ============================================

-- Set session timezone for consistent timestamps
SET timezone = 'UTC';

-- ============================================
-- STEP 1: Update zone_id for farms that intersect with zones
-- ============================================

UPDATE gweru_rural_farms f
SET zone_id = z.id
FROM chipinge_land_zones z
WHERE ST_Intersects(f.geom, z.geom)
  AND z.is_active = true
  AND f.zone_id IS NULL;

-- ============================================
-- STEP 2: Show results
-- ============================================

-- Count how many farms were updated
SELECT 
    'Farms Updated' as status,
    COUNT(*) as count
FROM gweru_rural_farms 
WHERE zone_id IS NOT NULL;

-- Show distribution of farms by zone
SELECT 
    z.id,
    z.zone,
    z.zone_code,
    z.zone_type,
    COUNT(f.id) as farm_count,
    ROUND(SUM(f.area_ha), 2) as total_area_ha
FROM chipinge_land_zones z
LEFT JOIN gweru_rural_farms f ON z.id = f.zone_id
WHERE z.is_active = true
GROUP BY z.id, z.zone, z.zone_code, z.zone_type
HAVING COUNT(f.id) > 0
ORDER BY farm_count DESC, z.zone;

-- Show specific farms for testing (parcels 76, 74, 67)
SELECT 
    f.id as parcel_id,
    f.name as stand_number,
    f.district as township_name,
    f.zone_id,
    z.zone as zone_name,
    z.zone_code,
    z.zone_type,
    f.area_ha
FROM gweru_rural_farms f
LEFT JOIN chipinge_land_zones z ON f.zone_id = z.id
WHERE f.id IN (76, 74, 67)
ORDER BY f.id;

-- ============================================
-- STEP 3: Verification - Test spatial join
-- ============================================

-- Show a sample of farms with their assigned zones
SELECT 
    f.id as parcel_id,
    f.name as stand_number,
    z.zone as zone_name,
    z.zone_code,
    z.zone_type,
    ST_AsText(ST_Centroid(f.geom)) as farm_centroid
FROM gweru_rural_farms f
JOIN chipinge_land_zones z ON f.zone_id = z.id
WHERE z.is_active = true
ORDER BY z.zone, f.id
LIMIT 10;

-- ============================================
-- Migration Complete
-- ============================================

-- This migration uses PostGIS spatial functions to assign farms to zones
-- based on geometric intersection, which is much more accurate than
-- manual mapping or arbitrary assignments
