// Auth moved to httpOnly cookies (vungu_at / vungu_rt) — login no longer
// returns a token in the JSON body. Existing tests use the return value as
// a Bearer header (`authenticate()` in jwtAuth.js accepts either), so this
// helper keeps that contract by pulling the raw JWT out of the Set-Cookie
// response instead.
async function loginAs(app, email, password) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email, password },
  })
  const body = res.json()
  if (!body.success) throw new Error(`login failed: ${JSON.stringify(body)}`)
  if (body.data.mfaRequired) throw new Error('loginAs: account has MFA enabled, use loginWithMfa')
  const cookie = (res.cookies || []).find((c) => c.name === 'vungu_at')
  if (!cookie) throw new Error('loginAs: no vungu_at cookie in login response')
  return cookie.value
}
module.exports = { loginAs }
