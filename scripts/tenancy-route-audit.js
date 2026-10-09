#!/usr/bin/env node
/**
 * Which route and service files touch which kinds of data? (a static read of the source; it runs nothing)
 *
 *   node scripts/tenancy-route-audit.js            a table of files by the classes of relation their SQL names
 *   node scripts/tenancy-route-audit.js --files    also name the relations each file touches
 *   node scripts/tenancy-route-audit.js --json     machine-readable
 *
 * The tenancy contract (docs/TENANCY.md) ends with the application's own connection running as the person asking, so that no
 * route can forget to scope. This audit turns "75 files" into an ordered list of work:
 *   plane: tenant   touches authority-owned data (tenant, tenant_child, pending, personal): must run as the person
 *          system   touches secrets or plumbing (sensitive, system): identity, sessions, payments, notifications: stays on the
 *                   system connection, scoped in code, and is the short list to review by hand
 *          shared   touches only reference and national data: can run as the person with no change in what it returns
 *          none     names no known relation
 * A file in both tenant and system planes needs splitting. The match is by relation NAME in the file's text, so it can over-report
 * (a column or alias with a relation's name) and miss a relation built from a variable; treat it as a guide, not a proof.
 */
const fs = require('node:fs')
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const ROOT = path.join(__dirname, '..')
const DIRS = ['src/routes', 'src/services', 'src/middleware', 'src/utils']
const SKIP = /(__tests__|\.test\.|\.spec\.|\/attic\/|\.d\.ts$)/

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name)
    const rel = path.relative(ROOT, p).split(path.sep).join('/')
    if (SKIP.test(rel)) continue
    if (e.isDirectory()) walk(path.relative(ROOT, p), out)
    else if (/\.(js|mjs)$/.test(e.name)) out.push(rel)
  }
  return out
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  let classes
  try { classes = (await pool.query('SELECT relation, class FROM tenancy.relation_class')).rows } finally { await pool.end() }
  // short names that would match ordinary words are ignored unless written as a schema-qualified or quoted name
  const AMBIGUOUS = new Set(['country', 'layers', 'places', 'users', 'payments', 'features', 'projects', 'property', 'analytics', 'roads', 'ward', 'parcel', 'building', 'layer', 'feature', 'village', 'survey_projects', 'workflow_states'])
  const rels = classes.map((r) => { const [schema, name] = r.relation.split('.'); return { ...r, schema, name } })

  const files = []
  for (const f of DIRS.flatMap((d) => walk(d))) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
    if (!/\b(pg|fastify\.pg|pool|client)\b[\s\S]*?\.(query|connect)\(|tenantPool/.test(text) && !/FROM\s|INSERT INTO|UPDATE\s+\w/.test(text)) continue
    const hits = new Map()
    for (const r of rels) {
      const q = r.schema === 'public' ? `(?:public\\.)?${r.name}` : `${r.schema}\\.${r.name}`
      // after FROM, JOIN, INTO, UPDATE or TABLE, with the name as a whole word
      const re = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+"?${q}"?(?![\\w])`, 'gi')
      if (re.test(text)) hits.set(r.relation, r.class)
    }
    if (!hits.size) continue
    // public.users is readable for the columns that say who a person is (migration 165), so a join to it for a name is
    // tenant-plane work; only a file that reads or writes other secrets belongs on the system plane.
    const classOf = (rel, c) => (rel === 'public.users' ? 'directory' : c)
    const cls = new Set([...hits.entries()].map(([rel, c]) => classOf(rel, c)))
    if (hits.size === 1 && hits.has('public.users')) { hits.clear(); hits.set('public.users', 'sensitive') }
    if (hits.has('public.users') && cls.has('directory') && ![...cls].some((c) => c === 'sensitive' || c === 'system')) cls.add('sensitive_users_only')
    const tenantish = ['tenant', 'tenant_child', 'tenant_view', 'pending', 'personal', 'directory'].some((c) => cls.has(c))
    const systemish = [...hits.entries()].some(([rel, c]) => (c === 'sensitive' && rel !== 'public.users') || c === 'system')
    const plane = tenantish && systemish ? 'split' : tenantish ? 'tenant' : systemish ? 'system' : 'shared'
    files.push({ file: f, plane, usesTenantPool: /tenantPool|dbContext/.test(text), classes: [...cls].sort(), relations: [...hits.keys()].sort() })
  }

  if (process.argv.includes('--json')) { console.log(JSON.stringify(files, null, 1)); return }
  const by = (p) => files.filter((f) => f.plane === p)
  console.log(`${files.length} files name at least one relation. By what they touch:`)
  for (const p of ['tenant', 'split', 'system', 'shared']) {
    const l = by(p)
    console.log(`  ${p.padEnd(7)} ${String(l.length).padStart(3)} files   (${l.filter((f) => f.usesTenantPool).length} already use the tenant pool)`)
  }
  for (const p of ['split', 'system']) {
    console.log(`\n== ${p === 'split' ? 'SPLIT: touch authority data AND secrets (must be divided)' : 'SYSTEM plane: identity, sessions, payments, plumbing (review by hand)'}`)
    for (const f of by(p)) console.log(`  ${f.file}${process.argv.includes('--files') ? '\n      ' + f.relations.join(', ') : '   [' + f.classes.join(', ') + ']'}`)
  }
  console.log('\n== TENANT plane, not yet on the tenant pool')
  for (const f of by('tenant').filter((x) => !x.usesTenantPool)) console.log(`  ${f.file}   [${f.classes.join(', ')}]${process.argv.includes('--files') ? '\n      ' + f.relations.join(', ') : ''}`)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
