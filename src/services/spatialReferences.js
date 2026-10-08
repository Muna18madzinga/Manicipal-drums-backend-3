/**
 * Where a spatial table is used. Looks in the QGIS project (by the table each layer READS, not by its
 * name), and in every code, config, SQL and test file of both repositories.
 *
 * A table was once dropped as unused because only code was searched, while the QGIS project still
 * read it. A table is "in use" if any of these find it. Documents (.md, reports) are returned
 * separately: they describe the table but do not depend on it.
 */
const fs = require('node:fs')
const path = require('node:path')
const { parseProject } = require('./qgisCatalogue')

const SKIP = new Set(['node_modules', '.git', 'backups', 'attic', 'dist', '.vite', '_backups'])
const EXT = new Set(['.js', '.ts', '.vue', '.sql', '.qml', '.py', '.json', '.mjs', '.md'])
const DOC = /(^|\/)docs\/|\.md$|-fidelity\.json$|\/data\/seed\//

function* walk(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (EXT.has(path.extname(e.name))) yield p
  }
}

/**
 * @param table   the table name
 * @param opts    { roots: [dirs to search], projectFile, exclude: [relative files to ignore] }
 * @returns { projectLayers, code, docs }  projectLayers: QGIS layers that read the table;
 *          code: non-document files that mention it; docs: documents that mention it
 */
function findReferences(table, { roots, projectFile, exclude = [] }) {
  const re = new RegExp(`\\b${table}\\b`)
  const relBase = path.resolve(roots[0], '..')
  const out = { projectLayers: [], code: [], docs: [] }

  if (projectFile && fs.existsSync(projectFile)) {
    out.projectLayers = parseProject(fs.readFileSync(projectFile, 'utf8')).layers
      .filter((l) => l.table === table).map((l) => l.name)
  }

  for (const root of roots) {
    for (const file of walk(root)) {
      const rel = path.relative(relBase, file).replace(/\\/g, '/')
      if (exclude.some((x) => rel.endsWith(x))) continue
      let text
      try { if (fs.statSync(file).size > 6_000_000) continue; text = fs.readFileSync(file, 'utf8') } catch { continue }
      if (!re.test(text)) continue
      ;(DOC.test(rel) ? out.docs : out.code).push(rel)
    }
  }
  return out
}

module.exports = { findReferences }
