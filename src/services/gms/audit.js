// src/services/gms/audit.js
// ─────────────────────────────────────────────────────────────────────────
// Explicit audit rows for what the onResponse hook (middleware/auditLog.js)
// cannot see: it records mutating requests only, and business rules 6 and 12
// also want every view of personal data and every export, which are GETs.
// Same table, same columns, so the IT admin reads one trail.
// ─────────────────────────────────────────────────────────────────────────

/** Resolves true once the row is written. Callers showing personal data must
 *  withhold it when this returns false: an unlogged view breaks rule 6. */
async function audit(pg, request, { event, severity = 'medium', entityType = null, entityId = null, details = {} }) {
  const u = request.user
  if (!u?.id) return false
  try {
    await pg.query(
      `INSERT INTO public.admin_audit_event
         (actor_id, actor_email, actor_role, event, severity, method, path, status,
          entity_type, entity_id, ip, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 200, $8, $9, $10::inet, $11, $12::jsonb)`,
      [u.id, u.email ?? null, u.role ?? null, event, severity, request.method,
        (request.url || '').split('?')[0].slice(0, 400), entityType,
        entityId == null ? null : String(entityId).slice(0, 64),
        request.ip || null, request.headers['user-agent'] || null, JSON.stringify(details)],
    )
    return true
  } catch (err) {
    request.log.warn({ err }, 'GMS audit write failed')
    return false
  }
}

module.exports = { audit }
