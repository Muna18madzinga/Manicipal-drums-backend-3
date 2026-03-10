-- Insert sample land use groups data
-- Run this script to populate the database with test data

-- PERMITTED groups
INSERT INTO land_use_groups
(group_code, description, group_category, development_category, use_scale, notes, is_active, created_at)
VALUES
('RES001', 'Single Family Residential', 'residential', 'permitted', 'small_scale', 'Standard residential housing', true, NOW()),
('COM001', 'Local Shops', 'commercial', 'permitted', 'small_scale', 'Neighborhood commercial', true, NOW()),
('AGR001', 'Small Scale Farming', 'agricultural', 'permitted', 'small_scale', 'Family farming operations', true, NOW())

ON CONFLICT (group_code) DO NOTHING;

-- PROHIBITED groups
INSERT INTO land_use_groups
(group_code, description, group_category, development_category, use_scale, notes, is_active, created_at)
VALUES
('IND001', 'Heavy Industry', 'industrial', 'prohibited', 'large_scale', 'Polluting industries not allowed', true, NOW()),
('MIN001', 'Mining Operations', 'industrial', 'prohibited', 'large_scale', 'Mineral extraction prohibited in urban areas', true, NOW()),
('NUC001', 'Nuclear Facilities', 'industrial', 'prohibited', 'large_scale', 'High risk facilities prohibited', true, NOW())

ON CONFLICT (group_code) DO NOTHING;

-- SPECIAL CONSENT groups
INSERT INTO land_use_groups
(group_code, description, group_category, development_category, use_scale, notes, is_active, created_at)
VALUES
('INST001', 'Private School', 'institutional', 'special_consent', 'mixed_scale', 'Requires special approval', true, NOW()),
('REC001', 'Golf Course', 'recreational', 'special_consent', 'large_scale', 'Large recreational facility', true, NOW()),
('HOSP001', 'Private Hospital', 'institutional', 'special_consent', 'mixed_scale', 'Medical facility requiring special consent', true, NOW())

ON CONFLICT (group_code) DO NOTHING;
