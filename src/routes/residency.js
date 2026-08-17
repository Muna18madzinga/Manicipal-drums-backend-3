/**
 * Citizen residency verification + mock Ministry of Lands deeds registry.
 *
 * A person is regarded as a resident/ratepayer of the district when they can
 * produce one of the statutory proofs (SI 85/2017 s5 taxonomy):
 *   - title deed / certificate of occupation  (checkable against the registry)
 *   - lodger's permit issued by the local authority
 *   - settlement / offer letter proving lawful occupation
 *   - proof of residence (rates or utility statement)
 *   - confirmation letter by councillor / village head / headman / chief
 *
 * Routes (all under /api):
 *   GET  /residency/requirements          Public: the accepted proofs
 *   GET  /residency/status                Citizen: my verdict + evidence
 *   POST /residency/deed-check            Citizen: verify a title deed number
 *                                         against the (mock) national registry;
 *                                         a holder match auto-verifies residency
 *   GET  /lands-registry/deeds            Ministry dashboard: deed book
 *   POST /lands-registry/deeds            Ministry dashboard: register a deed
 *   GET  /lands-registry/checks           Ministry dashboard: incoming checks
 *   GET  /lands-registry/stats            Ministry dashboard: headline figures
 */

const { requireAuth, requireRole } = require('../middleware/jwtAuth')

/** Document kinds that count as residency evidence once verified. */
const RESIDENCY_KINDS = [
  'title_deed', 'settlement_letter', 'lodgers_permit',
  'occupation_certificate', 'chiefs_letter', 'proof_of_residence',
]

const REQUIREMENTS = [
  {
    kind: 'title_deed',
    label: 'Title deed',
    detail: 'Registered title deed for property in the district. Verified instantly against the Deeds Registry using the deed number.',
    instant: true,
  },
  {
    kind: 'occupation_certificate',
    label: 'Certificate of occupation',
    detail: 'Certificate of occupation issued for a stand in the district.',
    instant: false,
  },
  {
    kind: 'lodgers_permit',
    label: "Lodger's permit",
    detail: "A lodger's permit issued by the council.",
    instant: false,
  },
  {
    kind: 'settlement_letter',
    label: 'Settlement / offer letter',
    detail: 'An offer or settlement letter proving lawful occupation of land in the district.',
    instant: false,
  },
  {
    kind: 'proof_of_residence',
    label: 'Rates or utility statement',
    detail: 'A council rates, water or electricity statement showing your name and physical address in the district.',
    instant: false,
  },
  {
    kind: 'chiefs_letter',
    label: 'Chief / councillor confirmation letter',
    detail: 'A confirmation letter from your ward councillor, village head, headman or chief.',
    instant: false,
  },
]

const MINISTRY_ROLES = ['admin', 'planner', 'planning_clerk', 'eo', 'gis_officer']

const isString = (v, max = 255) => typeof v === 'string' && v.length > 0 && v.length <= max

/** Normalise deed numbers/national ids for forgiving comparison. */
const norm = (s) => String(s || '').replace(/[\s-]/g, '').toUpperCase()

function deedDTO(row) {
  return {
    id: row.id,
    deedNumber: row.deed_number,
    holderName: row.holder_name,
    holderNationalId: row.holder_national_id,
    standNo: row.stand_no,
    propertyDescription: row.property_description,
    district: row.district,
    hectares: row.hectares == null ? null : Number(row.hectares),
    status: row.status,
    registeredAt: row.registered_at,
  }
}

async function residencyRoutes(fastify) {
  // ── Requirements (public) ────────────────────────────────────────────
  fastify.get('/residency/requirements', async (_request, reply) => {
    return reply.send({ success: true, data: REQUIREMENTS })
  })

  // ── My residency status ──────────────────────────────────────────────
  fastify.get('/residency/status', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { rows: urows } = await fastify.pg.query(
        `SELECT residency_status, residency_method, residency_verified_at
         FROM users WHERE id = $1`,
        [request.user.id],
      )
      const u = urows[0]
      if (!u) return reply.code(404).send({ success: false, error: 'not_found' })

      const { rows: docs } = await fastify.pg.query(
        `SELECT id, doc_kind, verification_status, verification_notes, created_at, verified_at
         FROM citizen_documents
         WHERE user_id = $1 AND deleted_at IS NULL AND doc_kind = ANY($2)
         ORDER BY created_at DESC`,
        [request.user.id, RESIDENCY_KINDS],
      )

      return reply.send({
        success: true,
        data: {
          status: u.residency_status,
          method: u.residency_method,
          verifiedAt: u.residency_verified_at,
          evidence: docs.map((d) => ({
            id: d.id,
            docKind: d.doc_kind,
            verificationStatus: d.verification_status,
            verificationNotes: d.verification_notes,
            createdAt: d.created_at,
            verifiedAt: d.verified_at,
          })),
        },
      })
    } catch (err) {
      request.log.error({ err }, 'residency status failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Title deed check against the (mock) Deeds Registry ──────────────
  fastify.post('/residency/deed-check', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { deedNumber } = request.body || {}
      if (!isString(deedNumber, 32)) {
        return reply.code(400).send({ success: false, error: 'deed_number_required' })
      }

      const { rows } = await fastify.pg.query(
        `SELECT * FROM lands_registry_deeds
         WHERE REPLACE(REPLACE(UPPER(deed_number), '-', ''), ' ', '')
             = REPLACE(REPLACE(UPPER($1), '-', ''), ' ', '')`,
        [deedNumber],
      )
      const deed = rows[0] || null

      // A "holder match" requires the deed's registered national id to equal
      // the citizen's national id on file. Name matching alone is spoofable.
      const userNid = norm(request.user.national_id)
      const holderMatch = Boolean(
        deed && deed.status === 'active' && userNid && norm(deed.holder_national_id) === userNid,
      )

      await fastify.pg.query(
        `INSERT INTO lands_registry_checks
           (deed_number, requested_by, requester_name, matched, holder_match, result_status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          deedNumber.trim(), request.user.id, request.user.name || request.user.email,
          Boolean(deed), holderMatch, deed ? deed.status : 'not_found',
        ],
      )

      if (holderMatch) {
        await fastify.pg.query(
          `UPDATE users SET residency_status = 'verified',
                            residency_method = 'deeds_registry',
                            residency_verified_at = NOW()
           WHERE id = $1`,
          [request.user.id],
        )
      }

      return reply.send({
        success: true,
        data: {
          found: Boolean(deed),
          deed: deed
            ? {
                deedNumber: deed.deed_number,
                holderName: deed.holder_name,
                standNo: deed.stand_no,
                propertyDescription: deed.property_description,
                district: deed.district,
                status: deed.status,
                registeredAt: deed.registered_at,
              }
            : null,
          holderMatch,
          residencyVerified: holderMatch,
          message: !deed
            ? 'No deed with that number exists in the registry.'
            : deed.status !== 'active'
              ? `Deed found but its status is ${deed.status}; it cannot be used for verification.`
              : holderMatch
                ? 'Deed holder matches your national ID. Residency verified.'
                : 'Deed found, but the registered holder does not match the national ID on your profile. Update your profile national ID or upload the deed for manual review.',
        },
      })
    } catch (err) {
      request.log.error({ err }, 'deed check failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ════════════════════════════════════════════════════════════════════
  // Mock Ministry of Lands dashboard (simulated external system)
  // ════════════════════════════════════════════════════════════════════

  fastify.get('/lands-registry/deeds', { preHandler: requireRole(fastify, MINISTRY_ROLES) }, async (request, reply) => {
    try {
      const { search, status } = request.query || {}
      const where = []
      const params = []
      if (isString(search, 120)) {
        params.push(`%${search}%`)
        where.push(`(deed_number ILIKE $${params.length} OR holder_name ILIKE $${params.length} OR stand_no ILIKE $${params.length})`)
      }
      if (isString(status, 20)) {
        params.push(status)
        where.push(`status = $${params.length}`)
      }
      const { rows } = await fastify.pg.query(
        `SELECT * FROM lands_registry_deeds
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY registered_at DESC
         LIMIT 200`,
        params,
      )
      return reply.send({ success: true, data: rows.map(deedDTO) })
    } catch (err) {
      request.log.error({ err }, 'lands registry list failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/lands-registry/deeds', { preHandler: requireRole(fastify, ['admin']) }, async (request, reply) => {
    try {
      const b = request.body || {}
      if (!isString(b.deedNumber, 32) || !isString(b.holderName, 160)) {
        return reply.code(400).send({ success: false, error: 'deed_number_and_holder_required' })
      }
      const { rows } = await fastify.pg.query(
        `INSERT INTO lands_registry_deeds
           (deed_number, holder_name, holder_national_id, stand_no, property_description, district, hectares, status)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'Vungu'), $7, COALESCE($8, 'active'))
         ON CONFLICT (deed_number) DO NOTHING
         RETURNING *`,
        [
          b.deedNumber.trim(), b.holderName.trim(),
          isString(b.holderNationalId, 32) ? b.holderNationalId.trim() : null,
          isString(b.standNo, 64) ? b.standNo.trim() : null,
          isString(b.propertyDescription, 2000) ? b.propertyDescription.trim() : null,
          isString(b.district, 80) ? b.district.trim() : null,
          b.hectares == null || Number.isNaN(Number(b.hectares)) ? null : Number(b.hectares),
          ['active', 'transfer_pending', 'cancelled'].includes(b.status) ? b.status : null,
        ],
      )
      if (!rows[0]) return reply.code(409).send({ success: false, error: 'deed_exists' })
      return reply.code(201).send({ success: true, data: deedDTO(rows[0]) })
    } catch (err) {
      request.log.error({ err }, 'lands registry insert failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/lands-registry/checks', { preHandler: requireRole(fastify, MINISTRY_ROLES) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT c.*, u.email AS requester_email
         FROM lands_registry_checks c
         LEFT JOIN users u ON u.id = c.requested_by
         ORDER BY c.created_at DESC
         LIMIT 100`,
      )
      return reply.send({
        success: true,
        data: rows.map((r) => ({
          id: r.id,
          deedNumber: r.deed_number,
          requesterName: r.requester_name,
          requesterEmail: r.requester_email,
          matched: r.matched,
          holderMatch: r.holder_match,
          resultStatus: r.result_status,
          createdAt: r.created_at,
        })),
      })
    } catch (err) {
      request.log.error({ err }, 'lands registry checks failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/lands-registry/stats', { preHandler: requireRole(fastify, MINISTRY_ROLES) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT
           (SELECT COUNT(*) FROM lands_registry_deeds)                               AS total_deeds,
           (SELECT COUNT(*) FROM lands_registry_deeds WHERE status = 'active')       AS active_deeds,
           (SELECT COUNT(*) FROM lands_registry_checks)                              AS total_checks,
           (SELECT COUNT(*) FROM lands_registry_checks
             WHERE created_at > NOW() - INTERVAL '7 days')                           AS checks_this_week,
           (SELECT COUNT(*) FROM lands_registry_checks WHERE holder_match)           AS verified_matches,
           (SELECT COUNT(*) FROM users WHERE residency_status = 'verified')          AS verified_residents`,
      )
      const s = rows[0]
      return reply.send({
        success: true,
        data: {
          totalDeeds: Number(s.total_deeds),
          activeDeeds: Number(s.active_deeds),
          totalChecks: Number(s.total_checks),
          checksThisWeek: Number(s.checks_this_week),
          verifiedMatches: Number(s.verified_matches),
          verifiedResidents: Number(s.verified_residents),
        },
      })
    } catch (err) {
      request.log.error({ err }, 'lands registry stats failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { residencyRoutes, RESIDENCY_KINDS }
