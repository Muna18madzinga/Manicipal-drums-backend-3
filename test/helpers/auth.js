async function loginAs(app, email, password) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email, password },
  })
  const body = res.json()
  if (!body.success) throw new Error(`login failed: ${JSON.stringify(body)}`)
  return body.data.token
}
module.exports = { loginAs }
