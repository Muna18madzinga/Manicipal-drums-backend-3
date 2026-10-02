/**
 * Boots the real application (server.js build()) without listening and returns every registered
 * route, captured with an onRoute hook installed before any plugin registers. Used by the route
 * inventory and the security probes so the inventory is the app's actual surface, not a grep.
 */
const Module = require('module')

async function buildWithRoutes() {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test'
  const routes = []
  const realPath = require.resolve('fastify')
  const real = require(realPath)
  const wrapped = function (opts = {}) {
    const app = real({ ...opts, logger: false })
    app.addHook('onRoute', (r) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method]
      for (const m of methods) routes.push({ method: m, url: r.url })
    })
    return app
  }
  Object.assign(wrapped, real)
  require.cache[realPath].exports = wrapped
  // Silence server.js's own console chatter (route tree, banners).
  const log = console.log
  console.log = () => {}
  try {
    delete require.cache[require.resolve('../../server.js')]
    const { build } = require('../../server.js')
    const app = await build()
    await app.ready()
    return { app, routes }
  } finally {
    console.log = log
    require.cache[realPath].exports = real
  }
}

module.exports = { buildWithRoutes }

if (require.main === module) {
  buildWithRoutes().then(async ({ app, routes }) => {
    const uniq = [...new Map(routes.map((r) => [`${r.method} ${r.url}`, r])).values()]
    const byMethod = {}
    for (const r of uniq) byMethod[r.method] = (byMethod[r.method] || 0) + 1
    console.log(JSON.stringify({ total: uniq.length, byMethod }))
    await app.close()
    process.exit(0)
  }).catch((e) => { console.error(e); process.exit(1) })
}
