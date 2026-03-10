#!/usr/bin/env node

const http = require('http');

// Test configuration
const BASE_URL = 'http://localhost:3001/api/admin';
const TOKEN = 'mock-jwt-token';

// Helper function to make HTTP requests
function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: `/api/admin${path}`,
      method: method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({
            status: res.statusCode,
            data: json
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            data: body
          });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

// Test cases
const tests = [
  // Authentication
  {
    name: 'Auth Profile',
    method: 'GET',
    path: '/auth/profile'
  },

  // Data Cleaning
  {
    name: 'Data Cleaning Jobs',
    method: 'GET',
    path: '/data-cleaning/jobs'
  },
  {
    name: 'Data Cleaning Statistics',
    method: 'GET',
    path: '/data-cleaning/statistics'
  },
  {
    name: 'Create Data Cleaning Job',
    method: 'POST',
    path: '/data-cleaning/jobs',
    data: {
      jobId: 1,
      cleaningType: 'duplicate_detection',
      config: { layerId: 1 }
    }
  },

  // QML Parser
  {
    name: 'QML Templates',
    method: 'GET',
    path: '/qml-templates'
  },
  {
    name: 'QML Statistics',
    method: 'GET',
    path: '/qml-templates/statistics'
  },
  {
    name: 'Validate QML',
    method: 'POST',
    path: '/qml-templates/validate',
    data: {
      qml_content: '<qml><renderer-v2 type="singleSymbol"><symbols><symbol type="marker" name="test"/></symbols></renderer-v2></qml>'
    }
  },

  // Approval Workflows
  {
    name: 'Workflows',
    method: 'GET',
    path: '/workflows'
  },
  {
    name: 'Workflow Statistics',
    method: 'GET',
    path: '/workflows/statistics'
  },
  {
    name: 'Create Workflow',
    method: 'POST',
    path: '/workflows',
    data: {
      name: 'Test Workflow',
      workflow_type: 'data_upload',
      steps: [{
        step: 1,
        name: 'Review',
        role: 'data_manager',
        required: true
      }]
    }
  },

  // Batch Processing
  {
    name: 'Batch Jobs',
    method: 'GET',
    path: '/batch/jobs'
  },
  {
    name: 'Batch Statistics',
    method: 'GET',
    path: '/batch/statistics'
  },
  {
    name: 'Create Batch Job',
    method: 'POST',
    path: '/batch/jobs',
    data: {
      name: 'Test Batch Job',
      job_type: 'data_cleaning',
      config: {}
    }
  }
];

// Run tests
async function runTests() {
  console.log('🧪 Testing Phase 2 API Endpoints\n');
  
  const results = [];
  
  for (const test of tests) {
    try {
      console.log(`Testing: ${test.name}`);
      const response = await makeRequest(test.method, test.path, test.data);
      
      const status = response.status;
      const success = status >= 200 && status < 300;
      
      results.push({
        name: test.name,
        method: test.method,
        path: test.path,
        status: status,
        success: success,
        data: response.data
      });
      
      if (success) {
        console.log(`✅ ${status} - Success`);
      } else {
        console.log(`❌ ${status} - Failed`);
        if (response.data.error) {
          console.log(`   Error: ${response.data.error}`);
        }
      }
      console.log('');
      
    } catch (error) {
      console.log(`❌ ${test.name} - Connection Error: ${error.message}`);
      results.push({
        name: test.name,
        method: test.method,
        path: test.path,
        status: 'ERROR',
        success: false,
        error: error.message
      });
      console.log('');
    }
  }
  
  // Summary
  console.log('📊 Test Results Summary:');
  console.log('======================');
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`✅ Successful: ${successful}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${((successful / results.length) * 100).toFixed(1)}%`);
  
  if (failed > 0) {
    console.log('\n❌ Failed Tests:');
    results.filter(r => !r.success).forEach(test => {
      console.log(`   - ${test.name}: ${test.status} ${test.data?.error || test.error || ''}`);
    });
  }
  
  console.log('\n🔍 Detailed Results:');
  results.forEach(test => {
    const icon = test.success ? '✅' : '❌';
    console.log(`${icon} ${test.method} ${test.path} - ${test.name} (${test.status})`);
  });
}

// Run the tests
runTests().catch(console.error);
