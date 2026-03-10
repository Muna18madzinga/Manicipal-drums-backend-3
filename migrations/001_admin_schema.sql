-- Admin Schema for Vungu Master Database
-- Core admin tables for authentication, ingestion, and audit logging

-- 1. Admin Users Table
CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'viewer',
    permissions JSONB NOT NULL DEFAULT '[]',
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Data Ingestion Jobs
CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id SERIAL PRIMARY KEY,
    job_name VARCHAR(255) NOT NULL,
    job_type VARCHAR(50) NOT NULL, -- 'shapefile', 'geojson', 'csv', 'kml', 'geopackage'
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed', 'cancelled'
    file_path VARCHAR(500),
    file_size BIGINT,
    config JSONB NOT NULL DEFAULT '{}',
    results JSONB NOT NULL DEFAULT '{}',
    errors JSONB DEFAULT '[]',
    progress JSONB DEFAULT '{"percentage": 0, "current_step": "", "total_steps": 0}',
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_by INTEGER REFERENCES admin_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Style Templates
CREATE TABLE IF NOT EXISTS style_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    geometry_type VARCHAR(50) NOT NULL, -- 'point', 'line', 'polygon'
    style_config JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES admin_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Validation Rules
CREATE TABLE IF NOT EXISTS validation_rules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    rule_type VARCHAR(50) NOT NULL, -- 'geometry', 'attribute', 'topology'
    geometry_type VARCHAR(50), -- 'point', 'line', 'polygon'
    rule_config JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES admin_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL, -- 'ingestion_job', 'style_template', 'validation_rule', 'admin_user'
    entity_id INTEGER NOT NULL,
    action VARCHAR(50) NOT NULL, -- 'create', 'update', 'delete', 'start', 'stop', 'approve', 'reject'
    old_values JSONB,
    new_values JSONB,
    user_id INTEGER REFERENCES admin_users(id),
    ip_address INET,
    user_agent TEXT,
    session_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Indexes
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users(role);
CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(is_active);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status ON ingestion_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_type ON ingestion_jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_created_by ON ingestion_jobs(created_by);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_created_at ON ingestion_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_style_templates_geometry_type ON style_templates(geometry_type);
CREATE INDEX IF NOT EXISTS idx_style_templates_active ON style_templates(is_active);
CREATE INDEX IF NOT EXISTS idx_validation_rules_type ON validation_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_validation_rules_geometry_type ON validation_rules(geometry_type);
CREATE INDEX IF NOT EXISTS idx_validation_rules_active ON validation_rules(is_active);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- 7. Triggers for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_admin_users_updated_at BEFORE UPDATE ON admin_users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_ingestion_jobs_updated_at BEFORE UPDATE ON ingestion_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_style_templates_updated_at BEFORE UPDATE ON style_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_validation_rules_updated_at BEFORE UPDATE ON validation_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 8. Insert default admin user
INSERT INTO admin_users (email, password_hash, role, permissions, first_name, last_name) VALUES
(
    'admin@vungu.gov.zw',
    '$2b$10$rQZ8ZHC8QWQZQZQZQZQZQuQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ',
    'super_admin',
    '[
        "users.create", "users.read", "users.update", "users.delete",
        "ingestion.create", "ingestion.read", "ingestion.update", "ingestion.delete",
        "styles.create", "styles.read", "styles.update", "styles.delete",
        "validation.create", "validation.read", "validation.update", "validation.delete",
        "audit.read", "system.admin"
    ]'::jsonb,
    'System',
    'Administrator'
)
ON CONFLICT (email) DO NOTHING;

-- 9. Insert default validation rules
INSERT INTO validation_rules (name, description, rule_type, geometry_type, rule_config, created_by) VALUES
(
    'Valid Geometry Check',
    'Ensures all geometries are valid according to OGC standards',
    'geometry',
    null,
    '{
        "check_type": "is_valid",
        "error_message": "Invalid geometry detected"
    }'::jsonb,
    1
),
(
    'Required Attributes',
    'Ensures required attributes are present and not null',
    'attribute',
    null,
    '{
        "required_fields": ["name", "type"],
        "error_message": "Missing required attributes"
    }'::jsonb,
    1
),
(
    'Polygon Area Check',
    'Ensures polygons have minimum area',
    'geometry',
    'polygon',
    '{
        "check_type": "min_area",
        "min_area": 1.0,
        "error_message": "Polygon area too small"
    }'::jsonb,
    1
),
(
    'Line Length Check',
    'Ensures lines have minimum length',
    'geometry',
    'line',
    '{
        "check_type": "min_length",
        "min_length": 0.1,
        "error_message": "Line length too short"
    }'::jsonb,
    1
)
ON CONFLICT DO NOTHING;

-- 10. Insert default style templates
INSERT INTO style_templates (name, description, geometry_type, style_config, created_by) VALUES
(
    'Default Point Style',
    'Basic red circle marker for points',
    'point',
    '{
        "type": "marker",
        "color": "#FF0000",
        "size": 5,
        "outline_color": "#000000",
        "outline_width": 1,
        "symbol": "circle"
    }'::jsonb,
    1
),
(
    'Default Line Style',
    'Basic blue solid line for linestrings',
    'line',
    '{
        "type": "line",
        "color": "#0000FF",
        "width": 2,
        "style": "solid",
        "cap_style": "round",
        "join_style": "round"
    }'::jsonb,
    1
),
(
    'Default Polygon Style',
    'Basic green fill with black outline for polygons',
    'polygon',
    '{
        "type": "fill",
        "fill_color": "#00FF00",
        "fill_opacity": 0.7,
        "outline_color": "#000000",
        "outline_width": 1,
        "outline_style": "solid"
    }'::jsonb,
    1
)
ON CONFLICT DO NOTHING;

-- Comments
COMMENT ON TABLE admin_users IS 'Administrative users with roles and permissions';
COMMENT ON TABLE ingestion_jobs IS 'Data ingestion jobs for importing spatial data';
COMMENT ON TABLE style_templates IS 'Style templates for different geometry types';
COMMENT ON TABLE validation_rules IS 'Validation rules for data quality checks';
COMMENT ON TABLE audit_logs IS 'Audit trail for all admin operations';
