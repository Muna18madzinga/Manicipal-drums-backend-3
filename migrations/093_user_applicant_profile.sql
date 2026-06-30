-- Migration 093: reusable applicant profile fields on users
--
-- "Enter once, use many times": a citizen fills in their identity details a
-- single time on their profile, and every new development application prefills
-- from it. Today the users table carries name, email and phone but not the
-- national ID number or a physical address, so each application form re-asks
-- for them. These two columns let the profile be the single source of truth.
--
-- Both are nullable and free-form (no CHECK) — Zimbabwean national ID numbers
-- have a well-known shape (e.g. 63-1234567A12) but we validate format in the
-- application layer, not the schema, so legacy/edge values are never rejected
-- at write time. Idempotent.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS national_id      VARCHAR(64);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS physical_address TEXT;

COMMENT ON COLUMN users.national_id IS
  'Applicant national ID / passport number, captured once and reused to prefill development applications.';
COMMENT ON COLUMN users.physical_address IS
  'Applicant postal/physical address, captured once and reused to prefill development applications.';

COMMIT;
