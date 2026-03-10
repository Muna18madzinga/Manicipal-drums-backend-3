// Test the individual layer endpoint directly
const http = require('http')

// Test function
async function testLayerEndpoint() {
  console.log('🧪 Testing individual layer endpoint...')
  
  // Test business_centres endpoint
  const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/dynamic-layers/layer/business_centres',
    method: 'GET'
  }
  
  const req = http.request(options, (res) => {
    let body = ''
    
    res.on('data', (chunk) => {
      body += chunk
    })
    
    res.on('end', () => {
      console.log('✅ Response status:', res.statusCode)
      console.log('📊 Response body:', body)
      
      try {
        const parsed = JSON.parse(body)
        console.log('🔍 Parsed response keys:', Object.keys(parsed))
        if (parsed.data) {
          console.log('🔍 Data keys:', Object.keys(parsed.data))
          if (parsed.data.objects) {
            console.log('🔍 Objects keys:', Object.keys(parsed.data.objects))
          }
        }
      } catch (error) {
        console.log('❌ JSON parse error:', error.message)
      }
    })
  })
  
  req.on('error', (error) => {
    console.error('❌ Request error:', error.message)
  })
  
  req.end()
}

testLayerEndpoint()
