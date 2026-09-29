/**
 * Full Council Operations Manual — flows, diagrams, roles.
 * Target: close to (not over) 50 pages when opened in Word.
 * Run: node scripts/generate-council-flows-manual-docx.js
 * Output: docs/Vungu_Council_Operations_Flows_Manual.docx
 */
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, WidthType, AlignmentType, ShadingType, PageBreak,
  Header, Footer, PageNumber,
} = require('docx')
const fs = require('fs')
const path = require('path')

const BLUE = '1E3A5F'
const ACCENT = '2563EB'
const LIGHT = 'F1F5F9'
const MONO = 'Consolas'

const h1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 360, after: 160 },
  children: [new TextRun({ text, bold: true, color: BLUE })],
})
const h2 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 280, after: 120 },
  children: [new TextRun({ text, bold: true, color: ACCENT })],
})
const h3 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 200, after: 80 },
  children: [new TextRun({ text, bold: true })],
})
const p = (text) => new Paragraph({
  spacing: { after: 100 },
  children: [new TextRun({ text, size: 22 })],
})
const boldP = (label, text) => new Paragraph({
  spacing: { after: 100 },
  children: [
    new TextRun({ text: label, bold: true, size: 22 }),
    new TextRun({ text, size: 22 }),
  ],
})
const bullet = (text) => new Paragraph({
  spacing: { after: 60 },
  indent: { left: 360 },
  children: [new TextRun({ text: `• ${text}`, size: 21 })],
})
const step = (n, text) => new Paragraph({
  spacing: { after: 60 },
  indent: { left: 360 },
  children: [new TextRun({ text: `${n}. ${text}`, size: 21 })],
})
const blank = () => new Paragraph({ text: '', spacing: { after: 80 } })
const pageBreak = () => new Paragraph({ children: [new PageBreak()] })

/** ASCII / box diagram as monospaced block */
function diagram(lines) {
  return lines.map((line) => new Paragraph({
    spacing: { after: 0 },
    shading: { type: ShadingType.CLEAR, fill: LIGHT },
    children: [new TextRun({ text: line || ' ', font: MONO, size: 16 })],
  }))
}

function cell(text, opts = {}) {
  const { header = false, width = 2400 } = opts
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: header
      ? { type: ShadingType.CLEAR, fill: BLUE }
      : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    children: [new Paragraph({
      children: [new TextRun({
        text: String(text),
        size: header ? 18 : 18,
        bold: header || !!opts.bold,
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
      new TableRow({
        children: headers.map((h) => cell(h, { header: true, width: colW })),
      }),
      ...rows.map((r) => new TableRow({
        children: r.map((c) => cell(c, { width: colW })),
      })),
    ],
  })
}

function sectionTitle(title, subtitle) {
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 80 },
      children: [new TextRun({ text: title, bold: true, size: 48, color: BLUE })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: subtitle, italics: true, size: 22, color: '64748B' })],
    }),
  ]
}

const children = []

// ── COVER ────────────────────────────────────────────────────────────────────
children.push(
  ...sectionTitle(
    'Vungu Rural District Council',
    'SpartialIQ Spatial Operations & Planning Platform',
  ),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 400, after: 120 },
    children: [new TextRun({ text: 'Council Operations Flows Manual', bold: true, size: 36 })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'End-to-end process flows, role responsibilities, and system diagrams', size: 22 })],
  }),
  blank(),
  blank(),
  table(['Field', 'Value'], [
    ['Document type', 'Operations & process manual'],
    ['Audience', 'Council ICT, Town Planning, GIS, EHO, Inspectors, Clerk, Survey'],
    ['Platform', 'SpartialIQ / VunguGIS'],
    ['Date', '23 September 2026'],
    ['DB status', 'Ready — PostGIS + council_ops + 3NF artefacts verified'],
    ['Companion', 'Supervisor-Review-Rectification-Summary.docx'],
  ]),
  blank(),
  p('This manual describes how every council role works inside the platform: who does what, in what order, which screens and APIs are used, and how cases move from citizen intake to determination and field compliance. Diagrams are textual flow charts suitable for printing and training.'),
  pageBreak(),
)

// ── TOC ──────────────────────────────────────────────────────────────────────
children.push(
  h1('Contents'),
  bullet('1. Database & platform readiness'),
  bullet('2. Architecture overview'),
  bullet('3. Role matrix & logins'),
  bullet('Plain English narrations — each person (citizen, clerk, planner, EO, GIS, inspector, EHO, surveyor, admin)'),
  bullet('4. Master development-control journey (end-to-end)'),
  bullet('5. Citizen portal & service desk'),
  bullet('6. Planning Clerk flows'),
  bullet('7. Town Planner flows'),
  bullet('8. EO Planning decision gate'),
  bullet('9. GIS Officer flows'),
  bullet('10. Building Inspector flows'),
  bullet('11. Environmental Health (EHO) flows'),
  bullet('12. Surveyor flows'),
  bullet('13. Admin / ICT flows'),
  bullet('14. Statutory plans & public participation'),
  bullet('15. Appeals & enforcement'),
  bullet('16. Data SSOT & normalisation'),
  bullet('17. Security, CAPTCHA & rate limits'),
  bullet('18. Deployment & smoke tests'),
  bullet('Appendix A — API map by department'),
  bullet('Appendix B — Demo accounts'),
  bullet('Appendix C — Glossary'),
  pageBreak(),
)

// ── 1 READY ──────────────────────────────────────────────────────────────────
children.push(
  h1('1. Database & platform readiness'),
  h2('1.1 Current verification'),
  p('As of this document’s generation date, the local stack reports:'),
  bullet('/ready → status ready; checks.database, postgis, council_ops = true'),
  bullet('3NF artefacts present: ref_stand_statuses, user_profiles, v_stands, zones_master'),
  bullet('Migrations through 128 on the Render allowlist (3NF = 126; zone_id_int = 127; zones bootstrap = 128)'),
  bullet('Production module loop previously green at 49/49 across all nine demo roles'),
  h2('1.2 What “DB ready” means'),
  p('Ready means the application schema, PostGIS extension, council_ops registers, clerk registers, and zone SSOT views exist and pass the readiness probe. It does not mean every OSM basemap row was rebuilt from SQL alone — large geometry still comes from GPKG/pg_dump (see DATA-DUMP-REPORT.md).'),
  h2('1.3 Readiness diagram'),
  ...diagram([
    '  [PostgreSQL + PostGIS]----[schema_migrations allowlist 001–128]',
    '           |',
    '           +-- spatial_planning.* (permits, inspections, EHO, …)',
    '           +-- council_ops.*      (roads, WASH, livestock, service desk)',
    '           +-- planning_clerk.*   (fees, acks, correspondence, …)',
    '           +-- zones_master VIEW  (SSOT peri-urban zones)',
    '           +-- v_stands VIEW      (3NF stands)',
    '           |',
    '  [Fastify /ready] ---- probes DB + PostGIS + council_ops',
    '  [Fastify /health] --- liveness only',
  ]),
  pageBreak(),
)

// ── 2 ARCH ───────────────────────────────────────────────────────────────────
children.push(
  h1('2. Architecture overview'),
  h2('2.1 Layers'),
  p('The platform is a council operations system, not a QGIS desktop replacement. Citizens and officers share one PostGIS database through role-specific Vue portals and a Fastify API.'),
  ...diagram([
    '  ┌──────────── Citizens / Public ────────────┐',
    '  │  Browser → Vite UI (:5174) → /api (:3000) │',
    '  └───────────────────┬───────────────────────┘',
    '                      │ JWT + CAPTCHA (auth)',
    '  ┌───────────────────▼───────────────────────┐',
    '  │           Fastify API + RBAC               │',
    '  │  permits · tiles · clerk · eho · ops · …   │',
    '  └───────────────────┬───────────────────────┘',
    '                      │',
    '  ┌───────────────────▼───────────────────────┐',
    '  │     PostgreSQL + PostGIS (MVT tiles)       │',
    '  └───────────────────────────────────────────┘',
    '                      │',
    '         Optional QGIS Server (WMS/WFS print)',
  ]),
  h2('2.2 Front-end portals'),
  table(['Portal path', 'Primary role', 'Purpose'], [
    ['/citizen', 'registered / viewer', 'Apply, track, map, pay, complain, service desk'],
    ['/planning-clerk-portal', 'planning_clerk', 'Receipt, register, fees, letters, dispatch'],
    ['/planner', 'planner', 'Casework, GIS screening, statutory workflow'],
    ['/eo-planner-portal', 'eo', 'Determination, permits, appeals oversight'],
    ['/gis-officer-portal', 'gis_officer', 'Themes, assets, import, symbology'],
    ['/inspector-workspace', 'building_inspector', 'Stages, field evidence, complaints'],
    ['/env-officer-workspace', 'env_officer', 'Premises, notices, programmes'],
    ['/surveyor', 'surveyor', 'Map console + council jobs'],
    ['/admin', 'admin', 'Users, content, platform status'],
  ]),
  h2('2.3 Design principles'),
  bullet('Single source of truth in Postgres — no fake operational geometries.'),
  bullet('Empty registers stay empty until Council imports or creates records.'),
  bullet('EO (or statutory decision-maker) owns determination; planners prepare.'),
  bullet('CAPTCHA + rate limits protect public auth; staff use JWT sessions.'),
  pageBreak(),
)

// ── 3 ROLES ──────────────────────────────────────────────────────────────────
children.push(
  h1('3. Role matrix & responsibilities'),
  h2('3.1 Who does what'),
  table(['Role', 'Owns', 'Must not'], [
    ['Citizen', 'Own applications, payments, complaints, tickets', 'Edit council registers'],
    ['Planning Clerk', 'Receipt, fees, acknowledgements, dispatch logs', 'Approve / refuse development'],
    ['Planner', 'Assessment, conditions, GIS screening, referrals', 'Final approve without EO path'],
    ['EO Planning', 'Determination, permit issue authority', 'Skip statutory notice where required'],
    ['GIS Officer', 'Spatial SSOT layers, imports, themes, styles', 'Invent geometries without source'],
    ['Building Inspector', 'Stage inspections, enforcement site evidence', 'Alter permit determination'],
    ['EHO', 'Health licences, notices, programmes', 'Issue planning permits'],
    ['Surveyor', 'Beacon/survey jobs linked to council cases', 'Overwrite cadastre as Deeds SSOT'],
    ['Admin', 'Accounts, content, platform health', 'Bypass EO on live determinations (UI gate)'],
  ]),
  h2('3.2 Handoff diagram'),
  ...diagram([
    '  Citizen ──lodge──► Clerk ──register──► Planner ──assess──► EO ──decide──┐',
    '     │                 │                    │                 │           │',
    '     │                 │                    ├──► GIS (site context)       │',
    '     │                 │                    ├──► EHO / referrals          │',
    '     │                 │                    └──► Inspector (stages)       │',
    '     │                 └──── fees / letters / dispatch ◄──────────────────┘',
    '     └── service desk / complaints ──► Inspector or EHO queue',
  ]),
  h2('3.3 Demo accounts (local / non-production)'),
  p('Password for all demo.*@vungu.test accounts: demo1234. Disable DEMO_SEED_ENABLED and rotate secrets before public production.'),
  pageBreak(),
)

// ── PLAIN ENGLISH NARRATIONS (5+ paragraphs per person) ─────────────────────
children.push(
  h1('Plain English — what each person does in this system'),
  p('This chapter explains the system in everyday language. There is one story for each kind of person who uses SpartialIQ at Vungu Rural District Council. Read the story for your job first. Each story has at least five short paragraphs and says exactly what you click, what you must not do, and what happens next.'),
  pageBreak(),
)

children.push(
  h1('The Citizen (resident / applicant)'),
  p('You are a resident or someone who needs a council service. You open the website on your phone or computer, choose Vungu Council, and either create an account or log in. When you create an account you must solve a picture CAPTCHA so bots cannot flood the system. After login you land on the Citizen Portal. That portal is your home: it is not the staff offices.'),
  p('If you want to build, extend, or change the use of land, you start a development application from Services or New application. You upload the forms and plans the council asks for. You can open the map to find your stand or parcel. The coloured council layers come from the council database. The ordinary street map underneath is only a guide; it is not the legal stand register.'),
  p('You can track your file under Applications. You will see whether the clerk has received it, whether fees are due, and whether planners or the EO have moved it forward. You do not approve your own permit. You wait for council staff. If the system asks for more documents, you upload them from Documents or from the case screen.'),
  p('If someone is building without permission, you use Complaints and describe the place. The system gives you a complaint number (for example BC-2026-0004). That number is real. Building inspectors can see it. If you need rates help, a trading licence question, a sewage or refuse problem, a broken road report, social welfare, or a survey enquiry, you use the Services desk and lodge a service ticket. That ticket is stored for staff even when the full online module is not finished yet.'),
  p('You can also open payments, notices, and your profile. Pay carefully and keep your receipt reference. Do not share your password. Do not expect the Ministry Lands simulation screen to be the national Deeds office — it is labelled as a simulation. When you are done, log out on a shared computer.'),
  p('In one sentence: as a citizen you ask, upload, pay, track, and report — you do not decide planning files, you do not edit council maps, and you do not change other people’s cases.'),
  pageBreak(),
)

children.push(
  h1('The Planning Clerk'),
  p('You are the person at the planning counter and the keeper of the paper trail. You log in with the planning clerk account and open the Planning Clerk Portal. Your job is to receive files, take fees, send acknowledgements, keep correspondence, file notice certificates, and later dispatch approved permits or send refusal letters. You do not approve or refuse development yourself. That belongs to the EO path.'),
  p('When a citizen brings a TPD pack or an online application arrives, you open Application receipt. You check that the forms are signed and the documents are present. You record the fee in Fees so the money is in the council register, not only in your notebook. Those fee rows are saved in the database. If you refresh the page or use another computer tomorrow, the receipt is still there.'),
  p('You must issue an acknowledgement within five working days. Open Acknowledgements, create the letter, and when you post or hand it over, mark it sent. The dashboard warns you if an acknowledgement is overdue. For refusals after a council or EO decision, you have a seven-day letter clock. Open Refusals, write the reasons clearly, and mark sent when posted.'),
  p('Public notices and neighbour (abutter) notices are your filing job too. When the newspaper certificate returns, log it under Public notices. When you deliver an adjacent-owner letter, log it in the abutter register. Correspondence is the diary of everything in and out — letters, emails, phone calls, and counter visits. Fill subject, party, and channel every time so nobody can say the council lost the message.'),
  p('When the EO has approved a permit, you open Permit dispatch. You record whether the applicant collected it, whether you posted it, or whether you emailed it, and you keep a proof reference. When something is refused, you do not hide the reasons. You send the refusal letter and leave the trail in the system. Enforcement order typing and the appeals list are also on your menu when those files reach you.'),
  p('In one sentence: you are the memory and the post office of planning — accurate, on time, and never the final decision-maker.'),
  pageBreak(),
)

children.push(
  h1('The Town Planner'),
  p('You are the professional who assesses development applications. You log in as planner and open the Planner workspace. You will see a map and a console of cases. You pick a file from your queue and open the full case. You read what the citizen submitted, what the clerk received, and what fees or letters already exist.'),
  p('You use GIS tools on the case. You select the parcel or stand and run site analysis. The system returns facts from PostGIS such as area and nearby layers. You generate a site screening PDF and put it on the file. That PDF is for the assessment pack, not a fake map drawing. If you need survey or GIS edits, you refer to those officers instead of inventing geometry.'),
  p('You circulate referrals where the handbook requires them — for example environmental health or engineering. You write conditions from the condition library. You record public participation needs so the clerk can run notices. You keep notes clear enough that another planner or the EO can understand the file without calling you.'),
  p('When you think the file is ready, you prepare a recommendation. You must not force a final approval if the system blocks you. If you try to approve and you are not the EO, the API returns an error that an EO decision is required. That is correct behaviour. Your job is to assess and recommend, not to stamp the final yes alone.'),
  p('You may also work on statutory plans and the Planning Studio for layout design. Studio drawings are planning tools. They become council truth only after the proper GIS and survey checks. Always say clearly in notes what is draft and what is adopted.'),
  p('In one sentence: you prepare a complete, honest assessment pack and hand determination to the EO — you do not bypass the decision gate.'),
  pageBreak(),
)

children.push(
  h1('The EO (Evaluating Officer / planning decision-maker)'),
  p('You are the officer who determines development applications in this system. You log in as EO and open the EO Planning portal. You see registers, diligence, circulation, decision, permits, enforcement, and appeals. Planners may sit with you, but the system treats your role as the one that can complete approval.'),
  p('Before you decide, you read the planner pack: plans, screening PDF, referrals, notices, and conditions. If something is missing, you send the file back with clear notes. Do not approve a hollow file. The citizen and the courts will judge the quality of your reasons.'),
  p('When you approve or conditionally approve, the status history records that you did it. That unlocks clerk dispatch of the permit. When you refuse, you write plain reasons. The clerk then runs the refusal letter process. Your notes on status history are for staff; they are protected so random public callers cannot scrape internal comments.'),
  p('You also oversee enforcement and appeals at planning level. Building complaints from citizens can appear in your map or panels so you see what is happening on the ground. You still do not replace the building inspector on site. You use their evidence when you decide stop-work or further action paths.'),
  p('If a planner asks why they cannot approve, explain separation of duties: assessment versus determination. That protects the council. Do not share your EO password with planners to “just finish the queue.”'),
  p('In one sentence: you own the yes, the no, and the conditions — and the system will show that it was you.'),
  pageBreak(),
)

children.push(
  h1('The GIS Officer'),
  p('You are the custodian of the council’s spatial truth in the computer. You log in as GIS officer and open the GIS Officer Portal. You maintain layers, styles, master plan themes, and operational asset registers such as roads, WASH, and livestock. You do not invent stands or roads that do not exist in a source file.'),
  p('When Council brings a GeoJSON or similar file, you use Import assets. First you run a dry-run. The system tells you how many rows it would insert and whether there are errors. Only when the dry-run is clean do you import for real. Empty registers are honest. A register with fake points is a lie on a map.'),
  p('You publish themes and can produce council map schedule PDFs and ward profiles for meetings. Web maps read PostGIS vector tiles. Optional QGIS Server is for special print or WMS needs. If QGIS Server is down, you still keep the web map honest rather than pretending atlas prints exist.'),
  p('Dangerous buttons — WFS publish, QML style upload, and spatial layer writes — now require your GIS or admin login. That stops strangers on the internet from overwriting styles or spawning server jobs. Do not disable those locks on production.'),
  p('When planners argue about zone boundaries, you point them to zones_master, which mirrors the permit master zones table. When stands need a proper zone link, new work should use the integer zone link, not the old confused UUID field. You document sources in the layer notes.'),
  p('In one sentence: you keep the map true, empty when empty, and locked against anonymous edits.'),
  pageBreak(),
)

children.push(
  h1('The Building Inspector'),
  p('You are the field officer for building stages and illegal building complaints. You log in as building inspector and open the Inspector Workspace. Your dashboard shows bookings, stages, case files, complaints, and reports. You work on real sites, not only on the office map.'),
  p('For a booked stage inspection you open the case, check the approved plans, and travel to the site. The system can help with routing. On site you complete the checklist, take photos, and capture GPS when you can. You pass, fail, or mark conditional work. You sync the result so the office file updates.'),
  p('When a citizen lodges an unauthorised building complaint, you see it in your queue. You visit, gather evidence, and recommend the next step. You do not rewrite the EO’s permit decision. If works must stop, you raise enforcement through the proper case notes and orders path with planning.'),
  p('You may open certificates and referrals sections when occupation or specialist input is needed. Keep language factual: what you saw, where, when, and what photo proves it. Opinions without evidence waste the EO’s time.'),
  p('Your mobile day may lose signal. Capture what you can and sync when you are back online. Full offline queues are still being improved, so do not pretend a failed sync was saved. Check the case again in the office.'),
  p('In one sentence: you prove what is on the ground and feed that proof into the file — you do not secretly approve planning applications.'),
  pageBreak(),
)

children.push(
  h1('The Environmental Health Officer (EHO)'),
  p('You protect public health for the council. You log in as environmental health officer and open the EHO workspace. You deal with food premises, sanitation, water, pests, burial permits, clearances, and field programmes. Planning officers may read some of your registers; you are the one who writes health decisions.'),
  p('A citizen may send a trading licence or nuisance ticket through the service desk. That ticket is only a request. It is not a licence by itself. You still inspect the premises. You record the inspection scope and verdict in the EHO system.'),
  p('If the place fails, you serve a notice — for example abatement or closure — and record how you served it. You follow up until the person complies, you escalate, or you withdraw the notice for a documented reason. When someone earns a clearance or certificate, you register it carefully with dates.'),
  p('You also run programmes such as refuse checks or spray runs. Those are area jobs, different from one-premises inspections. Log them so management can see coverage. Use GPS when you work in the field so the map matches your report.'),
  p('You do not issue planning permits. If a planning referral asks for your comment, answer inside the referral path and keep health reasons clear. Share passwords with nobody. Health notices can close a business; treat the system as a legal notebook.'),
  p('In one sentence: you inspect, notice, clear, and programme for health — tickets start the story, your register finishes it.'),
  pageBreak(),
)

children.push(
  h1('The Surveyor'),
  p('You are the licensed survey professional linked to council jobs. You log in as surveyor. You have a map console for daily work and a Survey Task Manager workspace for heavier modules. Council work arrives as jobs — beacon checks, diagrams, and tasks tied to planning or GIS requests.'),
  p('You open your jobs list, accept what is assigned, and carry out the field or office computations your professional rules require. You return coordinates and diagrams into the job record so planners and GIS officers can use them. You do not casually overwrite the council cadastre as if you were the Deeds registry.'),
  p('Some advanced modules in the workspace still show “planned” or empty states. That means they are not finished production tools. Do not tell the client those modules are live if they only show a placeholder. Use the live jobs path and the modules that actually calculate and save.'),
  p('When a citizen asks for a survey through the service desk, that ticket may need a registered surveyor chain. You clarify fees and scope outside or inside the job notes. Keep private survey client data out of the wrong council register.'),
  p('Work with GIS when geometry must become an official layer. Your survey may be right on the ground and still need a controlled import before the public map changes. Agree who presses import.'),
  p('In one sentence: you deliver survey truth into council jobs without pretending unfinished modules are finished.'),
  pageBreak(),
)

children.push(
  h1('The Admin / ICT officer'),
  p('You keep the platform alive for everyone else. You log in as admin and open the Admin area. You create and invite staff users and assign roles: planner, EO, clerk, GIS, inspector, EHO, surveyor, or viewer. You do not casually give everyone admin rights.'),
  p('You watch platform status pages. Those pages should tell the truth. If a microservice is missing, the status should say so. Do not fake green lights. You also manage site content pages for the public website and help with symbology registry access for GIS.'),
  p('On the server you care about secrets and uptime. Production needs strong JWT and CAPTCHA secrets, HTTPS, database backups, and the migration allowlist run through the latest numbers. You probe /health for liveness and /ready for database and PostGIS before you send the public to the site.'),
  p('You disable demo seed accounts on the public internet. Demo passwords are only for training machines. You make sure rate limits and CAPTCHA stay on so strangers cannot hammer login. When GIS asks to open a write API to the world, you say no — those routes stay role-locked.'),
  p('When the map is empty after a new server install, you remember that big OSM basemap data is not created by small SQL migrations alone. You restore the approved dump or GPKG using the data report instructions. Then you re-check /ready and a sample tile.'),
  p('In one sentence: you enable people and protect the system — honest status, strong secrets, and no demo passwords on the live council site.'),
  pageBreak(),
)

children.push(
  h1('How these people meet on one file (simple story)'),
  p('A resident wants to extend a house. She registers, solves the CAPTCHA, and submits a development application with plans. She pays the fee reference the screen shows. She goes home and waits.'),
  p('The planning clerk receives the file, logs the fee, and posts an acknowledgement within five working days. The town planner opens the case, runs the map screening, asks EHO for a comment if needed, and writes conditions. The planner tries to approve and is blocked until the EO decides. That is normal.'),
  p('The EO reads the pack and approves with conditions. The clerk dispatches the permit. Months later the building inspector checks a stage on site and records a pass with photos. If a neighbour had reported illegal building next door, that complaint would have gone to the inspector while this legal file followed the EO path.'),
  p('If the same resident later reports a sewage overflow, she lodges a service ticket. The EHO inspects and may serve a notice. Separately, if beacons are disputed, a surveyor job is raised and GIS only changes the public layer after a controlled update.'),
  p('Admin never appears inside the planning decision, but if the website is down, Admin is the one who restores the database connection and confirms /ready before telling the public to try again. Every person has a lane. The system is built to keep those lanes clear.'),
  pageBreak(),
)

// ── 4 MASTER JOURNEY ─────────────────────────────────────────────────────────
children.push(
  h1('4. Master development-control journey'),
  p('This is the primary statutory path for a Form TPD.1-style development application under the RTCP Act framework as implemented in the platform.'),
  h2('4.1 Swimlane overview'),
  ...diagram([
    ' CITIZEN          CLERK            PLANNER           GIS/EHO         EO            INSPECTOR',
    '   │                │                 │                │             │                 │',
    '   │ apply+CAPTCHA  │                 │                │             │                 │',
    '   ├───────────────►│ receive TPD     │                │             │                 │',
    '   │                │ fee receipt     │                │             │                 │',
    '   │                │ ack (5-day)     │                │             │                 │',
    '   │                ├────────────────►│ case open      │             │                 │',
    '   │                │                 ├───────────────►│ site PDF    │                 │',
    '   │                │                 │◄───────────────┤             │                 │',
    '   │                │                 │ referrals      │             │                 │',
    '   │                │ public notice   │                │             │                 │',
    '   │                │◄────────────────┤                │             │                 │',
    '   │                │                 │ recommend      ├────────────►│ decide          │',
    '   │                │                 │                │             │ approve/refuse  │',
    '   │                │ dispatch/refuse │                │◄────────────┤                 │',
    '   │◄───────────────┤ permit/letter   │                │             │                 │',
    '   │ build…         │                 │                │             │  stages/booking │',
    '   ├────────────────┼─────────────────┼────────────────┼─────────────┼────────────────►│',
    '   │ occupation…    │                 │                │             │◄── pass/fail ───┤',
  ]),
  h2('4.2 Detailed steps'),
  step(1, 'Citizen registers (visual CAPTCHA) and starts a development application or selects a stand on the map.'),
  step(2, 'Clerk receives documents, verifies identity pack, stamps receipt, logs fee in planning_clerk.fee_receipt.'),
  step(3, 'Clerk opens acknowledgement letter (statutory 5 working-day clock) and writes Development Register entry.'),
  step(4, 'Planner opens Application 360 / case file; runs GIS site-context and generates screening PDF.'),
  step(5, 'Planner circulates referrals (EHO, Engineering, etc.) and records conditions.'),
  step(6, 'Where required, public notice / abutter notifications are logged by clerk (notice certificates).'),
  step(7, 'Planner prepares recommendation; cannot PATCH approve — API returns eo_decision_required.'),
  step(8, 'EO records determination; on approval, permit documents become issuable; clerk dispatches.'),
  step(9, 'On refusal, clerk issues refusal letter within the 7-day rule and logs reasons.'),
  step(10, 'Building inspector runs stage inspections; evidence stored against the case.'),
  step(11, 'Citizen tracks status online; appeals path available where a refusal/condition is contested.'),
  h2('4.3 Status vocabulary (normalised)'),
  p('Application statuses are constrained to reference codes (submitted, under_review, pending_payment, approved, conditionally_approved, rejected, withdrawn, expired). Staff change status through the canonical status endpoint so history and notifications stay consistent.'),
  pageBreak(),
)

// ── 5 CITIZEN ────────────────────────────────────────────────────────────────
children.push(
  h1('5. Citizen portal & service desk'),
  h2('5.1 Portal sections'),
  bullet('Dashboard — workload summary for the signed-in resident'),
  bullet('Services desk — full council counter catalogue'),
  bullet('New application / Applications — development cases'),
  bullet('Map — wards, parcels, stands (OSM basemap is reference only)'),
  bullet('Documents, notices, payments, inspections, certificates, appeals'),
  bullet('Complaints — unauthorised building reports'),
  bullet('Service desk tickets — rates, trading licence, nuisance, roads, welfare, survey'),
  bullet('Profile & reference'),
  h2('5.2 Apply for development'),
  ...diagram([
    '  [Login/Register+CAPTCHA] → [Services: Development permit]',
    '            → [New application form + uploads]',
    '            → [Payment if required]',
    '            → [Track in Applications]',
    '            → [Respond to queries / upload missing docs]',
  ]),
  h2('5.3 Building complaint flow'),
  step(1, 'Citizen opens Complaints and describes location / stand / photos.'),
  step(2, 'API creates building_complaints row with reference (e.g. BC-YYYY-####).'),
  step(3, 'Inspector / EO queues see the complaint for follow-up.'),
  h2('5.4 Service desk ticket flow'),
  p('Non-planning counters that are not full online modules still accept a tracked ticket so reception is not a dead end.'),
  ...diagram([
    '  Citizen selects service (rates / licence / nuisance / roads / welfare / survey)',
    '       → ServiceDeskTicketSection posts /api/service-desk/tickets',
    '       → Stored in council_ops.service_desk_ticket',
    '       → Staff list via GET /api/service-desk/tickets',
    '       → Citizen sees “My recent requests”',
  ]),
  h2('5.5 Map honesty'),
  p('The citizen map uses PostGIS MVT for council layers. If tiles fail, the UI may fall back to an OSM reference basemap with a clear banner — OSM is never treated as Council cadastre truth.'),
  pageBreak(),
)

// ── 6 CLERK ──────────────────────────────────────────────────────────────────
children.push(
  h1('6. Planning Clerk flows'),
  p('Clerk work is administrative memory of the planning file. Registers live in Postgres schema planning_clerk (migration 124), not in the browser.'),
  h2('6.1 Section map'),
  table(['Section', 'Register / action'], [
    ['Dashboard', 'Overdue acks / refusals due'],
    ['Application receipt', 'Stamp inward TPD, link permit id'],
    ['Document verification', 'Confirm officer checks on uploads'],
    ['Development Register', 'Public inspection register view'],
    ['Acknowledgements', '5-day letters; mark sent'],
    ['Correspondence', 'In/out log'],
    ['Public notices', 'Newspaper certificates + abutters'],
    ['Fees', 'Fee receipts by kind'],
    ['Permit dispatch', 'Delivery method + proof'],
    ['Refusals', '7-day letters after resolution'],
    ['Enforcement records', 'Typing Sec 32/34 style orders'],
    ['Appeals', 'Appeals register handoff'],
  ]),
  h2('6.2 Fee + acknowledgement sequence'),
  ...diagram([
    '  Receive file → Issue fee receipt (application / scrutiny / notice / …)',
    '              → Create acknowledgement (due = +5 working days)',
    '              → Post letter → markAcknowledgementSent',
    '              → Case visible on planner register',
  ]),
  h2('6.3 Dispatch after EO approval'),
  step(1, 'EO determination = approved / conditionally approved.'),
  step(2, 'Clerk opens Permit dispatch; records collected / post / courier / email.'),
  step(3, 'Citizen can download/receive permit artefacts; inspector stages unlock as configured.'),
  h2('6.4 API surface'),
  bullet('GET/POST /api/clerk/correspondence, fee-receipts, acknowledgements, dispatches, refusals, notice-certificates, abutter-notifications'),
  bullet('PATCH …/acknowledgements/:id/mark-sent and …/refusals/:id/mark-sent'),
  pageBreak(),
)

// ── 7 PLANNER ────────────────────────────────────────────────────────────────
children.push(
  h1('7. Town Planner flows'),
  h2('7.1 Workspace'),
  p('PlannerShell combines the Vungu map (VunguPlannerView) with the console (case queues, statutory sections). Studio opens for parcel-level design work.'),
  h2('7.2 Daily loop'),
  ...diagram([
    '  Open /planner → Dashboard queue',
    '       → Select case → Application 360',
    '       → GIS Analyse → site-context → Generate site report PDF',
    '       → Referrals / conditions / participation',
    '       → Recommendation package',
    '       → Hand to EO (cannot self-approve)',
  ]),
  h2('7.3 Site screening'),
  step(1, 'POST /api/planning/site-context with layer + fid (e.g. vungu_parcels).'),
  step(2, 'Server returns parcel metrics intersecting council layers.'),
  step(3, 'PDF endpoint produces a screening report for the file.'),
  h2('7.4 Planning Studio'),
  p('Studio supports subdivision / layout tools (roads, stands, DXF interchange). Outputs must reconcile with GIS SSOT before being treated as council truth — surveyor/GIS sign-off paths apply.'),
  h2('7.5 Statutory shell'),
  p('Statutory workflow sections cover plan-making steps distinct from development control permits. Plans are stored in spatial_planning.statutory_plan.'),
  pageBreak(),
)

// ── 8 EO ─────────────────────────────────────────────────────────────────────
children.push(
  h1('8. EO Planning decision gate'),
  h2('8.1 Why the gate exists'),
  p('Separation of duties: planners assess; the EO (or assigned decision-maker) determines. The API enforces this on approve transitions.'),
  ...diagram([
    '  Planner PATCH status=approved',
    '        │',
    '        ▼',
    '  [EO gate] ──no──► HTTP 403 eo_decision_required',
    '        │ yes (role=eo + decision recorded)',
    '        ▼',
    '  Status history + notifications + clerk dispatch unlocked',
  ]),
  h2('8.2 EO portal sections (summary)'),
  bullet('Register / intake / diligence / notification / circulation'),
  bullet('Committee / decision / permits / enforcement / appeals'),
  bullet('Plans / reports / reference / settings'),
  h2('8.3 Complaints visibility'),
  p('EO map panels can load live building complaints so determination and enforcement context stay linked to citizen reports.'),
  pageBreak(),
)

// ── 9 GIS ────────────────────────────────────────────────────────────────────
children.push(
  h1('9. GIS Officer flows'),
  h2('9.1 Responsibilities'),
  p('Maintain authoritative spatial layers, styles, and operational asset registers. Never invent geometries; import with dry-run first.'),
  h2('9.2 Ops registers'),
  table(['Register', 'API', 'UI'], [
    ['Roads & Works', '/api/ops/roads', 'RoadsWorksSection'],
    ['WASH', '/api/ops/wash', 'WashAssetsSection'],
    ['Livestock', '/api/ops/livestock', 'LivestockSection'],
    ['Import', '/api/ops/import (dry-run)', 'OpsImportSection'],
    ['Master themes', '/api/ops/master-themes', 'MasterThemesSection'],
    ['Council map PDF', '/api/ops/council-map-report', 'GIS portal'],
  ]),
  h2('9.3 Import flow'),
  ...diagram([
    '  Prepare GeoJSON (Council truth)',
    '     → POST import dry_run=true → review would_insert / errors',
    '     → POST import dry_run=false → rows in council_ops.*',
    '     → Refresh register UI + map themes',
  ]),
  h2('9.4 Tile pipeline'),
  p('MVT tiles are generated with parameterized SQL, GiST bbox filters, zoom-aware simplification, and per-layer SRID (storage 4326). Missing tables return empty 204 tiles rather than breaking the map.'),
  h2('9.5 Protected write APIs'),
  p('After supervisor rectification, WFS publish, dynamic-layer QML upload, and spatial layer/feature writes require admin or gis_officer JWT roles.'),
  pageBreak(),
)

// ── 10 INSPECTOR ─────────────────────────────────────────────────────────────
children.push(
  h1('10. Building Inspector flows'),
  h2('10.1 Console'),
  bullet('Dashboard / bookings / stages / preconstruction'),
  bullet('Case file / plans / enforcement / complaints'),
  bullet('Certificates / referrals / reports / reference / settings'),
  h2('10.2 Stage inspection loop'),
  ...diagram([
    '  Queue item → Open inspection → Navigate to site (routing graph)',
    '     → Capture checklist + photos + GPS',
    '     → Score / verdict → Sync to server',
    '     → Trigger next stage or enforcement flag',
  ]),
  h2('10.3 Complaints'),
  p('Citizen unauthorised-building tickets appear for fielding. Inspectors must not change EO determinations; they record evidence and stage outcomes.'),
  pageBreak(),
)

// ── 11 EHO ───────────────────────────────────────────────────────────────────
children.push(
  h1('11. Environmental Health (EHO) flows'),
  h2('11.1 Operational record'),
  p('EHO APIs under /api/eho cover notices, inspections, food handlers, burial permits, clearances, programmes, and a dashboard summary. Writing is env_officer/admin; other planning roles may read where needed.'),
  h2('11.2 Typical licence / notice path'),
  ...diagram([
    '  Premises / trading ticket (citizen service desk or counter)',
    '     → EHO inspection (scope: food_hygiene / sanitation / …)',
    '     → Pass / conditional / fail',
    '     → Notice (abatement / closure / …) if required',
    '     → Clearance / certificate register entry',
  ]),
  h2('11.3 Programmes'),
  p('Field programmes (refuse, spray, latrine, education, …) are logged with optional GPS. They are operational memory under the Public Health Act — the officer decides; the system records.'),
  pageBreak(),
)

// ── 12 SURVEYOR ──────────────────────────────────────────────────────────────
children.push(
  h1('12. Surveyor flows'),
  h2('12.1 Two surfaces'),
  bullet('/surveyor — map console + task queue for council work'),
  bullet('/surveyor-workspace — Survey Task Manager modules'),
  h2('12.2 Council job path (production)'),
  ...diagram([
    '  Planner/GIS requests survey → Job in /api/surveyor/jobs',
    '     → Surveyor accepts → Field / compute modules',
    '     → Deliver diagram / coordinates → Link back to case',
  ]),
  h2('12.3 Planned modules'),
  p('Mining/topo/CAD “Planned” modules show empty states rather than crashing. They are not claimed as live council production paths until commissioned.'),
  pageBreak(),
)

// ── 13 ADMIN ─────────────────────────────────────────────────────────────────
children.push(
  h1('13. Admin / ICT flows'),
  h2('13.1 Duties'),
  bullet('Invite and assign staff roles (planner, eo, clerk, gis, inspector, eho, surveyor, viewer)'),
  bullet('Site content / CMS pages under /council/:slug'),
  bullet('Platform status (Phase 2 probes — honest, not fake OPERATIONAL)'),
  bullet('Security dashboard, symbology registry, land-use admin tools'),
  h2('13.2 Production checklist (ICT)'),
  step(1, 'Set NODE_ENV=production, JWT_SECRET, CAPTCHA_SECRET, DATABASE_URL.'),
  step(2, 'Run migrate-render.js through 128.'),
  step(3, 'Restore basemap GPKG/dump if map layers empty.'),
  step(4, 'Point NGINX at frontend/dist; proxy /api; TLS.'),
  step(5, 'Probe /health and /ready; run production-module-loop against staging.'),
  step(6, 'DEMO_SEED_ENABLED=false; remove demo passwords from public sites.'),
  pageBreak(),
)

// ── 14 STATUTORY ─────────────────────────────────────────────────────────────
children.push(
  h1('14. Statutory plans & public participation'),
  p('Plan-making is separate from development control. Statutory plans live in spatial_planning.statutory_plan and are edited through planner/EO plan sections.'),
  ...diagram([
    '  Draft plan → Internal review → Public participation window',
    '     → Objections log → Committee / EO consideration',
    '     → Adopt / amend → Publish map schedule (themes / PDF)',
  ]),
  p('Public participation artefacts (notices, certificates) are filed by the clerk against the relevant plan or permit file.'),
  pageBreak(),
)

// ── 15 APPEALS ───────────────────────────────────────────────────────────────
children.push(
  h1('15. Appeals & enforcement'),
  h2('15.1 Appeals'),
  p('Appeals against refusals or conditions are tracked in the appeals register. Clerk and EO portals both expose appeals sections; API routes under /api/appeals support the register.'),
  h2('15.2 Enforcement'),
  ...diagram([
    '  Breach observed (inspector/citizen/EHO)',
    '     → Case / complaint / notice',
    '     → Enforcement mapping (GIS) + evidence certificate PDF',
    '     → Order typing (clerk/EO) → Compliance revisit',
  ]),
  pageBreak(),
)

// ── 16 SSOT ──────────────────────────────────────────────────────────────────
children.push(
  h1('16. Data SSOT & normalisation'),
  h2('16.1 Canonical tables'),
  table(['Concept', 'SSOT'], [
    ['Peri-urban zones', 'proposed_peri_urban_zones + view zones_master'],
    ['Stands', 'stands + view v_stands (use zone_id_int)'],
    ['Users', 'public.users + user_profiles'],
    ['Development control', 'spatial_planning.permit_application'],
    ['Council assets', 'council_ops.*'],
    ['Clerk registers', 'planning_clerk.*'],
  ]),
  h2('16.2 3NF package'),
  bullet('ref_stand_statuses, ref_scale_categories, ref_use_scales, ref_zone_types, ref_application_statuses'),
  bullet('ward_fid FK; status_code / use_scale_code'),
  bullet('user_profiles separated from auth columns'),
  bullet('zone_id_int integer FK — do not join legacy UUID zone_id to serial zone ids'),
  h2('16.3 Dump-only honesty'),
  p('OSM buildings/roads and some ward/district polygons are not created by migrations. Fresh environments need a documented restore. Empty operational registers are intentional until import.'),
  pageBreak(),
)

// ── 17 SECURITY ──────────────────────────────────────────────────────────────
children.push(
  h1('17. Security, CAPTCHA & rate limits'),
  h2('17.1 Auth'),
  bullet('JWT access tokens with optional session id for logout/revocation'),
  bullet('Visual CAPTCHA on register/login (demo@vungu.test bypass only when not production)'),
  bullet('Role checks via requireRole / requireAuth preHandlers'),
  h2('17.2 Hardened writes (supervisor audit)'),
  bullet('WFS publisher, dynamic-layer QML, spatial writes → admin/gis_officer'),
  bullet('Application status-history GET → STAFF_ROLES'),
  bullet('OGC cache clear → admin/gis_officer'),
  h2('17.3 Rate limits'),
  p('Global and auth-scoped limits return HTTP 429 with retry messaging. Health/ready and tile/map-search paths are allow-listed appropriately.'),
  pageBreak(),
)

// ── 18 DEPLOY ────────────────────────────────────────────────────────────────
children.push(
  h1('18. Deployment & smoke tests'),
  h2('18.1 Minimal smoke'),
  step(1, 'GET /health → ok'),
  step(2, 'GET /ready → ready'),
  step(3, 'node scripts/production-module-loop.js → expect all modules PASS'),
  step(4, 'Browser: login each demo role; open home section; confirm no white screen'),
  h2('18.2 Interaction checks'),
  bullet('Citizen complaint creates BC- reference'),
  bullet('Planner approve blocked without EO'),
  bullet('Clerk fee persists after refresh'),
  bullet('GIS dry-run import returns would_insert'),
  bullet('Service desk ticket POST returns 201'),
  pageBreak(),
)

// ── EXPANDED TRAINING DETAIL (fills toward ~50 pages) ───────────────────────
children.push(
  h1('19. Training deep-dive — Citizen journey variants'),
  h2('19.1 Stand interest vs development permit'),
  p('Stand allocation interest and development permits are different legal paths. Interest expresses demand for an available stand and still closes at Housing with stamped forms. A development permit assumes authority over land (title, lease, or allocation letter) and engages statutory planning clocks.'),
  ...diagram([
    '  [Map: available stand] ──interest──► Housing counter (allocation)',
    '  [Parcel + authority] ──TPD.1──► Planning DC path (this manual §4)',
  ]),
  h2('19.2 Payment touchpoints'),
  p('Where fees apply (application, scrutiny, notice, occupation), the citizen payments views initiate a payment reference. Drivers may be manual or Paynow depending on environment. Card/Apple/Google tiles may show coming-soon until configured. Clerk fee receipts remain the counter SSOT for cash/EcoCash logged at reception.'),
  h2('19.3 Residency & KYC'),
  p('Some services require residency verification. The residency module collects proof; Ministry Lands UI is labelled simulation and must not be presented as the national Deeds registry.'),
  blank(),
  h2('19.4 Worked example — lodge a nuisance ticket'),
  step(1, 'Sign in as citizen/viewer.'),
  step(2, 'Open Services → Nuisance / sanitation complaint.'),
  step(3, 'Complete location, phone, and details; submit.'),
  step(4, 'Note ticket id under My recent requests.'),
  step(5, 'EHO staff later lists tickets via GET /api/service-desk/tickets and opens a health inspection if warranted.'),
  pageBreak(),
)

children.push(
  h1('20. Training deep-dive — Clerk day book'),
  h2('20.1 Morning checklist'),
  bullet('Dashboard: acknowledgements overdue? refusals due?'),
  bullet('Inward tray: new online applications vs counter TPD packs'),
  bullet('Fee reconciliation: yesterday’s receipts vs bank/EcoCash slip'),
  bullet('Dispatch shelf: approved permits awaiting collection'),
  h2('20.2 Worked example — acknowledge a new file'),
  step(1, 'Login demo.clerk@vungu.test → Acknowledgements.'),
  step(2, 'Create letter with permit_application_id and register number.'),
  step(3, 'System stores due_by = plus working days from received_at.'),
  step(4, 'Print/post; click mark sent when posted.'),
  step(5, 'Refresh — record remains (Postgres), not only this browser.'),
  h2('20.3 Correspondence hygiene'),
  p('Every inbound letter/email/phone note that affects the file should appear in correspondence with direction, channel, party, and subject. This protects the council when timelines or “we never got your letter” disputes arise.'),
  ...diagram([
    '  IN  letter/email/phone/in_person  → correspondence (direction=in)',
    '  OUT acknowledgement/refusal/dispatch → correspondence (direction=out)',
    '       + specialised register row (ack / refusal / dispatch)',
  ]),
  pageBreak(),
)

children.push(
  h1('21. Training deep-dive — Planner assessment pack'),
  h2('21.1 Minimum pack before EO'),
  bullet('Complete application form + ownership/authority evidence'),
  bullet('Site/locality plan and building plans as required'),
  bullet('GIS screening PDF on file'),
  bullet('Referral responses or timed-out notes'),
  bullet('Draft conditions library selections'),
  bullet('Public notice compliance evidence where applicable'),
  h2('21.2 Worked example — site report'),
  step(1, 'Login planner → open case → GIS tools.'),
  step(2, 'Select parcel feature (layer vungu_parcels, fid).'),
  step(3, 'Run Analyse / site-context.'),
  step(4, 'Generate complete site report PDF; file under documents.'),
  step(5, 'Summarise constraints in case notes for EO.'),
  h2('21.3 Failure mode — premature approve'),
  ...diagram([
    '  Planner clicks Approve',
    '     → API gate',
    '     → 403 eo_decision_required',
    '     → UI should show “Awaiting EO determination”',
  ]),
  pageBreak(),
)

children.push(
  h1('22. Training deep-dive — EO determination sitting'),
  h2('22.1 Decision types'),
  bullet('Approve — permit may issue subject to conditions'),
  bullet('Conditionally approve — conditions binding before/during works'),
  bullet('Refuse — reasons recorded; clerk refusal letter clock starts'),
  bullet('Defer — await committee, more information, or site visit'),
  h2('22.2 Audit expectations'),
  p('Every determination should leave: actor id, timestamp, from/to status, notes, and any generated documents. Status-history is staff-only so internal notes are not publicly scraped.'),
  pageBreak(),
)

children.push(
  h1('23. Training deep-dive — GIS change control'),
  h2('23.1 Before editing production layers'),
  bullet('Confirm layer SSOT table (zones_master vs dump copy)'),
  bullet('Backup or work in a staging schema if large'),
  bullet('Dry-run GeoJSON import'),
  bullet('Symbology via registry — avoid one-off undocumented QML on prod without auth'),
  h2('23.2 Theme schedule publication'),
  p('Master themes catalogue drives map legend language for Master Plan communication. Council map PDF produces a printable schedule for meetings without claiming QGIS atlas fidelity unless QGIS Server print is configured.'),
  ...diagram([
    '  Authoritative Geometry → PostGIS table/view',
    '       → MVT tiles (web)',
    '       → Optional WMS (QGIS Server)',
    '       → PDF schedule / ward profile / evidence certificate',
  ]),
  pageBreak(),
)

children.push(
  h1('24. Training deep-dive — Inspector field day'),
  h2('24.1 Pre-site'),
  bullet('Confirm booking and stage type'),
  bullet('Download case brief / plans offline notes if needed'),
  bullet('Check navigation route to site'),
  h2('24.2 On site'),
  bullet('Verify stand/parcel identity against map'),
  bullet('Complete checklist; photograph non-compliance'),
  bullet('Record GPS source (field_gps / map_pick)'),
  h2('24.3 After site'),
  bullet('Sync verdict; flag enforcement if stop-work needed'),
  bullet('Notify planner/EO via case notes if determination impact'),
  pageBreak(),
)

children.push(
  h1('25. Training deep-dive — EHO premises week'),
  h2('25.1 From ticket to notice'),
  p('A trading-licence or nuisance ticket is intake, not a licence. EHO still inspects under the Public Health Act and records notices/clearances in /api/eho registers.'),
  ...diagram([
    '  Ticket → Schedule inspection → Verdict',
    '     → if fail: serve notice (hand/post/affix)',
    '     → follow-up → comply / escalate / withdraw',
    '     → clearance or certificate when earned',
  ]),
  h2('25.2 Programmes vs inspections'),
  p('Programmes are area operations (spray, refuse). Inspections are premises-scoped. Both appear on the EHO summary counters.'),
  pageBreak(),
)

children.push(
  h1('26. Cross-cutting timelines (statutory clocks)'),
  table(['Clock', 'Owner', 'System support'], [
    ['Ack within 5 working days', 'Clerk', 'acknowledgement due_by + overdue dashboard'],
    ['Refusal letter within 7 days of resolution', 'Clerk', 'refusal due_by + mark sent'],
    ['Public notice period', 'Planner/Clerk', 'notice certificates + abutter log'],
    ['Inspection stage windows', 'Inspector', 'stage bookings / queue'],
    ['Appeal windows', 'Citizen/EO', 'appeals register'],
  ]),
  p('Working-day helpers exist in clerk composables (skip weekends). Council holiday calendars may still need manual adjustment in notes until a holiday table is commissioned.'),
  pageBreak(),
)

children.push(
  h1('27. Exception & escalation matrix'),
  table(['Situation', 'Escalate to', 'System cue'], [
    ['Missing docs after ack', 'Citizen + Clerk', 'Application query status / messages'],
    ['Planner blocked on approve', 'EO', '403 eo_decision_required'],
    ['Dangerous structure', 'Inspector + EO', 'Complaint priority / enforcement'],
    ['Health closure', 'EHO', 'Notice type closure'],
    ['Geometry dispute', 'GIS + Surveyor', 'Job + evidence certificate'],
    ['System outage', 'Admin/ICT', '/ready failing; status page'],
  ]),
  pageBreak(),
)

children.push(
  h1('28. RACI summary (council digital file)'),
  table(['Activity', 'R', 'A', 'C', 'I'], [
    ['Receive TPD', 'Clerk', 'Clerk', 'Planner', 'Citizen'],
    ['GIS screening', 'Planner', 'Planner', 'GIS', 'EO'],
    ['Determination', 'EO', 'EO', 'Planner', 'Clerk/Citizen'],
    ['Permit dispatch', 'Clerk', 'EO', 'Planner', 'Citizen'],
    ['Stage inspection', 'Inspector', 'EO/Planner', 'Clerk', 'Citizen'],
    ['Health notice', 'EHO', 'EHO', 'Clerk', 'Citizen'],
    ['Layer import', 'GIS', 'GIS', 'Planner', 'Admin'],
  ]),
  p('R=Responsible, A=Accountable, C=Consulted, I=Informed — adapted for digital workflow training.'),
  pageBreak(),
)

children.push(
  h1('29. Document & evidence catalogue'),
  bullet('Site screening PDF — planning/GIS'),
  bullet('Ward profile PDF — ops'),
  bullet('Council map theme schedule PDF — GIS'),
  bullet('s74-style evidence certificate PDF — enforcement/GIS'),
  bullet('Permit / refusal / acknowledgement letters — clerk registers'),
  bullet('Inspection photos — inspector field events'),
  bullet('QML/style registry — GIS symbology (authenticated writes)'),
  pageBreak(),
)

children.push(
  h1('30. Continuous improvement backlog (honest)'),
  bullet('Staff service-desk inbox UI (API exists)'),
  bullet('Full offline inspector sync (Phase 3)'),
  bullet('QGIS Server atlas for sealed A0/A1'),
  bullet('Committee / Director / Minister role enum if Council commissions'),
  bullet('Publish basemap GPKG URL for reproducible deploys'),
  bullet('Paynow/card production drivers beyond manual'),
  p('These are not blockers for day-to-day DC/clerk/GIS/EHO/inspector use of the current spine.'),
  pageBreak(),
)

// ── APPENDIX A ───────────────────────────────────────────────────────────────
children.push(
  h1('Appendix A — API map by department'),
  table(['Department', 'Prefix / examples'], [
    ['Auth', '/api/auth/login, /captcha, /me'],
    ['Citizen', '/api/citizen-*, /service-desk/tickets, /building-complaints'],
    ['DC / permits', '/api/permit-applications*, /applications/:id/status'],
    ['Planning GIS', '/api/planning/site-context, site PDF'],
    ['Clerk', '/api/clerk/*'],
    ['GIS ops', '/api/ops/*, /api/tiles/*, /map-search'],
    ['Inspector', '/api/inspections*, /inspector-*'],
    ['EHO', '/api/eho/*'],
    ['Survey', '/api/surveyor/*, /api/survey/*'],
    ['Admin', '/api/admin/users, site-content'],
  ]),
  blank(),
  h1('Appendix B — Demo accounts'),
  table(['Email', 'Role'], [
    ['demo.admin@vungu.test', 'admin'],
    ['demo.planner@vungu.test', 'planner'],
    ['demo.eo@vungu.test', 'eo'],
    ['demo.clerk@vungu.test', 'planning_clerk'],
    ['demo.gis@vungu.test', 'gis_officer'],
    ['demo.inspector@vungu.test', 'building_inspector'],
    ['demo.envoffice@vungu.test', 'env_officer'],
    ['demo.surveyor@vungu.test', 'surveyor'],
    ['demo.viewer@vungu.test', 'viewer'],
  ]),
  blank(),
  h1('Appendix C — Glossary'),
  boldP('MVT — ', 'Mapbox Vector Tiles generated from PostGIS for the web map.'),
  boldP('SSOT — ', 'Single Source of Truth; the table/view new code must read.'),
  boldP('EO — ', 'Evaluating Officer / planning decision authority in this deployment.'),
  boldP('EHO — ', 'Environmental Health Officer.'),
  boldP('TPD.1 — ', 'Development application form family used at reception.'),
  boldP('Dry-run import — ', 'Validate GeoJSON insert counts without writing rows.'),
  boldP('3NF — ', 'Third Normal Form; reference tables remove transitive/repeating attributes.'),
  blank(),
  blank(),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: '— End of Council Operations Flows Manual —', italics: true, color: '64748B' })],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120 },
    children: [new TextRun({ text: 'Vungu RDC · SpartialIQ · September 2026', size: 18, color: '94A3B8' })],
  }),
)

async function main() {
  const doc = new Document({
    creator: 'SpartialIQ',
    title: 'Vungu Council Operations Flows Manual',
    description: 'End-to-end council process flows and diagrams for SpartialIQ',
    styles: {
      default: {
        document: {
          styles: [],
        },
      },
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickStyle: true,
          paragraph: { spacing: { before: 360, after: 160 } },
          run: { size: 32, bold: true, color: BLUE, font: 'Calibri' },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          quickStyle: true,
          run: { size: 26, bold: true, color: ACCENT, font: 'Calibri' },
        },
        {
          id: 'Heading3',
          name: 'Heading 3',
          basedOn: 'Normal',
          next: 'Normal',
          quickStyle: true,
          run: { size: 24, bold: true, font: 'Calibri' },
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top: 720, bottom: 720, left: 720, right: 720,
          },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            children: [
              new TextRun({ text: 'Vungu RDC · SpartialIQ Council Flows Manual', size: 16, color: '64748B' }),
            ],
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
              new TextRun({ text: ' of ', size: 16, color: '64748B' }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '64748B' }),
            ],
          })],
        }),
      },
      children,
    }],
  })

  const outDir = path.join(__dirname, '..', 'docs')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, 'Vungu_Council_Operations_Flows_Manual.docx')
  const outAlt = path.join(outDir, 'Vungu_Council_Flows_Manual_Plain_English.docx')
  const buf = await Packer.toBuffer(doc)
  const targets = [
    outAlt,
    path.join(__dirname, '..', '..', 'Vungu_Council_Flows_Manual_Plain_English.docx'),
    path.join(__dirname, '..', '..', 'Vungu_Council_Operations_Flows_Manual.docx'),
  ]
  try {
    fs.writeFileSync(out, buf)
    targets.push(out)
    console.log('Wrote', out)
  } catch (e) {
    console.warn('Could not overwrite open file:', out, '-', e.code)
  }
  for (const t of targets) {
    try {
      fs.writeFileSync(t, buf)
      console.log('Wrote', t)
    } catch (e) {
      console.warn('Skip', t, e.code)
    }
  }
  console.log('Approx content blocks:', children.length)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
