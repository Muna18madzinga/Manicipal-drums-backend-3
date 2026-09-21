/**
 * seed-admin-demo.js
 *
 * Three unrelated admin registers, all empty:
 *
 *   - public.site_content   the CMS override table behind /api/site-content.
 *     Every public page already renders from a bundled default
 *     (frontend src/content/siteContent.ts) even with this table empty, so
 *     these rows are demo OVERRIDES the IT Admin's /admin/content editor can
 *     show and edit — one for each router-served public page (/about,
 *     /services, /privacy, /terms, /contact) plus one /council/:slug page.
 *     Body shape is { eyebrow?, intro?, blocks: Block[] }, matching what
 *     src/routes/site-content.js stores and the frontend's Block union
 *     understands (see frontend src/content/siteContent.ts).
 *   - public.invites        two pending staff invitations.
 *   - public.exchange_rates three currency rates (USD/ZWG, USD/ZAR,
 *     ZAR/ZWG) — there are 8 payments already in the database, all
 *     recorded against a rate_used of 36, with nothing in exchange_rates
 *     to check that against.
 *
 * Idempotent via seedkit's `ensure`; a re-run adds nothing.
 *
 *     node scripts/seed-admin-demo.js
 *     node scripts/seed-admin-demo.js --undo
 */

try { require('dotenv').config({ quiet: true }) } catch (_) { /* optional */ }
const crypto = require('crypto')
const { Pool } = require('pg')
const { ensure, remember } = require('./lib/seedkit')

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/Vungu_spatial334'

const TAG = 'VUNGU-ADMIN-DEMO'

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()

/**
 * seedkit's `forget` assumes every seeded table has an `id` column
 * (`DELETE ... WHERE id::text = $1`) — true everywhere else, but
 * public.site_content is keyed on `slug`. Rather than touch the shared
 * helper, this is the same ledger-driven delete with the one correction.
 */
async function forgetAdmin (db, tag) {
  const { rows } = await db.query(
    `SELECT table_name, row_id FROM public.seed_demo_ledger
      WHERE tag = $1 ORDER BY id DESC`, [tag])
  let n = 0
  for (const r of rows) {
    const keyCol = r.table_name === 'public.site_content' ? 'slug' : 'id'
    const res = await db.query(`DELETE FROM ${r.table_name} WHERE ${keyCol}::text = $1`, [r.row_id])
    n += res.rowCount
  }
  await db.query('DELETE FROM public.seed_demo_ledger WHERE tag = $1', [tag])
  return n
}

async function userId (db, email) {
  const { rows } = await db.query('SELECT id FROM public.users WHERE email = $1', [email])
  if (!rows.length) throw new Error(`No user ${email}. Run: node scripts/seed-demo-users.js`)
  return rows[0].id
}

async function seed (db) {
  const admin = await userId(db, 'demo.admin@vungu.test')

  // ── 1. Six site_content overrides ────────────────────────────────────────
  const pages = [
    {
      slug: 'about',
      title: 'About Vungu RDC',
      body: {
        eyebrow: 'About',
        intro: 'Vungu Rural District Council administers 609,588.88 hectares of the Midlands Province, divided into 19 wards.',
        blocks: [
          {
            type: 'prose',
            heading: 'Who we are',
            paragraphs: [
              'Vungu Rural District Council is the local authority responsible for development control, roads, rural water supply and sanitation, environmental health and primary services across the district. This portal is where the council now runs that work — the same process that used to run on paper forms and physical registers.',
              'The council area shares boundaries with Kwekwe, Chirumanzu, Shurugwi, Insiza and Inyati. It lies in natural farming regions 3 and 4.',
            ],
          },
        ],
      },
    },
    {
      slug: 'services',
      title: 'Council Services',
      body: {
        eyebrow: 'Services',
        intro: 'Services a resident or business can access through this portal or at the council offices.',
        blocks: [
          {
            type: 'bullets',
            heading: 'What the council handles',
            items: [
              'Development applications — new buildings, subdivisions, change of use and stand allocations.',
              'Building-stage inspections during construction, through to occupation certification.',
              'Environmental health — food-premises registration, licence clearances, burial permits and nuisance complaints.',
              'Land surveying — cadastral verification, pegging and layout design for new stands.',
              'GIS and mapping — the district cadastre, zoning designations and spatial analysis in support of the above.',
            ],
          },
        ],
      },
    },
    {
      slug: 'privacy',
      title: 'Privacy notice',
      body: {
        eyebrow: 'Legal',
        intro: 'What information the council collects through this portal, and why.',
        blocks: [
          {
            type: 'prose',
            heading: 'Information we collect',
            paragraphs: [
              'When you submit a development application, we collect your name, contact details, national ID or company registration, and the documents attached to the application (plans, proof of ownership, and similar). Payment records are kept for the amount, method and status of each transaction, not full card or wallet details.',
              'This information is used only to process the application or service you have requested, and to maintain the statutory registers the council is required to keep. It is retained for as long as the relevant planning or health record itself is retained.',
            ],
          },
          {
            type: 'prose',
            heading: 'Requests about your information',
            paragraphs: [
              'To ask what information the council holds about you, or to request a correction, contact the council offices using the details on the Contact page.',
            ],
          },
        ],
      },
    },
    {
      slug: 'terms',
      title: 'Terms of use',
      body: {
        eyebrow: 'Legal',
        intro: 'Conditions for using this portal to deal with Vungu Rural District Council.',
        blocks: [
          {
            type: 'numbered',
            heading: 'Using this portal',
            items: [
              'Information you submit must be accurate. An application found to contain false information may be refused or, if already approved, revoked.',
              'Application and inspection fees are set by council resolution and are non-refundable once an application has been accepted for processing.',
              'A permit or certificate issued through this portal remains subject to the Regional, Town and Country Planning Act and the council’s by-laws.',
              'Documents you upload remain your property; the council retains them as part of the statutory record for the application.',
            ],
          },
        ],
      },
    },
    {
      slug: 'contact',
      title: 'Contact Vungu RDC',
      body: {
        eyebrow: 'Contact',
        intro: 'Reach the council offices by phone, email or in person.',
        blocks: [
          {
            type: 'prose',
            heading: 'Council offices',
            paragraphs: [
              '19 Lincoln Road, Light Industrial Site, Gweru.',
              'Telephone: (+263) 54 226515/6. Email: admin@vungurdc.org.zw.',
              'Office hours: 8am to 5pm, Monday to Friday.',
            ],
          },
        ],
      },
    },
    {
      // Override of the bundled 'your-council' page at /council/your-council,
      // demonstrating that a stored override replaces the frontend default.
      slug: 'your-council',
      title: 'Your Council',
      body: {
        eyebrow: 'Department',
        intro: 'Vungu RDC is located in the Midlands Province and divided into 19 wards, covering a total area of 609,588.88 hectares.',
        blocks: [
          {
            type: 'prose',
            paragraphs: [
              'Development control, which used to be run on paper application forms and a physical stamp register, now runs through this portal end to end: lodging, circulation to service authorities, committee determination, stage inspections and occupation certification.',
            ],
          },
          {
            type: 'staff',
            heading: 'Executive Team',
            members: [
              { name: 'Mr. A. Magura', role: 'Chief Executive Officer' },
              { name: 'Mrs. Grace Kembo', role: 'Executive Officer — Finance' },
              { name: 'Ms. L.T. Maheru', role: 'Human Resources, Social Services & Administration Officer' },
              { name: 'Mr. C. Maramwidze', role: 'Executive Officer — Planner' },
              { name: 'Mr. Lawrence Chikwira', role: 'Internal Auditor' },
              { name: 'Mr. Kudzai Njodzi', role: 'Engineer' },
            ],
          },
        ],
      },
    },
  ]

  for (const page of pages) {
    // site_content's primary key is slug itself, so a plain existence check
    // does the idempotency job `ensure`'s natural-key lookup normally does.
    const { rows } = await db.query('SELECT slug FROM public.site_content WHERE slug = $1', [page.slug])
    if (rows.length) continue
    await db.query(
      `INSERT INTO public.site_content (slug, title, body, updated_by)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [page.slug, page.title, JSON.stringify(page.body), admin])
    await remember(db, TAG, 'public.site_content', page.slug)
  }

  // ── 2. Two pending invites ───────────────────────────────────────────────
  const invites = [
    {
      email: 'demo.invite.clerk@vungu.test',
      role: 'planning_clerk',
      job_title: 'Planning Clerk',
      department: 'Development Control',
    },
    {
      email: 'demo.invite.eo@vungu.test',
      role: 'eo',
      job_title: 'Enforcement Officer',
      department: 'Enforcement',
    },
  ]
  for (const inv of invites) {
    await ensure(db, TAG, 'public.invites', {
      token: crypto.randomBytes(24).toString('hex'),
      email: inv.email,
      role: inv.role,
      job_title: inv.job_title,
      department: inv.department,
      invited_by: admin,
      used: false,
    }, 'email = $1 AND used = false', [inv.email])
  }

  // ── 3. Three exchange rates ───────────────────────────────────────────────
  const rateDate = daysAgo(1).slice(0, 10)
  const rates = [
    ['USD', 'ZWG', 36.0],
    ['USD', 'ZAR', 18.5],
    ['ZAR', 'ZWG', 1.946],
  ]
  for (const [base, quote, rate] of rates) {
    await ensure(db, TAG, 'public.exchange_rates', {
      rate_date: rateDate,
      base_ccy: base,
      quote_ccy: quote,
      rate,
      source: 'Reserve Bank of Zimbabwe',
    }, 'rate_date = $1 AND base_ccy = $2 AND quote_ccy = $3 AND source = $4',
    [rateDate, base, quote, 'Reserve Bank of Zimbabwe'])
  }
}

;(async () => {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  })
  const db = await pool.connect()
  const undoing = process.argv.includes('--undo')
  try {
    await db.query('BEGIN')
    if (undoing) {
      const n = await forgetAdmin(db, TAG)
      await db.query('COMMIT')
      console.log(`Removed ${n} row(s) created by ${TAG}.`)
    } else {
      await seed(db)
      await db.query('COMMIT')
      const { rows } = await db.query(
        'SELECT count(*)::int n FROM public.seed_demo_ledger WHERE tag = $1', [TAG])
      console.log(`Seeded the admin demo data (${rows[0].n} rows tracked).`)
    }
  } catch (e) {
    await db.query('ROLLBACK')
    console.error('FAILED (rolled back):', e.message)
    process.exitCode = 1
  } finally {
    db.release()
    await pool.end()
  }
})()
