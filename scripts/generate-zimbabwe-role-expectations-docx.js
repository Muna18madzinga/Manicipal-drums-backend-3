/**
 * Zimbabwe council role expectations — RTCP / RDC / Public Health / Survey law
 * mapped to SpartialIQ activities. Simple English, ≥5 paragraphs per person.
 * Run: node scripts/generate-zimbabwe-role-expectations-docx.js
 */
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, WidthType, AlignmentType, ShadingType, PageBreak,
  Header, Footer, PageNumber,
} = require('docx')
const fs = require('fs')
const path = require('path')

const BLUE = '1E3A5F'
const ACCENT = 'B45309'
const LIGHT = 'FFFBEB'
const MONO = 'Consolas'

const h1 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 360, after: 160 },
  children: [new TextRun({ text: t, bold: true, color: BLUE })],
})
const h2 = (t) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 260, after: 120 },
  children: [new TextRun({ text: t, bold: true, color: ACCENT })],
})
const p = (t) => new Paragraph({
  spacing: { after: 140 },
  children: [new TextRun({ text: t, size: 22 })],
})
const bullet = (t) => new Paragraph({
  spacing: { after: 70 },
  indent: { left: 360 },
  children: [new TextRun({ text: `• ${t}`, size: 21 })],
})
const blank = () => new Paragraph({ text: '', spacing: { after: 80 } })
const pageBreak = () => new Paragraph({ children: [new PageBreak()] })
const diagram = (lines) => lines.map((line) => new Paragraph({
  spacing: { after: 0 },
  shading: { type: ShadingType.CLEAR, fill: LIGHT },
  children: [new TextRun({ text: line || ' ', font: MONO, size: 16 })],
}))

function cell(text, header = false, width = 3000) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: header ? { type: ShadingType.CLEAR, fill: BLUE } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: [new Paragraph({
      children: [new TextRun({
        text: String(text), size: 18, bold: header,
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

const children = []

children.push(
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [new TextRun({ text: 'Vungu Rural District Council', bold: true, size: 40, color: BLUE })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: 'What each person is expected to do', bold: true, size: 32 })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 200 },
    children: [new TextRun({
      text: 'According to Zimbabwe council law, typical RDC job models, and SpartialIQ best practice',
      italics: true, size: 22, color: '64748B',
    })],
  }),
  p('This document is for training and supervision. It explains, in simple English, what Zimbabwe’s legal framework and good local-authority practice expect from each user of SpartialIQ. It then states the exact activities that person must complete in the system. It is not a substitute for legal advice. Council resolutions, adopted by-laws, and the current wording of Acts always come first.'),
  blank(),
  table(['Instrument', 'Why it matters here'], [
    ['Regional, Town and Country Planning Act [Chapter 29:12]', 'Master/local plans, development permits, subdivision, enforcement, appeals'],
    ['Rural District Councils Act [Chapter 29:13]', 'RDC powers, committees, administration of the district'],
    ['Public Health Act, 2018', 'Local authorities must appoint EHOs; premises, nuisances, food, burial'],
    ['Land Survey Act [Chapter 20:12] & Land Surveyors Act [Chapter 27:06]', 'Licensed surveyors; Surveyor-General examines cadastral surveys'],
    ['Vungu RDC profile / committees / strategic plans (portal content)', 'Local portfolios: roads, health, finance, social services, LED'],
    ['DM Handbook / permit workflow in SpartialIQ', 'Lawful status transitions; EO determination gate'],
  ]),
  blank(),
  p('Best models used in this guide: (1) separation of duties — assessor is not always the final decision-maker; (2) complete file before determination; (3) records that survive staff change; (4) spatial Single Source of Truth — no fake map geometry; (5) Zimbabwe cadastral chain — planning permit → licensed survey → Surveyor-General → Deeds, which SpartialIQ supports but does not replace.'),
  pageBreak(),
)

// CITIZEN
children.push(
  h1('1. The citizen / applicant — expected activities'),
  h2('1.1 What Zimbabwe practice expects of you'),
  p('As a resident or developer dealing with a Rural District Council, you are expected to apply for permission before you change land use or put up buildings that need a development permit under the RTCP Act. You are expected to use the forms and fees the local planning authority publishes. You are expected to tell the truth on ownership or authority to develop. You are expected to allow inspections when the council asks.'),
  p('You are also expected to use the lawful counters for other council services: rates and billing with Finance, health licences and nuisances with Environmental Health, road complaints with Roads & Works, and social welfare with Social Services. Online tools do not remove the need to pay lawful fees or to attend the counter when the council still requires a stamp or identity check.'),
  p('Good citizenship models expect you to keep copies of what you submit, to respond when the council asks for missing documents, and not to start illegal building while a file is pending. If you object to a neighbour’s application during a formal notice period, you must do so in the way the notice explains, with your name and grounds.'),
  p('You are not expected to edit council maps, approve your own permit, or pose as a staff member. You are not expected to treat OpenStreetMap or a demo “Ministry Lands” screen as your title deed. Title and diagram approval remain with Deeds and the Surveyor-General where the law requires them.'),
  p('In SpartialIQ you are expected to: register with CAPTCHA; keep your login safe; lodge development applications and uploads; track your case; pay when asked; lodge building complaints and service-desk tickets for rates, licences, nuisance, roads, welfare, or survey enquiries; and read notices. When the system shows “waiting for EO” or “more documents needed,” that is your cue to wait or upload — not to build first.'),
  ...diagram([
    '  YOU → apply / pay / upload / track / report',
    '  COUNCIL STAFF → register, assess, decide, inspect',
    '  DEEDS / SURVEYOR-GENERAL → title & cadastral approval (outside this app’s claim)',
  ]),
  pageBreak(),
)

// CLERK
children.push(
  h1('2. The planning clerk — expected activities'),
  h2('2.1 What Zimbabwe RDC practice expects of you'),
  p('Planning clerks in Zimbabwean local authorities are the records and reception spine of development control. Job models and office practice expect you to receive applications, check that the pack is complete enough to register, issue receipts for fees, keep the development register, and write formal letters. You are the person who makes the file exist in council memory.'),
  p('Under good RTCP office practice, acknowledgement of a valid application starts or supports the statutory clock. This system encodes a five-working-day acknowledgement target and a seven-day refusal-letter target after determination. You are expected to meet those clocks or record why you could not. Late silence is a governance failure, not a small admin slip.'),
  p('You are expected to file public-notice certificates and neighbour (abutter) notifications when the planner or EO requires notice. You are expected to dispatch approved permits with proof of delivery and to send refusal letters with clear reasons. You keep correspondence in and out so disputes about “we never received your letter” can be answered from the register.'),
  p('Best records models (complete file, audit trail, separation of duties) say you must never approve or refuse the development yourself. You do not change map geometry. You do not delete history to hide a mistake — you add a correcting note. If money is taken at the counter, it must appear in the fee register the same day.'),
  p('In SpartialIQ you are expected to use every clerk section that matches the paper job: Application receipt, document verification, Development Register, Acknowledgements (create + mark sent), Correspondence, Public notices, Fees, Permit dispatch, Refusals, Enforcement records typing, and Appeals handoff. After refresh, your entries must still be there — they are stored in Postgres, not only on one PC.'),
  p('Supervisors should check weekly: overdue acknowledgements, refusals due, fee totals versus cash book, and permits approved but not yet dispatched. That is the RDC clerking standard this system is built to support.'),
  pageBreak(),
)

// PLANNER
children.push(
  h1('3. The town / spatial planner — expected activities'),
  h2('3.1 What the RTCP Act and RDC planner jobs expect'),
  p('Zimbabwe planner advertisements and the RTCP Act [Chapter 29:12] expect you to help prepare and update master and local plans, process development permits, subdivisions, consolidations, change of use and special consent, advise committees, and enforce planning law together with the RDC Act [Chapter 29:13]. You coordinate with the Surveyor-General’s world when layouts need surveys. You inspect and monitor development.'),
  p('A sound local-authority model splits your work into plan-making and development control. On development control you appraise the application against the operative plan, zoning, standards (including access and reserves), and consulted departments. You write conditions that are enforceable. You do not skip circulation or objection steps that the adopted workflow requires.'),
  p('You are expected to use spatial evidence. In SpartialIQ that means running site-context against PostGIS layers and filing a screening PDF. You refer to GIS when layers are wrong, and to surveyors when boundaries need a licensed survey. You never invent parcels on the public map to “make the file look ready.”'),
  p('Separation of duties is a best-practice control against corruption and error. In this deployment, final approval is gated to the EO decision path. You are expected to recommend and complete the assessment pack, not to bypass the gate with someone else’s password. If the API returns eo_decision_required, you have reached the correct handoff.'),
  p('In SpartialIQ you are expected to: work the planner queue; open Application 360; complete GIS screening; manage referrals and conditions; support public participation needs for the clerk; prepare recommendations; use statutory plan tools for plan-making; and use Studio only as a design aid until GIS/survey sign-off. Your notes must be clear enough for the EO and for audit.'),
  p('Committee advice remains a live expectation even when software is digital: you prepare maps and reports the Planning Committee or Council can understand, in language aligned with Vungu’s deliberative committees and the Rural District Development Committee planning cycle.'),
  pageBreak(),
)

// EO
children.push(
  h1('4. The EO / planning decision-maker — expected activities'),
  h2('4.1 What determination models expect'),
  p('In Zimbabwean local planning authorities, a senior planning officer or designated decision-maker determines applications after assessment, subject to schemes of delegation and committee oversight set by Council. The RTCP Act framework assumes decisions are reasoned, timed, and appealable. This system’s EO role is that determination seat for day-to-day permits.'),
  p('You are expected to refuse incomplete packs. Best decision models require: registered application, fees where due, acknowledgement, required consultations, notice compliance where needed, planner recommendation, and clear plans. Approving an empty file creates liability for the council.'),
  p('You are expected to choose approve, approve with conditions, refuse, or defer — and to write reasons a citizen and an appeal body can understand. Conditions must be precise. Refusals must state grounds linked to the plan or standards, not personal preference.'),
  p('You are expected to respect enforcement and complaints intelligence. Illegal building reports and inspector evidence inform whether compliance or enforcement is needed. You do not replace the building inspector on site, but you do not ignore field proof either.'),
  p('In SpartialIQ you are expected to use the EO portal registers, diligence and decision tools, record determinations so status history shows your role, unlock clerk dispatch on approval, and oversee appeals/enforcement sections. You must not share your EO login. Planner self-approval is blocked on purpose.'),
  p('Where Council requires committee determination for certain classes of application, you follow that resolution: prepare the item, wait for the minute, then record the decision in the system. Software does not cancel a Council resolution.'),
  pageBreak(),
)

// GIS
children.push(
  h1('5. The GIS officer — expected activities'),
  h2('5.1 What spatial governance expects'),
  p('RDC GIS and spatial planning posts in Zimbabwe expect you to maintain district spatial data, layouts, and maps that support the RTCP Act and council infrastructure programmes. You support pegging and layout work with planners, keep zoning layers consistent, and stop divergent “map copies” of the same zone.'),
  p('International and regional best models (including Cadastre 2014 lessons discussed in Zimbabwe research) stress one legal/spatial story: planning, survey, and deeds must not invent three different boundaries for one stand. SpartialIQ therefore treats zones_master / proposed_peri_urban_zones as the peri-urban SSOT for the map and permits. You are expected to defend that SSOT.'),
  p('You are expected to import only authoritative GeoJSON/GPKG data, dry-run first, and leave registers empty rather than draw fake roads or WASH points. Roads & Works and DSSWC portfolios on Vungu’s site need real assets when Council supplies them.'),
  p('You are expected to control write APIs. WFS publish, QML upload, and spatial layer edits are staff-locked. Anonymous internet users must not restyle or publish layers. That is basic cyber and records hygiene for a public authority.'),
  p('In SpartialIQ you are expected to maintain themes, roads/WASH/livestock registers, imports, symbology registry, evidence and council-map PDFs, and to help planners with screening layers. When survey brings a diagram, you only promote it to the public layer after controlled update.'),
  p('You advise ICT when a fresh server has schema but no basemap dump. Empty tiles after migrate are a data restore problem, not a reason to invent OSM as cadastre.'),
  pageBreak(),
)

// INSPECTOR
children.push(
  h1('6. The building inspector — expected activities'),
  h2('6.1 What local-authority building control expects'),
  p('Building inspectors in Zimbabwean local authorities inspect construction stages against approved plans and by-laws, sign off key stages with Engineering/Works where required, and act on illegal building. Development may proceed with a development permit; servicing and structural stages often need inspections before further work or occupation-related certificates.'),
  p('You are expected to verify you are on the correct stand, compare work to the approved drawings, record pass/fail/conditional outcomes, and photograph defects. You escalate dangerous structures quickly. You do not quietly “approve” a planning file from the field.'),
  p('Citizen complaints about unauthorised building are part of your expected workload. Investigate, evidence, recommend enforcement or regularisation paths back to planning/EO. Best enforcement models keep a chain of custody for photos and notes.'),
  p('You coordinate with Roads & Works and EHO when the defect is structural, drainage, or health-related rather than purely planning. You write factual reports the EO can use.'),
  p('In SpartialIQ you are expected to run the inspector workspace: bookings, stages, case file, complaints, evidence capture, and sync of verdicts. Check that sync succeeded. Do not claim offline capture is saved until the case shows it.'),
  p('Occupation or completion pathways remain tied to council procedures and any certificate of compliance culture used for serviced stands — the inspector’s evidence feeds that chain; Deeds still sit outside this app.'),
  pageBreak(),
)

// EHO
children.push(
  h1('7. The Environmental Health Officer — expected activities'),
  h2('7.1 What the Public Health Act expects'),
  p('The Public Health Act, 2018 expects local authorities to appoint environmental health officers to help carry out the Act in the district, under health services direction. Ministry and training materials describe EHOs inspecting premises, food and water, investigating nuisances and infectious disease risks, and enforcing public health law and council by-laws — including closure or other action where justified.'),
  p('You are expected to inspect trading and food premises before or during licensing, not to treat an online ticket as a licence. You serve notices for abatement, prohibition, or closure using lawful service methods and you follow up until compliance, escalation, or withdrawal is documented.'),
  p('You are expected to run or support programmes that prevent ill-health: refuse, sanitation, spray, education, water-point checks — matching Vungu’s health and WASH-related committee interests. Record coverage so Council can see what was done in which ward.'),
  p('Burial and related permits, food-handler controls, and clearances are sensitive. Best practice is dated registers, identifiable officers, and no back-dating. You supervise or work with EHTs as local structure requires.'),
  p('In SpartialIQ you are expected to use /eho inspections, notices, certificates, clearances, programmes, and summary dashboards; pick up service-desk tickets for nuisance and trading licence; and answer planning referrals with clear health reasons. You do not issue RTCP development permits.'),
  p('If Council has not filled an EHO post, the Act’s appointment duties still sit with the local authority — software cannot replace a missing statutory officer.'),
  pageBreak(),
)

// SURVEYOR
children.push(
  h1('8. The surveyor — expected activities'),
  h2('8.1 What land survey law expects'),
  p('Cadastral survey for registration in Zimbabwe is the work of a licensed land surveyor under the Land Surveyors Act [Chapter 27:06], with examination and approval by the Surveyor-General under the Land Survey Act [Chapter 20:12]. Research on Zimbabwe’s cadastre describes the chain: planning permit → licensed survey → Surveyor-General approval → Deeds. SpartialIQ must respect that chain.'),
  p('You are expected to carry out council-linked jobs (beacons, diagrams, layout surveys) to professional standards, lodge what must be lodged with the Surveyor-General, and return usable products to the planning authority. You do not tell clients the council app has replaced the Surveyor-General.'),
  p('You are expected to refuse instructions that ask you to fake boundaries to match an illegal building. Best ethics models put public boundary truth above client convenience.'),
  p('When planners approve a subdivision conceptually, you still survey to Act and regulations. When GIS wants a layer update, you supply controlled files; GIS imports after checks.'),
  p('In SpartialIQ you are expected to work live council jobs on /surveyor and the task manager paths that actually save results. Planned/empty modules must not be sold as finished. Citizen survey tickets may need your formal engagement and fee clarity.'),
  p('Keep survey.users / survey schemas isolated from public.users where the platform separates them — multi-tenant survey data is not a dumping ground for unrelated council gossip.'),
  pageBreak(),
)

// ADMIN
children.push(
  h1('9. Admin / ICT (and support to the CEO’s office) — expected activities'),
  h2('9.1 What RDC administration expects'),
  p('Under the RDC Act framework, the executive administration runs day-to-day council business. ICT and records support must keep systems available, secure, and auditable so technical departments can meet the RTCP and Public Health duties above. Vungu’s executive profiles (CEO and executive officers) remain the human authority; Admin in SpartialIQ is the digital keyring and platform steward.'),
  p('You are expected to create staff accounts with correct roles, remove leavers, and never leave demo passwords on the public internet. You run migrations from the allowlist, restore basemap dumps when needed, and monitor /health and /ready.'),
  p('You are expected to keep secrets strong (JWT, CAPTCHA), TLS on, backups tested, and status pages honest. Faking “all green” when PostGIS is down is a professional failure.'),
  p('You support content editors for council website pages (committees, rates info, contacts) without changing planning decisions. You help GIS with symbology registry access and refuse requests to open mutating GIS APIs to the anonymous public.'),
  p('In SpartialIQ you are expected to use Admin users, platform status, content, security views, and deployment checklists in the operations manuals. When /ready fails, you fix data or services before telling citizens to apply online.'),
  p('You escalate legal questions to the proper executive officer or council lawyer — you do not invent new planning law in a config file.'),
  pageBreak(),
)

// COMMITTEES note
children.push(
  h1('10. Councillors and committees (not daily system users, but set expectations)'),
  p('Vungu’s deliberative arm works through committees (including finance, roads and works, social services / health related portfolios, and development planning structures such as the Rural District Development Committee described in portal content). Councillors set policy and approve budgets and certain planning items under resolutions.'),
  p('SpartialIQ does not replace committee minutes. Officers are expected to bring system-printed registers, maps, and PDFs to committee, then record the resolution back into the case. Best governance models keep politics in the chamber and evidence in the file.'),
  p('Citizens and staff should know which decisions are delegated to the EO and which must wait for committee. That split is a Council document decision. When in doubt, officers ask the CEO’s office — they do not guess inside the software.'),
  pageBreak(),
)

// MASTER ACTIVITY MATRIX
children.push(
  h1('11. Master activity checklist — law → system'),
  table(['Person', 'Zimbabwe expectation (summary)', 'Must complete in SpartialIQ'], [
    ['Citizen', 'Apply before develop; use lawful counters; honest docs', 'CAPTCHA account; apply; track; pay; complain; tickets'],
    ['Clerk', 'Register, fees, letters, notice filing, dispatch', 'All clerk registers; 5-day ack; 7-day refusal; dispatch'],
    ['Planner', 'RTCP assessment, plans, advice, enforcement support', 'Case pack; GIS PDF; referrals; recommend; no self-approve'],
    ['EO', 'Reasoned determination / delegation', 'Decision record; unlock permit path; appeals oversight'],
    ['GIS', 'One spatial truth; support layouts & DC', 'SSOT layers; dry-run import; locked writes; themes/PDFs'],
    ['Inspector', 'Stage & illegal building control', 'Stages; evidence; complaints; sync verdicts'],
    ['EHO', 'Public Health Act inspections & notices', 'EHO registers; tickets→inspection; programmes'],
    ['Surveyor', 'Licensed survey; SG chain', 'Council jobs; honest modules; controlled handoff to GIS'],
    ['Admin', 'Secure available systems', 'Users; /ready; migrations; no public demos; TLS/secrets'],
  ]),
  blank(),
  h2('11.1 End-to-end lawful chain (best model)'),
  ...diagram([
    '  RTCP permit / subdivision permission (Local Planning Authority)',
    '       → Licensed surveyor field survey (Land Surveyors Act)',
    '       → Surveyor-General examination & approval (Land Survey Act)',
    '       → Deeds registration (Deeds Registry)',
    '  SpartialIQ covers the council planning/ops spine; it does not replace SG or Deeds.',
  ]),
  blank(),
  p('Document date: 23 September 2026. Sources consulted: RTCP Act Ch 29:12 practice summaries; RDC planner job models; Public Health Act 2018 appointment of EHOs; Land Survey / Surveyors Acts and Zimbabwe cadastre workflow literature; Vungu RDC portal committee and profile content; SpartialIQ DM/permit workflow and role portals. Always verify against the latest gazetted text and Council resolutions.'),
  blank(),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: '— End of Zimbabwe role expectations guide —', italics: true, color: '64748B' })],
  }),
)

async function main() {
  const doc = new Document({
    creator: 'SpartialIQ',
    title: 'Vungu RDC — Zimbabwe Role Expectations',
    sections: [{
      properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
      headers: {
        default: new Header({
          children: [new Paragraph({
            children: [new TextRun({
              text: 'Vungu RDC · Zimbabwe law & best-model expectations · SpartialIQ',
              size: 16, color: '64748B',
            })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Page ', size: 16, color: '64748B' }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '64748B' }),
              new TextRun({ text: ' / ', size: 16, color: '64748B' }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '64748B' }),
            ],
          })],
        }),
      },
      children,
    }],
  })
  const buf = await Packer.toBuffer(doc)
  const outs = [
    path.join(__dirname, '..', 'docs', 'Vungu_Zimbabwe_Role_Expectations.docx'),
    path.join(__dirname, '..', '..', 'Vungu_Zimbabwe_Role_Expectations.docx'),
  ]
  for (const o of outs) {
    fs.mkdirSync(path.dirname(o), { recursive: true })
    fs.writeFileSync(o, buf)
    console.log('Wrote', o)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
