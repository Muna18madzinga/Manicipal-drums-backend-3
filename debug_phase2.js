#!/usr/bin/env node

// Load environment variables
require('dotenv').config();

// Simple test to check if services can be instantiated
const { Pool } = require('pg');

async function testServices() {
  console.log('🔧 Testing Phase 2 Services...\n');
  
  // Test database connection
  console.log('1. Testing database connection...');
  try {
    const pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'vungu_master_db',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    const client = await pool.connect();
    console.log('✅ Database connection successful');
    client.release();
    
    // Test if tables exist
    console.log('\n2. Testing Phase 2 tables...');
    const tables = [
      'data_cleaning_jobs',
      'cleaning_issues', 
      'qml_style_templates',
      'style_components',
      'approval_workflows',
      'approval_requests',
      'approval_actions',
      'batch_jobs',
      'batch_job_items',
      'audit_logs_phase2'
    ];

    for (const table of tables) {
      try {
        const result = await pool.query(`SELECT COUNT(*) FROM ${table}`);
        console.log(`✅ ${table}: ${result.rows[0].count} rows`);
      } catch (error) {
        console.log(`❌ ${table}: ${error.message}`);
      }
    }

    // Test basic query
    console.log('\n3. Testing basic queries...');
    try {
      const result = await pool.query('SELECT COUNT(*) as total FROM batch_jobs');
      console.log(`✅ Batch jobs count: ${result.rows[0].total}`);
    } catch (error) {
      console.log(`❌ Batch jobs query failed: ${error.message}`);
    }

    await pool.end();
    console.log('\n🎉 Database tests completed');
    
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
  }
}

testServices().catch(console.error);
