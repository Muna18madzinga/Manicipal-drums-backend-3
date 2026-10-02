// One-off reproduction helper: boots the real app and injects the given requests with no credentials.
const { buildWithRoutes } = require('./capture-routes')
;(async () => {
  const { app } = await buildWithRoutes()
  for (const spec of JSON.parse(process.argv[2])) {
    const res = await app.inject({ method: spec.m, url: spec.u, payload: spec.b })
    console.error(`${spec.m} ${spec.u} -> ${res.statusCode} ${res.body.slice(0, 300).replace(/\s+/g, ' ')}`)
  }
  await app.close().catch(() => {})
  process.exit(0)
})()
