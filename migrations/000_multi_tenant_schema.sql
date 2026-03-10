-- Multi-Tenant Schema for Vungu Spatial Data Portal
-- Supports 92 local planning authorities

-- 1. Organizations table (for 92 local planning authorities)
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    code VARCHAR(50) NOT NULL UNIQUE, -- e.g., "VUNGU", "HARARE", "BULAWAYO"
    type VARCHAR(50) NOT NULL DEFAULT 'local_authority', -- 'local_authority', 'provincial', 'national'
    province VARCHAR(100),
    district VARCHAR(100),
    description TEXT,
    contact_email VARCHAR(255),
    contact_phone VARCHAR(50),
    address TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Users table with multi-tenant support
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'viewer', -- 'super_admin', 'org_admin', 'editor', 'viewer'
    permissions JSONB DEFAULT '[]', -- Role-based permissions
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, email) -- Email must be unique within organization
);

-- 3. Insert default organizations (92 local planning authorities)
INSERT INTO organizations (name, code, type, province, district) VALUES
('Vungu Rural District Council', 'VUNGU', 'local_authority', 'Midlands', 'Vungu'),
('Harare Metropolitan Province', 'HARARE', 'local_authority', 'Harare', 'Harare'),
('Bulawayo Metropolitan Province', 'BULAWAYO', 'local_authority', 'Bulawayo', 'Bulawayo'),
('Matabeleland North Provincial Council', 'MAT_NORTH', 'local_authority', 'Matabeleland North', 'Lupane'),
('Matabeleland South Provincial Council', 'MAT_SOUTH', 'local_authority', 'Matabeleland South', 'Gwanda'),
('Masvingo Provincial Council', 'MASVINGO', 'local_authority', 'Masvingo', 'Masvingo'),
('Manicaland Provincial Council', 'MANICALAND', 'local_authority', 'Manicaland', 'Mutare'),
('Mashonaland Central Provincial Council', 'MASH_CENTRAL', 'local_authority', 'Mashonaland Central', 'Bindura'),
('Mashonaland East Provincial Council', 'MASH_EAST', 'local_authority', 'Mashonaland East', 'Marondera'),
('Mashonaland West Provincial Council', 'MASH_WEST', 'local_authority', 'Mashonaland West', 'Chinhoyi')
-- Add remaining 82 authorities as needed
ON CONFLICT (code) DO NOTHING;

-- 4. Insert default admin user for Vungu (for testing)
INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, permissions)
SELECT 
    id,
    'admin@vungu.gov.zw',
    '$2b$10$N9qo8uLOickgx2ZMRZoMye.Ijd4rB9tQeX5dQJQJqJqJqJqJqJqJq',
    'System',
    'Administrator',
    'org_admin',
    '["users.manage", "data.manage", "layers.create", "layers.update", "layers.delete", "styles.manage", "audit.view"]'
FROM organizations WHERE code = 'VUNGU'
ON CONFLICT (organization_id, email) DO NOTHING;

-- 5. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_organizations_code ON organizations(code);
CREATE INDEX IF NOT EXISTS idx_organizations_active ON organizations(is_active);

-- 6. Enable Row Level Security (RLS) for data isolation
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

-- 7. RLS Policies for multi-tenant data access
-- Users can only see users from their own organization
CREATE POLICY users_organization_policy ON users
    FOR ALL
    TO authenticated_role
    USING (organization_id = current_setting('app.current_organization_id')::UUID);

-- Organizations are readable by all authenticated users
CREATE POLICY organizations_read_policy ON organizations
    FOR SELECT
    TO authenticated_role
    USING (is_active = true);

-- 8. Create function to set organization context
CREATE OR REPLACE FUNCTION set_organization_context(org_id UUID)
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_organization_id', org_id::text, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 10. Create view for user profiles with organization info
CREATE OR REPLACE VIEW user_profiles AS
SELECT 
    u.id,
    u.email,
    u.first_name,
    u.last_name,
    u.role,
    u.permissions,
    u.is_active,
    u.last_login,
    u.created_at,
    o.name as organization_name,
    o.code as organization_code,
    o.type as organization_type,
    o.province,
    o.district
FROM users u
JOIN organizations o ON u.organization_id = o.id;

-- Grant permissions to authenticated role
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO authenticated_role;
GRANT SELECT ON organizations TO authenticated_role;
GRANT SELECT ON user_profiles TO authenticated_role;
