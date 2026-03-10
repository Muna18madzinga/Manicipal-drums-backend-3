-- ============================================
-- Migration: Standardize Zone Names for Consistency
-- Updates zone names to be consistent across frontend and backend
-- ============================================

-- Set session timezone for consistent timestamps
SET timezone = 'UTC';

-- ============================================
-- STEP 1: Standardize zone names for consistency
-- ============================================

-- Update all "Estates" zones to "Smallholder Estates" for consistency
UPDATE chipinge_land_zones 
SET zone = 'Smallholder Estates' 
WHERE zone = 'Estates';

-- Update zone names to be more descriptive and consistent
UPDATE chipinge_land_zones 
SET zone = 'Cemetery Zone' 
WHERE zone = 'Cemetry';

UPDATE chipinge_land_zones 
SET zone = 'Communal Farming Zone' 
WHERE zone = 'Communal Farming';

UPDATE chipinge_land_zones 
SET zone = 'Conservation Area' 
WHERE zone = 'Conservation Areas';

UPDATE chipinge_land_zones 
SET zone = 'Commercial Farming Zone' 
WHERE zone = 'High Intensive Commercial Farming';

UPDATE chipinge_land_zones 
SET zone = 'Industrial Zone' 
WHERE zone = 'Industry';

UPDATE chipinge_land_zones 
SET zone = 'Irrigation Farming Zone' 
WHERE zone = 'Irrigation Farming';

UPDATE chipinge_land_zones 
SET zone = 'Urban Expansion Zone' 
WHERE zone = 'Urban Expansion';

UPDATE chipinge_land_zones 
SET zone = 'Game Park Zone' 
WHERE zone = 'Game Park';

UPDATE chipinge_land_zones 
SET zone = 'Game Corridor Zone' 
WHERE zone = 'Game Corridor';

UPDATE chipinge_land_zones 
SET zone = 'Forestry Zone' 
WHERE zone = 'Forestry';

-- ============================================
-- STEP 2: Show updated zone names
-- ============================================

-- Show the updated zone names
SELECT 
    id,
    zone,
    zone_code,
    zone_type,
    CASE 
        WHEN zone ILIKE '%smallholder%' THEN 'Smallholder Estates'
        WHEN zone ILIKE '%urban%' THEN 'Urban Expansion'
        WHEN zone ILIKE '%cemetery%' THEN 'Cemetery'
        WHEN zone ILIKE '%conservation%' THEN 'Conservation'
        WHEN zone ILIKE '%industrial%' THEN 'Industrial'
        WHEN zone ILIKE '%commercial%' THEN 'Commercial'
        ELSE zone
    END as standardized_category
FROM chipinge_land_zones 
WHERE is_active = true 
ORDER BY standardized_category, zone;

-- Show which parcels are affected
SELECT 
    f.id as parcel_id,
    f.name as stand_number,
    f.zone_id,
    z.zone as zone_name,
    z.zone_code
FROM gweru_rural_farms f
JOIN chipinge_land_zones z ON f.zone_id = z.id
WHERE f.zone_id IS NOT NULL
ORDER BY z.zone, f.id
LIMIT 20;

-- ============================================
-- Migration Complete
-- ============================================

-- This migration standardizes zone names to ensure consistency
-- between frontend and backend development application components
