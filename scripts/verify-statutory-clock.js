#!/usr/bin/env node
/**
 * Does the database count the statutory periods the way the Regional, Town and Country Planning Act [Chapter 29:12] does?
 *
 *   node scripts/verify-statutory-clock.js          (uses DATABASE_URL; changes nothing: everything runs in a rolled-back transaction)
 *
 * s.26(7): three calendar months from the date of ACKNOWLEDGEMENT, then deemed refused; s.40(6): four months for a subdivision or
 * consolidation. Migrations 170 and 171 put that arithmetic in the database; this proves it, including the cases that are easy to
 * get wrong (month ends, a draft letter, a re-sent letter, an extension the applicant granted).
 */
require('dotenv').config({ quiet: true })
const { Pool } = require('pg')

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  const c = await pool.connect()
  let fail = 0
  const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fail++ }
  const q = async (sql, args) => (await c.query(sql, args)).rows
  const deadline = async (d, type) => (await q("SELECT to_char(spatial_planning.determination_deadline($1::date, $2), 'YYYY-MM-DD') AS d", [d, type]))[0].d
  const newPermit = async (type = 'new_building', status = 'registered') => (await q(
    `INSERT INTO spatial_planning.permit_application (applicant_name, applicant_email, development_type, stand_number, status)
     VALUES ('Clock Test', 'clock.test@vungu.test', $1, 'CLOCK-TEST', $2) RETURNING id`, [type, status]))[0].id

  try {
    await c.query('BEGIN')

    console.log('the arithmetic (spatial_planning.determination_deadline)')
    ok((await deadline('2026-06-01', 'new_building')) === '2026-09-01', 'three calendar months, not 90 days: 1 June -> 1 September (92 days)')
    ok((await deadline('2026-12-01', null)) === '2027-03-01', '1 December -> 1 March (90 days)')
    ok((await deadline('2026-11-30', 'new_building')) === '2027-02-28', 'month end clamps: 30 November -> 28 February, not 2 March')
    ok((await deadline('2027-11-30', 'new_building')) === '2028-02-29', 'and in a leap year -> 29 February')
    ok((await deadline('2026-06-01', 'subdivision')) === '2026-10-01', 'a subdivision gets four months (s.40(6))')
    ok((await deadline('2026-06-01', 'consolidation')) === '2026-10-01', 'so does a consolidation')
    ok((await deadline(null, 'new_building')) === null, 'no acknowledgement, no deemed-refusal date')

    if (!(await q("SELECT to_regclass('spatial_planning.clerk_acknowledgement') AS t"))[0].t) {
      console.log('  (the clerk registers are not in this database: the letter checks are skipped)')
    } else {
      console.log('the acknowledgement letter starts the clock (migration 171)')
      const id = await newPermit()
      const permit = async (cols) => (await q(`SELECT ${cols} FROM spatial_planning.permit_application WHERE id = $1`, [id]))[0]
      await c.query(
        `INSERT INTO spatial_planning.clerk_acknowledgement (letter_no, permit_application_id, received_at, due_by, determination_due_by, recipient, drafted_by_name)
         VALUES ('CLOCK-T1', $1, '2026-06-01T08:00+02', '2026-06-08T08:00+02', '2026-09-01T08:00+02', 'x', 't')`, [id])
      ok((await permit('acknowledged_at::text AS a')).a === null, 'a DRAFT letter does not start the clock')
      await c.query("UPDATE spatial_planning.clerk_acknowledgement SET sent_at = '2026-06-10T09:00+02', sent_method = 'hand' WHERE letter_no = 'CLOCK-T1'")
      let r = await permit('acknowledged_at::text AS a, statutory_due_date::text AS d')
      ok(r.a === '2026-06-10', `sending it records the acknowledgement date (${r.a})`)
      ok(r.d === '2026-09-10', `the permit gets the Act's deadline, three months on (${r.d})`)
      const letter = async () => (await q("SELECT to_char(determination_due_by AT TIME ZONE 'Africa/Harare', 'YYYY-MM-DD HH24:MI:SS') AS t FROM spatial_planning.clerk_acknowledgement WHERE letter_no = 'CLOCK-T1'"))[0].t
      ok((await letter()) === '2026-09-10 23:59:59', `the letter's deadline is the end of that day, not receipt + 3 months (${await letter()})`)
      await c.query("UPDATE spatial_planning.permit_application SET development_type = 'subdivision' WHERE id = $1", [id])
      await c.query("UPDATE spatial_planning.clerk_acknowledgement SET sent_at = '2026-06-11T09:00+02' WHERE letter_no = 'CLOCK-T1'")
      ok((await letter()).startsWith('2026-10-11'), `a subdivision's letter gets four months (${await letter()})`)
      ok((await permit('acknowledged_at::text AS a')).a === '2026-06-10', 'a re-sent letter does not move the acknowledgement date already recorded')

      console.log('the status path and extensions')
      const other = await newPermit()
      await c.query("UPDATE spatial_planning.permit_application SET status = 'acknowledged' WHERE id = $1", [other])
      r = (await q('SELECT acknowledged_at IS NOT NULL AS a, statutory_due_date IS NOT NULL AS d FROM spatial_planning.permit_application WHERE id = $1', [other]))[0]
      ok(r.a && r.d, 'moving a case to "acknowledged" records today and its deadline')
      await c.query("UPDATE spatial_planning.permit_application SET statutory_due_date = '2027-01-01' WHERE id = $1", [other])
      await c.query("UPDATE spatial_planning.permit_application SET description = 'edited' WHERE id = $1", [other])
      r = (await q('SELECT statutory_due_date::text AS d FROM spatial_planning.permit_application WHERE id = $1', [other]))[0]
      ok(r.d === '2027-01-01', `an extension the applicant granted is not overwritten (${r.d})`)
    }

    console.log('the EO inbox (spatial_planning.v_eo_decision_queue)')
    const p3 = await newPermit('new_building', 'under_review')
    let v = (await q('SELECT days_to_deemed, ack_due_in_days FROM spatial_planning.v_eo_decision_queue WHERE id = $1', [p3]))[0]
    ok(v && v.days_to_deemed === null, 'an unacknowledged case has NO deemed-refusal countdown (the Act has not started counting)')
    ok(v && v.ack_due_in_days !== null, `it shows when acknowledgement is due instead (${v && v.ack_due_in_days} days)`)
    await c.query("UPDATE spatial_planning.permit_application SET acknowledged_at = CURRENT_DATE - 30 WHERE id = $1", [p3])
    v = (await q('SELECT days_to_deemed, ack_due_in_days FROM spatial_planning.v_eo_decision_queue WHERE id = $1', [p3]))[0]
    ok(v.days_to_deemed >= 58 && v.days_to_deemed <= 62 && v.ack_due_in_days === null, `acknowledged 30 days ago: about 60 days left, counted from acknowledgement (${v.days_to_deemed})`)
  } catch (e) {
    console.log('  FAIL unexpected: ' + e.message); fail++
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    c.release()
    await pool.end()
  }
  console.log(fail ? `\n${fail} check(s) FAILED` : '\nALL CHECKS PASSED')
  process.exit(fail ? 1 : 0)
}

main()
