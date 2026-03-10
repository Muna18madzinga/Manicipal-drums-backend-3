-- Final Land Use Controls Migration
-- Creates dynamic zone-land use relationship management

-- ============================================
-- 1. Add missing land use groups
-- ============================================

INSERT INTO land_use_groups (group_code, description, group_category, development_category, use_scale, notes, is_active, created_at, created_by)
VALUES 
    ('P', 'Prohibited Uses', 'prohibited', 'prohibited', 'all_scales', 'Uses explicitly prohibited by zoning regulations', true, NOW(), '00000000-0000-0000-0000-0000000000001'),
    ('SC', 'Special Consent', 'special_consent', 'special_consent', 'all_scales', 'Uses requiring special consent/approval', true, NOW(), '00000000-0000-0000-0000-0000000000001')
ON CONFLICT DO NOTHING;

-- ============================================
-- 2. Create zone_land_use_controls table
-- ============================================

CREATE TABLE zone_land_use_controls (
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
CREATE INDEX idx_zone_land_use_controls_zone_id ON zone_land_use_controls(zone_id);
CREATE INDEX idx_zone_land_use_controls_group_id ON zone_land_use_controls(land_use_group_id);
CREATE INDEX idx_zone_land_use_controls_type ON zone_land_use_controls(control_type);
CREATE INDEX idx_zone_land_use_controls_authority ON zone_land_use_controls(authority);

-- Add unique constraint
ALTER TABLE zone_land_use_controls 
ADD CONSTRAINT unique_zone_land_use_per_authority 
UNIQUE (zone_id, land_use_group_id, control_type, authority);

-- ============================================
-- 3. Create view for zone-land use controls
-- ============================================

CREATE VIEW zone_land_use_controls_detail AS
SELECT 
    zlc.id,
    puz.zone as zone_name,
    puz.zone_type,
    lug.group_code,
    lug.description,
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

-- ============================================
-- 4. Insert sample data
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
        VALUES (sample_zone_id, sample_land_use_id, 'permitted', 'default', 'Sample permitted use relationship', '00000000-0000-0000-0000-0000000000001');
    END IF;
END $$;

-- ============================================
-- 5. Add comments
-- ============================================

COMMENT ON TABLE zone_land_use_controls IS 'Dynamic zone-land use relationships supporting three-tier development control';
