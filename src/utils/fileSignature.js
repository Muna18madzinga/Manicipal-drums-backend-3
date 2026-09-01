/**
 * Magic-byte sniffing for uploaded files. MIME types declared by the client
 * are not trusted — this checks the actual file header.
 */

function detectMimeFromMagic(buffer) {
  if (!buffer || buffer.length < 4) return null

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 &&
    buffer[2] === 0x4e && buffer[3] === 0x47
  ) {
    return 'image/png'
  }
  if (buffer.slice(0, 4).toString('ascii') === '%PDF') {
    return 'application/pdf'
  }
  if (
    buffer.length >= 12 &&
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii').toLowerCase()
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic'
    }
  }

  return null
}

/**
 * @param {Buffer} buffer
 * @param {string} declaredMime
 * @param {Set<string>} allowed
 * @returns {{ ok: true, mime: string } | { ok: false, reason: string }}
 */
function validateFileSignature(buffer, declaredMime, allowed) {
  const detected = detectMimeFromMagic(buffer)
  if (!detected) {
    return { ok: false, reason: 'unrecognized_signature' }
  }
  if (!allowed.has(detected)) {
    return { ok: false, reason: 'disallowed_type' }
  }
  // HEIC is sometimes declared as image/heif; accept either when bytes say HEIC.
  const declared = String(declaredMime || '').toLowerCase()
  const compatible =
    detected === declared ||
    (detected === 'image/heic' && declared === 'image/heif')
  if (!compatible) {
    return { ok: false, reason: 'mime_mismatch' }
  }
  return { ok: true, mime: detected }
}

module.exports = { detectMimeFromMagic, validateFileSignature }
