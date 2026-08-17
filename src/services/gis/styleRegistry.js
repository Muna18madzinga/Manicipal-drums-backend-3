// src/services/gis/styleRegistry.js
// ---------------------------------------------------------------------------
// Lifecycle and resolution for the enterprise GIS symbology registry.
//
//   draft ──► review ──► approved ──► published ──► deprecated ──► archived
//
// Every transition is written with its audit row in ONE transaction, so a
// publication can never exist without the record of who authorised it.
//
// The hard guarantees (one published version per layer, published styles
// immutable, audit append-only, unsupported styles unpublishable) are enforced
// by migration 114 in the DATABASE, not here. This module is the well-behaved
// path; the constraints are what make misbehaviour impossible. If a check here
// and a constraint there ever disagree, the constraint wins -- deliberately.
// ---------------------------------------------------------------------------

const { validate, classifyFidelity, checksum, canonicalJson } = require('./styleDoc')
const { compileMaplibre, compileQml, compareFidelity } = require('./compile')

/** Allowed lifecycle transitions. Anything absent is rejected. */
const TRANSITIONS = {
  draft: ['review', 'archived'],
  review: ['approved', 'draft', 'archived'],   // back to draft = changes requested
  approved: ['published', 'review', 'archived'],
  published: ['deprecated', 'archived'],
  deprecated: ['archived', 'published'],       // re-publishing a deprecated version IS the rollback
  archived: [],
}

class StyleRegistryError extends Error {
  constructor(message, code = 'registry_error', statusCode = 400) {
    super(message)
    this.name = 'StyleRegistryError'
    this.code = code
    this.statusCode = statusCode
  }
}

const fail = (msg, code, status) => { throw new StyleRegistryError(msg, code, status) }

// ── Reads ──────────────────────────────────────────────────────────────────

/** The full governed layer catalogue with its published style, if any. */
async function listLayers(db, { includeInactive = false } = {}) {
  const { rows } = await db.query(
    `SELECT l.layer_id, l.display_name, l.description, l.geometry,
            l.data_source, l.data_srid, l.data_synced_at,
            l.qgis_project, l.qgis_layer, l.owner, l.steward,
            l.access_roles, l.min_zoom, l.max_zoom, l.is_active, l.metadata,
            s.style_id, s.style_name, s.style_version, s.source, s.source_path,
            s.renderer_type, s.classification_attribute, s.fidelity,
            s.checksum, s.published_at AS style_published_at,
            s.approved_by, s.published_by,
            (SELECT count(*)::int FROM gis_style v WHERE v.layer_id = l.layer_id) AS version_count,
            (SELECT max(v.style_version) FROM gis_style v WHERE v.layer_id = l.layer_id) AS latest_version
       FROM gis_layer l
       LEFT JOIN gis_style s ON s.layer_id = l.layer_id AND s.status = 'published'
      WHERE ($1 OR l.is_active)
      ORDER BY l.layer_id`,
    [includeInactive],
  )
  return rows
}

/** Every version of a layer, newest first -- the version history for the UI. */
async function listVersions(db, layerId) {
  const { rows } = await db.query(
    // `definition` is included deliberately: the admin console previews each
    // version's real colours and edits them into a new draft, and it cannot do
    // either from metadata alone. Version counts per layer are small (1-2), so
    // the payload cost is negligible next to a silently empty preview.
    `SELECT style_id, style_version, status, source, source_path, style_name,
            renderer_type, classification_attribute, fidelity, fidelity_notes,
            checksum, change_summary, created_by, approved_by, published_by,
            created_at, updated_at, approved_at, published_at, definition,
            jsonb_array_length(COALESCE(definition->'renderer'->'categories', '[]'::jsonb)) AS class_count
       FROM gis_style WHERE layer_id = $1
      ORDER BY style_version DESC`,
    [layerId],
  )
  return rows
}

/** Attaches the compiled renderer config for the requested target. */
function withCompiled(row, target) {
  const doc = row.definition
  const meta = {
    layerId: row.layer_id,
    styleVersion: row.style_version,
    styleId: row.style_id,
    checksum: row.checksum,
    publishedAt: row.published_at || row.style_published_at,
  }

  const base = {
    layerId: row.layer_id,
    displayName: row.display_name,
    geometry: row.geometry,
    styleId: row.style_id,
    styleName: row.style_name,
    styleVersion: row.style_version,
    // The gis_published_style view omits `status` because everything in it is
    // published by definition. Make that explicit rather than sending undefined
    // to a client that has to branch on it.
    status: row.status ?? (row.style_id ? 'published' : null),
    source: row.source,
    sourcePath: row.source_path,
    rendererType: row.renderer_type,
    classificationAttribute: row.classification_attribute,
    fidelity: row.fidelity,
    fidelityNotes: row.fidelity_notes,
    checksum: row.checksum,
    opacity: row.opacity !== undefined && row.opacity !== null ? Number(row.opacity) : 1,
    minZoom: row.min_zoom ?? row.scale_min_zoom ?? null,
    maxZoom: row.max_zoom ?? row.scale_max_zoom ?? null,
    approvedBy: row.approved_by,
    publishedBy: row.published_by,
    // Two independent provenance clocks. A style publication does NOT imply a
    // data change, and a data sync does NOT imply a style change.
    stylePublishedAt: row.published_at || row.style_published_at || null,
    dataSyncedAt: row.data_synced_at || null,
    dataSource: row.data_source,
    qgisProject: row.qgis_project,
    qgisLayer: row.qgis_layer,
    definition: doc,
  }

  if (target === 'qml') return { ...base, qml: compileQml(doc, meta) }
  if (target === 'none') return base
  const compiled = compileMaplibre(doc)
  return {
    ...base,
    maplibre: compiled.layers,
    renderStrategy: compiled.strategy,
    renderNotes: compiled.notes,
  }
}

/** The published style for a layer, compiled for the requested target. */
async function getPublishedStyle(db, layerId, { target = 'maplibre' } = {}) {
  const { rows } = await db.query('SELECT * FROM gis_published_style WHERE layer_id = $1', [layerId])
  const row = rows[0]
  if (!row) fail(`unknown layer "${layerId}"`, 'layer_not_found', 404)
  if (!row.style_id) fail(`layer "${layerId}" has no published style`, 'no_published_style', 404)
  return withCompiled(row, target)
}

/** A specific version, published or not. Used by preview and diff. */
async function getVersion(db, layerId, version, { target = 'maplibre' } = {}) {
  const { rows } = await db.query(
    `SELECT s.*, l.geometry, l.display_name, l.data_source, l.data_synced_at,
            l.qgis_project, l.qgis_layer
       FROM gis_style s JOIN gis_layer l USING (layer_id)
      WHERE s.layer_id = $1 AND s.style_version = $2`,
    [layerId, version],
  )
  const row = rows[0]
  if (!row) fail(`no version v${version} for layer "${layerId}"`, 'version_not_found', 404)
  return withCompiled(row, target)
}

async function getAudit(db, layerId, { limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT audit_id, layer_id, style_id, event, from_status, to_status,
            from_version, to_version, reason, change_summary, source_path,
            checksum, actor, actor_role, detail, created_at
       FROM gis_style_audit WHERE layer_id = $1
      ORDER BY created_at DESC, audit_id DESC LIMIT $2`,
    [layerId, Math.min(Number(limit) || 100, 500)],
  )
  return rows
}

// ── Layer catalogue writes ─────────────────────────────────────────────────

async function upsertLayer(db, layer) {
  const {
    layerId, displayName, description = null, geometry,
    dataSource = null, dataSrid = null, qgisProject = null, qgisLayer = null,
    owner = null, steward = null, accessRoles = null,
    minZoom = null, maxZoom = null, metadata = {},
  } = layer
  if (!layerId) fail('layerId is required', 'invalid_layer')
  if (!geometry) fail('geometry is required', 'invalid_layer')

  const { rows } = await db.query(
    `INSERT INTO gis_layer
       (layer_id, display_name, description, geometry, data_source, data_srid,
        qgis_project, qgis_layer, owner, steward, min_zoom, max_zoom, metadata,
        access_roles)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,
             COALESCE($14::text[], ARRAY['admin','gis_officer','planner']))
     ON CONFLICT (layer_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description  = EXCLUDED.description,
       geometry     = EXCLUDED.geometry,
       data_source  = EXCLUDED.data_source,
       data_srid    = EXCLUDED.data_srid,
       qgis_project = EXCLUDED.qgis_project,
       qgis_layer   = EXCLUDED.qgis_layer,
       owner        = COALESCE(EXCLUDED.owner, gis_layer.owner),
       steward      = COALESCE(EXCLUDED.steward, gis_layer.steward),
       min_zoom     = EXCLUDED.min_zoom,
       max_zoom     = EXCLUDED.max_zoom,
       metadata     = EXCLUDED.metadata,
       access_roles = EXCLUDED.access_roles,
       updated_at   = now()
     RETURNING *`,
    [layerId, displayName || layerId, description, geometry, dataSource, dataSrid,
     qgisProject, qgisLayer, owner, steward, minZoom, maxZoom,
     JSON.stringify(metadata), accessRoles],
  )
  return rows[0]
}

/**
 * Records that a layer's spatial DATA was synchronised. Deliberately a separate
 * call from anything style-related, so the UI can never imply one caused the other.
 */
async function markDataSynced(db, layerId, when = null) {
  const { rows } = await db.query(
    `UPDATE gis_layer SET data_synced_at = COALESCE($2::timestamptz, now()), updated_at = now()
      WHERE layer_id = $1 RETURNING layer_id, data_synced_at`,
    [layerId, when],
  )
  if (!rows[0]) fail(`unknown layer "${layerId}"`, 'layer_not_found', 404)
  return rows[0]
}

// ── Style version writes ───────────────────────────────────────────────────

async function writeAudit(client, entry) {
  const {
    layerId, styleId = null, event, fromStatus = null, toStatus = null,
    fromVersion = null, toVersion = null, reason = null, changeSummary = null,
    sourcePath = null, styleChecksum = null, actor = null, actorRole = null,
    detail = {},
  } = entry
  await client.query(
    `INSERT INTO gis_style_audit
       (layer_id, style_id, event, from_status, to_status, from_version,
        to_version, reason, change_summary, source_path, checksum, actor,
        actor_role, detail)
     VALUES ($1,$2,$3,$4::gis_style_status,$5::gis_style_status,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
    [layerId, styleId, event, fromStatus, toStatus, fromVersion, toVersion,
     reason, changeSummary, sourcePath, styleChecksum, actor, actorRole,
     JSON.stringify(detail)],
  )
}

/**
 * Creates a new DRAFT version from a style document.
 *
 * A new version is the ONLY way to change how a layer draws. There is no
 * update-in-place path, by design and by database constraint.
 *
 * Returns { style, validation, fidelity, unchanged }. When the document is
 * identical to an existing version, no row is written and `unchanged` names it
 * -- re-importing an unchanged QGIS project must not churn versions.
 */
async function createDraft(db, {
  layerId, doc, styleName = null, source = 'qgis', sourcePath = null,
  sourceChecksum = null, changeSummary = null, actor = null, actorRole = null,
  metadata = {},
}) {
  const validation = validate(doc)
  if (!validation.valid) {
    fail(`style document failed validation: ${validation.errors.join('; ')}`, 'invalid_style')
  }
  if (doc.layerId !== layerId) {
    fail(`document layerId "${doc.layerId}" does not match target layer "${layerId}"`, 'layer_mismatch')
  }

  const fidelity = classifyFidelity(doc)
  const sum = checksum(doc)

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const { rows: layerRows } = await client.query(
      'SELECT layer_id, geometry FROM gis_layer WHERE layer_id = $1 FOR UPDATE', [layerId],
    )
    if (!layerRows[0]) fail(`unknown layer "${layerId}" -- register it in gis_layer first`, 'layer_not_found', 404)
    if (layerRows[0].geometry !== doc.geometry) {
      fail(`document geometry "${doc.geometry}" does not match the catalogue geometry "${layerRows[0].geometry}"`, 'geometry_mismatch')
    }

    // Identical content already registered? Return it rather than duplicate it.
    const { rows: same } = await client.query(
      'SELECT * FROM gis_style WHERE layer_id = $1 AND checksum = $2 ORDER BY style_version DESC LIMIT 1',
      [layerId, sum],
    )
    if (same[0]) {
      await client.query('COMMIT')
      return {
        style: same[0],
        validation,
        fidelity,
        unchanged: `identical to v${same[0].style_version} (${same[0].status}); no new version created`,
      }
    }

    const { rows: maxRows } = await client.query(
      'SELECT COALESCE(max(style_version), 0) AS v FROM gis_style WHERE layer_id = $1', [layerId],
    )
    const version = Number(maxRows[0].v) + 1

    const { rows } = await client.query(
      `INSERT INTO gis_style
         (layer_id, style_name, style_version, status, source, source_path,
          source_checksum, definition, renderer_type, classification_attribute,
          classification_method, scale_min_zoom, scale_max_zoom, opacity,
          fidelity, fidelity_notes, checksum, metadata, change_summary, created_by)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18,$19)
       RETURNING *`,
      [layerId, styleName || `${layerId} v${version}`, version, source, sourcePath,
       sourceChecksum, JSON.stringify(doc), doc.renderer.type,
       doc.renderer.attribute || null, doc.renderer.method || null,
       doc.scale?.minZoom ?? null, doc.scale?.maxZoom ?? null, doc.opacity,
       fidelity.level, JSON.stringify(fidelity.notes), sum,
       JSON.stringify(metadata), changeSummary, actor],
    )

    await writeAudit(client, {
      layerId, styleId: rows[0].style_id, event: 'created',
      toStatus: 'draft', toVersion: version, changeSummary,
      sourcePath, styleChecksum: sum, actor, actorRole,
      detail: {
        fidelity: fidelity.level,
        validationWarnings: validation.warnings,
        rendererType: doc.renderer.type,
        classCount: doc.renderer.categories?.length ?? doc.renderer.ranges?.length ?? 1,
      },
    })

    await client.query('COMMIT')
    return { style: rows[0], validation, fidelity, unchanged: null }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Moves a version through the lifecycle.
 *
 * `publish` is the only transition with a side effect beyond its own row: the
 * currently-published version is deprecated first, in the SAME transaction, so
 * there is never an instant with two published styles or none.
 */
async function transition(db, {
  layerId, version, to, actor = null, actorRole = null, reason = null,
}) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query(
      'SELECT * FROM gis_style WHERE layer_id = $1 AND style_version = $2 FOR UPDATE',
      [layerId, version],
    )
    const style = rows[0]
    if (!style) fail(`no version v${version} for layer "${layerId}"`, 'version_not_found', 404)

    const allowed = TRANSITIONS[style.status] || []
    if (!allowed.includes(to)) {
      fail(
        `cannot move v${version} from "${style.status}" to "${to}"` +
        (allowed.length ? ` (allowed: ${allowed.join(', ')})` : ' (terminal state)'),
        'invalid_transition',
      )
    }

    // Re-validate at the gate. A document valid when drafted must still be
    // valid now -- the schema may have tightened in between.
    if (to === 'approved' || to === 'published') {
      const v = validate(style.definition)
      if (!v.valid) fail(`v${version} fails validation and cannot be ${to}: ${v.errors.join('; ')}`, 'invalid_style')
      if (style.fidelity === 'unsupported') {
        fail(`v${version} has fidelity "unsupported" and cannot reach production; the QGIS symbology needs a different rendering strategy first`, 'unsupported_fidelity')
      }
    }

    let displaced = null
    if (to === 'published') {
      if (!style.approved_by) {
        fail(`v${version} has no recorded approver; it must be approved before publication`, 'not_approved')
      }
      const { rows: live } = await client.query(
        `SELECT style_id, style_version FROM gis_style
          WHERE layer_id = $1 AND status = 'published' FOR UPDATE`, [layerId],
      )
      if (live[0]) {
        if (live[0].style_version === version) {
          fail(`v${version} is already the published style`, 'already_published')
        }
        await client.query("UPDATE gis_style SET status = 'deprecated' WHERE style_id = $1", [live[0].style_id])
        displaced = live[0].style_version
        await writeAudit(client, {
          layerId, styleId: live[0].style_id, event: 'deprecated',
          fromStatus: 'published', toStatus: 'deprecated',
          fromVersion: live[0].style_version, toVersion: version,
          reason: `displaced by v${version}`, actor, actorRole,
        })
      }
    }

    const sets = ['status = $3::gis_style_status']
    const params = [layerId, version, to]
    if (to === 'approved') {
      sets.push('approved_by = $4', 'approved_at = now()')
      params.push(actor)
    } else if (to === 'published') {
      // approved_by is preserved; publication records its own actor.
      sets.push('published_by = $4', 'published_at = now()')
      params.push(actor)
    }

    const { rows: updated } = await client.query(
      `UPDATE gis_style SET ${sets.join(', ')}
        WHERE layer_id = $1 AND style_version = $2 RETURNING *`,
      params,
    )

    const EVENT = { published: 'published', approved: 'approved', review: 'submitted' }
    await writeAudit(client, {
      layerId, styleId: style.style_id,
      event: EVENT[to] || to,
      fromStatus: style.status, toStatus: to,
      fromVersion: displaced, toVersion: version,
      reason, changeSummary: style.change_summary,
      sourcePath: style.source_path, styleChecksum: style.checksum,
      actor, actorRole,
      detail: displaced ? { displacedVersion: displaced } : {},
    })

    await client.query('COMMIT')
    return { style: updated[0], displaced }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Rolls production back to an earlier version.
 *
 * Implemented as a forward publication of the older version, never as a
 * mutation: v5 is deprecated and v4 re-published, so the audit log reads as a
 * sequence of publications and history stays linear. Spatial data is untouched
 * -- a rollback re-draws, it never re-writes geometry.
 */
async function rollback(db, { layerId, toVersion, actor = null, actorRole = null, reason = null }) {
  const { rows } = await db.query(
    'SELECT style_version, status, approved_by FROM gis_style WHERE layer_id = $1 AND style_version = $2',
    [layerId, toVersion],
  )
  const target = rows[0]
  if (!target) fail(`no version v${toVersion} for layer "${layerId}"`, 'version_not_found', 404)
  if (target.status === 'published') fail(`v${toVersion} is already published`, 'already_published')
  if (!['deprecated', 'approved'].includes(target.status)) {
    fail(`v${toVersion} is "${target.status}"; only a previously-published (deprecated) or approved version can be rolled back to`, 'not_rollbackable')
  }
  if (!target.approved_by) {
    fail(`v${toVersion} has no recorded approver and cannot be published`, 'not_approved')
  }

  const result = await transition(db, {
    layerId, version: toVersion, to: 'published', actor, actorRole,
    reason: reason || `rollback to v${toVersion}`,
  })

  // Record the event as a rollback specifically, so the audit trail
  // distinguishes "moved forward" from "reverted".
  const client = await db.connect()
  try {
    await writeAudit(client, {
      layerId, styleId: result.style.style_id, event: 'rolled_back',
      fromStatus: 'published', toStatus: 'published',
      fromVersion: result.displaced, toVersion,
      reason: reason || `rollback to v${toVersion}`, actor, actorRole,
      detail: { rolledBackFrom: result.displaced, rolledBackTo: toVersion },
    })
  } finally {
    client.release()
  }
  return result
}

// ── Diff + fidelity reporting ──────────────────────────────────────────────

/**
 * Compares two versions property by property, for pre-publication review.
 * Reports what a GIS officer needs in order to decide: which classes changed
 * colour, which were added or removed, whether the renderer itself changed.
 */
async function diffVersions(db, layerId, fromVersion, toVersion) {
  const [a, b] = await Promise.all([
    getVersion(db, layerId, fromVersion, { target: 'none' }),
    getVersion(db, layerId, toVersion, { target: 'none' }),
  ])
  const da = a.definition
  const dbb = b.definition

  const changes = []
  const note = (kind, property, from, to) => changes.push({ kind, property, from, to })

  if (da.renderer.type !== dbb.renderer.type) note('renderer', 'renderer.type', da.renderer.type, dbb.renderer.type)
  if (da.renderer.attribute !== dbb.renderer.attribute) note('classification', 'renderer.attribute', da.renderer.attribute ?? null, dbb.renderer.attribute ?? null)
  if (Number(da.opacity) !== Number(dbb.opacity)) note('opacity', 'opacity', da.opacity, dbb.opacity)
  if ((da.scale?.minZoom ?? null) !== (dbb.scale?.minZoom ?? null)) note('scale', 'scale.minZoom', da.scale?.minZoom ?? null, dbb.scale?.minZoom ?? null)
  if ((da.scale?.maxZoom ?? null) !== (dbb.scale?.maxZoom ?? null)) note('scale', 'scale.maxZoom', da.scale?.maxZoom ?? null, dbb.scale?.maxZoom ?? null)
  if (canonicalJson(da.labels ?? null) !== canonicalJson(dbb.labels ?? null)) {
    note('labels', 'labels', da.labels ?? null, dbb.labels ?? null)
  }

  // Category-level colour diff -- the change a planner actually sees on paper.
  const catMap = (d) => new Map((d.renderer.categories || []).map((c) => [String(c.value), c]))
  const ca = catMap(da)
  const cb = catMap(dbb)
  for (const [value, cat] of cb) {
    const prev = ca.get(value)
    if (!prev) { note('class_added', value, null, cat.symbol.fill ?? cat.symbol.stroke); continue }
    const pf = prev.symbol.fill ?? prev.symbol.stroke
    const nf = cat.symbol.fill ?? cat.symbol.stroke
    if (pf !== nf) note('colour', value, pf, nf)
    if (Number(prev.symbol.strokeWidth) !== Number(cat.symbol.strokeWidth)) {
      note('stroke_width', value, prev.symbol.strokeWidth, cat.symbol.strokeWidth)
    }
    if (prev.symbol.fillStyle !== cat.symbol.fillStyle) {
      note('fill_style', value, prev.symbol.fillStyle, cat.symbol.fillStyle)
    }
  }
  for (const [value, cat] of ca) {
    if (!cb.has(value)) note('class_removed', value, cat.symbol.fill ?? cat.symbol.stroke, null)
  }

  if (da.renderer.type === 'single' && dbb.renderer.type === 'single') {
    const sa = da.renderer.symbol
    const sb = dbb.renderer.symbol
    if ((sa.fill ?? sa.stroke) !== (sb.fill ?? sb.stroke)) {
      note('colour', 'renderer.symbol', sa.fill ?? sa.stroke, sb.fill ?? sb.stroke)
    }
    if (Number(sa.strokeWidth) !== Number(sb.strokeWidth)) {
      note('stroke_width', 'renderer.symbol', sa.strokeWidth, sb.strokeWidth)
    }
  }

  return {
    layerId,
    from: { version: a.styleVersion, status: a.status, checksum: a.checksum, fidelity: a.fidelity },
    to: { version: b.styleVersion, status: b.status, checksum: b.checksum, fidelity: b.fidelity },
    identical: a.checksum === b.checksum,
    changes,
    validation: validate(dbb),
  }
}

/**
 * The style fidelity report: for every layer with a published style, what QGIS
 * will draw versus what the web will draw, and whether they match.
 */
async function fidelityReport(db) {
  const { rows } = await db.query(
    `SELECT layer_id, display_name, style_version, definition, fidelity,
            renderer_type, checksum, source, source_path
       FROM gis_published_style WHERE style_id IS NOT NULL ORDER BY layer_id`,
  )
  const layers = rows.map((row) => {
    const cmp = compareFidelity(row.definition)
    return {
      layerId: row.layer_id,
      displayName: row.display_name,
      styleVersion: row.style_version,
      rendererType: row.renderer_type,
      source: row.source,
      sourcePath: row.source_path,
      checksum: row.checksum,
      fidelity: row.fidelity,
      strategy: cmp.strategy,
      status: cmp.match ? 'MATCH' : 'MISMATCH',
      failed: cmp.checks.filter((c) => !c.match),
      checkCount: cmp.checks.length,
      checks: cmp.checks,
    }
  })

  const { rows: unstyled } = await db.query(
    "SELECT layer_id, display_name FROM gis_published_style WHERE style_id IS NULL ORDER BY layer_id",
  )

  return {
    generatedAt: new Date().toISOString(),
    total: layers.length,
    matched: layers.filter((l) => l.status === 'MATCH').length,
    mismatched: layers.filter((l) => l.status === 'MISMATCH').length,
    byStrategy: layers.reduce((acc, l) => { acc[l.strategy] = (acc[l.strategy] || 0) + 1; return acc }, {}),
    byFidelity: layers.reduce((acc, l) => { acc[l.fidelity] = (acc[l.fidelity] || 0) + 1; return acc }, {}),
    unstyledLayers: unstyled,
    layers,
  }
}

module.exports = {
  TRANSITIONS,
  StyleRegistryError,
  listLayers,
  listVersions,
  getPublishedStyle,
  getVersion,
  getAudit,
  upsertLayer,
  markDataSynced,
  createDraft,
  transition,
  rollback,
  diffVersions,
  fidelityReport,
  writeAudit,
  withCompiled,
}
