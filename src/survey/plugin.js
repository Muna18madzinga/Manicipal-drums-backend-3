// Survey Task Manager (the merged, formerly standalone surveyor app) mounted
// under /api/survey. Bridges vungu portal auth -> per-surveyor schema world:
//   - verifies the vungu JWT (cookie or Bearer) via src/middleware/jwtAuth.js
//   - auto-provisions survey.users + surveyor_profiles + surveyor_<x> schema
//     on first use (ported from the old /auth/sso exchange)
//   - re-shapes request.user to { sub, id, email } as the survey routes expect
import crypto from 'crypto'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import pool, { createSurveyorSchema } from './config/db.js'
import User from './models/user.js'
import SurveyorProfile from './models/SurveyorProfile.js'

const require = createRequire(import.meta.url)
const { authenticate: vunguAuthenticate } = require('../middleware/jwtAuth.js')

// ponytail: process-local provisioning cache, restart clears it
const provisioned = new Map() // vungu email -> { sub, id, email }

async function ensureProvisioned(vunguUser, log) {
  let user = await User.findByEmail(vunguUser.email)
  if (!user) {
    // random unusable password — portal-authenticated account, no reset flow
    user = await User.create({
      email: vunguUser.email,
      password: crypto.randomBytes(32).toString('hex'),
    })
    log.info(`survey: created user account for ${vunguUser.email}`)
  }

  let profile = await SurveyorProfile.findByUserId(user.id)
  if (!profile) {
    profile = await SurveyorProfile.create({
      userId: user.id,
      name: vunguUser.name || vunguUser.email.split('@')[0],
      surveyorType: 'registered',        // unlocks cadastral modules
      licenseNumber: `VUNGU-${user.id}`, // check_registered_has_license requires one
      firm: 'Vungu Rural District Council',
    })
    await pool.query(
      `UPDATE users SET user_type = 'registered_surveyor' WHERE id = $1`,
      [user.id],
    )
    log.info(`survey: created surveyor profile for ${vunguUser.email}`)
  }

  if (!profile.schema_name) {
    const schemaName = await createSurveyorSchema(user.email)
    await SurveyorProfile.updateSchemaName(profile.id, schemaName)
    log.info(`survey: created schema ${schemaName} for ${vunguUser.email}`)
  }

  return { sub: user.id, id: user.id, email: user.email }
}

// Same prefix map as the old standalone server.js, minus the '/api' part
// (this plugin itself is registered with { prefix: '/api/survey' }).
const ROUTE_PREFIXES = {
  'control-points': '/control-points',
  'parcels': '/parcels',
  'surveyPlanPreview': '/survey-plan',
  'geopdf-vector': '/geopdf',
  'area-parcels': '/area-parcels',
  'survey-projects': '/survey-projects',
}

export default async function surveyPlugin(fastify) {
  fastify.decorate('surveyPg', pool)

  fastify.decorate('authenticate', async (request, reply) => {
    const vunguUser = await vunguAuthenticate(fastify, request, reply)
    if (!vunguUser) return // 401/403 already sent
    if (!['surveyor', 'admin'].includes(vunguUser.role)) {
      return reply.code(403).send({ error: 'not_a_surveyor' })
    }
    let surveyUser = provisioned.get(vunguUser.email)
    if (!surveyUser) {
      surveyUser = await ensureProvisioned(vunguUser, fastify.log)
      provisioned.set(vunguUser.email, surveyUser)
    }
    request.user = surveyUser
  })

  const routesDir = join(dirname(fileURLToPath(import.meta.url)), 'routes')
  const fs = await import('fs')
  const routeFiles = (await fs.promises.readdir(routesDir)).filter((f) => f.endsWith('.js'))
  for (const file of routeFiles) {
    const route = await import(pathToFileURL(join(routesDir, file)).href)
    const prefix = ROUTE_PREFIXES[file.replace('.js', '')] ?? ''
    await fastify.register(route.default, prefix ? { prefix } : {})
  }
  fastify.log.info(`survey: registered ${routeFiles.length} route modules`)
}
