// scripts/generate-data-dictionary.js
// ─────────────────────────────────────────────────────────────────────────
// Data dictionary generated from the database catalogue — never hand-edited.
//
//   docs/DATABASE.md                     (Markdown, for the repo)
//   docs/DATABASE_Data_Dictionary.docx   (Word, landscape, for reports)
//
// Every schema / table / column comes from pg_catalog, including the
// COMMENTs written by migration 132, the FKs into the ref schema (130) and
// exact row counts. Re-run after any migration:
//
//   node scripts/generate-data-dictionary.js            # uses DATABASE_URL
//   DATABASE_URL=postgresql://…/other node scripts/generate-data-dictionary.js
//   … --source "text"   # overrides the "Generated from <db>" wording
//
// The Word file has a static, clickable contents list (bookmarks), not a TOC
// field, so Word opens it without asking to "update fields".
// ─────────────────────────────────────────────────────────────────────────

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, PageOrientation, BorderStyle, AlignmentType,
  Bookmark, InternalHyperlink,
} = require('docx')

const SCHEMAS = ['public', 'spatial_planning', 'planning_clerk', 'council_ops', 'survey', 'ref']
const SKIP = new Set(['spatial_ref_sys', 'geometry_columns', 'geography_columns'])
const DOCS = path.join(__dirname, '..', 'docs')

// Grouping of public.* so the biggest schema reads as sections, not a wall.
const PUBLIC_GROUPS = [
  ['Identity & access', /^(users|invites|citizen_documents|analytics|site_content|local_authorities|lands_registry_.*|schema_migrations)$/],
  ['Legacy online application intake', /^(development_applications|application_.*|plan_review.*|inspection_(bookings|photos|status_events))$/],
  ['Payments & notifications', /^(payments|exchange_rates|notifications_outbox)$/],
  ['Stands, zones & land use', /^(stands|stand_allocation|proposed_peri_urban_zones|zone_land_use_controls|land_use_groups|development_matrix|planning_assistant_templates|beyond_peri_urban_zones|zones_master|v_stands|stands_tile_view|gweru_peri_urban_zone|vungu_beyond_peri_urban_zones)$/],
  ['GIS registry', /^(layers|layer_data|spatial_layers|gis_layer|gis_style|gis_style_audit|gis_published_style|ingestion_jobs|places)$/],
  ['Basemap — administrative boundaries', /^(country|provinces|districts|wards|vungu_clip_boundary|admin_areas)$/],
  ['Basemap — council imports', /^(vungu_.*|gweru_.*)$/],
  ['Basemap — OpenStreetMap', /.*/],
]

function shortType(t) {
  return t
    .replace(/character varying/g, 'varchar')
    .replace(/timestamp with time zone/g, 'timestamptz')
    .replace(/timestamp without time zone/g, 'timestamp')
    .replace(/double precision/g, 'float8')
    .replace(/^character\(/, 'char(')
}

async function load(db) {
  const { rows: rels } = await db.query(`
    SELECT c.oid, n.nspname AS sch, c.relname AS name, c.relkind AS kind,
           obj_description(c.oid, 'pg_class') AS comment,
           pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v') AND n.nspname = ANY($1)
     ORDER BY n.nspname, c.relkind, c.relname`, [SCHEMAS])
  const objs = rels.filter(r => !SKIP.has(r.name))
  const oids = objs.map(o => o.oid)

  for (const o of objs) {
    if (o.kind === 'v') continue
    const { rows } = await db.query(`SELECT count(*)::bigint AS n FROM "${o.sch}"."${o.name}"`)
    o.rows = Number(rows[0].n)
  }

  const { rows: cols } = await db.query(`
    SELECT a.attrelid AS oid, a.attnum, a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
           a.attidentity AS identity, a.attgenerated AS generated,
           pg_get_expr(d.adbin, d.adrelid) AS def,
           col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attrelid, a.attnum`, [oids])

  const { rows: cons } = await db.query(`
    SELECT con.conrelid AS oid, con.contype AS type, con.conkey AS keys,
           con.confrelid::regclass::text AS ref_table,
           (SELECT array_agg(a.attname ORDER BY k.i) FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n) AS ref_cols
      FROM pg_constraint con WHERE con.conrelid = ANY($1) AND con.contype IN ('p','u','f')`, [oids])

  const byOid = new Map(objs.map(o => [o.oid, Object.assign(o, { cols: [], fks: [] })]))
  for (const c of cols) byOid.get(c.oid).cols.push(c)
  for (const k of cons) {
    const o = byOid.get(k.oid)
    for (const [i, attnum] of k.keys.entries()) {
      const col = o.cols.find(c => c.attnum === attnum)
      if (!col) continue
      if (k.type === 'p') col.pk = true
      if (k.type === 'u' && k.keys.length === 1) col.unique = true
      if (k.type === 'f') col.ref = `${k.ref_table.replace(/^public\./, '')}.${k.ref_cols[i]}`
    }
    if (k.type === 'f') o.fks.push(k.ref_table.replace(/^public\./, ''))
  }

  // Lookup values + where each lookup is used.
  const refs = objs.filter(o => o.sch === 'ref')
  for (const r of refs) {
    const codeCol = r.cols.some(c => c.name === 'code') ? 'code' : 'fclass'
    const order = r.cols.some(c => c.name === 'sort_order') ? 'sort_order, ' : ''
    const { rows } = await db.query(`SELECT ${codeCol} AS code FROM ref."${r.name}" ORDER BY ${order}1`)
    r.values = rows.map(x => x.code)
    const { rows: users } = await db.query(`
      SELECT con.conrelid::regclass::text || '.' || a.attname AS used_by
        FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND con.confrelid = $1 ORDER BY 1`, [r.oid])
    r.usedBy = users.map(u => u.used_by.replace(/^public\./, ''))
  }

  const { rows: schemaComments } = await db.query(`
    SELECT nspname AS sch, obj_description(oid, 'pg_namespace') AS comment
      FROM pg_namespace WHERE nspname = ANY($1)`, [SCHEMAS])
  const { rows: [{ size }] } = await db.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS size')
  const { rows: [{ db: dbName }] } = await db.query('SELECT current_database() AS db')
  return { objs, refs, schemaComments: Object.fromEntries(schemaComments.map(s => [s.sch, s.comment])), size, dbName }
}

function keyNote(c) {
  const bits = []
  if (c.pk) bits.push('PK')
  if (c.unique) bits.push('UQ')
  if (c.ref) bits.push(`FK → ${c.ref}`)
  return bits.join(', ')
}
function colNote(c) {
  const bits = []
  if (c.generated === 's') bits.push(`generated: ${c.def}`)
  else if (c.identity) bits.push('identity')
  else if (c.def && /^nextval/.test(c.def)) bits.push('serial')
  else if (c.def) bits.push(`default ${c.def.replace(/::[a-z ]+(\[\])?/g, '')}`)
  if (c.comment) bits.push(c.comment)
  return bits.join(' — ')
}
function groupsFor(sch, objs) {
  const list = objs.filter(o => o.sch === sch)
  if (sch !== 'public') return [[null, list]]
  const seen = new Set()
  return PUBLIC_GROUPS.map(([title, re]) => {
    const g = list.filter(o => !seen.has(o) && re.test(o.name))
    g.forEach(o => seen.add(o))
    return [title, g]
  }).filter(([, g]) => g.length)
}
const fmtRows = n => (n == null ? 'view' : n.toLocaleString('en-GB'))
const fmtKb = b => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} kB` : `${(b / 1048576).toFixed(1)} MB`)
const md = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

// ── Markdown ────────────────────────────────────────────────────────────
function toMarkdown({ objs, refs, schemaComments, size, source }) {
  const out = []
  const tables = objs.filter(o => o.kind !== 'v')
  const today = new Date().toISOString().slice(0, 10)
  out.push('# SpartialIQ database — data dictionary', '')
  out.push(`Generated ${today} from ${source} by \`scripts/generate-data-dictionary.js\` — do not edit by hand.`, '')
  out.push('## Summary', '')
  out.push('| Schema | Purpose | Tables | Views | Rows | Size |', '|---|---|--:|--:|--:|--:|')
  for (const sch of SCHEMAS) {
    const t = tables.filter(o => o.sch === sch)
    const v = objs.filter(o => o.sch === sch && o.kind === 'v')
    if (!t.length && !v.length) continue
    out.push(`| \`${sch}\` | ${md(schemaComments[sch])} | ${t.length} | ${v.length} | ${fmtRows(t.reduce((a, o) => a + o.rows, 0))} | ${fmtKb(t.reduce((a, o) => a + Number(o.bytes), 0))} |`)
  }
  out.push(`| **Total** | database size ${size} | **${tables.length}** | **${objs.length - tables.length}** | | |`, '')

  out.push('## Design rules', '',
    '- **Every fact is stored once.** Derived values are computed (views) or `GENERATED` columns (`stands.centroid`, `proposed_peri_urban_zones.area_ha`) so they cannot drift.',
    '- **Every closed vocabulary is a table** in the `ref` schema (`code` PK, `label`, `description`, `sort_order`, `is_active`). Business columns reference it by FOREIGN KEY `ON UPDATE CASCADE`; adding a status is an `INSERT`, not a migration.',
    '- **Relationships are foreign keys, not copied names.** e.g. `stands.zone_id → proposed_peri_urban_zones.id`, `wards.parent_pcode → districts.pcode → provinces.pcode → country.pcode`.',
    '- **Compatibility views keep old names working** where QGIS or the tile server still use them (`gweru_peri_urban_zone`, `vungu_beyond_peri_urban_zones`, `zones_master`, `stands_tile_view`).',
    '- Per-surveyor workspace schemas (`surveyor_<name>`) are created at runtime by `survey.migrate_surveyor_to_schema()` and mirror `survey.*`; they are not listed here.',
    '- Migrations 130–132 implement the above; see their headers for exactly what moved.', '')

  out.push('## Core relationships', '', '```mermaid', 'erDiagram',
    '  users ||--o{ permit_application : "creates / decides"',
    '  permit_application ||--o{ application_consultation : circulates',
    '  permit_application ||--o{ application_objection : receives',
    '  permit_application ||--o{ stage_inspection : "inspected by"',
    '  permit_application ||--o{ permit_document : holds',
    '  permit_application ||--o{ permit_event : logs',
    '  permit_application ||--o{ survey_task : requests',
    '  proposed_peri_urban_zones ||--o{ stands : contains',
    '  proposed_peri_urban_zones ||--o{ zone_land_use_controls : controls',
    '  land_use_groups ||--o{ zone_land_use_controls : "applies to"',
    '  stands ||--o{ stand_allocation : "allocated by"',
    '  country ||--o{ provinces : contains',
    '  provinces ||--o{ districts : contains',
    '  districts ||--o{ wards : contains',
    '  wards ||--o{ beyond_peri_urban_zones : locates',
    '  ref_permit_status ||--o{ permit_application : "status"',
    '  ref_stand_status ||--o{ stands : "status"',
    '  ref_user_role ||--o{ users : "role"',
    '```', '')

  out.push('## Contents', '')
  for (const sch of SCHEMAS) if (objs.some(o => o.sch === sch)) out.push(`- [\`${sch}\`](#schema-${sch.replace(/_/g, '-')})`)
  out.push('')

  for (const sch of SCHEMAS.filter(s => s !== 'ref')) {
    if (!objs.some(o => o.sch === sch)) continue
    out.push(`## Schema \`${sch}\` {#schema-${sch.replace(/_/g, '-')}}`, '', md(schemaComments[sch]), '')
    for (const [title, list] of groupsFor(sch, objs)) {
      if (title) out.push(`### ${title}`, '')
      out.push('| Table / view | Purpose | Rows | References |', '|---|---|--:|---|')
      for (const o of list) out.push(`| \`${o.name}\`${o.kind === 'v' ? ' *(view)*' : ''} | ${md(o.comment)} | ${fmtRows(o.rows)} | ${[...new Set(o.fks)].map(f => `\`${f}\``).join(', ')} |`)
      out.push('')
      for (const o of list) {
        out.push(`#### ${sch}.${o.name}${o.kind === 'v' ? ' (view)' : ''}`, '')
        if (o.comment) out.push(md(o.comment), '')
        out.push('| Column | Type | Null | Key | Notes |', '|---|---|:-:|---|---|')
        for (const c of o.cols) out.push(`| \`${c.name}\` | ${md(shortType(c.type))} | ${c.notnull ? '' : '✓'} | ${md(keyNote(c))} | ${md(colNote(c))} |`)
        out.push('')
      }
    }
  }

  out.push('## Schema `ref` — lookup tables {#schema-ref}', '', md(schemaComments.ref), '')
  out.push('| Lookup | Meaning | Values (in order) | Used by |', '|---|---|---|---|')
  for (const r of refs) {
    const vals = r.name === 'osm_feature_class' ? `${r.values.length} OSM classes (${r.values.slice(0, 8).join(', ')}, …)` : r.values.join(', ')
    out.push(`| \`ref.${r.name}\` | ${md(r.comment)} | ${md(vals)} | ${r.usedBy.map(u => `\`${u}\``).join('<br>')} |`)
  }
  out.push('')
  return out.join('\n')
}

// ── Word ────────────────────────────────────────────────────────────────
const PAGE_W = 16838, PAGE_H = 11906, MARGIN = 900
const CONTENT_W = PAGE_W - 2 * MARGIN   // landscape A4 content width (DXA)
const HEAD_FILL = '1F3A5F', ZEBRA = 'F2F5F9', FONT = 'Calibri'
const border = { style: BorderStyle.SINGLE, size: 4, color: 'C8D0DA' }
const borders = { top: border, bottom: border, left: border, right: border }

function cell(text, width, { head = false, zebra = false, mono = false } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders,
    shading: head ? { type: ShadingType.CLEAR, color: 'auto', fill: HEAD_FILL }
                  : zebra ? { type: ShadingType.CLEAR, color: 'auto', fill: ZEBRA } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({ children: [new TextRun({
      text: String(text ?? ''), bold: head, color: head ? 'FFFFFF' : '1A1A1A',
      font: mono ? 'Consolas' : FONT, size: head ? 18 : 17,
    })] })],
  })
}
function table(headers, widths, rows, monoCols = [0]) {
  const scale = CONTENT_W / widths.reduce((a, b) => a + b, 0)
  const w = widths.map(x => Math.floor(x * scale))
  w[w.length - 1] += CONTENT_W - w.reduce((a, b) => a + b, 0)
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: w,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, w[i], { head: true })) }),
      ...rows.map((r, ri) => new TableRow({ cantSplit: true,
        children: r.map((v, i) => cell(v, w[i], { zebra: ri % 2 === 1, mono: monoCols.includes(i) })) })),
    ],
  })
}
const p = (text, { run = {}, ...para } = {}) =>
  new Paragraph({ spacing: { after: 120 }, ...para, children: [new TextRun({ text, font: FONT, size: 20, ...run })] })
// Headings carry a bookmark; H1/H2 are also collected for the contents list.
function makeHeadings() {
  const toc = []
  let n = 0
  const h = (text, level) => {
    const id = `h${++n}`
    if (level === HeadingLevel.HEADING_1 || level === HeadingLevel.HEADING_2) toc.push({ id, text, level })
    return new Paragraph({ heading: level, spacing: { before: 240, after: 120 },
      children: [new Bookmark({ id, children: [new TextRun({ text, font: FONT })] })] })
  }
  const contents = () => toc.map(e => new Paragraph({
    spacing: { after: 40 },
    indent: { left: e.level === HeadingLevel.HEADING_1 ? 0 : 400 },
    children: [new InternalHyperlink({ anchor: e.id, children: [new TextRun({
      text: e.text, font: FONT, size: e.level === HeadingLevel.HEADING_1 ? 21 : 19,
      bold: e.level === HeadingLevel.HEADING_1, color: '1F4E79', underline: {},
    })] })],
  }))
  return { h, contents }
}

function toDocx({ objs, refs, schemaComments, size, source }) {
  const tables = objs.filter(o => o.kind !== 'v')
  const { h, contents } = makeHeadings()
  const front = []
  const body = []
  front.push(new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 80 },
    children: [new TextRun({ text: 'SpartialIQ database — data dictionary', bold: true, size: 44, font: FONT, color: HEAD_FILL })] }))
  front.push(p(`Generated ${new Date().toISOString().slice(0, 10)} from ${source.replace(/`/g, "")} (${size}) by scripts/generate-data-dictionary.js.`, { run: { color: '555555' } }))
  front.push(new Paragraph({ spacing: { before: 200, after: 120 },
    children: [new TextRun({ text: 'Contents', bold: true, size: 28, font: FONT, color: HEAD_FILL })] }))

  body.push(h('Summary', HeadingLevel.HEADING_1))
  body.push(table(['Schema', 'Purpose', 'Tables', 'Views', 'Rows', 'Size'], [14, 52, 7, 7, 10, 10],
    SCHEMAS.filter(s => objs.some(o => o.sch === s)).map(sch => {
      const t = tables.filter(o => o.sch === sch)
      return [sch, schemaComments[sch], t.length, objs.filter(o => o.sch === sch && o.kind === 'v').length,
        fmtRows(t.reduce((a, o) => a + o.rows, 0)), fmtKb(t.reduce((a, o) => a + Number(o.bytes), 0))]
    }).concat([['Total', `Database size ${size}`, tables.length, objs.length - tables.length, '', '']])))

  body.push(h('Design rules', HeadingLevel.HEADING_1))
  for (const line of [
    'Every fact is stored once. Derived values are computed in views or as GENERATED columns (stands.centroid, proposed_peri_urban_zones.area_ha), so they cannot drift.',
    'Every closed vocabulary is a table in the ref schema (code, label, description, sort_order, is_active). Business columns reference it by FOREIGN KEY ON UPDATE CASCADE; adding a status is an INSERT, not a migration.',
    'Relationships are foreign keys, not copied names: stands.zone_id → proposed_peri_urban_zones.id; wards → districts → provinces → country by pcode.',
    'Compatibility views keep old names working where QGIS or the tile server use them (gweru_peri_urban_zone, vungu_beyond_peri_urban_zones, zones_master, stands_tile_view).',
  ]) body.push(p(line, { bullet: { level: 0 } }))

  for (const sch of SCHEMAS.filter(s => s !== 'ref')) {
    if (!objs.some(o => o.sch === sch)) continue
    body.push(h(`Schema ${sch}`, HeadingLevel.HEADING_1))
    body.push(p(schemaComments[sch] || ''))
    for (const [title, list] of groupsFor(sch, objs)) {
      if (title) body.push(h(title, HeadingLevel.HEADING_2))
      body.push(table(['Table / view', 'Purpose', 'Rows', 'References'], [20, 50, 8, 22],
        list.map(o => [o.name + (o.kind === 'v' ? ' (view)' : ''), o.comment, fmtRows(o.rows), [...new Set(o.fks)].join(', ')])))
      for (const o of list) {
        body.push(h(`${sch}.${o.name}${o.kind === 'v' ? ' (view)' : ''}`, HeadingLevel.HEADING_3))
        if (o.comment) body.push(p(o.comment, { run: { italics: true, color: '444444' } }))
        body.push(table(['Column', 'Type', 'Null', 'Key', 'Notes'], [18, 16, 5, 22, 39],
          o.cols.map(c => [c.name, shortType(c.type), c.notnull ? '' : 'yes', keyNote(c), colNote(c)])))
      }
    }
  }

  body.push(h('Schema ref — lookup tables', HeadingLevel.HEADING_1))
  body.push(p(schemaComments.ref || ''))
  body.push(table(['Lookup', 'Meaning', 'Values (in order)', 'Used by'], [17, 23, 32, 28],
    refs.map(r => [`ref.${r.name}`, r.comment,
      r.name === 'osm_feature_class' ? `${r.values.length} OSM classes (${r.values.slice(0, 8).join(', ')}, …)` : r.values.join(', '),
      r.usedBy.join(', ')])))

  return new Document({
    creator: 'SpartialIQ', title: 'SpartialIQ data dictionary',
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [{
      properties: { page: {
        size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE },
        margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      } },
      children: [...front, ...contents(), ...body],
    }],
  })
}

// docx gives every Bookmark w:id="1" — valid OOXML needs unique ids. Each
// bookmark wraps one heading, so starts/ends pair up in document order.
async function fixBookmarkIds(buffer) {
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(buffer)
  let xml = await zip.file('word/document.xml').async('string')
  let next = 0
  const open = []
  xml = xml.replace(/<w:bookmark(Start|End)([^>]*?)w:id="\d+"/g, (m, kind, attrs) => {
    const id = kind === 'Start' ? (open.push(++next), next) : open.pop()
    return `<w:bookmark${kind}${attrs}w:id="${id}"`
  })
  zip.file('word/document.xml', xml)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/vungu_master_db_v1' })
  await db.connect()
  try {
    const data = await load(db)
    const i = process.argv.indexOf('--source')
    data.source = i > 0 && process.argv[i + 1] ? process.argv[i + 1] : `\`${data.dbName}\``
    if (!data.refs.length) console.warn('warning: no ref schema — run migrations 130–132 first.')
    fs.writeFileSync(path.join(DOCS, 'DATABASE.md'), toMarkdown(data))
    fs.writeFileSync(path.join(DOCS, 'DATABASE_Data_Dictionary.docx'), await fixBookmarkIds(await Packer.toBuffer(toDocx(data))))
    const t = data.objs.filter(o => o.kind !== 'v').length
    console.log(`data dictionary: ${t} tables, ${data.objs.length - t} views, ${data.refs.length} lookups from ${data.dbName}`)
    console.log('  -> docs/DATABASE.md')
    console.log('  -> docs/DATABASE_Data_Dictionary.docx')
  } finally {
    await db.end()
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1) })
module.exports = { shortType }
