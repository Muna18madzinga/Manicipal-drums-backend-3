-- Reassign Land Use Groups to Zone-based Categories from proposed_peri_urban_zones
-- This script maps existing land use group categories to appropriate zones

-- First, let's see what zones we have available
-- SELECT DISTINCT zone FROM proposed_peri_urban_zones ORDER BY zone;

-- Mapping existing categories to zones:
-- residential -> Medium Density Residential
-- commercial -> Economic Corridor [Mixed Business]
-- industrial -> Light Industry
-- institutional -> Institutional
-- agricultural -> (keep as is, or map to a residential zone)
-- recreational -> (keep as is, or map to institutional)
-- mixed -> Mixed Density Residential

-- Update land use groups to use zone names as categories
UPDATE land_use_groups
SET group_category = CASE
    WHEN group_category = 'residential' THEN 'medium_density_residential'
    WHEN group_category = 'commercial' THEN 'economic_corridor_mixed_business'
    WHEN group_category = 'industrial' THEN 'light_industry'
    WHEN group_category = 'institutional' THEN 'institutional'
    WHEN group_category = 'agricultural' THEN 'medium_density_residential' -- Map to residential for now
    WHEN group_category = 'recreational' THEN 'institutional' -- Map to institutional
    WHEN group_category = 'mixed' THEN 'mixed_density_residential'
    ELSE group_category -- Keep existing if no mapping
END;

-- Alternative approach: Update to use the actual zone names from proposed_peri_urban_zones
-- This maps to the exact zone names that exist in the table

UPDATE land_use_groups
SET group_category = CASE
    WHEN group_category = 'residential' THEN 'Medium Density Residential'
    WHEN group_category = 'commercial' THEN 'Economic Corridor [Mixed Business]'
    WHEN group_category = 'industrial' THEN 'Light Industry'
    WHEN group_category = 'institutional' THEN 'Institutional'
    WHEN group_category = 'agricultural' THEN 'Medium Density Residential' -- Map agricultural to residential
    WHEN group_category = 'recreational' THEN 'Institutional' -- Map recreational to institutional
    WHEN group_category = 'mixed' THEN 'Mixed Density Residential'
    ELSE group_category
END
WHERE group_category IN ('residential', 'commercial', 'industrial', 'institutional', 'agricultural', 'recreational', 'mixed');

-- Verify the updates
SELECT
    group_code,
    description,
    group_category,
    development_category
FROM land_use_groups
ORDER BY group_category, group_code;
