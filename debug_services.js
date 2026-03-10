#!/usr/bin/env node

// Load environment variables
require('dotenv').config();

const { Pool } = require('pg');

// Import services for testing
const { DataCleaningService } = require('./src/services/admin/dataCleaningService');
const { QmlParserService } = require('./src/services/admin/qmlParserService');
const { ApprovalWorkflowService } = require('./src/services/admin/approvalWorkflowService');
const { BatchProcessingService } = require('./src/services/admin/batchProcessingService');

async function testServices() {
  console.log('🔧 Testing Phase 2 Services with Debugging...\n');
  
  // Create database connection
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

  console.log('1. Testing database connection...');
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as server_time');
    client.release();
    console.log(`✅ Database connection successful`);
    console.log(`   Server time: ${result.rows[0].server_time}`);
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    await pool.end();
    return;
  }

  // Test each service
  const services = [
    { name: 'DataCleaningService', class: DataCleaningService },
    { name: 'QmlParserService', class: QmlParserService },
    { name: 'ApprovalWorkflowService', class: ApprovalWorkflowService },
    { name: 'BatchProcessingService', class: BatchProcessingService }
  ];

  console.log('\n2. Testing individual services...');
  
  for (const service of services) {
    console.log(`\n--- Testing ${service.name} ---`);
    try {
      const serviceInstance = new service.class(pool);
      console.log(`✅ ${service.name} instantiated successfully`);
      
      // Wait a moment for async validation to complete
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.error(`❌ ${service.name} failed:`, error.message);
      console.error('   Stack:', error.stack);
    }
  }

  // Test basic operations
  console.log('\n3. Testing basic operations...');
  
  try {
    // Test DataCleaningService
    console.log('\n   Testing DataCleaningService operations...');
    const dataCleaningService = new DataCleaningService(pool);
    
    const jobs = await dataCleaningService.getCleaningJobs(10, 0);
    console.log(`   ✅ getCleaningJobs: ${jobs.length} jobs returned`);
    
    const stats = await dataCleaningService.getCleaningStatistics();
    console.log(`   ✅ getCleaningStatistics: ${JSON.stringify(stats).substring(0, 100)}...`);
    
  } catch (error) {
    console.error('   ❌ DataCleaningService operations failed:', error.message);
  }

  try {
    // Test QmlParserService
    console.log('\n   Testing QmlParserService operations...');
    const qmlParserService = new QmlParserService(pool);
    
    const templates = await qmlParserService.getQmlTemplates();
    console.log(`   ✅ getQmlTemplates: ${templates.length} templates returned`);
    
    const validation = await qmlParserService.validateQmlContent('<qml><renderer-v2/></qml>');
    console.log(`   ✅ validateQmlContent: ${validation.valid ? 'valid' : 'invalid'}`);
    
  } catch (error) {
    console.error('   ❌ QmlParserService operations failed:', error.message);
  }

  try {
    // Test ApprovalWorkflowService
    console.log('\n   Testing ApprovalWorkflowService operations...');
    const approvalService = new ApprovalWorkflowService(pool);
    
    const workflows = await approvalService.getWorkflows();
    console.log(`   ✅ getWorkflows: ${workflows.length} workflows returned`);
    
    const requests = await approvalService.getApprovalRequests();
    console.log(`   ✅ getApprovalRequests: ${requests.length} requests returned`);
    
  } catch (error) {
    console.error('   ❌ ApprovalWorkflowService operations failed:', error.message);
  }

  try {
    // Test BatchProcessingService
    console.log('\n   Testing BatchProcessingService operations...');
    const batchService = new BatchProcessingService(pool);
    
    const batchJobs = await batchService.getBatchJobs();
    console.log(`   ✅ getBatchJobs: ${batchJobs.length} jobs returned`);
    
    const stats = await batchService.getBatchStatistics();
    console.log(`   ✅ getBatchStatistics: ${JSON.stringify(stats).substring(0, 100)}...`);
    
  } catch (error) {
    console.error('   ❌ BatchProcessingService operations failed:', error.message);
  }

  await pool.end();
  console.log('\n🎉 Service testing completed');
}

testServices().catch(console.error);
