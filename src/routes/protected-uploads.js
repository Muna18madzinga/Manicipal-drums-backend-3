// src/routes/protected-uploads.js
// ─────────────────────────────────────────────────────────────────────────
// GET /uploads/<folder>/<key>/<file> — the ONLY way an uploaded file leaves
// the server.
//
// Uploads used to be served by @fastify/static with no authentication, so a
// citizen's national ID, title deed or permit plans were readable by anyone
// holding (or guessing, or finding in a log/referrer) the URL. Every file is
// now released only to:
//   • council staff (the case-file roles below), or
//   • the client who owns the record the folder is keyed by.
// Anyone else gets 404 — never 403 — so the endpoint does not confirm that
// someone else's file exists.
//
// The storage_url values already stored in the database are unchanged; this
// route answers exactly those paths, and the session cookie travels with
// plain <a href> / <img src> requests, so no frontend link had to change.
// ─────────────────────────────────────────────────────────────────────────

const path = require('node:path')
const fs = require('node:fs')
const { requireAuth } = require('../middleware/jwtAuth')

/** Council employees who work case files. Clients are never in this list. */
const STAFF_ROLES = new Set([
  'admin', 'planner', 'eo', 'env_officer', 'building_inspector',
  'planning_clerk', 'surveyor', 'gis_officer',
])

const UPLOADS = path.resolve(process.cwd(), 'uploads')
const rootFor = (envVar, folder) =>
  process.env[envVar] ? path.resolve(process.env[envVar]) : path.join(UPLOADS, folder)

// folder → where the writer puts it, and who owns a given <key>.
// Each owner query returns the owning user id for that key, or no row.
const FOLDERS = {
  'citizen-documents': {
    root: rootFor('CITIZEN_DOC_ROOT', 'citizen-documents'),
    owner: null, // the key IS the owner's user id
  },
  'permit-documents': {
    root: rootFor('PERMIT_DOC_ROOT', 'permit-documents'),
    owner: `SELECT created_by::text AS owner FROM spatial_planning.permit_application WHERE id::text = $1`,
  },
  'stage-photos': {
    root: rootFor('STAGE_PHOTO_ROOT', 'stage-photos'),
    owner: `SELECT pa.created_by::text AS owner
              FROM spatial_planning.stage_inspection si
              JOIN spatial_planning.permit_application pa ON pa.id = si.permit_app_id
             WHERE si.id::text = $1`,
  },
  'inspection-photos': {
    root: rootFor('INSPECTION_PHOTO_ROOT', 'inspection-photos'),
    owner: `SELECT da.user_id::text AS owner
              FROM inspection_bookings b
              JOIN development_applications da ON da.id::text = b.application_id::text
             WHERE b.id::text = $1`,
  },
  'plan-reviews': {
    root: rootFor('PLAN_REVIEW_ROOT', 'plan-reviews'),
    owner: `SELECT user_id::text AS owner FROM development_applications WHERE id::text = $1`,
  },
}

const MIME = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.heic': 'image/heic', '.dwg': 'application/acad', '.dxf': 'application/dxf',
}

// One path segment: letters, digits, dash, underscore, optional single extension.
// Rejects '..', slashes, encoded separators and anything else by construction.
const KEY_RX = /^[A-Za-z0-9_-]{1,80}$/
const FILE_RX = /^[A-Za-z0-9_-]{1,120}(\.[A-Za-z0-9]{1,8})?$/

/** Pure decision, exported for tests: may `user` read a file under `key`? */
function mayRead(user, ownerId) {
  if (!user) return false
  if (STAFF_ROLES.has(user.role)) return true
  return ownerId != null && String(ownerId) === String(user.id)
}

async function protectedUploadRoutes(fastify) {
  fastify.get('/uploads/:folder/:key/:file', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    const notFound = () => reply.code(404).send({ success: false, error: 'not_found' })
    const { folder, key, file } = request.params
    const spec = FOLDERS[folder]
    if (!spec || !KEY_RX.test(key) || !FILE_RX.test(file)) return notFound()

    let ownerId = null
    if (spec.owner === null) {
      ownerId = key
    } else if (!STAFF_ROLES.has(request.user.role)) {
      try {
        const { rows } = await fastify.pg.query(spec.owner, [key])
        ownerId = rows[0]?.owner ?? null
      } catch (err) {
        request.log.error({ err, folder }, 'upload owner lookup failed')
        return notFound()
      }
    }
    if (!mayRead(request.user, ownerId)) return notFound()

    const diskPath = path.resolve(spec.root, key, file)
    if (!diskPath.startsWith(path.resolve(spec.root) + path.sep)) return notFound()
    let stat
    try { stat = await fs.promises.stat(diskPath) } catch { return notFound() }
    if (!stat.isFile()) return notFound()

    const ext = path.extname(file).toLowerCase()
    reply
      .header('Content-Type', MIME[ext] || 'application/octet-stream')
      .header('Content-Length', stat.size)
      .header('Content-Disposition', MIME[ext] ? 'inline' : 'attachment')
      // Personal documents: never stored by shared caches or the browser disk cache.
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      // A hostile upload rendered inline can run nothing and fetch nothing.
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
    return reply.send(fs.createReadStream(diskPath))
  })
}

module.exports = { protectedUploadRoutes, mayRead, FOLDERS }
