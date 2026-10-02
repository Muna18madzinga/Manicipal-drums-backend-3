// src/services/gms/reconciliation.js
// ─────────────────────────────────────────────────────────────────────────
// GMS <-> ERP reconciliation. Each check is one query yielding (ref_key,
// detail). A run upserts open items (one open item per kind+key, however many
// runs see it) and closes open items that are no longer found, so "items
// cleared" in the monthly report is a count, not a guess.
// ─────────────────────────────────────────────────────────────────────────

const CHECKS = {
  structure_no_account: `
    SELECT p.parcel_id AS ref_key,
           jsonb_build_object('parcel_id', p.parcel_id, 'stand_no', p.stand_no,
             'township_code', p.township_code, 'ward_code', p.ward_code,
             'buildings', count(b.building_id)) AS detail
      FROM land.parcel p
      JOIN land.building b ON b.parcel_id = p.parcel_id
     WHERE p.status <> 'retired'
       AND NOT EXISTS (SELECT 1 FROM revenue_link.account_link a WHERE a.parcel_id = p.parcel_id)
     GROUP BY p.parcel_id`,

  account_no_parcel: `
    SELECT s.erp_account_no AS ref_key,
           jsonb_build_object('erp_account_no', s.erp_account_no, 'status_band', s.status_band) AS detail
      FROM revenue_link.billing_status s
     WHERE s.status_band <> 'closed'
       AND NOT EXISTS (SELECT 1 FROM revenue_link.account_link a WHERE a.erp_account_no = s.erp_account_no)`,

  account_on_retired_parcel: `
    SELECT a.parcel_id || '|' || a.erp_account_no AS ref_key,
           jsonb_build_object('parcel_id', a.parcel_id, 'erp_account_no', a.erp_account_no,
             'township_code', p.township_code, 'stand_no', p.stand_no) AS detail
      FROM revenue_link.account_link a
      JOIN land.parcel p ON p.parcel_id = a.parcel_id
     WHERE p.status = 'retired'`,

  duplicate_stand_no: `
    SELECT township_code || ':' || stand_no AS ref_key,
           jsonb_build_object('township_code', township_code, 'stand_no', stand_no,
             'parcel_ids', array_agg(parcel_id ORDER BY parcel_id)) AS detail
      FROM land.parcel
     WHERE status <> 'retired'
     GROUP BY township_code, stand_no
    HAVING count(*) > 1`,

  // ponytail: area_mismatch needs the ERP's area per account (not in the
  // contract yet); asset_no_erp_number needs the asset register (phase 2).
}

async function runReconciliation(pg) {
  const client = await pg.connect()
  const counts = {}
  try {
    await client.query('BEGIN')
    const { rows: [{ started }] } = await client.query('SELECT now() AS started')
    for (const [kind, sql] of Object.entries(CHECKS)) {
      const { rowCount } = await client.query(
        `INSERT INTO integration.reconciliation_item (kind, ref_key, detail)
         SELECT $1, c.ref_key, c.detail FROM (${sql}) c
         ON CONFLICT (kind, ref_key) WHERE status = 'open'
         DO UPDATE SET detail = EXCLUDED.detail, last_seen_at = now()`,
        [kind],
      )
      counts[kind] = rowCount
    }
    // In a transaction now() is constant, so "seen this run" is
    // last_seen_at >= started; everything older has been fixed at source.
    const { rowCount: cleared } = await client.query(
      `UPDATE integration.reconciliation_item
          SET status = 'resolved', resolved_at = now(),
              resolution_note = 'No longer found by the reconciliation run'
        WHERE status = 'open' AND kind = ANY($1) AND last_seen_at < $2`,
      [Object.keys(CHECKS), started],
    )
    await client.query('COMMIT')
    return { counts, cleared }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

module.exports = { runReconciliation, CHECKS }
