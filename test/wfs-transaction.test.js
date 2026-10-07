jest.mock('../src/middleware/jwtAuth', () => ({ requireRole: () => async () => {} }))
jest.mock('../src/utils/publicLayers', () => ({ publicLayerTables: async () => ['wards'] }))

const { createWFSTransactionRoutes } = require('../src/routes/wfsTransaction')

function buildHarness(columns, geometry = { type: 'POINT', srid: 4326 }) {
  const executed = []
  const client = {
    query: jest.fn(async (sql, params) => {
      executed.push({ sql, params })
      return { rowCount: 1, rows: [] }
    }),
    release: jest.fn(),
  }
  const pg = {
    query: jest.fn(async (sql) => {
      if (sql.includes('information_schema.tables')) return { rows: [{ table_name: 'qgis_wards' }] }
      if (sql.includes('information_schema.columns')) return { rows: columns }
      if (sql.includes('geometry_columns')) return { rows: [geometry] }
      return { rows: [] }
    }),
    connect: jest.fn(async () => client),
  }
  let handler
  const server = { pg, post: (_path, _opts, fn) => { handler = fn } }
  return { server, executed, client, run: async (body) => {
    const reply = { code: 200, body: null, status(c) { this.code = c; return this }, send(b) { this.body = b; return this } }
    await handler({ body, log: { error() {} } }, reply)
    return reply
  } }
}

const cols = (...names) => [
  ...names.map((column_name) => ({
    column_name,
    udt_name: column_name === 'id' || column_name === 'fid' ? 'int4' : 'text',
    is_nullable: 'NO',
    column_default: "nextval('seq'::regclass)",
  })),
  { column_name: 'geom', udt_name: 'geometry', is_nullable: 'YES', column_default: null },
]
const point = { type: 'Point', coordinates: [30, -19] }

async function setup(columns, geometry) {
  const h = buildHarness(columns, geometry)
  await createWFSTransactionRoutes(h.server)
  return h
}

describe('WFS-T transaction', () => {
  test('property keys that are not table columns never reach SQL', async () => {
    const h = await setup(cols('id', 'name'))
    const evil = 'x" = 1; DROP TABLE qgis_wards; --'
    const res = await h.run({
      typeName: 'qgis_wards',
      insert: [{ geometry: point, properties: { name: 'ok', [evil]: 'boom', geometry: {} } }],
    })
    expect(res.code).toBe(200)
    const sql = h.executed.map((e) => e.sql).join('\n')
    expect(sql).not.toMatch(/DROP TABLE/)
    expect(h.executed.find((e) => e.sql.startsWith('INSERT')).sql)
      .toBe('INSERT INTO "qgis_wards" ("name", "geom") VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))')
  })

  test('delete uses the one key column the table has', async () => {
    const h = await setup(cols('fid', 'name'))
    const res = await h.run({ typeName: 'qgis_wards', delete: [{ id: 7 }] })
    expect(res.body.data.deleted).toBe(1)
    const del = h.executed.find((e) => e.sql.startsWith('DELETE'))
    expect(del.sql).toBe('DELETE FROM "qgis_wards" WHERE "fid" = $1')
    expect(del.params).toEqual([7])
  })

  test('update uses the detected key column, not a hardcoded id', async () => {
    const h = await setup(cols('gid', 'name'))
    await h.run({ typeName: 'qgis_wards', update: [{ id: 3, geometry: point, properties: { name: 'n' } }] })
    expect(h.executed.find((e) => e.sql.startsWith('UPDATE')).sql)
      .toMatch(/WHERE "gid" = \$3$/)
  })

  test('update/delete on a table without id, fid or gid is a 400 and rolls back', async () => {
    const h = await setup(cols('name'))
    const res = await h.run({ typeName: 'qgis_wards', delete: [{ id: 1 }] })
    expect(res.code).toBe(400)
    expect(h.executed.map((e) => e.sql)).toContain('ROLLBACK')
    expect(h.executed.map((e) => e.sql)).not.toContain('COMMIT')
  })

  test('non-numeric id for an integer key is a 400, not a database error', async () => {
    const h = await setup(cols('id'))
    const res = await h.run({ typeName: 'qgis_wards', delete: [{ id: '1 OR 1=1' }] })
    expect(res.code).toBe(400)
  })

  test('non-array operations are rejected', async () => {
    const h = await setup(cols('id'))
    const res = await h.run({ typeName: 'qgis_wards', delete: { id: 1 } })
    expect(res.code).toBe(400)
  })

  test('single geometries are promoted with ST_Multi for MULTI* columns', async () => {
    const h = await setup(cols('id', 'name'), { type: 'MULTILINESTRING', srid: 4326 })
    await h.run({ typeName: 'qgis_wards', insert: [{ geometry: { type: 'LineString', coordinates: [[30, -19], [31, -19]] }, properties: {} }] })
    expect(h.executed.find((e) => e.sql.startsWith('INSERT')).sql)
      .toContain('ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))')
  })

  test('geometries are transformed to the column SRID when it is not 4326', async () => {
    const h = await setup(cols('id'), { type: 'POINT', srid: 32735 })
    await h.run({ typeName: 'qgis_wards', insert: [{ geometry: point, properties: {} }] })
    expect(h.executed.find((e) => e.sql.startsWith('INSERT')).sql)
      .toContain('ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 32735)')
  })

  test('inserting into a layer whose key has no default is a clear 400 before any write', async () => {
    const columns = cols('id', 'name')
    columns[0].column_default = null
    const h = await setup(columns)
    const res = await h.run({ typeName: 'qgis_wards', insert: [{ geometry: point, properties: { name: 'x' } }] })
    expect(res.code).toBe(400)
    expect(res.body.error).toMatch(/no default value/)
    expect(h.executed).toEqual([])
  })
})
