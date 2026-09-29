/**
 * Four detailed architecture docs for Vungu / SpartialIQ.
 * Run: node scripts/generate-four-architecture-docs.js
 */
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, WidthType, AlignmentType, ShadingType, PageBreak,
  Header, Footer, PageNumber,
} = require('docx')
const fs = require('fs')
const path = require('path')

const BLUE = '1E3A5F'
const ACCENT = '0F766E'
const LIGHT = 'F0FDFA'
const MONO = 'Consolas'

const h1 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 360, after: 160 },
  children: [new TextRun({ text: t, bold: true, color: BLUE, size: 28 })],
})
const h2 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 260, after: 120 },
  children: [new TextRun({ text: t, bold: true, color: ACCENT, size: 24 })],
})
const h3 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 180, after: 80 },
  children: [new TextRun({ text: t, bold: true, size: 22 })],
})
const p = (t) => new Paragraph({
  spacing: { after: 140 },
  children: [new TextRun({ text: t, size: 21 })],
})
const bullet = (t) => new Paragraph({
  spacing: { after: 70 },
  indent: { left: 360 },
  children: [new TextRun({ text: `• ${t}`, size: 20 })],
})
const numbered = (n, t) => new Paragraph({
  spacing: { after: 70 },
  indent: { left: 360 },
  children: [new TextRun({ text: `${n}. ${t}`, size: 20 })],
})
const blank = () => new Paragraph({ text: '', spacing: { after: 60 } })
const pageBreak = () => new Paragraph({ children: [new PageBreak()] })
const diagram = (lines) => lines.map((line) => new Paragraph({
  spacing: { after: 0 },
  shading: { type: ShadingType.CLEAR, fill: LIGHT },
  children: [new TextRun({ text: line || ' ', font: MONO, size: 14 })],
}))
const note = (t) => new Paragraph({
  spacing: { after: 120 },
  shading: { type: ShadingType.CLEAR, fill: 'FEF3C7' },
  children: [new TextRun({ text: `Note: ${t}`, italics: true, size: 19 })],
})

function cell(text, header = false, width = 2250) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: header ? { type: ShadingType.CLEAR, fill: BLUE } : undefined,
    margins: { top: 50, bottom: 50, left: 60, right: 60 },
    children: [new Paragraph({
      children: [new TextRun({
        text: String(text), size: 16, bold: header,
        color: header ? 'FFFFFF' : '000000',
      })],
    })],
  })
}
function table(headers, rows) {
  const colW = Math.floor(9000 / headers.length)
  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    columnWidths: headers.map(() => colW),
    rows: [
      new TableRow({ children: headers.map((h) => cell(h, true, colW)) }),
      ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false, colW)) })),
    ],
  })
}

function cover(title, subtitle, pagesHint) {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: 'Vungu Rural District Council', bold: true, size: 32, color: BLUE })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: 'SpartialIQ · Spatial Operations & Planning Platform', size: 20, color: '64748B' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [new TextRun({ text: title, bold: true, size: 40 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
      children: [new TextRun({ text: subtitle, italics: true, size: 20, color: '475569' })],
    }),
    table(['Field', 'Value'], [
      ['Document date', '23 September 2026'],
      ['Audience', 'Supervisors, ICT, planners, GIS, auditors'],
      ['Companion docs', 'Role Expectations; Flows Manual; Supervisor Rectification'],
      ['Scope', pagesHint || 'Detailed technical + Zimbabwe practice'],
      ['Classification', 'Internal Council / project delivery'],
    ]),
    blank(),
    p('This document is part of a four-part architecture set: (1) Conceptual Model, (2) Logical Model, (3) Physical Model, (4) Expected / Needed / Delivered with Zimbabwe sources. Read them in order for a complete picture.'),
    blank(),
  ]
}

function toc(items) {
  return [
    h1('Contents'),
    ...items.map((t, i) => new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: `${i + 1}. ${t}`, size: 20 })],
    })),
    blank(),
  ]
}

function docShell(title, children) {
  return new Document({
    creator: 'SpartialIQ',
    title,
    sections: [{
      properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
      headers: {
        default: new Header({
          children: [new Paragraph({
            children: [new TextRun({ text: `Vungu RDC · SpartialIQ · ${title}`, size: 14, color: '64748B' })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Page ', size: 14, color: '64748B' }),
              new TextRun({ children: [PageNumber.CURRENT], size: 14, color: '64748B' }),
              new TextRun({ text: ' of ', size: 14, color: '64748B' }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14, color: '64748B' }),
            ],
          })],
        }),
      },
      children,
    }],
  })
}

async function writeDoc(filename, title, children) {
  const buf = await Packer.toBuffer(docShell(title, children))
  const docsDir = path.join(__dirname, '..', 'docs')
  fs.mkdirSync(docsDir, { recursive: true })
  const out = path.join(docsDir, filename)
  fs.writeFileSync(out, buf)
  try { fs.writeFileSync(path.join(__dirname, '..', '..', filename), buf) } catch { /* open lock ok */ }
  console.log('Wrote', out, `(${buf.length} bytes)`)
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 CONCEPTUAL — very detailed
// ═══════════════════════════════════════════════════════════════════════════
async function conceptual() {
  const c = [
    ...cover(
      '1 — Conceptual Model',
      'Business meaning of the Vungu spatial planning & council operations system',
      'Concepts, domains, entities, rules, actors, Zimbabwe legal anchors',
    ),
    ...toc([
      'Purpose and audience',
      'Zimbabwe legal and institutional context',
      'System mission and scope boundaries',
      'Core business domains',
      'Conceptual entities catalogue',
      'Relationships and life-cycles',
      'Business rules and invariants',
      'Actors and responsibilities',
      'Information quality and trust',
      'Conceptual architecture views',
      'Glossary',
    ]),
    pageBreak(),

    h1('1. Purpose and audience'),
    p('The conceptual model answers: what is this system about in the real world? It deliberately avoids Postgres table names, API paths, and UI widgets. Those belong in the logical and physical models. Here we name the things Council must manage — land, people, decisions, evidence, money, notices, inspections — and how Zimbabwe law expects them to relate.'),
    p('Primary readers are supervisors who must confirm the platform matches council duty; planners and GIS officers who must agree on meaning; ICT staff who will implement; and auditors who need a clear story of intent. Secondary readers are training officers and new staff learning the digital office.'),
    p('This model is descriptive of Vungu Rural District Council’s adopted digital practice as embodied in SpartialIQ. Where Council later passes a resolution that changes process, the conceptual model should be updated in the same release cycle as the software.'),

    h1('2. Zimbabwe legal and institutional context'),
    h2('2.1 Instruments that shape concepts'),
    table(['Instrument', 'Conceptual impact'], [
      ['RTCP Act [Chapter 29:12]', 'Creates planning authority duties: plans, permits, subdivision, enforcement, appeals'],
      ['RDC Act [Chapter 29:13]', 'Creates the council as local authority; committees; administration'],
      ['Public Health Act 2018', 'Requires EHOs; premises, nuisances, food/water, burial; enforceable notices'],
      ['Land Survey Act [20:12]', 'Cadastral survey examination by Surveyor-General'],
      ['Land Surveyors Act [27:06]', 'Who may practise land surveying'],
      ['Council by-laws & resolutions', 'Local fee schedules, delegated decision-makers, notice practice'],
      ['Adopted master/local plans', 'The spatial policy the permit concept must obey'],
    ]),
    p('Conceptually, SpartialIQ is an instrument of the local planning authority and related council departments. It does not replace the Surveyor-General, the Deeds Registry, the courts, or the Ministry of Lands. It records Council’s side of the story with enough fidelity that an officer can defend a file.'),

    h2('2.2 Institutional actors outside the system'),
    bullet('Surveyor-General — examines cadastral surveys; issues diagram/approval that Deeds rely on.'),
    bullet('Deeds Registry — registers title; Council systems prepare evidence but do not grant title.'),
    bullet('Provincial / national planning oversight — may call in or advise on certain applications.'),
    bullet('Courts / Administrative Court — final appeal venues beyond the software’s appeal register.'),
    bullet('Utility providers — often consulted; not owned by Council’s GIS.'),
    note('Whenever a concept sounds like “title” or “final cadastral reality,” check whether the real owner of truth is SG/Deeds. The conceptual model must stay honest.'),

    h1('3. System mission and scope boundaries'),
    h2('3.1 In scope (conceptual)'),
    numbered(1, 'Receiving and tracking development-related applications and related fees.'),
    numbered(2, 'Assessing applications against plans, standards, and spatial context.'),
    numbered(3, 'Recording consultations, objections, committee advice, and determinations.'),
    numbered(4, 'Issuing or logging acknowledgements, refusals, public notices, and permit dispatch.'),
    numbered(5, 'Scheduling and recording building-stage and environmental-health inspections.'),
    numbered(6, 'Maintaining authoritative council spatial themes (zones, stands, ops assets when imported).'),
    numbered(7, 'Giving citizens a path to apply, pay (where configured), complain, and track tickets.'),
    numbered(8, 'Coordinating survey jobs that support planning without claiming Deeds powers.'),

    h2('3.2 Out of scope (conceptual)'),
    bullet('National cadastre ownership and SG examination workflow itself.'),
    bullet('Full municipal billing / valuation roll as a finance ERP (tickets may stub requests).'),
    bullet('Replacing committee minutes systems if Council keeps a separate minute book (software may assist).'),
    bullet('Guaranteeing OSM/OpenStreetMap geometry as cadastral truth.'),

    h1('4. Core business domains'),
    p('The platform is one composition of nine interlocking domains. Each domain has a clear purpose; none should swallow another.'),
    ...diagram([
      ' ┌──────────────────────── VUNGU RDC DIGITAL OFFICE ────────────────────────┐',
      ' │                                                                          │',
      ' │  [Plan-making]     [Development control]     [Clerking & records]         │',
      ' │  [GIS / spatial]   [Building inspection]     [Environmental health]       │',
      ' │  [Survey liaison]  [Council ops assets]      [Citizen multi-counter]      │',
      ' │                                                                          │',
      ' │              Identity & roles  ·  Audit & evidence  ·  Payments            │',
      ' └──────────────────────────────────────────────────────────────────────────┘',
    ]),
    h3('4.1 Plan-making'),
    p('Creating and maintaining the spatial policy: statutory plans, themes, revision history, and public-facing plan content. Conceptually this is “what the land is supposed to become,” not “who may build tomorrow.” Tomorrow’s permit must cite today’s plan.'),
    h3('4.2 Development control'),
    p('The casework of applications: lodging, screening, circulation, objection periods, technical assessment, determination, conditions, appeals, and enforcement triggers. This is the heart of RTCP practice in software.'),
    h3('4.3 Clerking and records'),
    p('The memory of the process: fee receipts, acknowledgements within expected clocks, correspondence logs, notice certificates, abutters, refusal letters, and permit dispatch. Without clerking, assessment is opinion; with clerking, assessment is a defendable file.'),
    h3('4.4 GIS / spatial authority'),
    p('Holding geometries and attributes Council trusts for zoning, stands, and operational assets. Distinguishes authoritative layers from reference basemaps. Protects write access so map truth cannot be casually overwritten.'),
    h3('4.5 Building inspection'),
    p('Field verification that construction matches approved plans at defined stages, plus response to illegal-building complaints. Produces evidence (verdicts, photos, scores) that can stop or unlock later stages.'),
    h3('4.6 Environmental health'),
    p('Premises inspections, programmes, certificates, and health notices under the Public Health Act — separate from planning permits even when the same building is involved.'),
    h3('4.7 Survey liaison'),
    p('Jobs and documents that connect Council need to licensed survey practice. The concept ends where SG examination and Deeds begin.'),
    h3('4.8 Council operations assets'),
    p('Roads, WASH, livestock facilities, and similar registers that other committees care about. May start empty until GeoJSON/GPKG import — emptiness is a valid conceptual state (“no inventory yet”).'),
    h3('4.9 Citizen multi-counter'),
    p('One front door for applications, map exploration, complaints, service tickets (trading licence, nuisance, roads, etc.), and status tracking — without pretending every backend module is a full ERP.'),

    pageBreak(),
    h1('5. Conceptual entities catalogue'),
    p('Each entity below is a thing officers can point to in a conversation. Synonyms in brackets show common Zimbabwe office language.'),

    h2('5.1 People and authority'),
    table(['Entity', 'Definition', 'Examples'], [
      ['Person', 'Human individual known to the system', 'Applicant, officer, councillor'],
      ['Organisation', 'Legal person acting as applicant or partner', 'Company, NGO, Ministry'],
      ['Party', 'Person or Organisation in a case role', 'Owner, agent, complainant'],
      ['Staff member', 'Person employed/contracted by Council', 'Planner, EHO, clerk'],
      ['Role', 'Bundle of duties and system powers', 'eo, planner, gis_officer'],
      ['Delegation', 'Authority assigned by resolution/policy', 'EO may determine Class X'],
      ['Committee', 'Council body that advises or decides', 'Planning committee'],
    ]),

    h2('5.2 Land and space'),
    table(['Entity', 'Definition', 'Notes'], [
      ['Ward', 'Administrative geography unit of the RDC', 'Often used for reporting'],
      ['Zone / land-use zone', 'Policy area with permitted use pattern', 'Must be SSOT for permits'],
      ['Stand', 'Council-recognised plot for allocation/control', 'May await survey formalisation'],
      ['Parcel / farm', 'Broader land unit (esp. rural)', 'May pre-exist stand creation'],
      ['Site', 'Place of a proposed development', 'May be point + description'],
      ['Spatial layer', 'Named map theme with geometry', 'Authoritative vs reference'],
      ['Feature', 'One geometry+attributes on a layer', 'Road segment, stand polygon'],
      ['Control point', 'Survey/geodetic reference marker', 'Supports survey jobs'],
    ]),

    h2('5.3 Applications and decisions'),
    table(['Entity', 'Definition', 'Notes'], [
      ['Development application', 'Request for planning permission / related consent', 'Core RTCP case'],
      ['Application type', 'Class of request', 'Building, subdivision, COU'],
      ['Status', 'Lawful position in the process', 'Not free text forever'],
      ['Referral / consultation', 'Ask to another organ for comment', 'Utilities, EHO, etc.'],
      ['Objection', 'Public or neighbour opposition logged', 'During notice period'],
      ['Assessment', 'Planner’s technical evaluation', 'Not yet determination'],
      ['Determination', 'Binding approve/refuse/conditional act', 'EO or delegated'],
      ['Condition', 'Binding requirement on approval', 'Must be trackable'],
      ['Appeal', 'Challenge to a determination', 'Internal register + courts'],
      ['Enforcement case', 'Action against unlawful development', 'May start from complaint'],
    ]),

    h2('5.4 Money, documents, notices'),
    table(['Entity', 'Definition'], [
      ['Fee', 'Amount due for a service under schedule'],
      ['Receipt', 'Proof of payment logged to a case'],
      ['Payment', 'Money movement (manual or gateway)'],
      ['Document / artefact', 'PDF, plan, photo, certificate stored to the file'],
      ['Acknowledgement letter', 'Formal receipt of a complete application'],
      ['Refusal letter', 'Formal communication of refusal with reasons'],
      ['Public notice', 'Advertisement/notice for consultation'],
      ['Notice certificate', 'Proof that notice was given as required'],
      ['Permit dispatch', 'Issue of the approved permit package'],
      ['Correspondence', 'Any other letter/email logged to the register'],
    ]),

    h2('5.5 Field work and health'),
    table(['Entity', 'Definition'], [
      ['Inspection', 'Scheduled or reactive site visit with recorded verdict'],
      ['Inspection stage', 'Named building stage (foundation, slab, …)'],
      ['Finding / score', 'Structured result against checklist'],
      ['Photo evidence', 'Image tied to inspection or complaint'],
      ['Building complaint', 'Allegation of illegal/unsafe building'],
      ['Premises', 'Place subject to health control'],
      ['Health notice', 'Enforceable direction under Public Health Act'],
      ['Health certificate / clearance', 'Positive health outcome recorded'],
      ['Programme', 'Planned EHO campaign (e.g. food hygiene)'],
    ]),

    h2('5.6 Operations and citizen service'),
    table(['Entity', 'Definition'], [
      ['Road asset', 'Maintained road feature in ops register'],
      ['WASH asset', 'Water/sanitation feature'],
      ['Livestock facility', 'Dip tank, auction pen, etc.'],
      ['Service ticket', 'Citizen request not (yet) a full DC case'],
      ['Residency claim', 'Citizen residency verification case (as configured)'],
      ['Notification', 'Alert to a party about a case event'],
    ]),

    h1('6. Relationships and life-cycles'),
    h2('6.1 Primary relationship diagram'),
    ...diagram([
      '  Party ──lodges──► DevelopmentApplication ──about──► Site/Stand/Parcel',
      '       │                     │                              │',
      '       │                     ├──has──► Fees/Receipts         ├──in──► Ward',
      '       │                     ├──has──► Documents             └──in──► Zone',
      '       │                     ├──has──► Letters/Notices',
      '       │                     ├──triggers──► Referrals/Objections',
      '       │                     ├──assessed-by──► Planner (Role)',
      '       │                     ├──determined-by──► EO/Delegate (Role)',
      '       │                     ├──may-need──► Inspections',
      '       │                     └──may-spawn──► Appeal / Enforcement',
      '  Complainant ──opens──► Ticket or BuildingComplaint ──assigned──► Inspector/EHO',
      '  Surveyor ──executes──► SurveyJob ──supports──► Application or Stand creation',
      '  GIS Officer ──maintains──► SpatialLayer ──describes──► Land/Assets',
    ]),

    h2('6.2 Application life-cycle (conceptual)'),
    p('Conceptually an application is born when a party asks Council for a planning decision and pays or undertakes to pay the due fee. It matures through acknowledgement (Council has a complete enough file), circulation and objection (others may speak), assessment (planner advises), determination (lawful decision-maker decides), and post-decision (dispatch, conditions monitoring, or appeal).'),
    ...diagram([
      '  INTENT → FEE/REGISTER → ACKNOWLEDGE → CONSULT/OBJECT → ASSESS',
      '       → DETERMINE (approve / conditional / refuse)',
      '       → DISPATCH or REFUSAL LETTER',
      '       → [optional] APPEAL → re-enter DETERMINE',
      '       → [parallel] INSPECT stages if building proceeds',
    ]),

    h2('6.3 Land life-cycle (conceptual)'),
    p('Land may exist first as a farm or undesignated parcel, then as a planned layout, then as stands, then as surveyed parcels with SG approval, then as titled property. Council’s conceptual responsibility shifts along that chain: plan and control early; coordinate survey mid-way; respect Deeds at the end.'),

    h2('6.4 Complaint-to-enforcement path'),
    p('A citizen tip may become a building complaint or service ticket. Inspection may confirm breach. Conceptually that can feed enforcement under RTCP or health notices under the Public Health Act. The software must not collapse these into one vague “issue” without a type.'),

    h1('7. Business rules and invariants'),
    h3('R1 — Separation of assessment and determination'),
    p('The person who writes the technical assessment must not, by default, be assumed to be the final decision-maker. Where Council delegates determination to the EO (or another role), the system concept must enforce that gate.'),
    h3('R2 — No determination without a file'),
    p('A determination concept requires an application identity, status history, and enough documents to show what was decided.'),
    h3('R3 — Spatial decisions cite authoritative geography'),
    p('Zoning and stand decisions must reference Council’s authoritative zone/stand concepts, not an anonymous OSM polygon.'),
    h3('R4 — Health ≠ planning'),
    p('A trading licence or health clearance is not a development permit. Tickets and EHO registers stay conceptually distinct even if one building needs both.'),
    h3('R5 — Cadastre honesty'),
    p('Survey jobs and stand polygons in Council systems do not by themselves create title. Language in letters and UI must not imply otherwise.'),
    h3('R6 — Empty registers are allowed'),
    p('Ops asset registers may be empty until import. Empty means “not loaded,” not “Council has zero roads.” Dashboards must not invent fake completeness.'),
    h3('R7 — Auditability'),
    p('Every material state change should be attributable to a person (or system actor) at a time, for supervision and court readiness.'),
    h3('R8 — Citizen least privilege'),
    p('Citizens see their own cases and public map themes; they do not see other people’s confidential files.'),

    pageBreak(),
    h1('8. Actors and responsibilities'),
    table(['Actor', 'Conceptual duty'], [
      ['Citizen / applicant', 'Lodge truthfully; pay fees; respond to requests; track status'],
      ['Planning clerk', 'Receive, receipt, acknowledge, register, notice, dispatch/refuse letters'],
      ['Planner', 'Assess against plan/standards; recommend; never silently final-approve if EO gate applies'],
      ['Executive Officer (EO)', 'Determine (or ensure lawful determination); own returns/escalations'],
      ['GIS officer', 'Protect spatial SSOT; publish themes; control write access'],
      ['Building inspector', 'Verify stages; evidence illegal building; feed enforcement'],
      ['EHO', 'Inspect premises; issue/track health notices; run programmes'],
      ['Surveyor (licensed)', 'Execute survey jobs; submit products toward SG path'],
      ['Admin / ICT', 'Accounts, roles, platform health, security configuration'],
      ['Committee / Council', 'Policy, fees, delegations — software must respect their resolutions'],
    ]),

    h1('9. Information quality and trust'),
    p('Conceptually every fact has a trust class: (A) Council-authoritative (zones SSOT, permit status, clerk letters); (B) Field-evidenced (inspection photos, GPS); (C) Citizen-asserted (application claims until checked); (D) Reference-only (OSM buildings for context). Mixing trust classes without labelling them is a conceptual failure.'),
    bullet('Authoritative facts drive decisions and letters.'),
    bullet('Field-evidenced facts support compliance.'),
    bullet('Citizen-asserted facts start a case but must be validated.'),
    bullet('Reference facts orient the map but must not silently become cadastre.'),

    h1('10. Conceptual architecture views'),
    h2('10.1 Capability view'),
    p('Capabilities = domains in section 4. Each capability exposes services to actors (apply, assess, determine, inspect, publish map, open ticket). Capabilities share identity, audit, and document services.'),
    h2('10.2 Event view (selected)'),
    bullet('ApplicationSubmitted → fee check → register'),
    bullet('ApplicationAcknowledged → clocks start for statutory letters'),
    bullet('ObjectionPeriodClosed → assessment may conclude'),
    bullet('AwaitingEoDecision → EO must act'),
    bullet('ApplicationDetermined → dispatch or refusal path'),
    bullet('InspectionFailed → block or flag related building stage'),
    bullet('HealthNoticeIssued → EHO follow-up required'),
    bullet('TicketOpened → route to owning department conceptually'),

    h1('11. Glossary'),
    table(['Term', 'Meaning in this model'], [
      ['SSOT', 'Single source of truth — one authoritative concept for a fact'],
      ['Determination', 'Final planning decision on an application'],
      ['EO gate', 'Rule that EO (or delegate) must determine, not the assessor alone'],
      ['Stand', 'Council plot unit used in allocation/control'],
      ['Zone', 'Land-use policy area'],
      ['Ticket', 'Service desk request distinct from full DC application'],
      ['Basemap', 'Reference geography (often OSM) not council cadastre'],
      ['Trust class', 'How strongly a fact may drive legal decisions'],
    ]),
    blank(),
    p('End of Conceptual Model. Continue to Logical Model for entities, keys, and normalisation.'),
  ]
  await writeDoc('01_Conceptual_Model.docx', 'Conceptual Model', c)
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 LOGICAL — very detailed
// ═══════════════════════════════════════════════════════════════════════════
async function logical() {
  const c = [
    ...cover(
      '2 — Logical Model',
      'Entities, attributes, keys, relationships, normalisation, and state machines',
      'DBMS-independent design that the physical Postgres model implements',
    ),
    ...toc([
      'Purpose and design principles',
      'Subject areas and namespaces',
      'Identity and access entities',
      'Land and zoning entities',
      'Development control entities',
      'Clerking entities',
      'Inspection and health entities',
      'Operations and tickets',
      'GIS content entities',
      'Survey entities',
      'Normalisation (3NF) decisions',
      'State machines',
      'Logical security model',
      'CRUD matrices by role',
      'Integrity rules',
    ]),
    pageBreak(),

    h1('1. Purpose and design principles'),
    p('The logical model translates conceptual things into structured entities with attributes, candidate keys, foreign keys, and constraints. It still avoids vendor-specific types where possible, but it is precise enough that two implementers would build compatible schemas.'),
    bullet('P1 — 3NF by default for transactional data (no transitive dependencies).'),
    bullet('P2 — Reference entities for repeating codes (status, scale, zone type).'),
    bullet('P3 — Preserve backward-compatible aliases when reforming legacy attributes.'),
    bullet('P4 — Separate authentication identity from biographical profile.'),
    bullet('P5 — Spatial attributes are first-class (geometry + SRID policy deferred to physical).'),
    bullet('P6 — Soft-delete and audit fields where cases have legal memory.'),

    h1('2. Subject areas and namespaces'),
    table(['Logical namespace', 'Responsibility'], [
      ['Identity', 'Users, profiles, roles, sessions, invites'],
      ['CadastreLand', 'Wards, zones, stands, parcels, topology helpers'],
      ['DevControl', 'Applications, statuses, conditions, appeals, planner cases'],
      ['Clerking', 'Fees, letters, notices, correspondence registers'],
      ['Inspections', 'Building stages, scores, photos, complaints'],
      ['EnvHealth', 'Premises, notices, certificates, programmes'],
      ['CouncilOps', 'Roads, WASH, livestock, service desk'],
      ['GisContent', 'Layers, features, styles, catalogues, site content'],
      ['Survey', 'Jobs, tasks, tenant isolation'],
      ['PaymentsDocs', 'Payments, documents, generated PDFs'],
    ]),

    h1('3. Identity and access entities'),
    h2('3.1 User'),
    bullet('UserId (PK), Email (UK), PasswordHash, RoleCode, IsActive, CreatedAt, LastLoginAt'),
    bullet('Holds authentication secrets and role assignment only.'),
    h2('3.2 UserProfile (1:1 User)'),
    bullet('UserId (PK/FK), FullName, JobTitle, Department, Phone, PreferredLanguage'),
    bullet('Created so that non-auth attributes do not sit in the auth row (3NF / security hygiene).'),
    h2('3.3 Role'),
    bullet('RoleCode (PK): citizen, planner, eo, planning_clerk, gis_officer, inspector, eho, surveyor, admin, …'),
    bullet('Role is a controlled vocabulary; new codes require migration + product decision.'),
    h2('3.4 Invite / Session / MFA (as implemented family)'),
    bullet('Invite tokens for onboarding; session/MFA entities support case-locking patterns where enabled.'),

    h1('4. Land and zoning entities'),
    h2('4.1 Ward'),
    bullet('WardId (PK), Name, Code, Geometry, PropertiesJSONB'),
    h2('4.2 Zone'),
    bullet('ZoneId (PK, integer), Code, Name, ZoneTypeCode → RefZoneType, IsActive, Geometry'),
    bullet('Logical SSOT: one Zone entity used by both map publication and permit foreign keys.'),
    h2('4.3 Stand'),
    bullet('StandId (PK), StandNumber (business key), WardId (FK), ZoneId (FK integer)'),
    bullet('StatusCode → RefStandStatus; UseScaleCode → RefUseScale'),
    bullet('Geometry; optional legacy WardName / ZoneTypeCache for compatibility'),
    bullet('Derived view StandView = Stand ⨝ Ward ⨝ Zone (labels only)'),
    note('Logical rule: ZoneType is not stored as a determining attribute of Stand; it is derived from Zone to remove transitive dependency StandId → ZoneId → ZoneType.'),
    h2('4.4 Ref tables'),
    table(['Reference entity', 'Purpose'], [
      ['RefStandStatus', 'available, allocated, reserved, …'],
      ['RefScaleCategory', 'planning template scale bands'],
      ['RefUseScale', 'use intensity / scale codes'],
      ['RefZoneType', 'residential, commercial, …'],
      ['RefApplicationStatus', 'lawful permit statuses'],
    ]),

    h1('5. Development control entities'),
    h2('5.1 PermitApplication (logical)'),
    bullet('ApplicationId (PK), ApplicantUserId (FK), ApplicationType, Description'),
    bullet('LandReference (stand/parcel/textual), Geometry optional for site pin'),
    bullet('StatusCode → RefApplicationStatus'),
    bullet('SubmittedAt, AcknowledgedAt, DeterminedAt, DeterminedByUserId'),
    bullet('DecisionCode (approve/conditional/refuse), DecisionReasons, Conditions[]'),
    bullet('PaymentState, ScreeningFlags, StatutoryPlanRefs'),
    h2('5.2 StatusHistory'),
    bullet('HistoryId, ApplicationId, FromStatus, ToStatus, ChangedBy, ChangedAt, Note'),
    bullet('Append-only logical log; citizens do not read unconstrained.'),
    h2('5.3 PlannerCase / Audit'),
    bullet('Case lock, assignment, recommendation text, checklist outcomes, linked application.'),
    h2('5.4 Condition'),
    bullet('ConditionId, ApplicationId, Text, DueDate, ComplianceStatus'),
    h2('5.5 Appeal'),
    bullet('AppealId, ApplicationId, LodgedBy, LodgedAt, Grounds, OutcomeStatus'),
    h2('5.6 PublicNotice / Consultation'),
    bullet('NoticeId, ApplicationId, PublishedAt, ClosesAt, BlockingEscalationFlag'),

    pageBreak(),
    h1('6. Clerking entities'),
    p('Clerking entities exist so that statutory memory is not trapped in a browser. Each maps to a register row officers can list, filter, and mark overdue.'),
    table(['Entity', 'Key attributes', 'Clock / rule'], [
      ['FeeReceipt', 'ReceiptNo, ApplicationId?, Amount, PaidAt, Method', 'Before/at registration'],
      ['AcknowledgementLetter', 'AckId, ApplicationId, IssuedAt, DueBy', 'Target ~5 working days'],
      ['Correspondence', 'CorrId, Direction, Subject, BodyRef, At', 'Ongoing'],
      ['RefusalLetter', 'RefusalId, ApplicationId, Reasons, IssuedAt', 'Target ~7 days post-decision'],
      ['PermitDispatch', 'DispatchId, ApplicationId, DispatchedAt, Method', 'Post-approval'],
      ['NoticeCertificate', 'CertId, ApplicationId, NoticeType, CertifiedAt', 'After notice given'],
      ['AbutterLog', 'LogId, ApplicationId, NeighbourRef, ServedAt', 'Consultation'],
    ]),

    h1('7. Inspection and health entities'),
    h2('7.1 Building inspection'),
    bullet('InspectionId, ApplicationId?, SiteRef, StageCode, ScheduledAt, CompletedAt'),
    bullet('Verdict, Score, InspectorUserId; Photos[]; PerItemScores[]'),
    bullet('WorkQueueItem for inspector routing; SiteGeometry for field context'),
    h2('7.2 BuildingComplaint'),
    bullet('ComplaintId, Reference (e.g. BC-…), Complainant, Location, Status, AssignedInspector'),
    h2('7.3 Environmental health'),
    bullet('PremisesInspection, HealthNotice, Clearance, Certificate, Programme, ProgrammeVisit'),
    bullet('Logical separation preserved from PermitApplication even when addresses match.'),

    h1('8. Operations and tickets'),
    bullet('RoadAsset / WashAsset / LivestockFacility: AssetId, Name, Status, Geometry, Properties'),
    bullet('ServiceDeskTicket: TicketId, Category, Subject, Body, CitizenUserId?, Status, CreatedAt'),
    bullet('Categories include trading_licence, nuisance, roads, and other citizen multi-counter types.'),
    bullet('Tickets may later promote to full applications; logically they start lighter.'),

    h1('9. GIS content entities'),
    bullet('Layer: LayerId, Name, GeometryType, IsAuthoritative, StyleId'),
    bullet('Feature: FeatureId, LayerId, Properties, Geometry, Version'),
    bullet('FeatureHistory: append-only edits for GIS audit'),
    bullet('Style / StyleRegistry: QML or JSON style document references'),
    bullet('SpatialLayersCatalogue / ThemeCatalogue: publication metadata for clients'),
    bullet('SiteContent: portal narrative blocks (committees, about, fees text)'),

    h1('10. Survey entities'),
    bullet('SurveyJob / SurveyTask: JobId, Title, Status, AssignedSurveyor, LinkedApplicationId?'),
    bullet('SurveyParcel / ControlPoint linkages as supporting evidence'),
    bullet('Tenant isolation: surveyor workspace logically separated (search_path physically)'),
    note('Logical model forbids a SurveyJob.Status of “title_registered” unless an external Deeds confirmation entity exists — which it does not in current scope.'),

    h1('11. Normalisation (3NF) decisions'),
    p('These decisions are the logical core of migration 126/127 thinking:'),
    ...diagram([
      '  VIOLATION                          REMEDY',
      '  stands.zone_type depends on zone   Drop as authority; derive via Zone join',
      '  stands.ward free text              Add WardId FK; keep name as cache',
      '  status strings unconstrained       Ref* + CHECK / FK',
      '  users mixes profile fields         UserProfile 1:1',
      '  zone_id UUID vs Zone.integer id    Stand.ZoneId integer (zone_id_int)',
      '  clerk data only in UI storage      Clerking.* entities server-side',
    ]),
    p('Boyce–Codd considerations: RoleCode and StatusCode are determined by controlled registries, not by overlapping candidate keys in fact tables. Geometry is atomic for logical purposes (WKT/WKB treated as a single attribute).'),

    h1('12. State machines'),
    h2('12.1 Permit application statuses (logical)'),
    p('Illustrative lawful set (aligned to DM handbook / pending_payment work):'),
    ...diagram([
      '  pending_payment',
      '       → registered',
      '       → acknowledged',
      '       → circulation | objection_period',
      '       → under_review',
      '       → awaiting_eo_decision',
      '       → approved | approved_with_conditions | refused | withdrawn',
      '       → appealed → (re-enter under_review / awaiting_eo_decision)',
    ]),
    bullet('Illegal transition example: registered → approved (skips assessment/EO).'),
    bullet('EO gate: approve* transitions require DeterminedBy role ∈ {eo, admin-delegate}.'),

    h2('12.2 Service ticket statuses'),
    bullet('open → in_progress → waiting_citizen → resolved → closed (and cancelled).'),

    h2('12.3 Inspection statuses'),
    bullet('scheduled → in_progress → passed | failed | partial | cancelled.'),

    h1('13. Logical security model'),
    table(['Operation class', 'Allowed roles (logical)'], [
      ['Citizen self-service R/W own cases', 'citizen (scoped)'],
      ['Clerk registers R/W', 'planning_clerk, admin'],
      ['Assess / recommend', 'planner, admin'],
      ['Determine / EO returns', 'eo, admin'],
      ['Mutate authoritative GIS', 'gis_officer, admin'],
      ['Read status history', 'staff roles (not public)'],
      ['EHO registers', 'eho, admin'],
      ['Inspector queue', 'inspector, admin'],
      ['Survey jobs', 'surveyor (own), admin'],
    ]),

    h1('14. CRUD matrices (summary)'),
    table(['Entity', 'Citizen', 'Clerk', 'Planner', 'EO', 'GIS'], [
      ['PermitApplication', 'CRU own', 'RU', 'RU', 'RU', 'R'],
      ['Determination fields', 'R', 'R', 'recommend', 'U', '—'],
      ['FeeReceipt', 'R own', 'CRUD', 'R', 'R', '—'],
      ['Zone / Stand geom', 'R pub', 'R', 'R', 'R', 'CRUD'],
      ['ServiceTicket', 'CR own', 'RU', 'RU', 'RU', 'R'],
    ]),

    h1('15. Integrity rules'),
    numbered(1, 'Every Stand.ZoneId must exist in Zone and be active for new allocations.'),
    numbered(2, 'StatusHistory.ToStatus must be a member of RefApplicationStatus.'),
    numbered(3, 'AcknowledgementLetter.ApplicationId must reference an existing application.'),
    numbered(4, 'Feature updates on authoritative layers require GIS/Admin role (enforced physically).'),
    numbered(5, 'UserProfile cannot exist without User; deleting User cascades or blocks per policy.'),
    numbered(6, 'Payments reference either an application or a clearly typed other service.'),
    blank(),
    p('End of Logical Model. Continue to Physical Model for PostgreSQL/PostGIS realisation.'),
  ]
  await writeDoc('02_Logical_Model.docx', 'Logical Model', c)
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 PHYSICAL — very detailed
// ═══════════════════════════════════════════════════════════════════════════
async function physical() {
  const c = [
    ...cover(
      '3 — Physical Model',
      'PostgreSQL + PostGIS implementation, migrations, indexes, and runtime behaviour',
      'How the logical model is stored and served in SpartialIQ',
    ),
    ...toc([
      'Platform and environments',
      'Schemas and ownership',
      'Core tables and views (SSOT)',
      '3NF and zone_id_int physicalisation',
      'Clerk, ops, EHO, inspector physical objects',
      'Spatial storage and tiling',
      'Migration allowlist governance',
      'Indexes, pools, and performance',
      'Security controls in the database edge',
      'Readiness and observability',
      'Dump vs migrate boundary',
      'Physical ER diagrams',
      'Deployment checklist',
    ]),
    pageBreak(),

    h1('1. Platform and environments'),
    table(['Component', 'Physical choice'], [
      ['RDBMS', 'PostgreSQL'],
      ['Spatial', 'PostGIS (geometry, ST_AsMVT, GiST)'],
      ['App API', 'Fastify (Node) on port 3000'],
      ['Frontend', 'Vue 3 + MapLibre on Vite (e.g. :5174)'],
      ['Local DB name', 'vungu_master_db_v1 (typical)'],
      ['Auth tokens', 'JWT in Authorization header'],
      ['Tile format', 'MVT (Mapbox Vector Tiles)'],
      ['Storage CRS', 'EPSG:4326 for authoritative geoms'],
      ['Migrate runner', 'scripts/migrate-render.js allowlist'],
    ]),
    p('Physical environments (dev/stage/prod) share schema shape via the allowlist. Data volume differs: production may hold multi-GB OSM dumps; CI may hold schema-only.'),

    h1('2. Schemas and ownership'),
    table(['Schema', 'Owns'], [
      ['public', 'users, user_profiles, stands, wards, zones tables/views, ref_*, many app tables'],
      ['spatial_planning', 'permit_application family, inspections, EHO, GIS features, statutory plans'],
      ['planning_clerk', 'correspondence, fee_receipt, acknowledgement_letter, refusal_letter, permit_dispatch, notice certs, abutters'],
      ['council_ops', 'road_asset, wash_asset, livestock_facility, service_desk_ticket'],
      ['survey / survey_*', 'per-surveyor tenant data; search_path isolation'],
    ]),

    h1('3. Core tables and views (SSOT)'),
    h2('3.1 Zones SSOT'),
    bullet('proposed_peri_urban_zones — base table, integer id, geometry, attributes'),
    bullet('zones_master — VIEW used by tile/layer registry (migrations 112, 113)'),
    bullet('vungu_proposed_peri_urban_zones — dump-era name; 128 can bootstrap proposed_* from it'),
    bullet('FKs from stands/development_matrix target proposed_peri_urban_zones.id (INTEGER)'),
    h2('3.2 Stands'),
    bullet('stands — physical fact table'),
    bullet('v_stands — view joining ward + zone labels (refreshed in 126/127)'),
    bullet('stands.zone_id_int INTEGER FK (127); legacy stands.zone_id UUID retained nullable for compatibility'),
    h2('3.3 Users'),
    bullet('public.users — auth'),
    bullet('public.user_profiles — 1:1 profile (126)'),
    bullet('survey.users — separate survey tenancy; do not casually merge'),

    h1('4. 3NF and zone_id_int physicalisation'),
    h2('4.1 Migration 126_3nf_normalization.sql'),
    bullet('Creates ref_stand_statuses, ref_scale_categories, ref_use_scales, ref_zone_types, ref_application_statuses'),
    bullet('Adds stands.ward_fid, status_code, use_scale_code, zone_type_cache; renames ward → ward_name pattern'),
    bullet('Drops authoritative use of denormalised zone_type on stands in favour of view derivation'),
    bullet('Adds FK-oriented columns on planning_assistant_templates'),
    bullet('CHECKs / constraints for development_applications.status against ref list'),
    bullet('Creates user_profiles and backfills from users'),
    h2('4.2 Migration 127_zone_id_int_contract.sql'),
    bullet('Adds/backfills zone_id_int from integer zone ids'),
    bullet('Recreates v_stands to expose zone_id_int and zone label'),
    bullet('API/OpenAPI contract: zone_id is integer (land-use routes)'),
    h2('4.3 Migration 128_bootstrap_proposed_peri_urban.sql'),
    bullet('If proposed_peri_urban_zones missing but vungu_* exists, CREATE TABLE AS / copy pattern'),
    bullet('Ensures 3NF FKs and tile views have a base relation on dump-shaped databases'),

    pageBreak(),
    h1('5. Clerk, ops, EHO, inspector physical objects'),
    h2('5.1 planning_clerk (124)'),
    bullet('Tables for fee_receipt, acknowledgement_letter, correspondence, refusal_letter, permit_dispatch, notice_certificate, abutter_log (names as migrated)'),
    bullet('API surface /api/clerk/* persists here — not localStorage'),
    h2('5.2 council_ops (123) + service desk (125)'),
    bullet('road_asset, wash_asset, livestock_facility with geometry(4326) + GiST'),
    bullet('service_desk_ticket for citizen multi-counter categories'),
    h2('5.3 EHO (121–122)'),
    bullet('Registers for inspections, notices, certificates, programmes, operations enhancements'),
    bullet('Routes under /api/eho/*'),
    h2('5.4 Inspector (116–118, 071–073, 120)'),
    bullet('Work queue, stage field events, site geometry, building_complaints'),
    bullet('Photo/scoring columns from handbook migrations'),

    h1('6. Spatial storage and tiling'),
    p('Authoritative geometries are stored in EPSG:4326. Tile queries use ST_TileEnvelope and ST_AsMVT. Missing relations return empty 204 rather than crashing the map client. GiST indexes (074, 078 family) make bbox intersection viable at district scale.'),
    ...diagram([
      '  Client (MapLibre) → GET /tiles/:layer/:z/:x/:y',
      '       → Fastify tile route → SQL ST_AsMVT(… ST_TileEnvelope …)',
      '       → PostGIS table/view (zones_master, v_stands, buildings, …)',
      '       → MVT bytes (or 204 if 42P01 / empty policy)',
    ]),
    bullet('Layer catalogue (111+) maps published names to relations'),
    bullet('GIS editable features (091/092) store mutable council sketches with history'),
    bullet('Style registry (114) binds QML/JSON styles to layers'),

    h1('7. Migration allowlist governance'),
    p('scripts/migrate-render.js is the physical SSOT of what a fresh deploy must apply. Supervisor audit found drift: 079_filter_buildings, 080_stands_tile_view, 112, 113, and the 3NF family were documented but missing from the allowlist. Rectification added them plus 126–128.'),
    h3('7.1 Representative allowlist families'),
    table(['Range / id', 'Theme'], [
      ['001, 042, 060–065', 'Core schema, applications, invites, stands, payments'],
      ['070–073', 'DM handbook + inspection scoring'],
      ['074, 078', 'Spatial GiST indexes'],
      ['079, 080_stands', 'Buildings filter + stands tile view'],
      ['082–090', 'Planner case, committee, EO, notices, consultation'],
      ['091–092, 111–114', 'GIS features, catalogue, styles'],
      ['101', 'Statutory plans'],
      ['115', 'Residency'],
      ['116–120', 'Inspector + building complaints'],
      ['121–122', 'EHO'],
      ['123–125', 'Council ops + clerk + service desk'],
      ['126–128', '3NF, zone_id_int, peri-urban bootstrap'],
    ]),

    h1('8. Indexes, pools, and performance'),
    bullet('GiST(geometry) on spatial facts used in tiles and intersects'),
    bullet('B-tree on foreign keys (ward_fid, zone_id_int, application ids)'),
    bullet('Connection pool sized for concurrent tile bursts'),
    bullet('HTTP caching middleware for safe GET tiles/content where configured'),
    bullet('Rate limiter: auth endpoints return 429 (not 500) when exceeded; health/tiles allow-listed'),

    h1('9. Security controls at the database edge'),
    p('Physical enforcement is primarily in the API preHandler layer; the database still uses constraints/FKs as the last line for structure.'),
    table(['Surface', 'Physical control'], [
      ['POST/DELETE /api/wfs/*', 'requireRole(admin, gis_officer)'],
      ['QML upload dynamic-layers', 'requireRole(admin, gis_officer)'],
      ['Spatial POST layers/features/qml/query', 'GIS write / staff as designed'],
      ['GET status-history', 'STAFF_ROLES'],
      ['OGC cache clear', 'admin/gis_officer'],
      ['Payment webhooks', 'signature verification'],
      ['Public auth', 'CAPTCHA required'],
      ['DEMO_SEED_ENABLED', 'must be false in production'],
    ]),

    h1('10. Readiness and observability'),
    bullet('GET /ready — process + DB connectivity probe'),
    bullet('Structured logs (pino); audit middleware on sensitive routes'),
    bullet('Production module loop scripts verify role paths (49/49 style suites)'),

    h1('11. Dump vs migrate boundary'),
    p('Migrations create the operational schema. They do not fabricate millions of OSM buildings or all ward polygons. Those arrive via GPKG/pg_dump. DATA-DUMP-REPORT.md records this boundary. Ops must publish SPATIAL_BASEMAP_GPKG_URL (or equivalent) so rebuilds are not folklore.'),
    table(['Object class', 'Source'], [
      ['users, permits, clerk, eho, ops tables', 'Migrations'],
      ['zones_master / proposed_* structure', '112/113/128'],
      ['stands structure + v_stands', '062 + 080_stands + 126/127'],
      ['buildings/roads/rivers bulk', 'External dump'],
      ['wards/districts polygons', 'External dump (typical)'],
    ]),

    pageBreak(),
    h1('12. Physical ER diagrams (simplified)'),
    ...diagram([
      '  users ──1:1── user_profiles',
      '  wards ──1:N── stands (ward_fid)',
      '  proposed_peri_urban_zones ──1:N── stands (zone_id_int)',
      '  proposed_peri_urban_zones ──1:N── development_matrix',
      '  zones_master (VIEW) ←→ proposed_peri_urban_zones',
      '  v_stands (VIEW) = stands ⨝ wards ⨝ zones',
      '',
      '  spatial_planning.permit_application',
      '       ├── status_history',
      '       ├── documents / uploads',
      '       ├── inspections / stage events',
      '       └── appeals / notices',
      '',
      '  planning_clerk.* ──o── application id (nullable link)',
      '  council_ops.service_desk_ticket ──o── users',
      '  council_ops.*_asset (geom 4326, GiST)',
    ]),

    h1('13. Deployment checklist (physical)'),
    numbered(1, 'Provision Postgres+PostGIS; set DATABASE_URL, JWT_SECRET, CAPTCHA_SECRET.'),
    numbered(2, 'Run migrate-render allowlist through 128.'),
    numbered(3, 'Restore basemap dump/GPKG; confirm wards/buildings exist if map requires them.'),
    numbered(4, 'Confirm proposed_peri_urban_zones or 128 bootstrap; SELECT from zones_master.'),
    numbered(5, 'Smoke GET /ready; sample MVT for zones and stands.'),
    numbered(6, 'DEMO_SEED_ENABLED=false; verify WFS POST without GIS role returns 401/403.'),
    numbered(7, 'Create staff users/roles; run module smoke for clerk/EO/EHO.'),
    blank(),
    p('End of Physical Model. Continue to Expected / Needed / Delivered for Zimbabwe traceability.'),
  ]
  await writeDoc('03_Physical_Model.docx', 'Physical Model', c)
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 EXPECTED / NEEDED / DELIVERED — very detailed
// ═══════════════════════════════════════════════════════════════════════════
async function expectedDelivered() {
  const c = [
    ...cover(
      '4 — Expected, Needed & Delivered',
      'Zimbabwe sources → platform requirements → extensive SpartialIQ delivery evidence',
      'Traceability for supervisors and auditors',
    ),
    ...toc([
      'Method and source list',
      'Development control (RTCP)',
      'Clerking and statutory letters',
      'Plan-making and statutory plans',
      'GIS and spatial SSOT',
      'Building inspection and illegal building',
      'Environmental health (Public Health Act)',
      'Survey and cadastre honesty',
      'Citizen multi-counter and RDC portfolios',
      'Identity, security, and cyber audit',
      'Data normalisation and migration governance',
      'Role-by-role delivery map',
      'Evidence artefacts index',
      'Residual gaps and backlog',
      'Master traceability matrix',
    ]),
    pageBreak(),

    h1('1. Method and source list'),
    p('For each duty area this document states three columns of meaning: Expected (what Zimbabwe law / good RDC practice requires), Needed (what a digital platform must therefore provide), and Delivered (what SpartialIQ extensively implemented and verified). Sources are cited in plain language; this is not a gazette reprint.'),
    h2('1.1 Primary sources'),
    bullet('Regional, Town and Country Planning Act [Chapter 29:12] — plans, permits, subdivision, enforcement, appeals.'),
    bullet('Rural District Councils Act [Chapter 29:13] — RDC establishment, committees, administration.'),
    bullet('Public Health Act, 2018 — local authority EHOs; premises; nuisances; programmes; notices.'),
    bullet('Land Survey Act [Chapter 20:12] and Land Surveyors Act [Chapter 27:06] — licensed survey; SG examination.'),
    bullet('Zimbabwe cadastre / SG–Deeds workflow literature — planning → survey → SG → Deeds chain.'),
    bullet('Vungu RDC portal content — committees (finance, roads & works, social services/health, LED, etc.).'),
    bullet('SpartialIQ DM Handbook workflow — encoded permit transitions and EO gate.'),
    bullet('Supervisor security/data review (Sep 2026) — HIGH/MEDIUM findings and rectifications.'),
    h2('1.2 Evidence standard for “Delivered”'),
    bullet('Schema: numbered migration present on allowlist and applied.'),
    bullet('API: route exists with authz matching role matrix.'),
    bullet('UI: portal/module reachable for the role.'),
    bullet('Verification: production module loop / ready probe / manual smoke where cited.'),

    h1('2. Development control (RTCP)'),
    h2('2.1 Expected'),
    p('As local planning authority, Council must receive development applications, assess them against adopted plans and standards, consult when required, determine with reasons, attach conditions where appropriate, and provide for appeal. Unlawful development attracts enforcement. Typical RDC planner models emphasise layouts, development control, Surveyor-General liaison, and committee advice. Determination is a public-power act and must be attributable to a lawful decision-maker under Council’s delegations — commonly the Executive Officer or a committee resolution path.'),
    p('Public participation and notice practices are part of fairness. Files must show what was considered. Fees under Council schedules fund the process and must be receipted.'),
    h2('2.2 Needed'),
    bullet('Digital application object with type, land reference, documents, and status history.'),
    bullet('Payment/fee linkage before or at registration as policy requires.'),
    bullet('Lawful status machine; block illegal skips to approved.'),
    bullet('Planner assessment distinct from EO/delegated determination (EO gate).'),
    bullet('Spatial screening against authoritative zones/stands; exportable screening PDF.'),
    bullet('Circulation, objection period, public notice support.'),
    bullet('Conditions, refusals with reasons, appeals register.'),
    bullet('Enforcement/complaint pathway into inspection.'),
    h2('2.3 Delivered (extensive)'),
    bullet('Permit / development application SSOT in spatial_planning + related migrations (042, 070 DM handbook, 077 pending_payment, 082/085 planner case, 086 EO returns, 089–090 notices/consultation).'),
    bullet('EO decision gate: approve path requires EO — planner self-approve returns 403 eo_decision_required.'),
    bullet('Site-context / screening materials and statutory plans API (101).'),
    bullet('Appeals routes; generated document content (087); map evidence doc types (088).'),
    bullet('Case locking / MFA session support migrations (097) where enabled.'),
    bullet('Production module loops covering planner and EO happy paths.'),
    table(['Need', 'Delivery artefact'], [
      ['Status machine', 'DM handbook migration 070 + app workflow config'],
      ['EO gate', 'Backend permit approve guard + 086 returns'],
      ['Documents', '064 payments/docs + 119 uploads'],
      ['Planner file', '082/085 planner case + audit'],
      ['Notices', '089 public notice + 090 escalation'],
    ]),

    pageBreak(),
    h1('3. Clerking and statutory letters'),
    h2('3.1 Expected'),
    p('A Zimbabwe planning office is judged by its registers as much as by its opinions. Reception must receipt fees, acknowledge complete applications within expected working-day clocks, keep correspondence, certify notices, log abutters, dispatch approvals, and issue refusal letters with reasons. These artefacts are what make a determination defensible.'),
    h2('3.2 Needed'),
    bullet('Server-side registers with list/filter/overdue views.'),
    bullet('Linkage from letters to application identifiers.'),
    bullet('Clocks: acknowledgement (~5 working days) and refusal letter (~7 days post-decision) as operational targets.'),
    bullet('No dependence on a single browser’s localStorage as SSOT.'),
    h2('3.3 Delivered'),
    bullet('Migration 124 planning_clerk.* schema.'),
    bullet('/api/clerk/* persistence for receipts, ack, correspondence, refusal, dispatch, notice certificates, abutters.'),
    bullet('Planning clerk portal sections (multi-register UI).'),
    bullet('Supervisor finding “clerk only in localStorage” closed.'),

    h1('4. Plan-making and statutory plans'),
    h2('4.1 Expected'),
    p('RTCP practice expects master/local plans and related policy to guide development control. Officers and citizens should be able to see which plan theme applies.'),
    h2('4.2 Needed / 4.3 Delivered'),
    bullet('Needed: store and expose statutory plan metadata/documents; link assessments to plan refs.'),
    bullet('Delivered: migration 101 statutory_plans; planning project/revision families (095/096/108); site content for portal narrative (094); planning assistant templates tied into 3NF refs (062/126).'),

    h1('5. GIS and spatial SSOT'),
    h2('5.1 Expected'),
    p('Council must know, on one map, where zones and stands are. Layouts must be coordinated with survey practice. Divergent zone copies cause unlawful or unfair decisions. Basemaps may orient users but must not silently overwrite policy geography.'),
    h2('5.2 Needed'),
    bullet('Single zones SSOT consumed by tiles and by FKs.'),
    bullet('Integer zone identifiers consistent across API and DB.'),
    bullet('MVT performance; GiST indexes; safe empty-tile behaviour.'),
    bullet('Role-locked mutating GIS/WFS/QML endpoints.'),
    bullet('Honest empty ops registers until import.'),
    bullet('Documented SRID (4326) — no stale 900914 fiction.'),
    h2('5.3 Delivered'),
    bullet('zones_master view + columns (112/113); bootstrap 128.'),
    bullet('zone_id_int contract (127); OpenAPI integer zone_id.'),
    bullet('stands tile view (080_stands); buildings buffer filter (079) on allowlist.'),
    bullet('council_ops asset registers (123); import dry-run patterns.'),
    bullet('Guards on WFS, dynamic-layers QML, spatial writes; OGC cache clear locked.'),
    bullet('spatialLayers.js JSDoc SRID corrected to 4326.'),
    bullet('SSOT-database.md + DATA-DUMP-REPORT.md published.'),

    h1('6. Building inspection and illegal building'),
    h2('6.1 Expected'),
    p('Local authority inspectors verify that building work matches approved plans at recognised stages and respond to illegal building. Evidence must be durable for enforcement and for later occupation decisions.'),
    h2('6.2 Needed'),
    bullet('Stage checklists, scoring, photos, work queue, site geometry.'),
    bullet('Citizen/staff complaint intake with references.'),
    bullet('Visibility for EO/planner when complaints affect cases.'),
    h2('6.3 Delivered'),
    bullet('Handbook inspections 070–073; queue 116; field events 117; site geometry 118; complaints 120.'),
    bullet('Inspector portal + routing support APIs.'),
    bullet('Module loop coverage for inspector role.'),

    h1('7. Environmental health (Public Health Act)'),
    h2('7.1 Expected'),
    p('The Public Health Act 2018 requires local authorities to appoint Environmental Health Officers to help carry out the Act. Duties include premises control, food and water safety, nuisance abatement, burial-related controls where applicable, and enforceable notices. These duties are not optional add-ons to planning; they are a parallel public-power track.'),
    h2('7.2 Needed'),
    bullet('EHO registers for inspections, notices, clearances, certificates, programmes.'),
    bullet('Citizen intake for nuisance and related tickets.'),
    bullet('Role-gated EHO workspace.'),
    h2('7.3 Delivered'),
    bullet('Migrations 121–122 environmental health registers/operations.'),
    bullet('/api/eho summary, notices, inspections, certificates, programmes.'),
    bullet('Service desk categories for trading licence & nuisance (125) live.'),
    bullet('EHO demo/role verification in production loops.'),

    pageBreak(),
    h1('8. Survey and cadastre honesty'),
    h2('8.1 Expected'),
    p('Cadastral surveys in Zimbabwe are performed by licensed surveyors and examined by the Surveyor-General; Deeds Registry registers title. Council planning and stand creation feed that chain but do not replace it. Job advertisements for RDC planners routinely mention liaison with the Surveyor-General.'),
    h2('8.2 Needed'),
    bullet('Survey job/task objects linked to council need.'),
    bullet('UI/docs language that never claims Deeds registration inside SpartialIQ.'),
    bullet('Control points / parcel helpers as supporting evidence.'),
    h2('8.3 Delivered'),
    bullet('Survey task migrations (080_survey_tasks, 099–102 family) + surveyor console/APIs.'),
    bullet('Control points (098); geometry validation / topology helpers (106/107).'),
    bullet('Conceptual and role-expectation docs explicitly state SG/Deeds remain external.'),
    bullet('Planned modules fail empty-safe rather than faking title.'),

    h1('9. Citizen multi-counter and RDC portfolios'),
    h2('9.1 Expected'),
    p('Under the RDC Act, Council operates through committees and departments spanning finance, roads & works, social services and health, local economic development, and more. Citizens expect a way to request services even when a full departmental ERP is not deployed. Vungu’s public profile and committee structure make this multi-portfolio expectation concrete.'),
    h2('9.2 Needed'),
    bullet('Catalogue of request types; ticket backend; status tracking.'),
    bullet('Map + DC application + payments entry points.'),
    bullet('CAPTCHA and abuse controls on public auth.'),
    h2('9.3 Delivered'),
    bullet('service_desk_ticket (125) powering multi-counter categories.'),
    bullet('Citizen portal flows for apply/track/complain/map.'),
    bullet('Residency verification module (115) labelled appropriately vs Ministry Lands.'),
    bullet('Payments/documents foundation (064) with webhook verification.'),

    h1('10. Identity, security, and cyber audit'),
    h2('10.1 Expected / needed'),
    p('Public-sector systems holding citizen files must authenticate users, authorise by role, protect mutating GIS endpoints, and avoid leaking status histories. Supervisor review (Sep 2026) treated open WFS/QML/spatial writes and open status-history as HIGH.'),
    h2('10.2 Delivered'),
    table(['Finding', 'Fix delivered'], [
      ['Unauthenticated WFS mutate', 'requireRole admin/gis_officer on POST/DELETE'],
      ['QML upload open', 'Same GIS/admin guard'],
      ['Spatial POST open', 'GIS write roles; query staff-scoped'],
      ['status-history open', 'STAFF_ROLES preHandler'],
      ['OGC cache clear open', 'admin/gis_officer'],
      ['Auth rate limit 500s', 'Proper 429 + allow-list health/tiles'],
      ['CAPTCHA', 'Required on public auth'],
      ['Payment webhooks', 'Signature verified'],
    ]),

    h1('11. Data normalisation and migration governance'),
    h2('11.1 Expected / needed'),
    p('Auditors expect 3NF for transactional data, consistent zone identifiers, and a migrate path that actually builds what docs promise. Drift between “mentioned in markdown” and “on Render allowlist” is a delivery defect.'),
    h2('11.2 Delivered'),
    bullet('126_3nf_normalization.sql applied + on allowlist.'),
    bullet('127_zone_id_int_contract.sql + v_stands refresh.'),
    bullet('128 bootstrap for proposed_peri_urban on dump-shaped DBs.'),
    bullet('Allowlist includes 079, 080_stands, 112, 113, 126–128.'),
    bullet('SSOT-database.md, DATA-DUMP-REPORT.md, SUPERVISOR-REVIEW-RECTIFICATION.md, summary docx.'),

    h1('12. Role-by-role delivery map'),
    table(['Role', 'Expected duty (short)', 'Delivered workspace'], [
      ['Citizen', 'Apply, pay, track, complain', 'Citizen portal + tickets + map'],
      ['Planning clerk', 'Registers & letters', '/clerk + planning_clerk.*'],
      ['Planner', 'Assess & recommend', 'Planner case + screening'],
      ['EO', 'Determine', 'EO decision + returns + gate'],
      ['GIS officer', 'Spatial SSOT', 'GIS tools + guarded writes'],
      ['Inspector', 'Stages & illegal building', 'Inspector queue + complaints'],
      ['EHO', 'Health Act duties', '/eho + notices + programmes'],
      ['Surveyor', 'Licensed survey jobs', 'Survey console + tasks'],
      ['Admin', 'Platform & users', 'Admin/auth + seeds control'],
    ]),
    p('See also Vungu_Zimbabwe_Role_Expectations.docx for ≥5 paragraphs per role in training language, and the Council Operations Flows Manual for end-to-end click-paths.'),

    pageBreak(),
    h1('13. Evidence artefacts index'),
    table(['Artefact', 'Use'], [
      ['docs/01_Conceptual_Model.docx', 'Business meaning'],
      ['docs/02_Logical_Model.docx', 'Entities & 3NF logic'],
      ['docs/03_Physical_Model.docx', 'Postgres realisation'],
      ['docs/04_Expected_Needed_And_Delivered_Zimbabwe.docx', 'This traceability doc'],
      ['docs/Vungu_Zimbabwe_Role_Expectations.docx', 'Per-role Zim expectations'],
      ['docs/Vungu_Council_Operations_Flows_Manual.docx', 'Detailed flows'],
      ['docs/Vungu_Council_Flows_Manual_Plain_English.docx', 'Simple English narrations'],
      ['docs/SSOT-database.md', 'Table SSOT map'],
      ['docs/DATA-DUMP-REPORT.md', 'Dump vs migrate'],
      ['docs/SUPERVISOR-REVIEW-RECTIFICATION.md', 'Audit fix log'],
      ['docs/Supervisor-Review-Rectification-Summary.docx', 'Audit summary Word'],
      ['PRODUCTION_MODULE_RESULTS.json', 'Loop evidence'],
      ['migrations/123–128', 'Ops/clerk/desk/3NF/zone/bootstrap'],
    ]),

    h1('14. Residual gaps and backlog (honest)'),
    p('Delivery is extensive but not infinite. The following remain needed for full institutional maturity:'),
    numbered(1, 'Publish canonical basemap GPKG/pg_dump URL (SPATIAL_BASEMAP_GPKG_URL) and restore runbook.'),
    numbered(2, 'Staff inbox UI for service-desk tickets (API exists; queue UX may be thin).'),
    numbered(3, 'Explicit committee/director role enum if resolutions require non-EO determination paths.'),
    numbered(4, 'Sealed QGIS atlas print packages for final layout sheets.'),
    numbered(5, 'Full offline-first inspector sync for low-connectivity wards.'),
    numbered(6, 'Production payment gateway completeness where Finance rejects manual-only.'),
    numbered(7, 'Deeper integration adapters to SG/Deeds if nationally offered (currently out of scope honesty).'),
    numbered(8, 'Load-tested tile SLOs on full OSM volume in production sizing.'),

    h1('15. Master traceability matrix'),
    ...diagram([
      '  Zimbabwe expectation                 Platform need                    Delivered extensively',
      '  ─────────────────────               ─────────────                    ────────────────────',
      '  RTCP permits & appeals         →   status machine + EO gate    →   070/086 + approve guard',
      '  Fair notice & file memory      →   clerk registers             →   124 + /api/clerk',
      '  One zone truth                 →   zones_master + int FK       →   112/113/127/128',
      '  3NF / clean stands             →   refs + ward_fid + views     →   126 + v_stands',
      '  Public Health EHO             →   EHO registers + tickets     →   121/122 + 125 + /eho',
      '  Stage & illegal building      →   inspector queue/complaints  →   116–120 + UI',
      '  Survey ≠ Deeds                →   jobs + honest docs          →   survey modules + docs',
      '  RDC multi-portfolio citizen   →   service desk catalogue      →   125 + citizen portal',
      '  Cyber: no open GIS mutate     →   role preHandlers            →   WFS/QML/spatial guards',
      '  Migrate = documented schema   →   allowlist completeness      →   079/080/112/113/126–128',
    ]),
    blank(),
    p('Conclusion: Against Zimbabwe local-authority expectations for an RDC planning and related-services office, SpartialIQ now carries an extensive delivered core — conceptual clarity, logical 3NF design, physical PostGIS realisation, and source-traced features across all major roles — with residual gaps explicitly listed for the next delivery tranche.'),
    blank(),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200 },
      children: [new TextRun({ text: '— End of Expected / Needed / Delivered —', italics: true, color: '64748B' })],
    }),
  ]
  await writeDoc('04_Expected_Needed_And_Delivered_Zimbabwe.docx', 'Expected Needed Delivered', c)
}

async function main() {
  await conceptual()
  await logical()
  await physical()
  await expectedDelivered()
  const idx = path.join(__dirname, '..', 'docs', 'README_ARCHITECTURE_DOCS.md')
  fs.writeFileSync(idx, `# Architecture & Zimbabwe expectations docs (detailed)

| # | File | Contents |
|---|------|----------|
| 1 | \`01_Conceptual_Model.docx\` | Business concepts, legal context, domains, entities, rules, actors, glossary |
| 2 | \`02_Logical_Model.docx\` | Namespaces, attributes, 3NF, state machines, CRUD/security matrices |
| 3 | \`03_Physical_Model.docx\` | Postgres/PostGIS schemas, migrations 079–128, tiles, security, deploy checklist |
| 4 | \`04_Expected_Needed_And_Delivered_Zimbabwe.docx\` | Full Expected→Needed→Delivered traceability + gaps |

Regenerate: \`node scripts/generate-four-architecture-docs.js\`
`)
  console.log('Wrote', idx)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
