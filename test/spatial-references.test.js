const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { findReferences } = require('../src/services/spatialReferences')

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-'))
  const root = path.join(base, 'app-backend')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'))
  fs.mkdirSync(path.join(root, 'node_modules'))
  fs.mkdirSync(path.join(root, 'backups'))
  fs.writeFileSync(path.join(root, 'src', 'routes.js'), "const t = 'old_zones'\n")
  fs.writeFileSync(path.join(root, 'docs', 'notes.md'), 'The old_zones table was retired.\n')
  fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), "'old_zones'")
  fs.writeFileSync(path.join(root, 'backups', 'dump.sql'), 'old_zones')
  fs.writeFileSync(path.join(root, 'src', 'other.js'), "const t = 'old_zones_v2'\n")   // a different table: must not match
  const project = path.join(root, 'p.qgs')
  fs.writeFileSync(project,
    `<qgis projectname="T"><layer-tree-group><layer-tree-layer checked="Qt::Checked" id="a" name="friendly_name"/></layer-tree-group>` +
    `<projectlayers><maplayer geometry="Polygon"><id>a</id><layername>friendly_name</layername>` +
    `<datasource>service='v' table=&quot;public&quot;.&quot;old_zones&quot; (geom)</datasource></maplayer></projectlayers></qgis>`)
  return { base, root, project }
}

describe('where a spatial table is used', () => {
  let f
  beforeEach(() => { f = fixture() })
  afterEach(() => fs.rmSync(f.base, { recursive: true, force: true }))

  test('a QGIS layer counts by the table it reads, whatever it is called', () => {
    const r = findReferences('old_zones', { roots: [f.root], projectFile: f.project })
    expect(r.projectLayers).toEqual(['friendly_name'])
  })

  test('a layer that is merely NAMED like the table does not count as reading it', () => {
    const r = findReferences('friendly_name', { roots: [f.root], projectFile: f.project })
    expect(r.projectLayers).toEqual([])
  })

  test('code blocks, documents are listed apart, dependencies and backups are ignored, whole words only', () => {
    const r = findReferences('old_zones', { roots: [f.root], projectFile: f.project })
    expect(r.code).toEqual(['app-backend/src/routes.js'])
    expect(r.docs).toEqual(['app-backend/docs/notes.md'])
  })

  test('a file you have read can be set aside', () => {
    const r = findReferences('old_zones', { roots: [f.root], projectFile: f.project, exclude: ['src/routes.js'] })
    expect(r.code).toEqual([])
  })
})
