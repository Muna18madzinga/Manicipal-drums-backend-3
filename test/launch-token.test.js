const crypto = require('node:crypto')
const { sign, verify, claimsForJob, launchUrl, loadPrivateKey } = require('../src/lib/launchToken')

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const other = crypto.generateKeyPairSync('ed25519')
const NOW = 1_800_000_000

const task = {
  id: '11111111-1111-1111-1111-111111111111', task_type: 'verification', stand_number: '4521', suburb_ward: 'Ward 6', gauss_lo: 29,
  instructions: 'Verify the corner beacons', due_date: '2026-11-01', lon: 29.8, lat: -19.45, permit_ref: 'TPD/2026/014',
  authority_code: 'VUNGU', authority_name: 'Vungu Rural District Council',
}
const user = { email: 'Surveyor@Vungu.Test', name: 'S Moyo' }

describe('launch tokens', () => {
  test('a signed token verifies with the matching public key and carries the job', () => {
    const { token } = sign(claimsForJob(task, user), { privateKey, kid: 'k1', now: NOW })
    const c = verify(token, { publicKey, now: NOW + 5 })
    expect(c.iss).toBe('vungis')
    expect(c.aud).toBe('surveypro')
    expect(c.sub).toBe('surveyor@vungu.test')              // lower-cased: the email is the key in SurveyPro
    expect(c.authority).toEqual({ code: 'VUNGU', name: 'Vungu Rural District Council' })
    expect(c.job).toMatchObject({ id: task.id, gauss_lo: 29, stand_number: '4521', due_date: '2026-11-01', location: { lon: 29.8, lat: -19.45 } })
    expect(c.exp - c.iat).toBe(600)
    expect(c.jti).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('every token has its own id, so SurveyPro can refuse a replay', () => {
    const a = sign({}, { privateKey, now: NOW }).claims.jti
    const b = sign({}, { privateKey, now: NOW }).claims.jti
    expect(a).not.toBe(b)
  })

  test('the header names the key (kid) and the algorithm', () => {
    const { token } = sign({}, { privateKey, kid: 'vungis-7', now: NOW })
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'vungis-7' })
  })

  test('a token signed by anyone else is refused', () => {
    const { token } = sign({}, { privateKey: other.privateKey, now: NOW })
    expect(() => verify(token, { publicKey, now: NOW })).toThrow('bad signature')
  })

  test('changing the payload breaks the signature', () => {
    const { token } = sign({ sub: 'a@b.test' }, { privateKey, now: NOW })
    const [h, p, s] = token.split('.')
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    claims.sub = 'someone-else@b.test'
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`
    expect(() => verify(forged, { publicKey, now: NOW })).toThrow('bad signature')
  })

  test('"alg: none" and symmetric algorithms are refused outright', () => {
    const { token } = sign({}, { privateKey, now: NOW })
    const [, p] = token.split('.')
    for (const alg of ['none', 'HS256']) {
      const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url')
      expect(() => verify(`${h}.${p}.`, { publicKey, now: NOW })).toThrow('wrong algorithm')
      expect(() => verify(`${h}.${p}.AAAA`, { publicKey, now: NOW })).toThrow('wrong algorithm')
    }
  })

  test('it expires after ten minutes (plus a minute of clock skew)', () => {
    const { token } = sign({}, { privateKey, now: NOW })
    expect(() => verify(token, { publicKey, now: NOW + 600 + 60 })).not.toThrow()
    expect(() => verify(token, { publicKey, now: NOW + 600 + 61 })).toThrow('expired')
  })

  test('it is not valid before it was issued', () => {
    const { token } = sign({}, { privateKey, now: NOW })
    expect(() => verify(token, { publicKey, now: NOW - 61 })).toThrow('not yet valid')
  })

  test('a token made for another audience or issuer is refused', () => {
    expect(() => verify(sign({ aud: 'something-else' }, { privateKey, now: NOW }).token, { publicKey, now: NOW })).toThrow('wrong audience')
    expect(() => verify(sign({ iss: 'someone' }, { privateKey, now: NOW }).token, { publicKey, now: NOW })).toThrow('wrong issuer')
  })

  test('garbage is not a token', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', null, undefined]) expect(() => verify(bad, { publicKey })).toThrow('not a token')
  })

  test('signing without a key says so rather than producing a token nobody can check', () => {
    expect(() => sign({}, { privateKey: null })).toThrow(/no launch signing key/)
  })

  test('the key can come from the environment, with \\n for newlines', () => {
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const k = loadPrivateKey({ SURVEYPRO_LAUNCH_PRIVATE_KEY: pem.replace(/\n/g, '\\n') })
    const { token } = sign({}, { privateKey: k, now: NOW })
    expect(() => verify(token, { publicKey, now: NOW })).not.toThrow()
    expect(loadPrivateKey({})).toBeNull()
  })

  test('the launch URL points at SurveyPro and carries only the token', () => {
    expect(launchUrl('a.b.c', { SURVEYPRO_URL: 'https://survey.example.org/' })).toBe('https://survey.example.org/launch?token=a.b.c')
    expect(() => launchUrl('a.b.c', {})).toThrow(/SURVEYPRO_URL/)
  })

  test('a due date from the database (a Date at local midnight) becomes YYYY-MM-DD, whatever the time zone', () => {
    expect(claimsForJob({ ...task, due_date: new Date(2026, 11, 1) }, user).job.due_date).toBe('2026-12-01')
    expect(claimsForJob({ ...task, due_date: '2026-12-01T00:00:00.000Z' }, user).job.due_date).toBe('2026-12-01')
    expect(claimsForJob({ ...task, due_date: null }, user).job.due_date).toBeNull()
  })

  test('the claims leave out the applicant and anything private', () => {
    const c = claimsForJob({ ...task, applicant_name: 'Secret', applicant_email: 'x@y.test' }, user)
    expect(JSON.stringify(c)).not.toMatch(/Secret|x@y\.test/)
  })
})
