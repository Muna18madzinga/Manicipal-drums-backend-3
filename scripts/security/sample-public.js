// Prints the field names (and one sample record, truncated) returned anonymously by public routes.
const { buildWithRoutes } = require('./capture-routes')
function firstRecord(body) {
  const d = body?.data ?? body?.features ?? body
  const arr = Array.isArray(d) ? d : Array.isArray(d?.features) ? d.features : Array.isArray(d?.data) ? d.data : null
  const rec = arr ? arr[0] : d
  return rec?.properties ?? rec
}
;(async () => {
  const { app } = await buildWithRoutes()
  for (const url of JSON.parse(process.argv[2])) {
    const res = await app.inject({ method: 'GET', url })
    let body; try { body = JSON.parse(res.body) } catch { body = res.body.slice(0, 200) }
    const rec = firstRecord(body)
    const keys = rec && typeof rec === 'object' ? Object.keys(rec).join(',') : String(rec).slice(0, 120)
    console.error(`${res.statusCode} ${url}\n    fields: ${keys.slice(0, 400)}`)
  }
  await app.close().catch(() => {})
  process.exit(0)
})()
