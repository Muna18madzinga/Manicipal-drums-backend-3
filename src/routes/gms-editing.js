// src/routes/gms-editing.js
// ─────────────────────────────────────────────────────────────────────────
// GIS Management System, phase 2: layers, features, edit sessions and QA.
//
//   GET    /gms/layers                            viewInternal
//   GET    /gms/layers/:id/features               viewInternal (+ layer access)  ?bbox&accuracy
//   GET    /gms/features/:id                      viewInternal (+ layer access)  feature + history
//   POST   /gms/features/:id/restore              approveQa    { version, reason }
//   POST   /gms/edit-sessions                     editLayers   { layer_id } — opens or resumes
//   GET    /gms/edit-sessions                     editLayers / approveQa  ?scope=mine|queue
//   GET    /gms/edit-sessions/:id                 owner or approveQa
//   PUT    /gms/edit-sessions/:id/edits           owner        autosave
//   POST   /gms/edit-sessions/:id/validate        owner or approveQa
//   POST   /gms/edit-sessions/:id/submit          owner        -> QA queue
//   POST   /gms/edit-sessions/:id/approve         approveQa (not the editor)
//   POST   /gms/edit-sessions/:id/reject|return   approveQa    { reason }
//   DELETE /gms/edit-sessions/:id                 owner        abandon
//   POST   /gms/geometry/split | merge            editLayers   geometry helpers
//
// Tables: gis_ops.layer / feature / feature_version / edit_session (133).
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')
const { GMS } = require('../services/gms/roles')
const { audit } = require('../services/gms/audit')
const {
  canEditLayer, validateEdits, applyEdits, restoreVersion, EditConflict,
} = require('../services/gms/editing')

const tags = ['GMS editing']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_FEATURES = 5000

const canSeePersonal = (user) => GMS.personalData.includes(user.role)

/** Restricted layers: personal-data roles, or the custodian department's own people. */
const canViewLayer = (user, layer) => layer.access_level !== 'restricted'
  || canSeePersonal(user)
  || (user.department && user.department === layer.custodian_dept)

const personalFields = (layer) => (layer.attributes || []).filter((f) => f.personal).map((f) => f.name)

function mask(attrs, hidden) {
  if (!hidden.length) return attrs
  const out = { ...attrs }
  for (const k of hidden) delete out[k]
  return out
}

async function gmsEditingRoutes(fastify) {
  const pg = fastify.pg
  const view = { preHandler: requireRole(fastify, GMS.viewInternal) }
  const editor = { preHandler: requireRole(fastify, GMS.editLayers) }
  const qa = { preHandler: requireRole(fastify, GMS.approveQa) }
  const sessionReaders = { preHandler: requireRole(fastify, [...new Set([...GMS.editLayers, ...GMS.approveQa])]) }

  const getLayer = async (id) => (await pg.query('SELECT * FROM gis_ops.layer WHERE layer_id = $1', [id])).rows[0]

  /**
   * Personal fields are shown only to roles that may see them, and only once
   * the view is on the audit trail (rule 6). Returns the fields to hide.
   */
  async function personalGate(request, layer, entityId, count) {
    const fields = personalFields(layer)
    if (!fields.length) return []
    if (!canSeePersonal(request.user)) return fields
    const logged = await audit(pg, request, {
      event: 'PERSONAL_DATA_VIEW', severity: 'high', entityType: 'gms_layer', entityId,
      details: { layer: layer.layer_id, fields, features: count },
    })
    return logged ? [] : fields
  }

  // ── Layers and features ─────────────────────────────────────────────
  fastify.get('/gms/layers', { ...view, schema: { tags, summary: 'Editable GMS layers' } }, async (request) => {
    const { rows } = await pg.query(`
      SELECT l.*, (SELECT count(*)::int FROM gis_ops.feature f
                    WHERE f.layer_id = l.layer_id AND f.status = 'published') AS features
        FROM gis_ops.layer l ORDER BY l.grp, l.title`)
    return {
      success: true,
      data: rows.filter((l) => canViewLayer(request.user, l)).map((l) => ({
        ...l, can_edit: canEditLayer(request.user, l),
      })),
    }
  })

  fastify.get('/gms/layers/:id/features', { ...view, schema: { tags, summary: 'Published features as GeoJSON' } }, async (request, reply) => {
    const layer = await getLayer(request.params.id)
    if (!layer || !canViewLayer(request.user, layer)) return reply.code(404).send({ success: false, error: 'not_found' })
    const bbox = String(request.query?.bbox || '').split(',').map(Number)
    const hasBbox = bbox.length === 4 && bbox.every(Number.isFinite)
    const classes = String(request.query?.accuracy || '').split(',').filter((c) => /^[ABCD]$/.test(c))
    const { rows } = await pg.query(
      `SELECT feature_id, attrs, accuracy_class, source, version, updated_at,
              ST_AsGeoJSON(geom, 7)::json AS geometry
         FROM gis_ops.feature
        WHERE layer_id = $1 AND status = 'published'
          AND ($2::float8[] IS NULL OR geom && ST_MakeEnvelope($2[1], $2[2], $2[3], $2[4], 4326))
          AND (cardinality($3::text[]) = 0 OR accuracy_class = ANY($3))
        ORDER BY feature_id LIMIT $4`,
      [layer.layer_id, hasBbox ? bbox : null, classes, MAX_FEATURES + 1],
    )
    const hidden = await personalGate(request, layer, layer.layer_id, rows.length)
    return {
      type: 'FeatureCollection',
      truncated: rows.length > MAX_FEATURES,
      features: rows.slice(0, MAX_FEATURES).map((r) => ({
        type: 'Feature',
        id: Number(r.feature_id),
        geometry: r.geometry,
        properties: {
          ...mask(r.attrs, hidden), feature_id: Number(r.feature_id), version: r.version,
          accuracy_class: r.accuracy_class, source: r.source, updated_at: r.updated_at,
        },
      })),
    }
  })

  fastify.get('/gms/features/:id', { ...view, schema: { tags, summary: 'Feature with its full history' } }, async (request, reply) => {
    const id = Number(request.params.id)
    const { rows: [f] } = await pg.query(
      `SELECT f.*, ST_AsGeoJSON(f.geom, 7)::json AS geometry FROM gis_ops.feature f WHERE f.feature_id = $1`,
      [Number.isInteger(id) ? id : 0])
    const layer = f && await getLayer(f.layer_id)
    if (!f || !canViewLayer(request.user, layer)) return reply.code(404).send({ success: false, error: 'not_found' })
    const { rows: versions } = await pg.query(
      `SELECT v.version, v.action, v.attrs, v.accuracy_class, v.source, v.session_id, v.changed_at, v.note,
              u.email AS changed_by, ST_AsGeoJSON(v.geom, 7)::json AS geometry
         FROM gis_ops.feature_version v LEFT JOIN public.users u ON u.id = v.changed_by
        WHERE v.feature_id = $1 ORDER BY v.version DESC`, [id])
    const hidden = await personalGate(request, layer, id, 1)
    delete f.geom
    return {
      success: true,
      data: {
        ...f, feature_id: Number(f.feature_id), attrs: mask(f.attrs, hidden),
        layer: { layer_id: layer.layer_id, title: layer.title, attributes: layer.attributes, custodian_dept: layer.custodian_dept },
        versions: versions.map((v) => ({ ...v, attrs: mask(v.attrs, hidden) })),
      },
    }
  })

  fastify.post('/gms/features/:id/restore', { ...qa, schema: { tags, summary: 'Restore an earlier version' } }, async (request, reply) => {
    const version = Number(request.body?.version)
    const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : ''
    if (!Number.isInteger(version) || !reason) return reply.code(400).send({ success: false, error: 'version_and_reason_required' })
    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const ok = await restoreVersion(client, Number(request.params.id), version, request.user.id, reason)
      await client.query(ok ? 'COMMIT' : 'ROLLBACK')
      if (!ok) return reply.code(404).send({ success: false, error: 'not_found' })
      return { success: true }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  // ── Edit sessions ───────────────────────────────────────────────────
  async function loadSession(id) {
    if (!UUID.test(id)) return null
    const { rows: [s] } = await pg.query(
      `SELECT s.*, u.email AS user_email, COALESCE(u.full_name, u.name) AS user_name, d.email AS decided_by_email
         FROM gis_ops.edit_session s
         JOIN public.users u ON u.id = s.user_id
         LEFT JOIN public.users d ON d.id = s.decided_by
        WHERE s.session_id = $1`, [id])
    return s || null
  }
  const isOwner = (s, user) => s.user_id === user.id
  const mayRead = (s, user) => isOwner(s, user) || GMS.approveQa.includes(user.role)

  fastify.post('/gms/edit-sessions', { ...editor, schema: { tags, summary: 'Open (or resume) an edit session' } }, async (request, reply) => {
    const layer = await getLayer(String(request.body?.layer_id || ''))
    if (!layer) return reply.code(404).send({ success: false, error: 'not_found' })
    if (!canEditLayer(request.user, layer)) {
      return reply.code(403).send({
        success: false, error: 'not_custodian',
        message: `${layer.title} is kept by ${layer.custodian_dept}. You can edit only layers your department is custodian of.`,
      })
    }
    // ON CONFLICT on the partial unique index = resume the live session.
    const { rows: [s] } = await pg.query(
      `INSERT INTO gis_ops.edit_session (layer_id, user_id) VALUES ($1, $2)
       ON CONFLICT (user_id, layer_id) WHERE status IN ('open', 'returned')
       DO UPDATE SET updated_at = gis_ops.edit_session.updated_at
       RETURNING session_id`, [layer.layer_id, request.user.id])
    return { success: true, data: await loadSession(s.session_id) }
  })

  fastify.get('/gms/edit-sessions', { ...sessionReaders, schema: { tags, summary: 'My sessions, or the QA queue' } }, async (request, reply) => {
    const queue = request.query?.scope === 'queue'
    if (queue && !GMS.approveQa.includes(request.user.role)) return reply.code(403).send({ success: false, error: 'forbidden' })
    const { rows } = await pg.query(
      `SELECT s.session_id, s.layer_id, l.title AS layer_title, l.custodian_dept, s.status, s.title,
              jsonb_array_length(s.edits) AS edit_count, s.submitted_at, s.decided_at, s.decision_note,
              s.created_at, s.updated_at, u.email AS user_email, COALESCE(u.full_name, u.name) AS user_name
         FROM gis_ops.edit_session s
         JOIN gis_ops.layer l ON l.layer_id = s.layer_id
         JOIN public.users u ON u.id = s.user_id
        WHERE ${queue
          ? `s.status = 'submitted'`
          : `s.user_id = $1 AND (s.status IN ('open', 'returned', 'submitted') OR s.decided_at > now() - interval '30 days')`}
        ORDER BY COALESCE(s.submitted_at, s.updated_at) ${queue ? 'ASC' : 'DESC'} LIMIT 200`,
      queue ? [] : [request.user.id])
    return { success: true, data: rows }
  })

  fastify.get('/gms/edit-sessions/:id', { ...sessionReaders, schema: { tags, summary: 'One edit session' } }, async (request, reply) => {
    const s = await loadSession(request.params.id)
    if (!s || !mayRead(s, request.user)) return reply.code(404).send({ success: false, error: 'not_found' })
    return { success: true, data: { ...s, layer: await getLayer(s.layer_id) } }
  })

  fastify.put('/gms/edit-sessions/:id/edits', {
    ...editor, bodyLimit: 10 * 1024 * 1024, schema: { tags, summary: 'Autosave the session edits' },
  }, async (request, reply) => {
    const s = await loadSession(request.params.id)
    if (!s || !isOwner(s, request.user)) return reply.code(404).send({ success: false, error: 'not_found' })
    if (!['open', 'returned'].includes(s.status)) return reply.code(409).send({ success: false, error: 'session_not_editable', status: s.status })
    const edits = request.body?.edits
    if (!Array.isArray(edits)) return reply.code(400).send({ success: false, error: 'edits_not_a_list' })
    const title = typeof request.body?.title === 'string' ? request.body.title.slice(0, 200) : s.title
    const { rows: [r] } = await pg.query(
      `UPDATE gis_ops.edit_session SET edits = $2::jsonb, title = $3, updated_at = now()
        WHERE session_id = $1 RETURNING updated_at`,
      [s.session_id, JSON.stringify(edits), title])
    return { success: true, data: { updated_at: r.updated_at } }
  })

  fastify.post('/gms/edit-sessions/:id/validate', { ...sessionReaders, schema: { tags, summary: 'Check attributes and topology' } }, async (request, reply) => {
    const s = await loadSession(request.params.id)
    if (!s || !mayRead(s, request.user)) return reply.code(404).send({ success: false, error: 'not_found' })
    return { success: true, data: { errors: await validateEdits(pg, await getLayer(s.layer_id), s.edits) } }
  })

  fastify.post('/gms/edit-sessions/:id/submit', { ...editor, schema: { tags, summary: 'Submit to the QA queue' } }, async (request, reply) => {
    const s = await loadSession(request.params.id)
    if (!s || !isOwner(s, request.user)) return reply.code(404).send({ success: false, error: 'not_found' })
    if (!['open', 'returned'].includes(s.status)) return reply.code(409).send({ success: false, error: 'session_not_editable', status: s.status })
    if (!s.edits.length) return reply.code(400).send({ success: false, error: 'nothing_to_submit' })
    const errors = await validateEdits(pg, await getLayer(s.layer_id), s.edits)
    if (errors.length) return reply.code(422).send({ success: false, error: 'topology_or_attribute_errors', errors })
    await pg.query(
      `UPDATE gis_ops.edit_session SET status = 'submitted', submitted_at = now(), updated_at = now()
        WHERE session_id = $1`, [s.session_id])
    return { success: true }
  })

  fastify.post('/gms/edit-sessions/:id/approve', { ...qa, schema: { tags, summary: 'Approve and publish' } }, async (request, reply) => {
    const s = await loadSession(request.params.id)
    if (!s) return reply.code(404).send({ success: false, error: 'not_found' })
    if (s.status !== 'submitted') return reply.code(409).send({ success: false, error: 'not_submitted', status: s.status })
    if (isOwner(s, request.user)) {
      return reply.code(403).send({ success: false, error: 'own_edit', message: 'Edits are approved by someone other than their editor.' })
    }
    const layer = await getLayer(s.layer_id)
    // Published data may have moved since submission: check again.
    const errors = await validateEdits(pg, layer, s.edits)
    if (errors.length) return reply.code(422).send({ success: false, error: 'topology_or_attribute_errors', errors })

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const created = await applyEdits(client, layer, s, request.user.id)
      await client.query(
        `UPDATE gis_ops.edit_session SET status = 'approved', decided_by = $2, decided_at = now(), updated_at = now()
          WHERE session_id = $1`, [s.session_id, request.user.id])
      await client.query('COMMIT')
      return { success: true, data: { created } }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (err instanceof EditConflict) {
        await pg.query(
          `UPDATE gis_ops.edit_session SET status = 'returned', decided_by = $2, decided_at = now(),
                  decision_note = $3, updated_at = now() WHERE session_id = $1`,
          [s.session_id, request.user.id, `Returned automatically: ${err.message}. Reload the feature and redo the change.`])
        return reply.code(409).send({ success: false, error: 'edit_conflict', feature_id: err.featureId })
      }
      throw err
    } finally {
      client.release()
    }
  })

  for (const [action, status] of [['reject', 'rejected'], ['return', 'returned']]) {
    fastify.post(`/gms/edit-sessions/:id/${action}`, { ...qa, schema: { tags, summary: `${action} with a reason` } }, async (request, reply) => {
      const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim().slice(0, 2000) : ''
      if (!reason) return reply.code(400).send({ success: false, error: 'missing_field', field: 'reason' })
      const { rowCount } = await pg.query(
        `UPDATE gis_ops.edit_session SET status = $2, decided_by = $3, decided_at = now(),
                decision_note = $4, updated_at = now()
          WHERE session_id = $1 AND status = 'submitted'`,
        [UUID.test(request.params.id) ? request.params.id : null, status, request.user.id, reason])
      if (!rowCount) return reply.code(409).send({ success: false, error: 'not_submitted' })
      return { success: true }
    })
  }

  fastify.delete('/gms/edit-sessions/:id', { ...editor, schema: { tags, summary: 'Abandon an edit session' } }, async (request, reply) => {
    const s = await loadSession(request.params.id)
    if (!s || !isOwner(s, request.user)) return reply.code(404).send({ success: false, error: 'not_found' })
    if (!['open', 'returned'].includes(s.status)) return reply.code(409).send({ success: false, error: 'session_not_editable' })
    await pg.query(`UPDATE gis_ops.edit_session SET status = 'abandoned', updated_at = now() WHERE session_id = $1`, [s.session_id])
    return { success: true }
  })

  // ── Geometry helpers (results go back into the client's session) ─────
  fastify.post('/gms/geometry/split', { ...editor, schema: { tags, summary: 'Split a polygon or line by a line' } }, async (request, reply) => {
    const { geometry, blade } = request.body || {}
    if (!geometry || !blade) return reply.code(400).send({ success: false, error: 'geometry_and_blade_required' })
    try {
      const { rows } = await pg.query(
        `SELECT ST_AsGeoJSON((ST_Dump(ST_Split(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326),
                                               ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)))).geom, 7)::json AS g`,
        [JSON.stringify(geometry), JSON.stringify(blade)])
      if (rows.length < 2) return reply.code(422).send({ success: false, error: 'blade_does_not_cross' })
      return { success: true, data: rows.map((r) => r.g) }
    } catch {
      return reply.code(422).send({ success: false, error: 'cannot_split' })
    }
  })

  fastify.post('/gms/geometry/merge', { ...editor, schema: { tags, summary: 'Merge adjacent geometries' } }, async (request, reply) => {
    const list = request.body?.geometries
    if (!Array.isArray(list) || list.length < 2) return reply.code(400).send({ success: false, error: 'two_or_more_geometries' })
    try {
      const { rows: [r] } = await pg.query(
        `SELECT ST_AsGeoJSON(u, 7)::json AS g, ST_NumGeometries(u) AS parts FROM (
           SELECT ST_UnaryUnion(ST_Collect(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326))) AS u
             FROM jsonb_array_elements_text($1::jsonb) AS x) q`,
        [JSON.stringify(list.map((g) => JSON.stringify(g)))])
      if (r.parts > 1) return reply.code(422).send({ success: false, error: 'not_adjacent' })
      return { success: true, data: r.g }
    } catch {
      return reply.code(422).send({ success: false, error: 'cannot_merge' })
    }
  })
}

module.exports = { gmsEditingRoutes }
