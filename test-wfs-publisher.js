#!/usr/bin/env node

/**
 * Test script for WFS Publisher functionality
 * 
 * This script tests the complete PyQGIS WFS publishing workflow
 * including auto-publishing and styling extraction.
 */

const path = require('path');
const axios = require('axios');

// Configuration
const BACKEND_URL = 'http://localhost:3000';
const PROJECT_PATH = path.join(__dirname, '../qgis-projects/vungu-master-plan-working.qgs');
const TEST_LAYERS = ['gweru_rural_planning_boundary', 'zimbabwe'];

// Colors for console output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testBackendConnection() {
  log('\n🔍 Testing backend connection...', 'blue');
  
  try {
    const response = await axios.get(`${BACKEND_URL}/test`);
    log('✅ Backend connection successful', 'green');
    return true;
  } catch (error) {
    log(`❌ Backend connection failed: ${error.message}`, 'red');
    return false;
  }
}

async function testWFSPublishingStatus() {
  log('\n📊 Checking WFS Publisher status...', 'blue');
  
  try {
    const response = await axios.get(`${BACKEND_URL}/api/wfs/status`);
    
    log(`✅ WFS Publisher status:`, 'green');
    log(`   Cache size: ${response.data.data.cacheSize}`, 'cyan');
    log(`   Cached projects: ${response.data.data.cachedProjects.length}`, 'cyan');
    
    return true;
  } catch (error) {
    log(`❌ WFS Publisher status check failed: ${error.message}`, 'red');
    return false;
  }
}

async function testPublishSpecificLayers() {
  log('\n🚀 Testing specific layer publishing...', 'blue');
  
  try {
    const response = await axios.post(`${BACKEND_URL}/api/wfs/publish`, {
      projectPath: PROJECT_PATH,
      layerNames: TEST_LAYERS,
      options: {
        wfsUrl: 'http://localhost:8080/wfs',
        save: true
      }
    });
    
    log('✅ Layer publishing completed:', 'green');
    log(`   Published layers: ${response.data.data.published.join(', ')}`, 'cyan');
    log(`   Failed layers: ${response.data.data.failed.join(', ')}`, 'yellow');
    log(`   Success rate: ${response.data.data.successRate.toFixed(1)}%`, 'cyan');
    
    return response.data.data;
  } catch (error) {
    log(`❌ Layer publishing failed: ${error.message}`, 'red');
    if (error.response?.data?.details) {
      log(`   Details: ${error.response.data.details}`, 'yellow');
    }
    return null;
  }
}

async function testPublishAllLayers() {
  log('\n🎯 Testing publish all layers...', 'blue');
  
  try {
    const response = await axios.post(`${BACKEND_URL}/api/wfs/publish-all`, {
      projectPath: PROJECT_PATH,
      options: {
        wfsUrl: 'http://localhost:8080/wfs',
        save: true
      }
    });
    
    log('✅ Publish all layers completed:', 'green');
    log(`   Published layers: ${response.data.data.published.join(', ')}`, 'cyan');
    log(`   Failed layers: ${response.data.data.failed.join(', ')}`, 'yellow');
    log(`   Success rate: ${response.data.data.successRate.toFixed(1)}%`, 'cyan');
    
    return response.data.data;
  } catch (error) {
    log(`❌ Publish all layers failed: ${error.message}`, 'red');
    if (error.response?.data?.details) {
      log(`   Details: ${error.response.data.details}`, 'yellow');
    }
    return null;
  }
}

async function testPublishAndStyle() {
  log('\n🎨 Testing publish and style workflow...', 'blue');
  
  try {
    const response = await axios.post(`${BACKEND_URL}/api/wfs/publish-and-style`, {
      projectPath: PROJECT_PATH,
      layerNames: TEST_LAYERS,
      options: {
        wfsUrl: 'http://localhost:8080/wfs',
        save: true,
        maxFeatures: 10,
        includeLegend: true
      }
    });
    
    log('✅ Publish and style workflow completed:', 'green');
    
    const { publishing, styling, workflow } = response.data.data;
    
    log(`   Publishing: ${publishing.published.length} layers published`, 'cyan');
    log(`   Styling: ${styling.filter(s => s.success).length} layers styled`, 'cyan');
    log(`   Workflow completed: ${workflow.completed}`, 'cyan');
    
    // Show styling details
    styling.forEach(layer => {
      if (layer.success) {
        log(`   ✅ ${layer.layerName}: Styled successfully`, 'green');
      } else {
        log(`   ❌ ${layer.layerName}: ${layer.error}`, 'red');
      }
    });
    
    return response.data.data;
  } catch (error) {
    log(`❌ Publish and style workflow failed: ${error.message}`, 'red');
    if (error.response?.data?.details) {
      log(`   Details: ${error.response.data.details}`, 'yellow');
    }
    return null;
  }
}

async function testQGISServerWFS() {
  log('\n🌐 Testing QGIS Server WFS...', 'blue');
  
  try {
    // Test WFS GetCapabilities
    const capabilitiesResponse = await axios.get(
      'http://localhost:8080/?SERVICE=WFS&REQUEST=GetCapabilities&VERSION=1.0.0',
      { timeout: 5000 }
    );
    
    log('✅ QGIS Server WFS GetCapabilities successful', 'green');
    
    // Check if layers are published
    const capabilitiesText = capabilitiesResponse.data;
    const featureTypes = capabilitiesText.match(/<FeatureType>/g);
    
    if (featureTypes && featureTypes.length > 0) {
      log(`   Found ${featureTypes.length} published feature types`, 'cyan');
    } else {
      log('   No feature types found (layers may not be published)', 'yellow');
    }
    
    // Test GetFeature for our test layers
    for (const layerName of TEST_LAYERS) {
      try {
        const featureResponse = await axios.get(
          `http://localhost:8080/?SERVICE=WFS&REQUEST=GetFeature&VERSION=1.0.0&TYPENAME=${layerName}&OUTPUTFORMAT=application/json`,
          { timeout: 5000 }
        );
        
        if (featureResponse.data.type === 'FeatureCollection') {
          log(`   ✅ ${layerName}: ${featureResponse.data.features.length} features`, 'green');
        } else {
          log(`   ⚠️  ${layerName}: Unexpected response format`, 'yellow');
        }
      } catch (featureError) {
        log(`   ❌ ${layerName}: ${featureError.message}`, 'red');
      }
    }
    
    return true;
  } catch (error) {
    log(`❌ QGIS Server WFS test failed: ${error.message}`, 'red');
    return false;
  }
}

async function clearCache() {
  log('\n🗑️  Clearing WFS Publisher cache...', 'blue');
  
  try {
    await axios.delete(`${BACKEND_URL}/api/wfs/cache`);
    log('✅ Cache cleared successfully', 'green');
    return true;
  } catch (error) {
    log(`❌ Cache clear failed: ${error.message}`, 'red');
    return false;
  }
}

async function runTests() {
  log('🧪 WFS Publisher Test Suite', 'cyan');
  log('================================', 'cyan');
  
  const results = {
    backendConnection: false,
    wfsStatus: false,
    publishSpecific: false,
    publishAll: false,
    publishAndStyle: false,
    qgisServerWFS: false,
    cacheClear: false
  };
  
  // Run tests
  results.backendConnection = await testBackendConnection();
  
  if (results.backendConnection) {
    results.wfsStatus = await testWFSPublishingStatus();
    results.publishSpecific = await testPublishSpecificLayers();
    results.publishAll = await testPublishAllLayers();
    results.publishAndStyle = await testPublishAndStyle();
    results.qgisServerWFS = await testQGISServerWFS();
    results.cacheClear = await clearCache();
  }
  
  // Summary
  log('\n📊 Test Results Summary', 'cyan');
  log('========================', 'cyan');
  
  Object.entries(results).forEach(([test, passed]) => {
    const status = passed ? '✅ PASS' : '❌ FAIL';
    const color = passed ? 'green' : 'red';
    const testName = test.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
    log(`${status} - ${testName}`, color);
  });
  
  const passedTests = Object.values(results).filter(Boolean).length;
  const totalTests = Object.keys(results).length;
  
  log(`\n🎯 Overall: ${passedTests}/${totalTests} tests passed`, passedTests === totalTests ? 'green' : 'yellow');
  
  if (passedTests === totalTests) {
    log('\n🎉 All tests passed! WFS Publisher is working correctly.', 'green');
  } else {
    log('\n⚠️  Some tests failed. Check the logs above for details.', 'yellow');
  }
  
  process.exit(passedTests === totalTests ? 0 : 1);
}

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  log(`❌ Unhandled Rejection: ${reason}`, 'red');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  log(`❌ Uncaught Exception: ${error.message}`, 'red');
  process.exit(1);
});

// Run tests
if (require.main === module) {
  runTests();
}

module.exports = {
  runTests,
  testBackendConnection,
  testWFSPublishingStatus,
  testPublishSpecificLayers,
  testPublishAllLayers,
  testPublishAndStyle,
  testQGISServerWFS,
  clearCache
};
