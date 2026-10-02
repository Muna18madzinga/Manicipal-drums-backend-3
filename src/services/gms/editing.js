// src/services/gms/editing.js
// ─────────────────────────────────────────────────────────────────────────
// Edit sessions: validation (attributes + topology) and applying an approved
// session to the published features, with a version row per change.
//
// An edit is one of
//   { op: 'create', geometry, attrs, accuracy_class, source }
//   { op: 'update', feature_id, base_version, geometry?, attrs?, accuracy_class?, source? }
//   { op: 'delete', feature_id, base_version }
// geometry is GeoJSON in WGS84. base_version is the version the editor
// started from: if someone else's edit was approved in between, approval
// stops with a conflict instead of silently overwriting it.
// ─────────────────────────────────────────────────────────────────────────

const { GMS } = require('./roles')

const GEOM_FAMILY = { Point: 'POINT', LineString: 'LINESTRING', Polygon: 'POLYGON' }
// A road end closer than this to another road, but not on it, is an unsnapped
// node: an undershoot or overshoot rather than a real dead end.
const SNAP_TOLERANCE_M = 1
const TOUCH_TOLERANCE_M = 0.01
const OVERLAP_TOLERANCE_M2 = 0.01
const CLASSES = new Set(['A', 'B', 'C', 'D'])

class EditConflict extends Error {
  constructor(featureId) {
    super(`feature ${featureId} changed since this session started`)
    this.featureId = featureId
  }
}

function canEditLayer(user, layer) {
  if (!layer?.editable || !GMS.editLayers.includes(user.role)) return false
  // Departmental focal points edit only what their department is custodian of.
  if (user.role === 'dept_editor') return !!user.department && user.department === layer.custodian_dept
  return true
}

/** Attribute problems against the layer's schema, as short codes per field. */
function attrErrors(layer, attrs) {
  const out = []
  const schema = layer.attributes || []
  const known = new Set(schema.map((f) => f.name))
  for (const k of Object.keys(attrs || {})) {
    if (!known.has(k)) out.push({ field: k, code: 'unknown_attribute' })
  }
  for (const f of schema) {
    const v = attrs?.[f.name]
    const empty = v === undefined || v === null || v === ''
    if (empty) {
      if (f.required) out.push({ field: f.name, code: 'required' })
      continue
    }
    if (f.type === 'number' && !Number.isFinite(Number(v))) out.push({ field: f.name, code: 'not_a_number' })
    if (f.type === 'date' && Number.isNaN(Date.parse(v))) out.push({ field: f.name, code: 'not_a_date' })
    if (f.type === 'boolean' && typeof v !== 'boolean') out.push({ field: f.name, code: 'not_a_boolean' })
    if (Array.isArray(f.domain) && !f.domain.includes(v)) out.push({ field: f.name, code: 'not_in_domain', allowed: f.domain })
  }
  return out
}

/**
 * Validate a session's edits. Returns a list of problems; empty means it may
 * be submitted. Each problem names the edit (index) and, for topology, carries
 * a WGS84 geometry the map can highlight.
 */
async function validateEdits(pg, layer, edits) {
  const errors = []
  if (!Array.isArray(edits)) return [{ code: 'edits_not_a_list' }]

  const ids = []
  edits.forEach((e, index) => {
    if (!['create', 'update', 'delete'].includes(e?.op)) { errors.push({ index, code: 'bad_op' }); return }
    if (e.op === 'create') {
      if (!e.geometry) errors.push({ index, code: 'missing_geometry' })
      if (!CLASSES.has(e.accuracy_class)) errors.push({ index, code: 'missing_accuracy_class' })
      if (!e.source || !String(e.source).trim()) errors.push({ index, code: 'missing_source' })
      for (const a of attrErrors(layer, e.attrs)) errors.push({ index, code: 'attribute', field: a.field, problem: a.code, allowed: a.allowed })
    } else {
      if (!Number.isInteger(e.feature_id) || !Number.isInteger(e.base_version)) {
        errors.push({ index, code: 'missing_feature_ref' })
        return
      }
      if (e.accuracy_class !== undefined && !CLASSES.has(e.accuracy_class)) errors.push({ index, code: 'missing_accuracy_class' })
      if (ids.includes(e.feature_id)) errors.push({ index, code: 'feature_edited_twice', feature_id: e.feature_id })
      ids.push(e.feature_id)
    }
  })

  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    const current = new Map((await client.query(
      `SELECT feature_id, layer_id, version, attrs, status FROM gis_ops.feature WHERE feature_id = ANY($1::bigint[])`,
      [ids])).rows.map((r) => [Number(r.feature_id), r]))
    edits.forEach((e, index) => {
      if (e?.op !== 'update' && e?.op !== 'delete') return
      const f = current.get(e.feature_id)
      if (!f || f.layer_id !== layer.layer_id || f.status !== 'published') {
        errors.push({ index, code: 'unknown_feature', feature_id: e.feature_id })
      } else if (e.op === 'update' && e.attrs) {
        for (const a of attrErrors(layer, { ...f.attrs, ...e.attrs })) errors.push({ index, code: 'attribute', field: a.field, problem: a.code, allowed: a.allowed })
      }
    })

    // Geometry checks run on everything the session would draw.
    const drawn = edits
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => (e?.op === 'create' || e?.op === 'update') && e.geometry)
    if (drawn.length) {
      await client.query(`
        CREATE TEMP TABLE es_in ON COMMIT DROP AS
        SELECT r.idx, r.fid, ST_SetSRID(ST_GeomFromGeoJSON(r.geometry), 4326) AS g
          FROM jsonb_to_recordset($1::jsonb) AS r(idx int, fid bigint, geometry text)`,
      [JSON.stringify(drawn.map(({ e, index }) => ({
        idx: index, fid: e.op === 'update' ? e.feature_id : null, geometry: JSON.stringify(e.geometry),
      })))])
    } else {
      await client.query('CREATE TEMP TABLE es_in (idx int, fid bigint, g geometry) ON COMMIT DROP')
    }

    const family = GEOM_FAMILY[layer.geom_type]
    for (const r of (await client.query(
      `SELECT idx, GeometryType(g) AS t, ST_IsValid(g) AS ok, ST_IsValidReason(g) AS why FROM es_in`)).rows) {
      if (r.t.replace(/^MULTI/, '') !== family) errors.push({ index: r.idx, code: 'wrong_geometry_type', expected: layer.geom_type })
      else if (!r.ok) errors.push({ index: r.idx, code: 'invalid_geometry', reason: r.why })
    }
    const geometryOk = !errors.some((e) => e.code === 'wrong_geometry_type' || e.code === 'invalid_geometry')
    const touched = ids // features this session updates or deletes: judge them by their new shape
    const rules = layer.rules || {}

    if (geometryOk && rules.point_in_ward && family === 'POINT'
        && (await client.query('SELECT 1 FROM admin.ward LIMIT 1')).rowCount) {
      for (const r of (await client.query(`
        SELECT idx, ST_AsGeoJSON(g, 7)::json AS geometry FROM es_in i
         WHERE NOT EXISTS (SELECT 1 FROM admin.ward w WHERE ST_Intersects(w.geom, i.g))`)).rows) {
        errors.push({ index: r.idx, code: 'outside_ward', geometry: r.geometry })
      }
    }

    if (geometryOk && rules.network && family === 'LINESTRING') {
      // Other lines = published lines of this layer not changed here, plus the
      // session's own new shapes.
      for (const r of (await client.query(`
        WITH others AS (
          SELECT NULL::int AS idx, f.geom AS g FROM gis_ops.feature f
           WHERE f.layer_id = $1 AND f.status = 'published' AND NOT (f.feature_id = ANY($2::bigint[]))
          UNION ALL SELECT idx, g FROM es_in
        ),
        ends AS (
          SELECT i.idx, e.pt FROM es_in i, ST_Dump(i.g) d,
                 LATERAL (VALUES (ST_StartPoint(d.geom)), (ST_EndPoint(d.geom))) AS e(pt)
        )
        SELECT e.idx, ST_AsGeoJSON(e.pt, 7)::json AS geometry FROM ends e
         WHERE EXISTS (SELECT 1 FROM others o WHERE o.idx IS DISTINCT FROM e.idx
                         AND ST_DWithin(o.g::geography, e.pt::geography, $3))
           AND NOT EXISTS (SELECT 1 FROM others o WHERE o.idx IS DISTINCT FROM e.idx
                         AND ST_DWithin(o.g::geography, e.pt::geography, $4))`,
      [layer.layer_id, touched, SNAP_TOLERANCE_M, TOUCH_TOLERANCE_M])).rows) {
        errors.push({ index: r.idx, code: 'not_snapped', geometry: r.geometry })
      }
    }

    if (geometryOk && rules.no_overlap && family === 'POLYGON') {
      for (const r of (await client.query(`
        WITH others AS (
          SELECT NULL::int AS idx, f.feature_id, f.attrs, f.geom AS g FROM gis_ops.feature f
           WHERE f.layer_id = $1 AND f.status = 'published' AND NOT (f.feature_id = ANY($2::bigint[]))
        )
        SELECT a.idx, b.idx AS other_idx, NULL::bigint AS other_feature,
               ST_AsGeoJSON(x, 7)::json AS geometry, ST_Area(x::geography) AS m2
          FROM es_in a JOIN es_in b ON a.idx < b.idx AND ST_Intersects(a.g, b.g)
          CROSS JOIN LATERAL ST_Intersection(a.g, b.g) AS x
         WHERE ST_Area(x::geography) > $3
        UNION ALL
        SELECT a.idx, NULL, o.feature_id, ST_AsGeoJSON(x, 7)::json, ST_Area(x::geography)
          FROM es_in a JOIN others o ON ST_Intersects(a.g, o.g)
          CROSS JOIN LATERAL ST_Intersection(a.g, o.g) AS x
         WHERE ST_Area(x::geography) > $3`,
      [layer.layer_id, touched, OVERLAP_TOLERANCE_M2])).rows) {
        errors.push({
          index: r.idx, code: 'overlap', geometry: r.geometry, overlap_m2: Number(r.m2),
          with_index: r.other_idx, with_feature: r.other_feature == null ? null : Number(r.other_feature),
        })
      }
    }

    await client.query('ROLLBACK')
    return errors
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function writeVersion(client, f, action, sessionId, userId, note = null) {
  await client.query(
    `INSERT INTO gis_ops.feature_version
       (feature_id, version, action, attrs, geom, accuracy_class, source, session_id, changed_by, note)
     SELECT feature_id, version, $2, attrs, geom, accuracy_class, source, $3, $4, $5
       FROM gis_ops.feature WHERE feature_id = $1`,
    [f, action, sessionId, userId, note])
}

/** Apply every edit in order inside the caller's transaction. Throws EditConflict. */
async function applyEdits(client, layer, session, userId) {
  const created = []
  for (const e of session.edits) {
    if (e.op === 'create') {
      const { rows: [f] } = await client.query(
        `INSERT INTO gis_ops.feature (layer_id, attrs, geom, accuracy_class, source, custodian_dept)
         VALUES ($1, $2::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $4, $5, $6)
         RETURNING feature_id`,
        [layer.layer_id, JSON.stringify(e.attrs || {}), JSON.stringify(e.geometry),
          e.accuracy_class, String(e.source).trim(), layer.custodian_dept])
      await writeVersion(client, f.feature_id, 'create', session.session_id, userId)
      created.push(Number(f.feature_id))
      continue
    }
    const { rows: [cur] } = await client.query(
      'SELECT version FROM gis_ops.feature WHERE feature_id = $1 FOR UPDATE', [e.feature_id])
    if (!cur || cur.version !== e.base_version) throw new EditConflict(e.feature_id)
    if (e.op === 'update') {
      await client.query(
        `UPDATE gis_ops.feature
            SET attrs = attrs || $2::jsonb,
                geom = COALESCE(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), geom),
                accuracy_class = COALESCE($4, accuracy_class),
                source = COALESCE($5, source),
                version = version + 1, updated_at = now()
          WHERE feature_id = $1`,
        [e.feature_id, JSON.stringify(e.attrs || {}), e.geometry ? JSON.stringify(e.geometry) : null,
          e.accuracy_class ?? null, e.source ? String(e.source).trim() : null])
      await writeVersion(client, e.feature_id, 'update', session.session_id, userId)
    } else {
      await client.query(
        `UPDATE gis_ops.feature SET status = 'retired', version = version + 1, updated_at = now()
          WHERE feature_id = $1`, [e.feature_id])
      await writeVersion(client, e.feature_id, 'delete', session.session_id, userId)
    }
  }
  return created
}

/** Put an earlier version back as the newest one. History is never rewritten. */
async function restoreVersion(client, featureId, version, userId, note) {
  const { rows: [v] } = await client.query(
    'SELECT * FROM gis_ops.feature_version WHERE feature_id = $1 AND version = $2', [featureId, version])
  if (!v) return false
  await client.query(
    `UPDATE gis_ops.feature
        SET attrs = $2, geom = $3, accuracy_class = $4, source = $5,
            status = CASE WHEN $6::text = 'delete' THEN 'retired' ELSE 'published' END,
            version = version + 1, updated_at = now()
      WHERE feature_id = $1`,
    [featureId, v.attrs, v.geom, v.accuracy_class, v.source, v.action])
  await writeVersion(client, featureId, 'restore', null, userId, note)
  return true
}

module.exports = {
  canEditLayer, attrErrors, validateEdits, applyEdits, restoreVersion, EditConflict,
  SNAP_TOLERANCE_M, OVERLAP_TOLERANCE_M2,
}
