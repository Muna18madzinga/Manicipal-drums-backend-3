# Migrations

## How migrations run

`scripts/migrate-render.js` holds the **canonical ordered allowlist** (`MIGRATIONS`).
Only files in that array are ever applied; applied filenames are recorded in the
`schema_migrations` table (`filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ`) and
skipped on re-run. Run with:

```bash
DATABASE_URL=postgresql://… node scripts/migrate-render.js   # or: npm run migrate
```

See `docs/OPERATIONS_RUNBOOK.md` §2 for the pre-production verification checklist.

## Rules

1. **Numbering**: take the next free three-digit number (highest wins — check both
   this directory and the `MIGRATIONS` array). Never reuse or fork a number with
   variant suffixes (`_fixed`, `_final`, `_v2`); iterate in place until the file is
   right, *then* add it to the allowlist.
2. **Idempotent only**: `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` / additive DDL.
   A migration must be safe to run twice.
3. **Additive only**: no `DROP COLUMN`/`DROP TABLE` in routine migrations. Fixing a
   bad migration means writing a new forward migration, not editing an applied one.
4. **Header comment**: what it does, which routes/features depend on it, and the
   idempotency statement.
5. **Soft delete**: statutory/evidentiary tables carry `deleted_at TIMESTAMPTZ` +
   `deleted_by UUID` (migration 103). New record tables should include these from
   the start; DELETE endpoints must be `UPDATE … SET deleted_at = NOW()`.

## Files not in the allowlist

Some numbered files in this directory were applied manually (psql) to specific
environments before the allowlist existed and are kept for reference — do not
assume presence/absence in any given database without checking
`information_schema`. New work must always go through the allowlist.

## attic/

Superseded drafts (e.g. the eight `050_*` land-use variants replaced by
`050_enhance_land_use_management_corrected.sql`). Never apply anything from
`attic/`; it exists only so old environments can be diagnosed.
