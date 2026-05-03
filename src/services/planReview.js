/**
 * Plan auto-review.
 *
 * Two layers:
 *
 *   1. runDeterministicChecks(file) — rules that we can apply with NO
 *      external dependencies (mime type, size, sha256 dedup, header
 *      sniff for PDF / DWG / DXF / DGN, basic text-search for required
 *      annotations like 'NORTH', 'SCALE', 'SITE PLAN'). This function
 *      always runs and is fast.
 *
 *   2. runDeepChecks(file)  — clearly stubbed. Real geometric checks
 *      (setback measurements, plot coverage off the drawing) require a
 *      CAD parser. The interface is in place so plugging `dxf-parser`
 *      or a python sidecar is one file change. Until that lands, this
 *      function returns nothing, but the citizen can still submit the
 *      plan; staff review remains the final gate.
 *
 * Findings shape:
 *   { severity: 'info'|'warn'|'error', code, message, source?, bbox? }
 */

const crypto = require('node:crypto')

const PDF_MAGIC = Buffer.from('%PDF-')
const DWG_MAGIC = Buffer.from('AC10') // AutoCAD R14+
const DXF_HINT  = Buffer.from('SECTION')

const REQUIRED_PDF_TOKENS = [
  // Lower-cased; we test case-insensitively.
  { code: 'missing_north_arrow', message: 'Drawing is missing a NORTH arrow / orientation indicator.', token: 'north' },
  { code: 'missing_scale_bar',   message: 'Drawing is missing a SCALE indicator (e.g. 1:100, 1:200, scale bar).', token: 'scale' },
  { code: 'missing_site_plan',   message: 'Submission must include a SITE PLAN.', token: 'site plan' },
  { code: 'missing_floor_plan',  message: 'Submission must include a FLOOR PLAN.', token: 'floor plan' },
]

function detectFileKind(buffer, mime) {
  if (mime === 'application/pdf' || (buffer && buffer.slice(0, 5).equals(PDF_MAGIC))) return 'pdf'
  if (mime?.includes('dwg') || (buffer && buffer.slice(0, 4).equals(DWG_MAGIC))) return 'dwg'
  if (mime?.includes('dxf') || (buffer && buffer.includes(DXF_HINT))) return 'dxf'
  return 'unknown'
}

/**
 * Quick text sniff: returns lowercased decoded ASCII from the file
 * (works on PDFs without proper text extraction; we accept some noise
 * because we only ever match plain English keywords).
 */
function sniffText(buffer) {
  if (!buffer) return ''
  // Cap to 2 MB to keep the search bounded for very large PDFs.
  const max = Math.min(buffer.length, 2 * 1024 * 1024)
  // Replace non-ASCII with spaces so token matches don't bleed across binary noise.
  const ascii = []
  for (let i = 0; i < max; i++) {
    const c = buffer[i]
    ascii.push((c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : ' ')
  }
  return ascii.join('').toLowerCase()
}

/**
 * Deterministic checks — always run.
 */
function runDeterministicChecks({ buffer, mime, bytes, allowedKinds = ['pdf'] }) {
  const findings = []

  // 1. Mime / magic.
  const kind = detectFileKind(buffer, mime)
  if (kind === 'unknown') {
    findings.push({
      severity: 'error',
      code: 'unknown_format',
      message: `Could not identify the file format (mime=${mime}). Upload a PDF or recent CAD file.`,
    })
  } else if (!allowedKinds.includes(kind)) {
    findings.push({
      severity: 'error',
      code: 'format_not_supported',
      message: `Format ${kind.toUpperCase()} is not yet supported by the auto-review. Submit a PDF.`,
    })
  }

  // 2. Size sanity — empty (or > 50 MB).
  if (bytes < 100) {
    findings.push({
      severity: 'error',
      code: 'file_too_small',
      message: 'File is empty or truncated.',
    })
  } else if (bytes > 50 * 1024 * 1024) {
    findings.push({
      severity: 'warn',
      code: 'file_very_large',
      message: 'File is over 50 MB. Consider exporting at a lower DPI to speed up review.',
    })
  }

  // 3. PDF token sniff for required annotations.
  if (kind === 'pdf') {
    const text = sniffText(buffer)
    for (const tok of REQUIRED_PDF_TOKENS) {
      if (!text.includes(tok.token)) {
        findings.push({
          severity: 'warn',
          code: tok.code,
          message: tok.message,
          source: { manualSection: '4.2', page: 17 },
        })
      }
    }
  }

  // 4. Hash for dedup at the row layer (route layer reads this).
  const sha256_hex = buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : null

  return { kind, findings, sha256_hex }
}

/**
 * Deep checks — placeholder. When a CAD parser is wired in, this is
 * where geometric measurements run (e.g. "computed building outline
 * exceeds the 50 % plot coverage limit for this zone").
 *
 * Returns an array of findings; an empty array means "we ran nothing".
 */
async function runDeepChecks() {
  // TODO: integrate dxf-parser / pdfjs-dist for setback measurement.
  return []
}

/**
 * Decide overall plan_reviews.status from a findings list.
 */
function statusFromFindings(findings) {
  if (findings.some(f => f.severity === 'error')) return 'auto_failed'
  if (findings.some(f => f.severity === 'warn'))  return 'auto_warnings'
  return 'auto_passed'
}

module.exports = {
  detectFileKind,
  runDeterministicChecks,
  runDeepChecks,
  statusFromFindings,
}
