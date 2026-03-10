-- Enhanced Land Use Management Migration (Corrected)
-- Uses existing proposed_peri_urban_zones table for zones
-- Adds development control categories and zone-land use relationship management

-- ============================================
-- 1. Enhance land_use_groups table
-- ============================================

-- Add development control and scale categorization
ALTER TABLE land_use_groups 
ADD COLUMN development_category VARCHAR(20) CHECK (development_category IN ('permitted', 'prohibited', 'special_consent')),
ADD COLUMN use_scale VARCHAR(20) CHECK (use_scale IN ('small_scale', 'large_scale', 'mixed_scale', 'all_scales'));

-- Update existing land use groups with proper categories
UPDATE land_use_groups SET 
    development_category = 'permitted',
    use_scale = CASE 
        WHEN group_code IN ('A', 'A1', 'A2', 'A3', 'A4', 'A5') THEN 'small_scale'
        WHEN group_code IN ('B', 'C', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6') THEN 'mixed_scale'
        WHEN group_code IN ('D', 'E', 'F', 'G', 'H', 'I') THEN 'mixed_scale'
        ELSE 'small_scale'
    END;

-- Add development control categories
INSERT INTO land_use_groups (group_code, group_name, group_category, development_category, use_scale, description, notes, is_active, created_at, created_by)
VALUES 
    ('P', 'Prohibited Uses', 'prohibited', 'prohibited', 'all_scales', 'Uses explicitly prohibited by zoning regulations', 'X() - Prohibited uses in zone definitions', true, NOW(), '00000000-0000-0000-0000-0000000000001'),
    ('SC', 'Special Consent', 'special_consent', 'special_consent', 'all_scales', 'Uses requiring special consent/approval', 'SC() - Special consent uses in zone definitions', true, NOW(), '00000000-0000-0000-0000-0000000000001');

-- ============================================
-- 2. Enhance proposed_peri_urban_zones table
-- ============================================

-- Add zone type and scale categorization
ALTER TABLE proposed_peri_urban_zones 
ADD COLUMN zone_type VARCHAR(50),
ADD COLUMN scale_category VARCHAR(20) CHECK (scale_category IN ('small_scale', 'large_scale', 'mixed_scale')),
ADD COLUMN authority VARCHAR(100) DEFAULT 'default',
ADD COLUMN zone_description TEXT;

-- Update zones with proper types based on zone names and types
UPDATE proposed_peri_urban_zones SET 
    zone_type = CASE 
        WHEN zone ILIKE '%communal%' OR zone_type ILIKE '%communal%' THEN 'Communal Farming Zone'
        WHEN zone ILIKE '%commercial%' OR zone_type ILIKE '%commercial%' THEN 'High Intensive Commercial Farming Zone'
        WHEN zone ILIKE '%estates%' OR zone_type ILIKE '%estates%' THEN 'Estates Zone (Large Farms)'
        WHEN zone ILIKE '%irrigation%' OR zone_type ILIKE '%irrigation%' THEN 'Irrigation Scheme Zone'
        WHEN zone ILIKE '%peri_urban%' OR zone_type ILIKE '%peri_urban%' THEN 'Proposed Peri-Urban Zone'
        ELSE 'Mixed Zone'
    END,
    scale_category = CASE
        WHEN zone ILIKE '%communal%' OR zone_type ILIKE '%communal%' THEN 'small_scale'
        WHEN zone ILIKE '%commercial%' OR zone_type ILIKE '%commercial%' THEN 'large_scale'
        WHEN zone ILIKE '%estates%' OR zone_type ILIKE '%estates%' THEN 'large_scale'
        WHEN zone ILIKE '%irrigation%' OR zone_type ILIKE '%irrigation%' THEN 'mixed_scale'
        WHEN zone ILIKE '%peri_urban%' OR zone_type ILIKE '%peri_urban%' THEN 'mixed_scale'
        ELSE 'mixed_scale'
    END,
    zone_description = CASE
        WHEN zone ILIKE '%communal%' OR zone_type ILIKE '%communal%' THEN 'Small-scale subsistence farming areas'
        WHEN zone ILIKE '%commercial%' OR zone_type ILIKE '%commercial%' THEN 'Large-scale commercial agriculture operations'
        WHEN zone ILIKE '%estates%' OR zone_type ILIKE '%estates%' THEN 'Very large farms such as tea plantations'
        WHEN zone ILIKE '%irrigation%' OR zone_type ILIKE '%irrigation%' THEN 'Mixed residential and agricultural areas with irrigation'
        WHEN zone ILIKE '%peri_urban%' OR zone_type ILIKE '%peri_urban%' THEN 'Proposed urban development zones'
        ELSE 'Mixed development zone'
    END;

-- ============================================
-- 3. Create zone_land_use_controls table
-- ============================================

CREATE TABLE zone_land_use_controls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id UUID NOT NULL REFERENCES proposed_peri_urban_zones(id) ON DELETE CASCADE,
    land_use_group_id UUID NOT NULL REFERENCES land_use_groups(id) ON DELETE CASCADE,
    control_type VARCHAR(20) NOT NULL CHECK (control_type IN ('permitted', 'prohibited', 'special_consent')),
    authority VARCHAR(100) DEFAULT 'default',
    conditions TEXT, -- Specific conditions for special consent uses
    created_at TIMESTAMP DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by UUID REFERENCES users(id)
);

-- Create indexes for performance
CREATE INDEX idx_zone_land_use_controls_zone_id ON zone_land_use_controls(zone_id);
CREATE INDEX idx_zone_land_use_controls_group_id ON zone_land_use_controls(land_use_group_id);
CREATE INDEX idx_zone_land_use_controls_type ON zone_land_use_controls(control_type);
CREATE INDEX idx_zone_land_use_controls_authority ON zone_land_use_controls(authority);

-- ============================================
-- 4. Create zone_land_use_control_history table for audit trail
-- ============================================

CREATE TABLE zone_land_use_control_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    control_id UUID NOT NULL REFERENCES zone_land_use_controls(id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
    old_values JSONB,
    new_values JSONB,
    changed_at TIMESTAMP DEFAULT NOW(),
    changed_by UUID REFERENCES users(id)
);

CREATE INDEX idx_zone_land_use_control_history_control_id ON zone_land_use_control_history(control_id);
CREATE INDEX idx_zone_land_use_control_history_changed_at ON zone_land_use_control_history(changed_at);

-- ============================================
-- 5. Add constraints for data integrity
-- ============================================

-- Ensure each zone-land use combination is unique per authority
ALTER TABLE zone_land_use_controls 
ADD CONSTRAINT unique_zone_land_use_per_authority 
UNIQUE (zone_id, land_use_group_id, control_type, authority);

-- ============================================
-- 6. Create views for easier querying
-- ============================================

-- View for zone land use controls with full details
CREATE OR REPLACE VIEW zone_land_use_controls_detail AS
SELECT 
    zlc.id,
    puz.zone as zone_name,
    puz.zone_type,
    puz.scale_category,
    lug.group_code,
    lug.group_name,
    lug.group_category,
    lug.development_category,
    lug.use_scale,
    zlc.control_type,
    zlc.authority,
    zlc.conditions,
    zlc.created_at,
    zlc.updated_at
FROM zone_land_use_controls zlc
JOIN proposed_peri_urban_zones puz ON zlc.zone_id = puz.id
JOIN land_use_groups lug ON zlc.land_use_group_id = lug.id;

-- View for zone summary with land use counts
CREATE OR REPLACE VIEW zone_land_use_summary AS
SELECT 
    puz.id as zone_id,
    puz.zone as zone_name,
    puz.zone_type,
    puz.scale_category,
    puz.authority,
    COUNT(CASE WHEN zlc.control_type = 'permitted' THEN 1 END) as permitted_uses_count,
    COUNT(CASE WHEN zlc.control_type = 'prohibited' THEN 1 END) as prohibited_uses_count,
    COUNT(CASE WHEN zlc.control_type = 'special_consent' THEN 1 END) as special_consent_uses_count,
    COUNT(zlc.id) as total_land_use_controls
FROM proposed_peri_urban_zones puz
LEFT JOIN zone_land_use_controls zlc ON puz.id = zlc.zone_id
GROUP BY puz.id, puz.zone, puz.zone_type, puz.scale_category, puz.authority;

-- ============================================
-- 7. Insert sample data for testing
-- ============================================

-- Get first zone and land use group for sample data
DO $$
DECLARE
    sample_zone_id UUID;
    sample_land_use_id UUID;
BEGIN
    SELECT id INTO sample_zone_id FROM proposed_peri_urban_zones LIMIT 1;
    SELECT id INTO sample_land_use_id FROM land_use_groups WHERE development_category = 'permitted' LIMIT 1;
    
    IF sample_zone_id IS NOT NULL AND sample_land_use_id IS NOT NULL THEN
        INSERT INTO zone_land_use_controls (zone_id, land_use_group_id, control_type, authority, conditions, created_by)
        VALUES (sample_zone_id, sample_land_use_id, 'permitted', 'default', 'Sample permitted use relationship', '00000000-0000-0000-0000-0000000000001');
    END IF;
END $$;

-- ============================================
-- 8. Add comments for documentation
-- ============================================

COMMENT ON TABLE land_use_groups IS 'Enhanced land use groups with development control categories and scale classification';
COMMENT ON TABLE proposed_peri_urban_zones IS 'Enhanced zones with type, scale, and authority classification';
COMMENT ON TABLE zone_land_use_controls IS 'Dynamic zone-land use relationships supporting three-tier development control';
COMMENT ON TABLE zone_land_use_control_history IS 'Audit trail for zone-land use control changes';

-- ============================================
-- Migration complete
-- ============================================

-- Log migration completion (if migration_history table exists, otherwise skip)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'migration_history') THEN
        INSERT INTO migration_history (migration_name, executed_at, status, notes)
        VALUES ('050_enhance_land_use_management_corrected.sql', NOW(), 'completed', 'Enhanced land use management with development control categories and dynamic zone-land use relationships using proposed_peri_urban_zones table');
    END IF;
END $$;
