-- Migration 061: customer applicant_type metadata + expanded invite roles
--
-- Two related changes:
--
-- 1. The customer-facing register page now collects an `applicant_type`
--    (resident, landowner, business, consultant, visitor). The value is
--    descriptive only; authorisation is still driven by `role`. We persist
--    it so the council can route applications correctly and produce stats.
--
-- 2. The previous invite system only allowed `admin | planner | viewer`,
--    but the frontend (AdminView "Invite Employee") covers eight role IDs:
--    admin, planner, eo, env_officer, building_inspector, planning_clerk,
--    surveyor, gis_officer. We expand both the users.role CHECK constraint
--    and the invites.role CHECK constraint to match.

BEGIN;

-- ── 1. users: applicant_type column ───────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS applicant_type VARCHAR(32);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_applicant_type_check;
ALTER TABLE users ADD CONSTRAINT users_applicant_type_check
  CHECK (
    applicant_type IS NULL
    OR applicant_type IN ('resident','landowner','business','consultant','visitor')
  );

-- ── 2. users.role: expand to all internal roles ───────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN (
    'public',
    'registered',
    'viewer',
    'admin',
    'planner',
    'eo',
    'env_officer',
    'building_inspector',
    'planning_clerk',
    'surveyor',
    'gis_officer'
  ));

-- ── 3. invites.role: same expansion (employee-only) ───────────────────
ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_role_check;
ALTER TABLE invites ADD CONSTRAINT invites_role_check
  CHECK (role IN (
    'admin',
    'planner',
    'viewer',
    'eo',
    'env_officer',
    'building_inspector',
    'planning_clerk',
    'surveyor',
    'gis_officer'
  ));

COMMIT;
