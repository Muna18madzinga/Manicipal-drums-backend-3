/**
 * Generate SpartialIQ System Process Flow Document
 * Run: node scripts/generate-process-flow-docx.js
 * Output: docs/SpartialIQ_Process_Flows.docx
 */
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, WidthType, AlignmentType, BorderStyle, ShadingType,
  convertInchesToTwip, PageOrientation,
} = require('docx')
const fs = require('fs')
const path = require('path')

// ── Helpers ───────────────────────────────────────────────────────────────────
const h1 = (text) => new Paragraph({
  text, heading: HeadingLevel.HEADING_1,
  spacing: { before: 400, after: 200 },
})
const h2 = (text) => new Paragraph({
  text, heading: HeadingLevel.HEADING_2,
  spacing: { before: 300, after: 150 },
})
const h3 = (text) => new Paragraph({
  text, heading: HeadingLevel.HEADING_3,
  spacing: { before: 200, after: 100 },
})
const para = (text) => new Paragraph({
  children: [new TextRun({ text, size: 22 })],
  spacing: { after: 120 },
})
const bullet = (text) => new Paragraph({
  children: [new TextRun({ text, size: 22 })],
  bullet: { level: 0 },
  spacing: { after: 80 },
})
const numBullet = (text, level = 0) => new Paragraph({
  children: [new TextRun({ text, size: 22 })],
  numbering: { reference: 'main', level },
  spacing: { after: 80 },
})
const blankLine = () => new Paragraph({ text: '' })

function flowTable(headers, rows) {
  const makeCell = (text, header = false) => new TableCell({
    children: [new Paragraph({
      children: [new TextRun({ text, size: 20, bold: header })],
      alignment: AlignmentType.LEFT,
    })],
    shading: header ? { type: ShadingType.SOLID, color: '2563EB', fill: '2563EB' } : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map(h => makeCell(h, true)),
      }),
      ...rows.map(row => new TableRow({
        children: row.map(cell => makeCell(cell)),
      })),
    ],
  })
}

// ── Document content ─────────────────────────────────────────────────────────
const doc = new Document({
  numbering: {
    config: [{
      reference: 'main',
      levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.LEFT }],
    }],
  },
  sections: [{
    properties: {},
    children: [
      // ── Title Page ────────────────────────────────────────────────────────
      new Paragraph({
        children: [new TextRun({ text: 'SpartialIQ', bold: true, size: 56, color: '2563EB' })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 1200, after: 200 },
      }),
      new Paragraph({
        children: [new TextRun({ text: 'Vungu Rural District Council Planning Portal', size: 32 })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }),
      new Paragraph({
        children: [new TextRun({ text: 'System Process Flow Document', bold: true, size: 40 })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }),
      new Paragraph({
        children: [new TextRun({ text: `Version 1.0  ·  ${new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}`, size: 22, italics: true })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 600 },
      }),
      new Paragraph({ text: '', pageBreakBefore: true }),

      // ── Section 1: System Overview ─────────────────────────────────────────
      h1('1. System Overview'),
      para('SpartialIQ is a multi-council Zimbabwe digital planning portal that replaces paper-based development control. Citizens submit applications online; the system routes each submission through a mandatory departmental workflow — Planner → Surveyor → Environmental Officer → Building Inspector — with real-time status tracking visible to both staff and applicants.'),
      blankLine(),
      h2('1.1 Architecture'),
      bullet('Frontend: Vue 3 + Pinia + MapLibre GL hosted on Vercel'),
      bullet('Backend: Fastify + PostgreSQL/PostGIS hosted on Render'),
      bullet('Auth: JWT HS256, 12-hour access tokens + 14-day refresh tokens'),
      bullet('8 staff roles: admin, planner, eo, env_officer, building_inspector, planning_clerk, surveyor, gis_officer'),
      blankLine(),
      h2('1.2 Council Coverage'),
      para('The system covers 10 Zimbabwe RDC councils selectable on the welcome screen: Vungu, Gweru, Kwekwe, Bulawayo, Harare, Mutare, Masvingo, Chinhoyi, Bindura, and Kariba. Each council has its own data namespace in localStorage key spartialiq_council.'),
      blankLine(),

      // ── Section 2: User Registration & KYC ──────────────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('2. User Registration & Identity Verification (KYC)'),
      h2('2.1 Process Flow'),
      flowTable(
        ['Step', 'Actor', 'Action', 'System Response'],
        [
          ['1', 'Citizen', 'Opens /register, enters name, email, password', 'Account created, JWT issued'],
          ['2', 'Citizen', 'Submits KYC form: ID type, ID number, full name', 'kyc_verifications row created (status: pending)'],
          ['3', 'IT Admin', 'Opens Admin → KYC/Identity tab, reviews submission', 'Sees National ID / passport / driver\'s licence details'],
          ['4', 'IT Admin', 'Clicks Approve or Reject (with notes)', 'status updated to approved/rejected; planner notified'],
          ['5', 'System', 'On approval: workflow_notification sent to planner role', 'Planner sees badge on dashboard'],
          ['6', 'Citizen', 'Proceeds to submit development application', 'Application registered, dev_register_no assigned'],
        ]
      ),
      blankLine(),
      h2('2.2 Backend Endpoints'),
      bullet('POST   /api/kyc — citizen submits identity document'),
      bullet('GET    /api/kyc — admin lists all KYC submissions'),
      bullet('PATCH  /api/kyc/:id/approve — admin approves'),
      bullet('PATCH  /api/kyc/:id/reject  — admin rejects with notes'),
      blankLine(),

      // ── Section 3: Development Application Submission ─────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('3. Development Application — Full Statutory Workflow'),
      h2('3.1 Legislation'),
      para('The workflow follows the Regional Town & Country Planning Act [Ch. 29:12] — specifically Section 26 (development requiring permission), Section 32 (enforcement orders), and Section 34 (prohibition orders).'),
      blankLine(),
      h2('3.2 12-Stage Process Flow'),
      flowTable(
        ['Stage', 'Status Code', 'Owner', 'Action Required'],
        [
          ['1 — Submission',             'registered',              'Planning Clerk',       'Receive TPD form + fee; assign dev_register_no'],
          ['2 — Document check',         'pending_docs',            'Planning Clerk',       'Verify site plan, building plan, title deed, ID'],
          ['3 — Under review',           'under_review',            'Planner (EO)',         'Assess merits; check zoning compliance'],
          ['4 — Consultation',           'consultation',            'All departments',      'Route to Surveyor, Env Officer, Building Inspector'],
          ['5 — Public objection period','objection_period',        'Planning Clerk',       'Post public notice; log any objections for 30 days'],
          ['6 — Appeal period',          'appeal',                  'Planner',              'Handle objection hearings if received'],
          ['7 — Approved',               'approved',                'Planner (EO)',         'Issue signed permit; update spatial record'],
          ['8 — Conditionally approved', 'conditionally_approved',  'Planner',              'Issue permit with listed conditions'],
          ['9 — Building permit issued', 'building_permit_issued',  'Building Inspector',   'Sign-off on building plans; permit issued'],
          ['10 — Foundation inspection', 'foundation_insp',         'Building Inspector',   'Stage 1 site inspection before foundations'],
          ['11 — Superstructure insp.',  'superstructure_insp',     'Building Inspector',   'Stage 2 inspection — walls at plate height'],
          ['12 — Roofing inspection',    'roofing_insp',            'Building Inspector',   'Stage 3 inspection — roof structure'],
          ['13 — Final inspection',      'final_insp',              'Building Inspector',   'Stage 4 — complete works'],
          ['14 — Occupation certificate','occupation_issued',       'Planner (EO)',         'Issue certificate of occupation; close file'],
        ]
      ),
      blankLine(),
      h2('3.3 Document Routing Between Departments'),
      para('When an application reaches consultation (stage 4), the system emits a workflow_notification to the following roles:'),
      bullet('surveyor — app_verification queued for site-plan cadastral check'),
      bullet('env_officer — plan_appraisal queued for health/environmental review'),
      bullet('building_inspector — building_plan_appraisal queued'),
      bullet('gis_officer — application_mapping queued for spatial record'),
      para('Each role sees a badge counter on their dashboard. The notification links directly to the permit application ID so the officer can open the correct case immediately.'),
      blankLine(),

      // ── Section 4: Planner Workspace ─────────────────────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('4. Town Planning Officer (Planner) Workspace'),
      h2('4.1 Dashboard'),
      para('Route: /planner-workspace → Dashboard section. Polls /api/permit-applications every 30 seconds for newly submitted applications. KPI cards show active permits, approved, open enforcement orders, and clock-pressure deadlines.'),
      blankLine(),
      h2('4.2 Statutory Workflow'),
      para('Drives each permit through all 14 stages. Each stage transition:'),
      bullet('Records the status change in permit_applications.status'),
      bullet('Emits a workflow_notification to the next responsible department'),
      bullet('Updates the statutory clock (56-day outer limit from receipt)'),
      blankLine(),
      h2('4.3 Permit Register (Annexure 2 Development Register)'),
      para('Searchable, filterable table of all permits. Exports to CSV. Falls back to demo data when backend is unavailable.'),
      h2('4.4 Enforcement & Prohibition Orders'),
      para('Issues Section 32 enforcement orders (stop-work, demolition, rectification, removal, cessation) and Section 34 prohibition orders. Each order is plotted on the GIS Officer enforcement map.'),
      h2('4.5 Building Plans Appraisal'),
      para('Selects a permit and reviews all plan revisions. Can approve, approve-with-conditions, or reject. Rejection triggers re-submission workflow.'),
      blankLine(),

      // ── Section 5: Surveyor Workspace ────────────────────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('5. Surveyor Workspace'),
      flowTable(
        ['Section', 'Function'],
        [
          ['Dashboard',         'Workload summary — pegging queue, encroachment alerts, upcoming setting-outs'],
          ['Cadastral',         'Stand register (stand number, title deed, SG diagram, area, coordinates) + beacon records + servitudes. Persisted in localStorage (surveyor_stand_register_v1).'],
          ['Layouts',           'Pre-layout → designed → verified → DPP approved → pegging → completed pipeline. Supports document upload (PDF, DWG, PNG). Files stored locally via FileReader.'],
          ['App Verification',  'Loads all permits under_review/consultation. Cross-checks stand_number against cadastral register. 9-item verification checklist.'],
          ['Construction',      'Stage 1 setting-out for approved permits. 5-item checklist (boundaries, building lines, site plan match, levels, pegs intact). Records verdict: pass/conditional/fail.'],
          ['Enforcement Support','Boundary disputes + encroachment documentation. Court-evidence survey records.'],
          ['Reports',           'Periodic cadastral reports exportable to CSV.'],
          ['Reference',         'Land Survey Act [Ch. 20:12] + building lines + standard coordinates.'],
        ]
      ),
      blankLine(),

      // ── Section 6: Environmental Officer Workspace ────────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('6. Environmental Health Officer Workspace'),
      flowTable(
        ['Section', 'Function'],
        [
          ['Dashboard',           'EHO workload: pending plan appraisals, active enforcement, outstanding certificates'],
          ['Plan Appraisal',      'Reviews building plans for ventilation (window area ≥ 10%), sanitation (WC ratios), hygiene (wash basins), floor area and construction standards'],
          ['Inspections',         'Pre-occupation environmental inspections. Pass/fail/conditional verdict.'],
          ['Enforcement',         'Issues environmental enforcement notices under PEZA and Public Health Act.'],
          ['Surveillance',        'Tracks ongoing site surveillance for approved developments.'],
          ['Certificates',        'Issues certificate of compliance (environmental) before Occupation Certificate.'],
          ['Reports',             'Monthly and quarterly environmental reports.'],
        ]
      ),
      blankLine(),

      // ── Section 7: GIS Officer Portal ────────────────────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('7. GIS Officer Portal'),
      h2('7.1 Spatial Database (CRUD)'),
      para('13 GIS layers managed via the Spatial Database section. Each record tracks: layer_name, category, feature_count, coordinate_system, source, is_public, last_updated_at. Persisted in localStorage (gis_layer_registry_v1).'),
      blankLine(),
      h2('7.2 Application Mapping'),
      para('Plots all permit applications as MapLibre GL markers on the Council area map. Colour-coded by status. Click any marker for full permit details.'),
      blankLine(),
      h2('7.3 Environmental Constraints Layer'),
      para('Four constraint polygons: Vungu wetland (EMA), River buffer (30 m), Scenic beauty area (RTCP s.22), Tributary buffer. Each layer can be toggled individually via the Eye/EyeOff button in the legend. Any permit overlapping a constraint is flagged for EMA referral.'),
      blankLine(),
      h2('7.4 Enforcement Mapping'),
      para('Section 32/34 orders plotted as coloured circles. Colour by order type: stop-work (red), demolition (dark red), rectification (amber), removal (purple), cessation (crimson). New orders can be manually plotted via the "Plot new order" form when backend data is unavailable.'),
      blankLine(),

      // ── Section 8: Admin ─────────────────────────────────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('8. IT Administration'),
      h2('8.1 User & Access Management'),
      para('The Admin portal (/admin) manages all staff accounts. The Admin can:'),
      bullet('Invite employees by email — generates a one-time /invite?token= link'),
      bullet('Assign roles: admin, planner, viewer'),
      bullet('Suspend, reactivate, and remove users'),
      bullet('View the org chart (Vungu RDC Planning & Environment Department)'),
      blankLine(),
      h2('8.2 KYC / Identity Verification'),
      para('All citizen identity submissions are reviewed in the KYC/Identity tab. The IT Admin approves or rejects each submission with optional reviewer notes. Approved citizens can progress their applications through the workflow.'),
      blankLine(),
      h2('8.3 Subscription Timer'),
      para('The Subscription tab shows a real-time countdown to system licence expiry. The Admin can enter a reactivation key (format: SPATIALIQ-YYYYMMDD-XXXX) to extend the licence. The expiry date is stored in localStorage key spatialiq_subscription_expiry.'),
      blankLine(),

      // ── Section 9: Payments ──────────────────────────────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('9. Payment Gateway Integration'),
      h2('9.1 Supported Methods'),
      flowTable(
        ['Gateway', 'Currency', 'Trigger', 'Status'],
        [
          ['Paynow (Zimbabwe)',   'USD / ZiG', 'POST /api/payments/initiate with method=paynow',   'Live — requires PAYNOW_INTEGRATION_ID + KEY in .env'],
          ['EcoCash',            'ZiG',        'POST /api/payments/initiate with method=ecocash',  'Live — requires ECOCASH_MERCHANT_CODE in .env'],
          ['OneMoney',           'ZiG',        'POST /api/payments/initiate with method=onemoney', 'Live — requires ONEMONEY_MERCHANT_CODE in .env'],
          ['Stripe (card)',      'USD',        'POST /api/payments/initiate with method=stripe',   'Live — requires STRIPE_SECRET_KEY in .env'],
        ]
      ),
      blankLine(),
      h2('9.2 Payment Flow'),
      numBullet('Citizen selects service type → system looks up fee schedule (/api/payments/fees/:serviceId)', 0),
      numBullet('Citizen chooses payment method → POST /api/payments/initiate returns refNo', 0),
      numBullet('For Paynow/EcoCash: citizen is redirected to gateway; webhook confirms payment', 0),
      numBullet('POST /api/payments/confirm/:refNo → status updated, receipt generated', 0),
      numBullet('GET /api/payments/receipt/:refNo → printable receipt shown at /receipt/:refNo', 0),
      blankLine(),

      // ── Section 10: Cross-Dept Notifications ─────────────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('10. Cross-Department Workflow Notifications'),
      para('When a permit application changes status, the backend emits a workflow_notification record. Every role dashboard polls /api/notifications/unread-count on mount and displays a badge. The notification links directly to the permit_application_id.'),
      blankLine(),
      flowTable(
        ['Trigger Event', 'Notified Role(s)', 'Message'],
        [
          ['Application registered',    'planner, planning_clerk',        'New application VGU-2026-XXXX received'],
          ['Status → consultation',     'surveyor, env_officer, building_inspector, gis_officer', 'Application requires your department\'s input'],
          ['Enforcement order issued',  'planner, gis_officer',           'Section 32 order ENF-2026-XXXX plotted'],
          ['KYC approved',              'planner',                        'Identity verified — citizen can now submit applications'],
          ['Building plan rejected',    'applicant (planner notifies)',   'Plan revision required: <notes>'],
          ['Occupation cert issued',    'all roles',                      'File closed: occupation certificate issued for VGU-2026-XXXX'],
        ]
      ),
      blankLine(),

      // ── Section 11: Production Deployment ───────────────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('11. Production Deployment Checklist'),
      h2('11.1 Backend (Render)'),
      bullet('Set DATABASE_URL to Render PostgreSQL connection string'),
      bullet('Set JWT_SECRET (min 32-char random string)'),
      bullet('Run node scripts/migrate-render.js (applies migrations 001–075)'),
      bullet('Set PAYNOW_INTEGRATION_ID, PAYNOW_INTEGRATION_KEY for payments'),
      bullet('Set STAGE_PHOTO_ROOT to a writable directory for inspection photos'),
      blankLine(),
      h2('11.2 Frontend (Vercel)'),
      bullet('Set VITE_API_BASE_URL to your Render backend URL'),
      bullet('vercel.json rewrites /api/* to backend — already configured'),
      bullet('Build command: npm run build  |  Output: dist/'),
      blankLine(),
      h2('11.3 Database'),
      bullet('PostgreSQL 14+ with PostGIS extension enabled'),
      bullet('Run CREATE SCHEMA IF NOT EXISTS spatial_planning before migrations'),
      bullet('Migration 075 creates: workflow_notifications + kyc_verifications'),
      blankLine(),

      // ── Appendix ─────────────────────────────────────────────────────────
      new Paragraph({ text: '', pageBreakBefore: true }),
      h1('Appendix A: API Endpoint Summary'),
      flowTable(
        ['Category', 'Key Endpoints'],
        [
          ['Auth',             'POST /api/auth/login, POST /api/auth/register, POST /api/auth/invite, GET /api/auth/me'],
          ['Permit apps',      'POST/GET /api/permit-applications, PATCH /api/permit-applications/:id/status'],
          ['Enforcement',      'POST/GET /api/enforcement-orders, PATCH /api/enforcement-orders/:id/status'],
          ['Building plans',   'POST/GET /api/permit-applications/:id/building-plans, PATCH /api/building-plans/:id/appraisal'],
          ['Inspections',      'POST/GET /api/permit-applications/:id/stage-inspections, GET /api/inspector/queue'],
          ['Payments',         'POST /api/payments/initiate, POST /api/payments/confirm/:ref, GET /api/payments/receipt/:ref'],
          ['Notifications',    'GET/POST /api/notifications, PATCH /api/notifications/read-all'],
          ['KYC',              'POST /api/kyc, GET /api/kyc, PATCH /api/kyc/:id/approve, PATCH /api/kyc/:id/reject'],
          ['Spatial tiles',    'GET /api/tiles/layers, GET /api/tiles/:layer/:z/:x/:y.pbf'],
          ['Stands',           'GET /api/stands, GET /api/stands/:id, GET /api/available-stands'],
        ]
      ),
      blankLine(),
      new Paragraph({
        children: [new TextRun({
          text: `Generated by SpartialIQ system on ${new Date().toLocaleString('en-GB')}`,
          size: 18, italics: true, color: '94a3b8',
        })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 600 },
      }),
    ],
  }],
})

const outDir = path.resolve(__dirname, '..', 'docs')
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'SpartialIQ_Process_Flows.docx')

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(outPath, buffer)
  console.log(`✅ Process flow document written to: ${outPath}`)
}).catch(err => {
  console.error('❌ Failed to generate DOCX:', err.message)
  process.exit(1)
})
