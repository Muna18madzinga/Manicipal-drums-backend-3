// src/utils/publicLayers.js
// ─────────────────────────────────────────────────────────────────────────
// What an ANONYMOUS map endpoint may serve. The dynamic-layer and OGC/WFS
// routes read table names from the URL and discover columns at runtime, so
// without these rules they would publish case files and personal details
// (development_applications was flagged as a visible layer and served whole).
//
//   • Only tables registered visible in spatial_layers are servable at all.
//   • Tables holding cases or people are never servable, whatever the flag.
//   • Columns that identify or contact a person are always dropped.
// ─────────────────────────────────────────────────────────────────────────

const PRIVATE_TABLE = /(application|applicant|owner|user|citizen|payment|permit|complaint|appeal|objection|document|kyc|residency|session|audit|inspection|booking|notification|message|ticket)/i

const PERSONAL_COLUMN = /(owner|holder|allottee|applicant|occupant|tenant|surname|first_?name|full_?name|phone|mobile|tel(ephone)?$|email|national|id_?no|id_?number|passport|address|password|token|secret)/i

const isPrivateTable = (name) => PRIVATE_TABLE.test(String(name))
const isPersonalColumn = (name) => PERSONAL_COLUMN.test(String(name))

/** Visible, non-private table names from spatial_layers (public schema only). */
async function publicLayerTables(pg) {
  const { rows } = await pg.query(`
    SELECT sl.table_name
      FROM spatial_layers sl
      JOIN information_schema.tables t
        ON t.table_schema = 'public' AND t.table_name = sl.table_name
     WHERE sl.is_visible = true`)
  return rows.map(r => r.table_name).filter(t => !isPrivateTable(t))
}

module.exports = { isPrivateTable, isPersonalColumn, publicLayerTables }
