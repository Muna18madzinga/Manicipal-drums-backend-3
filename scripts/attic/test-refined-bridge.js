/**
 * Test script for Refined OGC Bridge
 * Testing with vungu-master-plan-working.qgs
 */

const { RefinedOGCBridge } = require('./src/services/admin/refinedOGCBridge')

async function test() {
  console.log('='.repeat(60))
  console.log('Testing Refined OGC Bridge')
  console.log('Project: vungu-master-plan-working.qgs')
  console.log('='.repeat(60))

  try {
    // Initialize bridge
    const bridge = new RefinedOGCBridge({
      baseUrl: 'http://localhost:8080',
      project: '/etc/qgisserver/vungu-master-plan-working.qgs',
      projectLocalPath: 'c:/mataranyika/vungu-master-alpha-qgis-server/qgis-projects'
    })

    console.log('\n✅ RefinedOGCBridge initialized successfully')

    // Layers in this project: gweru_rural_planning_boundary, zimbabwe
    const layersToTest = ['gweru_rural_planning_boundary', 'zimbabwe']
    
    for (const layerName of layersToTest) {
      console.log('\n' + '='.repeat(60))
      console.log(`LAYER: ${layerName}`)
      console.log('='.repeat(60))

      // Test style extraction
      console.log('\n--- Style Extraction ---')
      try {
        const style = await bridge.getStyle(layerName)
        console.log('✅ Style extraction successful!')
        console.log('   Source:', style.source)
        console.log('   Renderer type:', style.rendererType)
        console.log('   Attribute:', style.attributeName || 'N/A')
        console.log('   Symbol count:', style.symbols?.length || 0)
        console.log('   Has complex patterns:', style.hasComplexPatterns)
        console.log('   Has hatch patterns:', style.hasHatchPatterns)
        console.log('   Has gradients:', style.hasGradients)
        
        // Show symbols details
        if (style.symbols && style.symbols.length > 0) {
          console.log('\n   Symbols:')
          for (const sym of style.symbols.slice(0, 5)) {
            console.log(`     - ${sym.name || sym.id}: ${sym.fill?.color || 'no fill'}`)
          }
        }
        
        if (style.maplibreStyle) {
          console.log('\n   MapLibre Style:')
          console.log('   ', JSON.stringify(style.maplibreStyle, null, 2).replace(/\n/g, '\n   '))
        }
      } catch (styleError) {
        console.log('⚠️ Style extraction failed:', styleError.message)
      }

      // Test direct PostgreSQL features
      console.log('\n--- Feature Extraction ---')
      try {
        const features = await bridge.getDirectFeatures(layerName, { maxFeatures: 3 })
        console.log('✅ Feature extraction successful!')
        console.log('   Total features:', features.totalFeatures)
        console.log('   Table name:', features.metadata.tableName)
        
        if (features.features.length > 0) {
          console.log('   First feature properties:', Object.keys(features.features[0].properties).join(', '))
        }
      } catch (featureError) {
        console.log('⚠️ Feature extraction failed:', featureError.message)
      }
    }

    console.log('\n' + '='.repeat(60))
    console.log('✅ All Tests Complete!')
    console.log('='.repeat(60))

  } catch (error) {
    console.error('❌ Test failed:', error.message)
    console.error(error.stack)
  }
}

test()
