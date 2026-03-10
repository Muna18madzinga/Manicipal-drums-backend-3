-- Populate spatial_layers table with actual PostGIS layers
INSERT INTO spatial_layers (table_name, display_name, geometry_type, description, style_config, is_visible) VALUES
('gweru_chief_homesteads', 'Chief Homesteads', 'point', 'Traditional chief homestead locations in Gweru district', '{"color": "#FF6B6B", "radius": 8}', true),
('gweru_schools', 'Schools', 'point', 'Educational institutions in Gweru district', '{"color": "#4ECDC4", "radius": 8}', true),
('gweru_health_centres', 'Health Facilities', 'point', 'Healthcare facilities in Gweru district', '{"color": "#96CEB4", "radius": 8}', true),
('gweru_roads', 'Road Network', 'line', 'Road infrastructure in Gweru district', '{"color": "#DDA0DD", "strokeWidth": 3}', true),
('gcc_boundary', 'Gweru City Boundary', 'polygon', 'Administrative boundary of Gweru city', '{"color": "#45B7D1", "fillOpacity": 0.3, "strokeColor": "#45B7D1"}', true)
ON CONFLICT (table_name) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    geometry_type = EXCLUDED.geometry_type,
    description = EXCLUDED.description,
    style_config = EXCLUDED.style_config,
    is_visible = EXCLUDED.is_visible;
