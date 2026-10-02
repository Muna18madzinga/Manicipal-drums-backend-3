// src/services/gms/erpAdapter.js
// ─────────────────────────────────────────────────────────────────────────
// The ERP side of the outbox. The worker calls adapter.deliver(event) and
// knows nothing else about the ERP, so a different ERP is a different
// adapter here and no change anywhere else.
//
// deliver() resolves { status: 'acknowledged' | 'sent', reply? } or throws.
// 'sent' is for asynchronous channels whose acknowledgement arrives later.
//
//   ERP_ADAPTER=http  ERP_BASE_URL=https://erp.local/api  ERP_API_KEY_REF=...
//   ERP_ADAPTER=stub  (default) an in-process fake ERP for dev, demo and tests
//
// ERP_API_KEY is read from the environment; ERP_API_KEY_REF is only the
// label shown in the admin screen for where that secret is kept.
// ─────────────────────────────────────────────────────────────────────────

function httpAdapter({ baseUrl, apiKey, timeoutMs = 10_000 }) {
  return {
    name: 'http',
    async deliver(event) {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/gms-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': event.idempotency_key,
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`ERP responded ${res.status}`)
      const reply = await res.json().catch(() => null)
      return { status: 'acknowledged', reply }
    },
  }
}

// A fake ERP that remembers what it was sent. `down` simulates an outage.
function stubAdapter() {
  const received = new Map()
  return {
    name: 'stub',
    down: false,
    received,
    async deliver(event) {
      if (this.down) throw new Error('ERP unavailable (stub outage)')
      received.set(event.idempotency_key, event)
      return { status: 'acknowledged', reply: { received: true } }
    },
  }
}

function createErpAdapter(env = process.env) {
  if (env.ERP_ADAPTER === 'http') {
    if (!env.ERP_BASE_URL) throw new Error('ERP_ADAPTER=http needs ERP_BASE_URL')
    return httpAdapter({ baseUrl: env.ERP_BASE_URL, apiKey: env.ERP_API_KEY })
  }
  // ponytail: CSV-over-SFTP fallback adapter not built; see TODO.md.
  return stubAdapter()
}

module.exports = { createErpAdapter, stubAdapter, httpAdapter }
