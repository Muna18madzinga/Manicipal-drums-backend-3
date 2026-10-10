// src/routes/context.js
// ─────────────────────────────────────────────────
// What VunGIS tells SurveyPro about the register, on behalf of a person SurveyPro vouches for.
//
//   POST /context/check-layout    a layout still being worked on, against the register: the rules the importer will apply, without writing
//
// Authenticated by a SERVICE TOKEN (src/lib/serviceToken.js), not by a VunGIS login: the caller is SurveyPro's server. Read-only: the check runs
// in a read-only transaction that is always rolled back. Advisory: the importer (src/services/surveyproImport.js) stays the gate.
// docs/HARMONIZATION-SCOPE.md, piece A1.
// ─────────────────────────────────────────────────

const { systemOf } = require('../lib/dbContext')
const { loadPublicKey, verify } = require('../lib/serviceToken')
const { checkLayout } = require('../services/layoutCheck')

const SCOPE = 'check-layout'
const MAX_PARCELS = 2000

async function contextRoutes(fastify) {
  const pg = systemOf(fastify.pg)

  /** Bearer token -> claims, or an answer already sent. */
  async function serviceAuth(request, reply) {
    const publicKey = loadPublicKey()
    if (!publicKey) return reply.code(503).send({ success: false, error: 'not_configured', message: 'The register check is not connected to SurveyPro on this server.' })
    const m = /^Bearer (.+)$/.exec(request.headers.authorization || '')
    if (!m) return reply.code(401).send({ success: false, error: 'no_token' })
    try { request.service = verify(m[1], { publicKey, scope: SCOPE }) }
    catch (e) { return reply.code(401).send({ success: false, error: 'invalid_token', message: e.message }) }
  }

  fastify.post('/context/check-layout', {
    preHandler: serviceAuth,
    bodyLimit: 20 * 1024 * 1024,
    schema: {
      tags: ['Context'],
      summary: 'Check a survey layout against the register (service token)',
      body: {
        type: 'object', required: ['authority_code', 'project_id', 'parcels'], additionalProperties: false,
        properties: {
          authority_code: { type: 'string', maxLength: 32 },
          project_id: { type: 'integer', minimum: 1 },
          township: { type: ['string', 'null'], maxLength: 120 },
          survey_class: { type: ['string', 'null'], maxLength: 4 },
          parcels: {
            type: 'array', maxItems: MAX_PARCELS,
            items: {
              type: 'object', required: ['id', 'geojson'], additionalProperties: false,
              properties: {
                id: { type: 'integer' }, stand: { type: ['string', 'null'] }, designation: { type: ['string', 'null'] },
                area_m2: { type: ['number', 'null'] }, lo_zone: { type: ['integer', 'null'] }, srid: { type: ['integer', 'null'] },
                geojson: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const b = request.body
    // the token vouches for one council; a layout for another is not its business
    if (b.authority_code !== request.service.authority) {
      return reply.code(403).send({ success: false, error: 'wrong_authority', message: 'This token is for another council.' })
    }
    const authority = (await pg.query('SELECT id FROM public.local_authorities WHERE code = $1', [b.authority_code])).rows[0]
    if (!authority) return reply.code(404).send({ success: false, error: 'unknown_authority', message: `${b.authority_code} is not set up in VunGIS.` })

    const township = b.township ? String(b.township).trim() : ''
    const client = await pg.connect()
    try {
      await client.query('BEGIN READ ONLY')
      const r = await checkLayout(client, { township, parcels: b.parcels, keyOf: (p) => `${b.authority_code}:${b.project_id}:${p.id}` })
      // the same note the importer gives: class B is "surveys in townships", C every other survey
      const cls = b.survey_class ? String(b.survey_class).trim().toUpperCase() : null
      if (b.parcels.length && (cls === 'B' || cls === 'C')) {
        const expected = township ? 'B' : 'C'
        if (cls !== expected) r.warnings.push({ code: 'class_vs_township', survey_class: cls, expected })
      }
      return { success: true, authority: b.authority_code, ...r }
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
}

module.exports = { contextRoutes }
