# Operations runbook — Vungu RDC planning portal

Backend: Fastify + PostgreSQL/PostGIS, self-hosted on the council's own server. Frontend: Vue 3, deployed separately (see frontend repo). This runbook covers the backend; update it whenever the deploy topology changes.

## 1. Deployment

**Normal deploy:**
1. Take a backup (`npm run backup`, §3).
2. On the server: `git pull` on `main`, then `npm ci`.
3. Run pending migrations (§2) — nothing runs them automatically.
4. Restart the backend service (whatever supervises `npm start`: systemd, pm2 or NSSM) and check `GET /health` goes green. If the reverse proxy (nginx/Caddy) runs on a different machine, set `TRUST_PROXY` to its IP, otherwise every client is seen as the proxy's address; on the same machine the default (`loopback`) is correct.
5. Smoke-test: `node test-tiles-endpoint.js` and a login via the frontend against the new deploy.

**Manual/rollback deploy:**
1. `git checkout <previous-good-commit>`, `npm ci`, restart the service.
2. If the rollback crosses a migration boundary (the new commit ran a migration the old code doesn't expect), see §4 Rollback before redeploying — do not roll back code past a migration without also deciding what happens to the schema.

## 2. Migrations

- All migrations live in `migrations/*.sql`, applied in the order listed in `scripts/migrate.js`'s `MIGRATIONS` array, tracked in the `schema_migrations` table (idempotent — already-applied files are skipped).
- **Adding a migration**: write the `.sql` file, append its filename to `MIGRATIONS` in `scripts/migrate.js`, then run `node scripts/migrate.js` against the target `DATABASE_URL`.
- **Verification before running against production**:
  1. Run it against a local/staging copy of the schema first (`npm run migrate` with a local `DATABASE_URL`).
  2. Read the migration's own header comment — every migration in this repo documents what it does and confirms it's idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, etc.). Treat a migration without that idempotency as unsafe to re-run.
  3. Confirm `pg_dump --schema-only` before/after shows only the expected diff.
- **This is a destructive-adjacent operation on shared data.** Running `node scripts/migrate.js` against a production `DATABASE_URL` should only happen with a human at the keyboard confirming the target — never automate this step against production without a second human approval.

## 3. Backup and restore

- **There is no managed-host snapshot.** `npm run backup` is the only backup, so it must run **nightly on a schedule** (cron or Task Scheduler), and before any risky migration or bulk data operation:
  ```
  npm run backup        # scripts/backup-db.js
  ```
  This dumps the database (`backups/db-<ts>.dump`, pg_dump custom format) **and**
  zips `uploads/` (`backups/uploads-<ts>.zip`) — citizen documents and inspection
  photos live on the server's disk alongside the database. Retention: newest 14 of each (override with `BACKUP_KEEP`).
  **Copy `backups/` off the server every night** (second disk, another machine, or
  off-site storage). A backup on the same disk is lost with the disk.
- **Restore drill (run at least quarterly, not just when something breaks):**
  1. Spin up a scratch Postgres instance (local Docker or a spare machine).
  2. `pg_restore -d "$SCRATCH_DATABASE_URL" backup-*.dump`
  3. Run `node scripts/verify-spatial-tables.js` and `node test-tiles-endpoint.js` against the restored instance.
  4. Record how long the restore took — this is your recovery-time estimate, not a guess.
  5. Delete the scratch instance when done.

## 4. Rollback procedure

1. **Code-only rollback** (no migration involved): check out the previous commit and restart the service (§1). Safe, no data action needed.
2. **Rollback across a migration boundary**: migrations in this repo are additive (`ADD COLUMN`, new tables) — rolling back code does not require reversing the migration; the old code simply ignores the new columns/tables. Do **not** write down-migrations that drop columns/tables as part of a routine rollback — that's a separate, deliberate decision requiring its own backup-first plan (§3).
3. If a migration itself was wrong (bad data, wrong constraint): write a new forward migration that fixes it. Do not hand-edit the `schema_migrations` table or the production schema outside a migration file.

## 5. Monitoring

Current gaps (be honest about what's NOT wired up yet, not just what should exist):
- **API failures**: no centralized error tracking (e.g. Sentry) is currently configured. Fastify logs to stdout — capture it with the service supervisor (journald, pm2 logs or NSSM log files) and set up a log-based alert on 5xx rate as the minimum viable signal until a dedicated error tracker is added.
- **Document-generation failures**: `generated_document` inserts in `development-management.js` are wrapped in try/catch and logged via `request.log.error` but do not currently page anyone. At minimum, alert on the log pattern `"decision letter generation failed"` / `"generation failed"`.
- **Sync conflicts (409s)**: the optimistic-lock conflict responses (migration 097) are visible in the frontend as a banner but not currently aggregated server-side. If conflict frequency needs monitoring (e.g. to detect a UI bug generating spurious conflicts), add a counter metric on the 409 branches in `development-management.js`'s `/case` and `/status` routes.
- **Session/auth anomalies**: `permit_event` and the security-audit migration (041) give an audit trail to query after the fact, but there's no live alerting on repeated failed logins or MFA bypass attempts yet.

## 6. Retention and archival

- **Statutory records** (`generated_document`, `permit_event`, `statutory_clock_event`, committee records): these are the legal record of council decisions. Do not delete. Define a retention period with legal/council input (RTCP Act record-keeping requirements should drive this, not a default), and if archival to cold storage is needed after N years, archive — do not delete — since these may be needed for appeals or court review.
- **`user_session` rows** (migration 097): safe to prune once `expires_at` has passed and the row is not needed for audit (e.g. purge sessions older than 90 days past expiry). This is operational data, not a statutory record.
- **Citizen PII in localStorage-cached drafts** (planner case-file caches, purged on logout per `stores/auth.ts`): not a server retention concern, but confirm the purge-on-logout behavior stays in place as new role workspaces are added (see the scope note in that file).

## 7. Disaster recovery

- **Objective (current, not aspirational — update once actually tested)**: Recovery Point Objective = up to 24h (nightly `npm run backup`, until continuous backup / WAL archiving is configured). Recovery Time Objective = untested — the first restore drill (§3) should set a real number here instead of a guess.
- Run the restore drill in §3 on a fixed cadence (quarterly minimum) and update the RTO/RPO figures above with what was actually observed, not what was hoped for.
- Keep this runbook itself under version control in the repo (it is) so a DR event doesn't depend on someone's memory of where the runbook lives.
