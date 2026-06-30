/**
 * File upload security middleware for SpartialIQ.
 * Validates actual file bytes (magic bytes / file signatures) rather than
 * trusting the client-supplied Content-Type header.
 *
 * Without this, an attacker can rename a .php or .svg file to .pdf and
 * upload it as a "building plan" — the server would store it without validation.
 *
 * Supported types and their magic bytes:
 *   PDF     %PDF    (25 50 44 46)
 *   JPEG    FF D8 FF
 *   PNG     89 50 4E 47 0D 0A 1A 0A
 *   WebP    52 49 46 46 ... 57 45 42 50
 *   HEIC    contains 'ftyp' at offset 4
 *   DWG     41 43 31 30 (AC10 prefix)
 */

const MAGIC_SIGNATURES = [
  { mime: 'application/pdf',  check: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { mime: 'image/jpeg',       check: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { mime: 'image/png',        check: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { mime: 'image/webp',       check: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
                                         && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { mime: 'image/heic',       check: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
  // DWG (AutoCAD drawing) — AC1009 through AC1032
  { mime: 'application/acad', check: (b) => b[0] === 0x41 && b[1] === 0x43 && b[2] === 0x31 && b[3] === 0x30 },
]

const ACCEPTED_MIMES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  'image/heic', 'application/acad', 'application/octet-stream',
])

/**
 * Detects the actual MIME type from file bytes.
 * @param {Buffer} buf — first 16 bytes is enough for all signatures above
 * @returns {string|null} detected MIME type, or null if unrecognised
 */
function detectMime(buf) {
  if (!buf || buf.length < 8) return null
  const b = new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.length, 16))
  for (const sig of MAGIC_SIGNATURES) {
    try {
      if (sig.check(b)) return sig.mime
    } catch {}
  }
  return null
}

/**
 * Validates an uploaded file buffer.
 * @param {Buffer} buf — full file buffer
 * @param {string} claimedMime — MIME type from Content-Type or form field
 * @returns {{ ok: boolean, mime: string|null, error?: string }}
 */
function validateUpload(buf, claimedMime = '') {
  if (!buf || buf.length === 0) {
    return { ok: false, mime: null, error: 'empty_file' }
  }
  const detected = detectMime(buf)
  if (!detected) {
    return { ok: false, mime: null, error: 'bad_mime' }
  }
  if (!ACCEPTED_MIMES.has(detected)) {
    return { ok: false, mime: detected, error: 'bad_mime' }
  }
  return { ok: true, mime: detected }
}

/**
 * Maximum upload sizes by category.
 */
const MAX_BYTES = {
  building_plan:    20 * 1024 * 1024,   // 20 MB — DWG/PDF plans
  identity_doc:     5  * 1024 * 1024,   // 5 MB — ID scans
  inspection_photo: 10 * 1024 * 1024,   // 10 MB — inspection photos
  layout_doc:       20 * 1024 * 1024,   // 20 MB — survey layouts
  default:          10 * 1024 * 1024,   // 10 MB fallback
}

function maxBytesFor(category = 'default') {
  return MAX_BYTES[category] ?? MAX_BYTES.default
}

module.exports = { validateUpload, detectMime, maxBytesFor, ACCEPTED_MIMES }
