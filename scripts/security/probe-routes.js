/**
 * Probes every GET route of the real app with a given identity (none, or a session cookie) and
 * reports the status. GET only: probing writes anonymously could change data. Streams (SSE) are
 * cut off after a few seconds and reported as "open".
 *   PROBE_OUT=out.json node scripts/security/probe-routes.js [--cookie <vungu_at>]
 */
const { buildWithRoutes } = require('./capture-routes')

const UUID = '00000000-0000-4000-8000-000000000000'
function fill(url) {
  return url
    .replace(/:([A-Za-z_]+)\??(\.[a-z]+)?/g, (_m, name, ext) => {
      const v = /id$|Id$|uuid|sid|sessionId/.test(name) ? UUID : /^(z|x|y)$/.test(name) ? '1' : 'probe'
      return v + (ext || '')
    })
    .replace(/\*/g, 'probe')
}

async function probe(app, method, url, cookie) {
  const res = await Promise.race([
    app.inject({ method, url, headers: cookie ? { cookie: `vungu_at=${cookie}` } : {} }),
    new Promise((r) => setTimeout(() => r({ statusCode: 'open', body: '' }), 4000)),
  ])
  let error = null
  try { error = JSON.parse(res.body)?.error ?? null } catch { /* non-JSON */ }
  return { status: res.statusCode, error, bytes: res.body ? res.body.length : 0 }
}

async function main() {
  const i = process.argv.indexOf('--cookie')
  const cookie = i > 0 ? process.argv[i + 1] : null
  const { app, routes } = await buildWithRoutes()
  const gets = [...new Set(routes.filter((r) => r.method === 'GET').map((r) => r.url))].sort()
  const out = []
  for (const url of gets) {
    const target = fill(url)
    out.push({ route: `GET ${url}`, target, ...(await probe(app, 'GET', target, cookie)) })
  }
  require("node:fs").writeFileSync(process.env.PROBE_OUT, JSON.stringify(out, null, 1))
  await app.close().catch(() => {})
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
