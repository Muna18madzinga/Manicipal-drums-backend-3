/**
 * Create Planner User Script
 * 
 * This script creates the 'planner' user for Vungu RDC.
 * Run with: node create-planner-user.js
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Database configuration (match your .env settings)
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'vungu_master_db_v1',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'cairo2025'
};

// Planner user details
const PLANNER_USER = {
  email: 'planner@vungurdc.gov.zw',
  name: 'Vungu Planner',
  role: 'planner',
  organization: 'Vungu Rural District Council',
  password: 'VunguPlanner2025!',
  phone: '+263 55 2521 500'
};

async function createPlannerUser() {
  console.log('🔧 Connecting to database as postgres...');
  console.log(`   Host: ${dbConfig.host}`);
  console.log(`   Database: ${dbConfig.database}`);
  console.log(`   User: ${dbConfig.user}`);
  
  const pool = new Pool(dbConfig);
  
  try {
    console.log('🔧 Creating planner user...');
    console.log(`📧 Email: ${PLANNER_USER.email}`);
    console.log(`🏢 Organization: ${PLANNER_USER.organization}`);
    console.log(`👤 Role: ${PLANNER_USER.role}`);
    
    // Hash the password using bcrypt
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(PLANNER_USER.password, saltRounds);
    
    console.log('🔐 Password hashed successfully');
    
    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id, email FROM users WHERE email = $1',
      [PLANNER_USER.email]
    );
    
    if (existingUser.rows.length > 0) {
      console.log('⚠️  User already exists. Updating password and details...');
      
      // Update existing user
      const result = await pool.query(`
        UPDATE users 
        SET 
          name = $1,
          role = $2,
          organization = $3,
          password_hash = $4,
          phone = $5,
          status = 'active',
          active = true,
          updated_at = NOW()
        WHERE email = $6
        RETURNING id, email, name, role, organization, active, created_at
      `, [
        PLANNER_USER.name,
        PLANNER_USER.role,
        PLANNER_USER.organization,
        passwordHash,
        PLANNER_USER.phone,
        PLANNER_USER.email
      ]);
      
      console.log('✅ User updated successfully!');
      console.log('\n📋 User Details:');
      console.log(`   ID: ${result.rows[0].id}`);
      console.log(`   Email: ${result.rows[0].email}`);
      console.log(`   Name: ${result.rows[0].name}`);
      console.log(`   Role: ${result.rows[0].role}`);
      console.log(`   Organization: ${result.rows[0].organization}`);
      console.log(`   Active: ${result.rows[0].active}`);
      
    } else {
      // Insert new user
      const result = await pool.query(`
        INSERT INTO users (
          id,
          email,
          name,
          role,
          organization,
          password_hash,
          phone,
          status,
          email_verified,
          active,
          created_at,
          updated_at
        ) VALUES (
          gen_random_uuid(),
          $1, $2, $3, $4, $5, $6, 'active', true, true, NOW(), NOW()
        )
        RETURNING id, email, name, role, organization, active, created_at
      `, [
        PLANNER_USER.email,
        PLANNER_USER.name,
        PLANNER_USER.role,
        PLANNER_USER.organization,
        passwordHash,
        PLANNER_USER.phone
      ]);
      
      console.log('✅ User created successfully!');
      console.log('\n📋 User Details:');
      console.log(`   ID: ${result.rows[0].id}`);
      console.log(`   Email: ${result.rows[0].email}`);
      console.log(`   Name: ${result.rows[0].name}`);
      console.log(`   Role: ${result.rows[0].role}`);
      console.log(`   Organization: ${result.rows[0].organization}`);
      console.log(`   Active: ${result.rows[0].active}`);
    }
    
    console.log('\n🔑 Login Credentials:');
    console.log(`   Email: ${PLANNER_USER.email}`);
    console.log(`   Password: ${PLANNER_USER.password}`);
    console.log('\n⚠️  IMPORTANT: Change the default password after first login!');
    
    // Also create an admin user entry if using admin_users table
    try {
      const adminCheck = await pool.query(
        'SELECT 1 FROM admin_users WHERE user_id = (SELECT id FROM users WHERE email = $1)',
        [PLANNER_USER.email]
      );
      
      if (adminCheck.rows.length === 0) {
        // Create admin entry with planner permissions
        await pool.query(`
          INSERT INTO admin_users (id, user_id, role, permissions)
          SELECT 
            gen_random_uuid(),
            id,
            'planner',
            '{
              "layers": {"view": true, "manage": true},
              "features": {"view": true, "edit": true},
              "styles": {"view": true, "apply": true},
              "maps": {"view": true, "export": true},
              "users": {"view": false, "manage": false}
            }'::jsonb
          FROM users WHERE email = $1
        `, [PLANNER_USER.email]);
        console.log('✅ Admin user entry created with planner permissions');
      }
    } catch (adminError) {
      // admin_users table might not exist, that's ok
      console.log('ℹ️  Note: admin_users table not found (optional)');
    }
    
  } catch (error) {
    console.error('❌ Error creating planner user:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run the script
createPlannerUser();
