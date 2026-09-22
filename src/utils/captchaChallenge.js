/**
 * Classic visual CAPTCHA for public auth endpoints.
 * Server draws a distorted character image (SVG) and returns an HMAC-signed
 * challenge so verification needs no Redis/session storage.
 * The signed token stores a hash of the code — never the plaintext — so the
 * network response cannot be scraped for the answer.
 * Pair with a honeypot field on the client for bots that skip the UI.
 */
const crypto = require('crypto')

const TTL_MS = 5 * 60 * 1000
const CODE_LEN = 5
// Drop look-alikes (0/O, 1/I/l) so humans can read the image.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function secret() {
  const resolved = process.env.CAPTCHA_SECRET || process.env.JWT_SECRET
  if (!resolved) {
    // A captcha HMAC signed with a publicly-known key can be forged, defeating
    // the bot-protection this is meant to provide. Fail fast instead.
    throw new Error('[captcha] CAPTCHA_SECRET (or JWT_SECRET) must be set in the environment')
  }
  return resolved
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex')
}

function answerHash(code) {
  return crypto.createHmac('sha256', secret()).update(`captcha-ans:${code}`).digest('hex')
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function pickCode(len = CODE_LEN) {
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Distorted CAPTCHA image as an SVG data URI. */
function renderCaptchaSvg(code) {
  const w = 200
  const h = 64
  const bg = '#f4f6f9'
  const parts = []

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`)
  parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`)

  for (let i = 0; i < 6; i++) {
    const x1 = randomInt(0, w)
    const y1 = randomInt(0, h)
    const x2 = randomInt(0, w)
    const y2 = randomInt(0, h)
    const stroke = `rgb(${randomInt(120, 180)},${randomInt(120, 180)},${randomInt(140, 200)})`
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${randomInt(1, 2)}" opacity="0.55"/>`,
    )
  }

  for (let i = 0; i < 40; i++) {
    const cx = randomInt(0, w)
    const cy = randomInt(0, h)
    const r = randomInt(1, 2)
    const fill = `rgb(${randomInt(90, 160)},${randomInt(90, 160)},${randomInt(100, 170)})`
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" opacity="0.45"/>`)
  }

  const chars = code.split('')
  const slot = w / (chars.length + 1)
  chars.forEach((ch, i) => {
    const x = Math.round(slot * (i + 1) + randomInt(-4, 4))
    const y = Math.round(h / 2 + randomInt(-8, 8))
    const rot = randomInt(-28, 28)
    const size = randomInt(26, 34)
    const fill = `rgb(${randomInt(20, 55)},${randomInt(30, 70)},${randomInt(50, 100)})`
    parts.push(
      `<text x="${x}" y="${y}" fill="${fill}" font-family="Georgia, 'Times New Roman', serif" `
      + `font-size="${size}" font-weight="700" text-anchor="middle" dominant-baseline="middle" `
      + `transform="rotate(${rot} ${x} ${y})">${escXml(ch)}</text>`,
    )
  })

  for (let i = 0; i < 2; i++) {
    const y = randomInt(18, h - 18)
    const stroke = `rgb(${randomInt(80, 140)},${randomInt(80, 140)},${randomInt(100, 160)})`
    parts.push(
      `<path d="M0 ${y} Q ${w / 2} ${y + randomInt(-18, 18)} ${w} ${y + randomInt(-10, 10)}" `
      + `fill="none" stroke="${stroke}" stroke-width="1.5" opacity="0.65"/>`,
    )
  }

  parts.push('</svg>')
  const svg = parts.join('')
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

function createCaptchaChallenge() {
  const answer = pickCode()
  const exp = Date.now() + TTL_MS
  const payload = `${answerHash(answer)}.${exp}`
  const challenge = `${payload}.${sign(payload)}`
  return {
    image: renderCaptchaSvg(answer),
    challenge,
    expiresInSec: Math.floor(TTL_MS / 1000),
  }
}

/**
 * @param {string} challenge
 * @param {string|number} answer
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyCaptchaChallenge(challenge, answer) {
  if (typeof challenge !== 'string' || !challenge.includes('.')) {
    return { ok: false, reason: 'missing_challenge' }
  }
  const parts = challenge.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'bad_challenge' }
  const [expectedHash, expStr, sig] = parts
  const payload = `${expectedHash}.${expStr}`
  const expectedSig = sign(payload)
  try {
    const a = Buffer.from(sig, 'utf8')
    const b = Buffer.from(expectedSig, 'utf8')
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'bad_signature' }
    }
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  if (Date.now() > Number(expStr)) return { ok: false, reason: 'expired' }

  const given = String(answer ?? '').replace(/\s+/g, '').toUpperCase()
  if (!given || given.length < 4 || given.length > 8) {
    return { ok: false, reason: 'wrong_answer' }
  }
  const got = answerHash(given)
  try {
    const a = Buffer.from(got, 'utf8')
    const b = Buffer.from(expectedHash, 'utf8')
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'wrong_answer' }
    }
  } catch {
    return { ok: false, reason: 'wrong_answer' }
  }
  return { ok: true }
}

/** True when bots filled the honeypot. */
function honeypotTripped(body) {
  const hp = body?.website ?? body?.company_url ?? body?.fax
  return typeof hp === 'string' && hp.trim().length > 0
}

module.exports = {
  createCaptchaChallenge,
  verifyCaptchaChallenge,
  honeypotTripped,
}
