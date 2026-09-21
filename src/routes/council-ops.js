/**
 * Council operations asset registers — Roads, WASH, livestock, council assets.
 * Tables: council_ops.* (migration 123). Empty until authoritative import.
 * Never invents geometries.
 */
const { requireRole } = require('../middleware/jwtAuth')

const READ_ROLES = [
  'admin', 'gis_officer', 'planner', 'planning_clerk', 'eo', 'env_officer',
  'building_inspector', 'surveyor',
]
const WRITE_ROLES = ['admin', 'gis_officer', 'planner']

const isUuid = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)

const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max

function parsePoint(lng, lat) {
  const x = Number(lng)
  const y = Number(lat)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < -180 || x > 180 || y < -90 || y > 90) return null
  if (x === 0 && y === 0) return null
  return { lng: x, lat: y }
}

function geojsonPoint(geom) {
  if (!geom) return null
  try {
    const g = typeof geom === 'string' ? JSON.parse(geom) : geom
    if (g?.type === 'Point' && Array.isArray(g.coordinates)) {
      return { lng: g.coordinates[0], lat: g.coordinates[1] }
    }
  } catch { /* ignore */ }
  return null
}

async function councilOpsRoutes(fastify) {
  const pg = fastify.pg

  // ── Master Plan theme catalogue (also under /planning; mirrored for GIS) ──
  fastify.get('/ops/master-themes', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (_request, reply) => {
    const { getMasterThemeCatalogue } = require('../config/vunguMasterThemes')
    return reply.send({ success: true, data: getMasterThemeCatalogue() })
  })

  // ── Ward spatial profile PDF ─────────────────────────────────────────
  fastify.post('/ops/ward-profile-report', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const ward = String(request.body?.ward || '').trim()
    if (!ward || ward.length > 120) {
      return reply.code(400).send({ success: false, error: 'bad_ward' })
    }
    const { fetchWardFacts, buildWardProfilePdf } = require('../services/wardProfilePdf')
    const facts = await fetchWardFacts(pg, ward)
    const pdf = await buildWardProfilePdf(facts, request.user?.name || request.user?.email)
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="VRDC-Ward-Profile-${ward.replace(/\s+/g, '_')}.pdf"`)
      .send(pdf)
  })

  // ── s74 evidence certificate PDF ─────────────────────────────────────
  fastify.post('/ops/evidence-certificate', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}
    const { buildEvidenceCertificatePdf } = require('../services/evidenceCertificatePdf')
    const pdf = await buildEvidenceCertificatePdf({
      subject: b.subject,
      targetId: b.targetId,
      particulars: b.particulars || {},
      officer: request.user?.name || request.user?.email,
    })
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'attachment; filename="VRDC-s74-Evidence.pdf"')
      .send(pdf)
  })

  // ── One-click Council Map schedule PDF ───────────────────────────────
  fastify.post('/ops/council-map-report', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const { buildCouncilMapPdf } = require('../services/councilMapPdf')
    const pdf = await buildCouncilMapPdf({
      subject: request.body?.subject || 'All Vungu — theme schedule',
      officer: request.user?.name || request.user?.email,
    })
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'attachment; filename="VRDC-Council-Map-Schedule.pdf"')
      .send(pdf)
  })

  // ── Roads ────────────────────────────────────────────────────────────
  fastify.get('/ops/roads', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const search = isStr(q.search, 120) ? q.search.trim() : null
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500)
    const { rows } = await pg.query(
      `SELECT id, asset_code, name, hierarchy, authority, surface, condition,
              length_m, ward, status, data_quality, source, responsible_dept,
              ST_AsGeoJSON(geom)::json AS geometry,
              created_at, updated_at
         FROM council_ops.road_asset
        WHERE ($1::text IS NULL
               OR name ILIKE '%'||$1||'%'
               OR asset_code ILIKE '%'||$1||'%'
               OR ward ILIKE '%'||$1||'%')
        ORDER BY updated_at DESC
        LIMIT $2`,
      [search, limit],
    )
    return reply.send({
      success: true,
      data: rows,
      meta: {
        count: rows.length,
        note: rows.length
          ? null
          : 'No road assets loaded. Import authoritative Roads & Works data — OSM roads on the map are reference only.',
      },
    })
  })

  fastify.post('/ops/roads', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.name, 255) && !isStr(b.asset_code, 64)) {
      return reply.code(400).send({ success: false, error: 'missing_field', message: 'name or asset_code required' })
    }
    const geomJson = b.geometry ? JSON.stringify(b.geometry) : null
    try {
      const { rows } = await pg.query(
        `INSERT INTO council_ops.road_asset
           (asset_code, name, hierarchy, authority, surface, condition, length_m, ward,
            status, data_quality, source, responsible_dept, geom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
           CASE WHEN $13::text IS NULL THEN NULL
                ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($13), 4326)) END)
         RETURNING id, asset_code, name, status, data_quality`,
        [
          b.asset_code || null, b.name || null, b.hierarchy || null, b.authority || null,
          b.surface || null, b.condition || null, b.length_m ?? null, b.ward || null,
          b.status || 'active', b.data_quality || 'unverified', b.source || 'manual_entry',
          b.responsible_dept || 'Roads & Works', geomJson,
        ],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create road asset failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── WASH ─────────────────────────────────────────────────────────────
  fastify.get('/ops/wash', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const type = isStr(q.type, 40) ? q.type.trim() : null
    const search = isStr(q.search, 120) ? q.search.trim() : null
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500)
    const { rows } = await pg.query(
      `SELECT id, asset_code, asset_type, name, ward, capacity, operational,
              responsible_party, data_quality, source, responsible_dept,
              ST_X(geom) AS lng, ST_Y(geom) AS lat,
              created_at, updated_at
         FROM council_ops.wash_asset
        WHERE ($1::text IS NULL OR asset_type = $1)
          AND ($2::text IS NULL
               OR name ILIKE '%'||$2||'%'
               OR asset_code ILIKE '%'||$2||'%'
               OR ward ILIKE '%'||$2||'%')
        ORDER BY updated_at DESC
        LIMIT $3`,
      [type, search, limit],
    )
    return reply.send({
      success: true,
      data: rows,
      meta: {
        count: rows.length,
        note: rows.length
          ? null
          : 'No WASH assets loaded. Import the DSSWC inventory — do not invent boreholes.',
      },
    })
  })

  fastify.post('/ops/wash', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}
    const TYPES = [
      'borehole', 'well', 'water_point', 'tank', 'reservoir', 'pipeline',
      'scheme', 'treatment', 'pump', 'toilet', 'septic', 'waste_site', 'other',
    ]
    if (!TYPES.includes(b.asset_type)) {
      return reply.code(400).send({ success: false, error: 'bad_type' })
    }
    const pos = parsePoint(b.lng, b.lat)
    if (!pos && !b.geometry) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'location' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO council_ops.wash_asset
           (asset_code, asset_type, name, ward, capacity, operational,
            responsible_party, data_quality, source, responsible_dept, geom)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           CASE
             WHEN $11::float8 IS NOT NULL THEN ST_SetSRID(ST_MakePoint($11,$12), 4326)
             WHEN $13::text IS NOT NULL THEN ST_SetSRID(ST_GeomFromGeoJSON($13), 4326)
             ELSE NULL END)
         RETURNING id, asset_code, asset_type, name, operational, data_quality`,
        [
          b.asset_code || null, b.asset_type, b.name || null, b.ward || null,
          b.capacity || null, b.operational || 'unknown', b.responsible_party || null,
          b.data_quality || 'unverified', b.source || 'manual_entry',
          b.responsible_dept || 'DSSWC',
          pos ? pos.lng : null, pos ? pos.lat : null,
          b.geometry ? JSON.stringify(b.geometry) : null,
        ],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create wash asset failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Livestock ────────────────────────────────────────────────────────
  fastify.get('/ops/livestock', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const search = typeof q.search === 'string' && q.search.trim() ? q.search.trim() : null
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 500)
    const params = []
    let where = ''
    if (search) {
      params.push(`%${search}%`)
      where = `WHERE (name ILIKE $1 OR facility_type ILIKE $1 OR ward ILIKE $1)`
    }
    params.push(limit)
    const { rows } = await pg.query(
      `SELECT id, facility_type, name, ward, data_quality, source,
              ST_X(geom) AS lng, ST_Y(geom) AS lat, created_at, updated_at
         FROM council_ops.livestock_facility
         ${where}
        ORDER BY updated_at DESC LIMIT $${params.length}`,
      params,
    )
    return reply.send({
      success: true,
      data: rows,
      meta: {
        count: rows.length,
        note: rows.length ? null : 'No dip tanks / stock pens loaded yet.',
      },
    })
  })

  // ── Council assets ───────────────────────────────────────────────────
  fastify.get('/ops/assets', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const { rows } = await pg.query(
      `SELECT id, asset_code, name, asset_class, department, condition, ward,
              data_quality, source,
              ST_AsGeoJSON(geom)::json AS geometry,
              created_at, updated_at
         FROM council_ops.council_asset
        ORDER BY updated_at DESC LIMIT 500`,
    )
    return reply.send({
      success: true,
      data: rows,
      meta: {
        count: rows.length,
        note: rows.length ? null : 'No council asset register loaded yet.',
      },
    })
  })

  // ── GeoJSON FeatureCollection import (validated, no silent overwrite) ─
  fastify.post('/ops/import/:register', {
    preHandler: requireRole(fastify, ['admin', 'gis_officer']),
  }, async (request, reply) => {
    const register = String(request.params.register || '')
    const ALLOWED = {
      wash: { table: 'council_ops.wash_asset', kind: 'point' },
      livestock: { table: 'council_ops.livestock_facility', kind: 'point' },
      assets: { table: 'council_ops.council_asset', kind: 'geom' },
      roads: { table: 'council_ops.road_asset', kind: 'line' },
    }
    const target = ALLOWED[register]
    if (!target) {
      return reply.code(400).send({ success: false, error: 'bad_register', message: `Use one of: ${Object.keys(ALLOWED).join(', ')}` })
    }
    const fc = request.body
    if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
      return reply.code(400).send({ success: false, error: 'bad_geojson', message: 'Body must be a GeoJSON FeatureCollection' })
    }
    if (fc.features.length > 2000) {
      return reply.code(400).send({ success: false, error: 'too_many', message: 'Max 2000 features per import' })
    }

    const dryRun = request.query?.dry_run === 'true' || request.body?.dry_run === true
    let inserted = 0
    const errors = []

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      for (let i = 0; i < fc.features.length; i++) {
        const f = fc.features[i]
        const props = f.properties || {}
        const geom = f.geometry
        if (!geom) {
          errors.push({ index: i, error: 'missing_geometry' })
          continue
        }
        try {
          if (register === 'wash') {
            const assetType = props.asset_type || props.type || 'other'
            await client.query(
              `INSERT INTO council_ops.wash_asset
                 (asset_code, asset_type, name, ward, capacity, operational, data_quality, source, geom)
               VALUES ($1,$2,$3,$4,$5,$6,'unverified',$7, ST_SetSRID(ST_GeomFromGeoJSON($8), 4326))`,
              [
                props.asset_code || props.code || null,
                assetType,
                props.name || null,
                props.ward || null,
                props.capacity || null,
                props.operational || 'unknown',
                props.source || 'geojson_import',
                JSON.stringify(geom),
              ],
            )
          } else if (register === 'livestock') {
            await client.query(
              `INSERT INTO council_ops.livestock_facility
                 (facility_type, name, ward, data_quality, source, geom)
               VALUES ($1,$2,$3,'unverified',$4, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326))`,
              [
                props.facility_type || props.type || 'other',
                props.name || null,
                props.ward || null,
                props.source || 'geojson_import',
                JSON.stringify(geom),
              ],
            )
          } else if (register === 'assets') {
            await client.query(
              `INSERT INTO council_ops.council_asset
                 (asset_code, name, asset_class, department, ward, data_quality, source, geom)
               VALUES ($1,$2,$3,$4,$5,'unverified',$6, ST_SetSRID(ST_GeomFromGeoJSON($7), 4326))`,
              [
                props.asset_code || props.code || null,
                props.name || `Asset ${i + 1}`,
                props.asset_class || props.class || 'other',
                props.department || null,
                props.ward || null,
                props.source || 'geojson_import',
                JSON.stringify(geom),
              ],
            )
          } else if (register === 'roads') {
            await client.query(
              `INSERT INTO council_ops.road_asset
                 (asset_code, name, hierarchy, surface, ward, data_quality, source, geom)
               VALUES ($1,$2,$3,$4,$5,'unverified',$6,
                 ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($7), 4326)))`,
              [
                props.asset_code || props.ref || null,
                props.name || null,
                props.hierarchy || props.fclass || null,
                props.surface || null,
                props.ward || null,
                props.source || 'geojson_import',
                JSON.stringify(geom),
              ],
            )
          }
          inserted += 1
        } catch (err) {
          errors.push({ index: i, error: err.message || 'insert_failed' })
        }
      }
      if (dryRun || errors.length > fc.features.length / 2) {
        await client.query('ROLLBACK')
        return reply.send({
          success: true,
          data: { dry_run: true, would_insert: inserted, errors },
          message: dryRun ? 'Dry run — nothing written' : 'Too many errors — rolled back',
        })
      }
      await client.query('COMMIT')
      return reply.code(201).send({
        success: true,
        data: { inserted, errors, register },
      })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      request.log.error({ err }, 'ops import failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    } finally {
      client.release()
    }
  })

  // ── Summary dashboard ────────────────────────────────────────────────
  fastify.get('/ops/summary', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (_request, reply) => {
    const [roads, wash, livestock, assets] = await Promise.all([
      pg.query('SELECT COUNT(*)::int AS n FROM council_ops.road_asset'),
      pg.query('SELECT COUNT(*)::int AS n FROM council_ops.wash_asset'),
      pg.query('SELECT COUNT(*)::int AS n FROM council_ops.livestock_facility'),
      pg.query('SELECT COUNT(*)::int AS n FROM council_ops.council_asset'),
    ])
    return reply.send({
      success: true,
      data: {
        roads: roads.rows[0].n,
        wash: wash.rows[0].n,
        livestock: livestock.rows[0].n,
        assets: assets.rows[0].n,
      },
    })
  })
}

module.exports = { councilOpsRoutes }
