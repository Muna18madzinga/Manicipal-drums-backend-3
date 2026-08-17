/**
 * prune-smoke-permits.js
 *
 * Removes leftover automated-test permit applications ("Survey Smoke",
 * "Planner Smoke", "Citizen Smoke", "E2E Survey", …) so the Development
 * Register shows only genuine council records during a demo.
 *
 * Safety:
 *   - Dry run by default. Pass --commit to actually delete.
 *   - Always writes a full-row JSON backup of everything it deletes first.
 *   - Only matches applicant names on the explicit SMOKE_PATTERN below; real
 *     applicants are never touched.
 *
 * Run from the backend root:
 *     node scripts/prune-smoke-permits.js            # dry run
 *     node scripts/prune-smoke-permits.js --commit   # delete
 */

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/vungu_master_db_v1';

// Applicant names created by automated smoke/e2e suites. Deliberately narrow
// so a real applicant is never caught by accident.
const SMOKE_PATTERN = '(smoke|^e2e |^test )';
const WHERE = `applicant_name ~* '${SMOKE_PATTERN}'`;

const BACKUP =
  process.env.PRUNE_BACKUP ||
  path.join(__dirname, `smoke-permits-backup-${new Date().toISOString().slice(0, 10)}.json`);

(async () => {
  const commit = process.argv.includes('--commit');
  const c = new Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });
  await c.connect();
  try {
    const doomed = await c.query(
      `SELECT id, tpd_reference, applicant_name, status
         FROM spatial_planning.permit_application
        WHERE ${WHERE}
        ORDER BY tpd_reference`);
    const keep = await c.query(
      `SELECT tpd_reference, applicant_name, status
         FROM spatial_planning.permit_application
        WHERE NOT (${WHERE})
        ORDER BY tpd_reference`);

    console.log(`\nWould delete: ${doomed.rows.length}`);
    console.log(`Would keep:   ${keep.rows.length}`);
    console.table(keep.rows);

    // ON DELETE RESTRICT dependants would abort the delete — surface them first.
    const blocked = await c.query(
      `SELECT count(*)::int n
         FROM spatial_planning.occupation_certificate
        WHERE permit_app_id IN (
          SELECT id FROM spatial_planning.permit_application WHERE ${WHERE})`);
    console.log(`Blocking occupation_certificate rows (ON DELETE RESTRICT): ${blocked.rows[0].n}`);

    if (!doomed.rows.length) { console.log('\nNothing to do.'); return; }

    // Full-row backup before anything is removed.
    const full = await c.query(
      `SELECT * FROM spatial_planning.permit_application WHERE ${WHERE}`);
    fs.writeFileSync(BACKUP, JSON.stringify(full.rows, null, 2), 'utf8');
    console.log(`\nBackup written: ${full.rows.length} rows -> ${BACKUP}`);

    if (!commit) {
      console.log('\nDRY RUN — nothing deleted. Re-run with --commit to apply.');
      return;
    }

    await c.query('BEGIN');
    if (blocked.rows[0].n > 0) {
      const oc = await c.query(
        `DELETE FROM spatial_planning.occupation_certificate
          WHERE permit_app_id IN (
            SELECT id FROM spatial_planning.permit_application WHERE ${WHERE})`);
      console.log(`Removed ${oc.rowCount} occupation_certificate row(s) first.`);
    }
    const r = await c.query(
      `DELETE FROM spatial_planning.permit_application WHERE ${WHERE}`);
    await c.query('COMMIT');
    console.log(`Deleted ${r.rowCount} smoke-test permit(s). Dependants cascaded.`);

    const left = await c.query(
      'SELECT count(*)::int n FROM spatial_planning.permit_application');
    console.log(`permit_application now holds ${left.rows[0].n} row(s).`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('FAILED (rolled back):', e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
})();
