-- Initial schema for Vungu Master Alpha Spatial Data Portal
-- PostgreSQL with PostGIS extensions

-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    organization VARCHAR(255),
    role VARCHAR(50) DEFAULT 'registered' CHECK (role IN ('public', 'registered', 'admin')),
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login TIMESTAMP WITH TIME ZONE
);

-- Layers table - metadata for spatial layers
CREATE TABLE IF NOT EXISTS layers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(50) NOT NULL CHECK (type IN ('vector', 'raster', 'point', 'polygon', 'line')),
    published BOOLEAN DEFAULT false,
    visible BOOLEAN DEFAULT true,
    style JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Layer data table - actual spatial data
CREATE TABLE IF NOT EXISTS layer_data (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    layer_id UUID NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
    geom GEOMETRY(GEOMETRY, 4326) NOT NULL,
    properties JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Places table - for search/geocoding
CREATE TABLE IF NOT EXISTS places (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(100),
    geom GEOMETRY(POINT, 4326) NOT NULL,
    relevance DECIMAL(3,2) DEFAULT 1.0,
    properties JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User sessions table (for authentication tracking)
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Analytics table - track usage
CREATE TABLE IF NOT EXISTS analytics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100),
    resource_id VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);
CREATE INDEX IF NOT EXISTS idx_layers_published ON layers(published);
CREATE INDEX IF NOT EXISTS idx_layers_visible ON layers(visible);
CREATE INDEX IF NOT EXISTS idx_layer_data_layer_id ON layer_data(layer_id);
CREATE INDEX IF NOT EXISTS idx_layer_data_geom ON layer_data USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_places_name ON places(name);
CREATE INDEX IF NOT EXISTS idx_places_geom ON places USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_places_relevance ON places(relevance DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_analytics_user_id ON analytics(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_action ON analytics(action);
CREATE INDEX IF NOT EXISTS idx_analytics_created_at ON analytics(created_at);

-- Create trigger for updating updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_layers_updated_at 
    BEFORE UPDATE ON layers 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Insert sample data
INSERT INTO users (email, password_hash, name, organization, role) VALUES
('admin@vungu-rdc.org', '$2b$10$rOzJqQjQjQjQjQjQjQjQu', 'System Administrator', 'Vungu RDC', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Insert sample layers
INSERT INTO layers (name, description, type, published, visible, style) VALUES
('Urban Planning Zones', 'Urban planning and zoning boundaries', 'polygon', true, true, 
 '{"color": "#FF6B6B", "fillOpacity": 0.3, "strokeColor": "#FF6B6B"}'),
('Development Areas', 'Current and planned development areas', 'polygon', true, true,
 '{"color": "#4ECDC4", "fillOpacity": 0.3, "strokeColor": "#4ECDC4"}'),
('Environmental Zones', 'Environmental conservation areas', 'polygon', true, true,
 '{"color": "#45B7D1", "fillOpacity": 0.3, "strokeColor": "#45B7D1"}'),
('Health Facilities', 'Hospitals, clinics, and health centers', 'point', true, true,
 '{"color": "#96CEB4", "radius": 8}'),
('Educational Institutions', 'Schools, colleges, and universities', 'point', true, true,
 '{"color": "#FFEAA7", "radius": 8}'),
('Transportation Network', 'Roads, highways, and transport infrastructure', 'line', true, true,
 '{"color": "#DDA0DD", "strokeWidth": 3}')
ON CONFLICT DO NOTHING;

-- Insert sample places for search
INSERT INTO places (name, type, geom, relevance) VALUES
('Vungu Town Center', 'urban_center', ST_GeomFromText('POINT(30.5 -20.0)', 4326), 1.0),
('Vungu District Hospital', 'health_facility', ST_GeomFromText('POINT(30.52 -20.02)', 4326), 0.9),
('Vungu Primary School', 'education', ST_GeomFromText('POINT(30.48 -19.98)', 4326), 0.8),
('Main Market', 'commercial', ST_GeomFromText('POINT(30.51 -20.01)', 4326), 0.85),
('Bus Terminus', 'transport', ST_GeomFromText('POINT(30.53 -20.03)', 4326), 0.8)
ON CONFLICT DO NOTHING;
