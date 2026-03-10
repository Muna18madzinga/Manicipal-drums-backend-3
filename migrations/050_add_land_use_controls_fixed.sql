-- Add Zone-Land Use Controls Migration (Fixed)
-- Creates dynamic zone-land use relationship management

-- ============================================
-- 1. Add missing columns to proposed_peri_urban_zones
-- ============================================

ALTER TABLE proposed_peri_urban_zones 
ADD COLUMN IF NOT EXISTS scale_category VARCHAR(20) CHECK (scale_category IN ('small_scale', 'large_scale', 'mixed_scale')),
ADD COLUMN IF NOT EXISTS authority VARCHAR(100) DEFAULT 'default',
ADD COLUMN IF NOT EXISTS zone_description TEXT;

-- Update zones with scale categories
UPDATE proposed_peri_urban_zones SET 
    scale_category = CASE
        WHEN zone_type ILIKE '%communal%' THEN 'small_scale'
        WHEN zone_type ILIKE '%commercial%' THEN 'large_scale'
        WHEN zone_type ILIKE '%estates%' THEN 'large_scale'
        WHEN zone_type ILIKE '%irrigation%' THEN 'mixed_scale'
        WHEN zone_type ILIKE '%peri_urban%' THEN 'mixed_scale'
        ELSE 'mixed_scale'
    END,
    zone_description = CASE
        WHEN zone_type ILIKE '%communal%' THEN 'Small-scale subsistence farming areas'
        WHEN zone_type ILIKE '%commercial%' THEN 'Large-scale commercial agriculture operations'
        WHEN zone_type ILIKE '%estates%' THEN 'Very large farms such as tea plantations'
        WHEN zone_type ILIKE '%irrigation%' THEN 'Mixed residential and agricultural areas with irrigation'
        WHEN zone_type ILIKE '%peri_urban%' THEN 'Proposed urban development zones'
        ELSE 'Mixed development zone'
    END
WHERE scale_category IS NULL OR zone_description IS NULL;

-- ============================================
-- 2. Add missing land use groups
-- ============================================

INSERT INTO land_use_groups (group_code, group_name, group_category, development_category, use_scale, description, notes, is_active, created_at, created_by)
VALUES 
    ('P', 'Prohibited Uses', 'prohibited', 'prohibited', 'all_scales', 'Uses explicitly prohibited by zoning regulations', 'X() - Prohibited uses in zone definitions', true, NOW(), '00000000-0000-0000-0000-0000000000001'),
    ('SC', 'Special Consent', 'special_consent', 'special_consent', 'all_scales', 'Uses requiring special consent/approval', 'SC() - Special consent uses in zone definitions', true, NOW(), '00000000-0000-0000-0000-0000000000001')
ON CONFLICT DO NOTHING;

-- ============================================
-- 3. Create zone_land_use_controls table
-- ============================================

CREATE TABLE IF NOT EXISTS zone_land_use_controls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id INTEGER NOT NULL REFERENCES proposed_peri_urban_zones(id) ON DELETE CASCADE,
    land_use_group_id UUID NOT NULL REFERENCES land_use_groups(id) ON DELETE CASCADE,
    control_type VARCHAR(20) NOT NULL CHECK (control_type IN ('permitted', 'prohibited', 'special_consent')),
    authority VARCHAR(100) DEFAULT 'default',
    conditions TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by UUID REFERENCES users(id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_zone_land_use_controls_zone_id ON zone_land_use_controls(zone_id);
CREATE INDEX IF NOT EXISTS idx_zone_land_use_controls_group_id ON zone_land_use_controls(land_use_group_id);
CREATE INDEX IF NOT EXISTS idx_zone_land_use_controls_type ON zone_land_use_controls(control_type);
CREATE INDEX IF NOT EXISTS idx_zone_land_use_controls_authority ON zone_land_use_controls(authority);

-- Add unique constraint
ALTER TABLE zone_land_use_controls 
ADD CONSTRAINT IF NOT EXISTS unique_zone_land_use_per_authority 
UNIQUE (zone_id, land_use_group_id, control_type, authority);

-- ============================================
-- 4. Create audit history table
-- ============================================

CREATE TABLE IF NOT EXISTS zone_land_use_control_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    control_id UUID NOT NULL REFERENCES zone_land_use_controls(id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
    old_values JSONB,
    new_values JSONB,
    changed_at TIMESTAMP DEFAULT NOW(),
    changed_by UUID REFERENCES users(id)
);

-- Create history indexes
CREATE INDEX IF NOT EXISTS idx_zone_land_use_control_history_control_id ON zone_land_use_control_history(control_id);
CREATE INDEX IF NOT EXISTS idx_zone_land_use_control_history_changed_at ON zone_land_use_control_history(changed_at);

-- ============================================
-- 5. Create views
-- ============================================

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
-- 6. Insert sample data
-- ============================================

DO $$
DECLARE
    sample_zone_id INTEGER;
    sample_land_use_id UUID;
BEGIN
    SELECT id INTO sample_zone_id FROM proposed_peri_urban_zones LIMIT 1;
    SELECT id INTO sample_land_use_id FROM land_use_groups WHERE development_category = 'permitted' LIMIT 1;
    
    IF sample_zone_id IS NOT NULL AND sample_land_use_id IS NOT NULL THEN
        INSERT INTO zone_land_use_controls (zone_id, land_use_group_id, control_type, authority, conditions, created_by)
        VALUES (sample_zone_id, sample_land_use_id, 'permitted', 'default', 'Sample permitted use relationship', '00000000-0000-0000-0000-0000000000001')
        ON CONFLICT DO NOTHING;
    END IF;
END $$;

-- ============================================
-- 7. Add comments
-- ============================================

COMMENT ON TABLE zone_land_use_controls IS 'Dynamic zone-land use relationships supporting three-tier development control';
COMMENT ON TABLE zone_land_use_control_history IS 'Audit trail for zone-land use control changes';
