/**
 * Which authority does this deployment of the portal serve?
 *
 * A citizen has no authority of their own (they are not council staff), so what they raise or lodge belongs to the authority whose
 * portal they are using. Today that is one authority per deployment, named by PORTAL_AUTHORITY_CODE (default VUNGU). When several
 * authorities share a deployment this is the one function to change: it would read the authority from the host name or the
 * path instead of the environment, and nothing that calls it would need to.
 *
 * Staff are different: their authority comes from their own record, and the database applies it (app.authority_id()).
 */
let cached = null

const portalAuthorityCode = (env = process.env) => String(env.PORTAL_AUTHORITY_CODE || 'VUNGU').trim().toUpperCase()

/** The id of the authority this portal serves. Throws if it is not configured as an authority, so a typo cannot file things under nobody. */
async function portalAuthorityId(pg, env = process.env) {
  const code = portalAuthorityCode(env)
  if (cached && cached.code === code) return cached.id
  const { rows } = await pg.query('SELECT id FROM public.local_authorities WHERE code = $1', [code])
  if (!rows[0]) throw new Error(`PORTAL_AUTHORITY_CODE ${code} is not an authority in this database`)
  cached = { code, id: rows[0].id }
  return cached.id
}

const resetPortalCache = () => { cached = null }

module.exports = { portalAuthorityId, portalAuthorityCode, resetPortalCache }
