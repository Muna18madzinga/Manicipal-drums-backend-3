// test-ogc-exception-guard.js
// Self-check for ogcServiceException() in refinedOGCBridge.
// No DB, no QGIS Server, no framework — run with: node test-ogc-exception-guard.js
//
// QGIS Server returns HTTP 200 for a request it cannot service (wrong/missing
// SERVICE=), with a ServiceExceptionReport body. Before this guard the health
// probe read that as "healthy" and GetMap handed XML back as if it were a PNG.

const assert = require('assert')
const { ogcServiceException } = require('./src/services/admin/refinedOGCBridge')

const res = (contentType, body) => ({
  headers: { 'content-type': contentType },
  data: Buffer.from(body, 'binary')
})

// The exact body QGIS Server logged for GET /ogc/collections.
const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<ServiceExceptionReport xmlns="http://www.opengis.net/ogc" version="1.3.0">
 <ServiceException code="Service configuration error">Service unknown or unsupported. Current supported services (case-sensitive): WMS WFS WCS WMTS SampleService, or use a WFS3 (OGC API Features) endpoint</ServiceException>
</ServiceExceptionReport>`

// 1. An exception report is detected, and the message is surfaced.
const fault = ogcServiceException(res('text/xml; charset=utf-8', REPORT))
assert.ok(fault && fault.startsWith('Service unknown or unsupported'), `got: ${fault}`)

// 2. A real GetCapabilities document (also XML) is NOT a fault.
assert.strictEqual(
  ogcServiceException(res('text/xml', '<?xml version="1.0"?><WMS_Capabilities version="1.3.0"><Service/></WMS_Capabilities>')),
  null
)

// 3. A PNG tile is never scanned as XML — including one whose bytes happen to
//    contain the string (content-type short-circuits first).
assert.strictEqual(ogcServiceException(res('image/png', '\x89PNG<ServiceException>')), null)

// 4. A self-closing exception with no message still counts as a fault.
assert.strictEqual(
  ogcServiceException(res('application/xml', '<ServiceException code="x"></ServiceException>')),
  'OGC ServiceException'
)

// 5. Missing headers must not throw (axios error paths, mocked responses).
assert.strictEqual(ogcServiceException({ data: Buffer.from('x') }), null)

console.log('PASS test-ogc-exception-guard.js (5 checks)')
