// Database setup script for the unified backend
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:cairo2025@localhost:5432/vungu_master_db_v1'
})

async function setupDatabase() {
  console.log('🔧 Setting up database...')
  
  try {
    // Create tables
    // Check if users table exists and add missing columns
    try {
      await pool.query('SELECT 1 FROM users LIMIT 1')
      
      // Add missing columns if they don't exist
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT \'user\'')
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS organization VARCHAR(255)')
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true')
      
      console.log('✅ Users table updated with missing columns')
    } catch (error) {
      // Create users table if it doesn't exist
      await pool.query(`
        CREATE TABLE users (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          full_name VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'user',
          organization VARCHAR(255),
          password_hash VARCHAR(255),
          phone VARCHAR(50),
          status VARCHAR(50) DEFAULT 'active',
          email_verified BOOLEAN DEFAULT false,
          active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          last_login_at TIMESTAMP
        )
      `)
      console.log('✅ Users table created')
    }
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS survey_projects (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        created_by UUID REFERENCES users(id),
        surveyor_id UUID REFERENCES users(id)
      )
    `)
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS coordinate_points (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        geom GEOMETRY(POINT, 4326),
        description TEXT,
        type VARCHAR(50) DEFAULT 'beacon',
        project_id UUID REFERENCES survey_projects(id),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS land_parcels (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        stand VARCHAR(100) NOT NULL,
        description TEXT,
        area_m2 DECIMAL(12,2),
        geom GEOMETRY(POLYGON, 4326),
        project_id UUID REFERENCES survey_projects(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)
    
    // Handle layers table - check if it exists and recreate if needed
    try {
      const layerResult = await pool.query('SELECT 1 FROM layers LIMIT 1')
      console.log('✅ Layers table already exists')
    } catch (error) {
      // Create layers table if it doesn't exist
      await pool.query(`
        CREATE TABLE layers (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          type VARCHAR(50) NOT NULL,
          style JSONB,
          published BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `)
      console.log('✅ Layers table created')
    }
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS layer_data (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        layer_id VARCHAR(255) REFERENCES layers(id) ON DELETE CASCADE,
        geom GEOMETRY,
        properties JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS places (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(100),
        geom GEOMETRY(POINT, 4326),
        relevance DECIMAL(3,2) DEFAULT 1.0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)
    
    // Create indexes
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)')
    await pool.query('CREATE INDEX IF NOT EXISTS idx_projects_surveyor ON survey_projects(surveyor_id)')
    await pool.query('CREATE INDEX IF NOT EXISTS idx_parcels_project ON land_parcels(project_id)')
    await pool.query('CREATE INDEX IF NOT EXISTS idx_points_project ON coordinate_points(project_id)')
    await pool.query('CREATE INDEX IF NOT EXISTS idx_layer_data_layer ON layer_data(layer_id)')
    await pool.query('CREATE INDEX IF NOT EXISTS idx_layer_data_geom ON layer_data USING GIST(geom)')
    await pool.query('CREATE INDEX IF NOT EXISTS idx_parcels_geom ON land_parcels USING GIST(geom)')
    await pool.query('CREATE INDEX IF NOT EXISTS idx_points_geom ON coordinate_points USING GIST(geom)')
    await pool.query('CREATE INDEX IF NOT EXISTS idx_places_geom ON places USING GIST(geom)')
    
    // Insert sample data
    await pool.query(`
      INSERT INTO users (email, full_name, role, organization, password_hash)
      VALUES ('admin@vungu.gov.zw', 'Admin User', 'admin', 'Vungu RDC', 'mock-hash')
      ON CONFLICT (email) DO UPDATE SET
        role = EXCLUDED.role,
        organization = EXCLUDED.organization
    `)
    
    await pool.query(`
      INSERT INTO layers (id, name, description, type, published)
      VALUES (gen_random_uuid(), 'Sample Boundaries', 'Sample land boundaries', 'polygon', true)
    `)
    
    console.log('✅ Database setup completed successfully!')
    
  } catch (error) {
    console.error('❌ Database setup failed:', error)
    throw error
  } finally {
    await pool.end()
  }
}

// Run setup if called directly
if (require.main === module) {
  setupDatabase().catch(console.error)
}

module.exports = { setupDatabase }
