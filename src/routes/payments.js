/**
 * Payment routes.
 *
 *   GET  /api/payments/quote                ?priceUsd=25&walletCcy=ZWG
 *                                            Public quote of the current bill
 *                                            in the wallet currency.
 *   GET  /api/payments/rate                  Current exchange rate metadata.
 *   POST /api/payments                       Initiate a payment (auth).
 *   GET  /api/payments/:id                   Read a payment (owner / admin).
 *   POST /api/payments/:id/confirm           Manual driver: mark paid (DEV/QA).
 *   POST /api/payments/:id/cancel            Owner cancels while pending.
 *   GET  /api/payments                       List my payments (auth).
 *   POST /api/payments/webhook/:driver       Provider callbacks
 *                                            (signature verified by driver).
 *
 * Side-effects on confirmation:
 *   - inspection_fee:   sets inspection_bookings.fee_paid_at + flips status
 *                       (pending_payment → waitlisted)
 *   - application_fee:  appends a notification + audit row.
 *
 * Money is always quoted as a NUMERIC string returned to the client and
 * stored as DB NUMERIC; the client must NOT do its own multiplication.
 */

const { requireAuth, requireRole } = require('../middleware/jwtAuth')
const exchangeRate = require('../services/exchangeRate')
const driverModule = require('../services/paymentDriver')
const notifier = require('../services/notifier')

const isString = (v, max = 4096) =>
  typeof v === 'string' && v.length > 0 && v.length <= max

const VALID_PURPOSES = new Set([
  'application_fee', 'inspection_fee', 'permit_fee',
  'occupation_certificate', 'other',
])
const VALID_RELATED_KINDS = new Set([
  'inspection_booking', 'development_application', 'permit',
])
const VALID_DRIVERS = new Set(['manual', 'paynow', 'stripe', 'ecocash', 'onemoney'])
const VALID_WALLETS = new Set(['USD', 'ZWG'])

function paymentDTO(row) {
  return {
    id:               row.id,
    purpose:          row.purpose,
    relatedKind:      row.related_kind,
    relatedId:        row.related_id,
    payerId:          row.payer_id,
    amountUsd:        Number(row.amount_usd),
    amountZwg:        Number(row.amount_zwg),
    rateUsed:         Number(row.rate_used),
    walletCcy:        row.wallet_ccy,
    driver:           row.driver,
    providerRef:      row.provider_ref,
    providerStatus:   row.provider_status,
    status:           row.status,
    issuedReceiptNo:  row.issued_receipt_no,
    paidAt:           row.paid_at,
    receiptUrl:       row.receipt_url,
    metadata:         row.metadata ?? {},
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  }
}

async function paymentRoutes(fastify) {
  // ── Quote ───────────────────────────────────────────────────────────
  fastify.get('/payments/quote', async (request, reply) => {
    try {
      const priceUsd = Number(request.query?.priceUsd)
      const walletCcy = String(request.query?.walletCcy || 'USD').toUpperCase()
      if (!Number.isFinite(priceUsd) || priceUsd < 0) {
        return reply.code(400).send({ success: false, error: 'bad_price' })
      }
      if (!VALID_WALLETS.has(walletCcy)) {
        return reply.code(400).send({ success: false, error: 'bad_wallet' })
      }
      const data = await exchangeRate.quote(fastify.pg, { priceUsd, walletCcy })
      return reply.send({ success: true, data })
    } catch (err) {
      request.log.error({ err }, 'quote failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Current rate (meta) ─────────────────────────────────────────────
  fastify.get('/payments/rate', async (request, reply) => {
    try {
      const meta = await exchangeRate.getLatestRate(fastify.pg)
      return reply.send({ success: true, data: meta })
    } catch (err) {
      request.log.error({ err }, 'rate failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Initiate payment ────────────────────────────────────────────────
  fastify.post('/payments', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const body = request.body || {}
      const purpose     = isString(body.purpose, 32) ? body.purpose : null
      const relatedKind = isString(body.relatedKind, 32) ? body.relatedKind : null
      const relatedId   = isString(body.relatedId, 64) ? body.relatedId : null
      const driverName  = isString(body.driver, 32) ? String(body.driver).toLowerCase() : 'manual'
      const walletCcy   = isString(body.walletCcy, 8) ? String(body.walletCcy).toUpperCase() : 'USD'
      const priceUsd    = Number(body.priceUsd)
      const metadata    = (body.metadata && typeof body.metadata === 'object') ? body.metadata : {}

      if (!purpose || !VALID_PURPOSES.has(purpose)) {
        return reply.code(400).send({ success: false, error: 'bad_purpose' })
      }
      if (relatedKind && !VALID_RELATED_KINDS.has(relatedKind)) {
        return reply.code(400).send({ success: false, error: 'bad_related_kind' })
      }
      if (!VALID_DRIVERS.has(driverName)) {
        return reply.code(400).send({ success: false, error: 'bad_driver' })
      }
      if (!VALID_WALLETS.has(walletCcy)) {
        return reply.code(400).send({ success: false, error: 'bad_wallet' })
      }
      if (!Number.isFinite(priceUsd) || priceUsd < 0) {
        return reply.code(400).send({ success: false, error: 'bad_price' })
      }

      const quoted = await exchangeRate.quote(fastify.pg, { priceUsd, walletCcy })

      const driver = driverModule.getDriver(driverName)

      // Insert as 'pending' first so we have an id for the driver call.
      const { rows } = await fastify.pg.query(
        `INSERT INTO payments
           (purpose, related_kind, related_id, payer_id, payer_email,
            amount_usd, amount_zwg, rate_used, rate_id, wallet_ccy,
            driver, status, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12::JSONB)
         RETURNING *`,
        [
          purpose, relatedKind, relatedId, request.user.id, request.user.email,
          quoted.amountUsd, quoted.amountZwg, quoted.rate, quoted.rateId, walletCcy,
          driverName,
          JSON.stringify(metadata),
        ],
      )
      const row = rows[0]

      // Hand off to the driver.
      let initResult
      try {
        initResult = await driver.initPayment({ payment: row })
      } catch (err) {
        request.log.error({ err }, 'driver initPayment failed')
        await fastify.pg.query(
          `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [row.id],
        )
        return reply.code(502).send({
          success: false, error: 'driver_init_failed', message: err.message,
        })
      }

      const { rows: updated } = await fastify.pg.query(
        `UPDATE payments
            SET status          = 'awaiting_provider',
                provider_ref    = $2,
                provider_status = $3,
                updated_at      = NOW()
          WHERE id = $1
          RETURNING *`,
        [row.id, initResult.providerRef, initResult.providerStatus || null],
      )

      // Merge provider extras into metadata (pollUrl for polling, ussdCode for display)
      const extraMeta = {}
      if (initResult.pollUrl)   extraMeta.pollUrl   = initResult.pollUrl
      if (initResult.pollId)    extraMeta.pollId    = initResult.pollId
      if (initResult.ussdCode)  extraMeta.ussdCode  = initResult.ussdCode
      if (initResult.clientSecret) extraMeta.clientSecret = initResult.clientSecret
      if (initResult.ussdInstructions) extraMeta.ussdInstructions = initResult.ussdInstructions

      if (Object.keys(extraMeta).length > 0) {
        await fastify.pg.query(
          `UPDATE payments SET metadata = metadata || $2::JSONB WHERE id = $1`,
          [row.id, JSON.stringify(extraMeta)],
        )
      }

      return reply.send({
        success: true,
        data: {
          ...paymentDTO(updated[0]),
          redirectUrl:      initResult.redirectUrl  ?? null,
          ussdCode:         initResult.ussdCode     ?? null,
          ussdInstructions: initResult.ussdInstructions ?? null,
          clientSecret:     initResult.clientSecret ?? null,
        },
      })
    } catch (err) {
      request.log.error({ err }, 'payment init failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Available payment methods ────────────────────────────────────────
  // Public — used by the frontend to know which buttons to show.
  // Returns live status per driver without exposing any credentials.
  fastify.get('/payments/methods', async (request, reply) => {
    const { isDriverLive } = driverModule
    return reply.send({
      success: true,
      data: [
        {
          id:          'manual',
          label:       'Manual (dev)',
          description: 'Development mode — confirm in the UI',
          live:        isDriverLive('manual'),
          type:        'dev',
        },
        {
          id:          'paynow',
          label:       'Paynow',
          description: 'EcoCash · OneMoney · Visa · Mastercard · ZimSwitch via Paynow',
          live:        isDriverLive('paynow'),
          type:        'redirect',
          methods:     ['ecocash', 'onemoney', 'visa', 'mastercard', 'zimswitch', 'innbucks'],
        },
        {
          id:          'ecocash',
          label:       'EcoCash Direct',
          description: 'Pay via EcoCash USSD or merchant push (Econet subscribers)',
          live:        isDriverLive('ecocash'),
          type:        'ussd',
          ussdShortcode: '*151*1*1*',
        },
        {
          id:          'onemoney',
          label:       'OneMoney Direct',
          description: 'Pay via OneMoney USSD or merchant push (NetOne subscribers)',
          live:        isDriverLive('onemoney'),
          type:        'ussd',
          ussdShortcode: '*111*2*',
        },
        {
          id:          'stripe',
          label:       'International Card',
          description: 'Visa / Mastercard billed in USD via Stripe',
          live:        isDriverLive('stripe'),
          type:        'card',
        },
      ],
    })
  })

  // ── Read mine / by id ───────────────────────────────────────────────
  fastify.get('/payments/:id', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT * FROM payments WHERE id = $1`,
        [request.params.id],
      )
      const row = rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' })
      const u = request.user
      const isStaff = ['admin', 'planner', 'eo', 'planning_clerk'].includes(u.role)
      if (row.payer_id !== u.id && !isStaff) {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }
      return reply.send({ success: true, data: paymentDTO(row) })
    } catch (err) {
      request.log.error({ err }, 'payment get failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/payments', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT * FROM payments WHERE payer_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [request.user.id],
      )
      return reply.send({ success: true, data: rows.map(paymentDTO) })
    } catch (err) {
      request.log.error({ err }, 'payment list failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Manual confirm (DEV-mode driver). Real providers → /webhook. ────
  fastify.post('/payments/:id/confirm', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT * FROM payments WHERE id = $1`,
        [request.params.id],
      )
      const row = rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' })
      if (row.driver !== 'manual') {
        return reply.code(400).send({
          success: false, error: 'wrong_driver',
          message: 'Manual confirmation only applies to driver=manual.',
        })
      }
      const u = request.user
      const isStaff = ['admin', 'planning_clerk'].includes(u.role)
      if (row.payer_id !== u.id && !isStaff) {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }
      if (row.status === 'paid') {
        return reply.send({ success: true, data: paymentDTO(row), idempotent: true })
      }

      await applyPaid(fastify, row, request.user.id)
      const fresh = await fastify.pg.query(`SELECT * FROM payments WHERE id = $1`, [row.id])
      return reply.send({ success: true, data: paymentDTO(fresh.rows[0]) })
    } catch (err) {
      request.log.error({ err }, 'payment confirm failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Cancel a pending row (owner only, before driver settled) ────────
  fastify.post('/payments/:id/cancel', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT * FROM payments WHERE id = $1`,
        [request.params.id],
      )
      const row = rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' })
      if (row.payer_id !== request.user.id && request.user.role !== 'admin') {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }
      if (!['pending', 'awaiting_provider'].includes(row.status)) {
        return reply.code(409).send({ success: false, error: 'not_cancellable' })
      }
      const { rows: upd } = await fastify.pg.query(
        `UPDATE payments SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [row.id],
      )
      return reply.send({ success: true, data: paymentDTO(upd[0]) })
    } catch (err) {
      request.log.error({ err }, 'payment cancel failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Provider webhooks ───────────────────────────────────────────────
  // Real drivers verify signatures; the dev driver returns ok=false so
  // accidental hits do nothing. CORS is intentionally permissive on
  // this route — providers will POST from arbitrary origins.
  fastify.post('/payments/webhook/:driver', async (request, reply) => {
    try {
      const driver = driverModule.getDriver(request.params.driver)
      const verdict = await driver.verifyWebhook({
        headers: request.headers,
        body:    request.body,
        rawBody: request.rawBody,
      })
      if (!verdict.ok) {
        return reply.code(400).send({ success: false, error: 'bad_webhook' })
      }
      const { rows } = await fastify.pg.query(
        `SELECT * FROM payments WHERE provider_ref = $1`,
        [verdict.providerRef],
      )
      const row = rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' })

      // Update raw provider_status regardless.
      await fastify.pg.query(
        `UPDATE payments SET provider_status = $2, updated_at = NOW() WHERE id = $1`,
        [row.id, verdict.providerStatus || null],
      )
      if (verdict.paid) {
        await applyPaid(fastify, row, null)
      }
      return reply.send({ success: true })
    } catch (err) {
      request.log.error({ err }, 'webhook failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Manual rate insertion (admin) — useful while no fetcher exists ──
  fastify.post('/payments/admin/rates',
    { preHandler: requireRole(fastify, ['admin']) },
    async (request, reply) => {
      try {
        const { rateDate, rate, source, sourceUrl } = request.body || {}
        if (!isString(rateDate, 32) || !isString(source, 64)) {
          return reply.code(400).send({ success: false, error: 'bad_request' })
        }
        const id = await exchangeRate.upsertRate(fastify.pg, {
          rateDate, rate: Number(rate), source, sourceUrl,
        })
        return reply.send({ success: true, data: { id } })
      } catch (err) {
        request.log.error({ err }, 'admin rate failed')
        return reply.code(500).send({ success: false, error: 'internal' })
      }
    },
  )
}

/**
 * Mark a payment row as paid + run the side-effects associated with its
 * purpose. Idempotent: a second call returns without re-running effects.
 */
async function applyPaid(fastify, row, actorUserId) {
  const client = await fastify.pg.connect()
  try {
    await client.query('BEGIN')

    const receiptNo = row.issued_receipt_no
      ? row.issued_receipt_no
      : await driverModule.nextReceiptNumber(client)

    const { rows } = await client.query(
      `UPDATE payments
          SET status            = 'paid',
              paid_at           = COALESCE(paid_at, NOW()),
              issued_receipt_no = COALESCE(issued_receipt_no, $2),
              updated_at        = NOW()
        WHERE id = $1 AND status <> 'paid'
        RETURNING *`,
      [row.id, receiptNo],
    )
    const updated = rows[0]
    if (!updated) {
      // Already paid — nothing else to do.
      await client.query('ROLLBACK')
      return
    }

    if (updated.purpose === 'inspection_fee' && updated.related_kind === 'inspection_booking') {
      // Flip the related booking from pending_payment → waitlisted +
      // emit the existing inspection_waitlisted email.
      const { rows: bookingRows } = await client.query(
        `UPDATE inspection_bookings
            SET status      = CASE WHEN status = 'pending_payment'
                                   THEN 'waitlisted'
                                   ELSE status END,
                fee_paid_at = COALESCE(fee_paid_at, NOW()),
                updated_at  = NOW()
          WHERE id = $1
          RETURNING *`,
        [updated.related_id],
      )
      const booking = bookingRows[0]
      if (booking) {
        await client.query(
          `INSERT INTO inspection_status_events (booking_id, from_status, to_status, actor_id, actor_role, notes)
           VALUES ($1, 'pending_payment', 'waitlisted', $2, 'system', 'fee paid')`,
          [booking.id, actorUserId || null],
        )
        // Find the citizen email on the related application.
        const { rows: contactRows } = await client.query(
          `SELECT u.id AS user_id, u.email,
                  COALESCE(u.full_name, u.name) AS name
           FROM development_applications da
           LEFT JOIN users u ON u.id::text = da.user_id
           WHERE da.id = $1`,
          [booking.application_id],
        )
        const c = contactRows[0]
        if (c?.email) {
          await notifier.enqueue(client, {
            userId: c.user_id, email: c.email,
            kind: 'inspection_waitlisted',
            templateData: {
              applicationId: booking.application_id,
              stageNumber:   booking.stage_number,
              stageName:     booking.stage_name,
              name:          c.name,
            },
            payload: {
              bookingId:  booking.id,
              paymentId:  updated.id,
              receiptNo:  updated.issued_receipt_no,
            },
          })
        }
      }
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

module.exports = { paymentRoutes }
