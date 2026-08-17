-- 115: Citizen residency verification + mock Ministry of Lands deeds registry.
--
-- WHY
-- An RDC serves its own residents/ratepayers. Statutorily (Electoral
-- (Voter Registration) Regulations SI 85/2017 s5, mirrored by RDC practice)
-- a person proves residence in a district with:
--   (a) title deeds or a certificate of occupation
--   (b) a lodger's permit issued by the local authority
--   (c) rates/utility statements in their name
--   (j) an offer/settlement letter proving lawful occupation
--   (h) a confirmation letter by the councillor, village head, headman or chief
--
-- This migration:
--   1. widens citizen_documents.doc_kind with the missing residency proofs
--   2. stamps a residency verdict on users
--   3. creates a seeded lands_registry_deeds table that simulates the
--      national Deeds Registry (Ministry of Lands) for title-deed checks,
--      plus a checks log that feeds the mock ministry dashboard.

-- ── 1. New document kinds ────────────────────────────────────────────────
ALTER TABLE citizen_documents DROP CONSTRAINT IF EXISTS citizen_documents_doc_kind_check;
ALTER TABLE citizen_documents ADD CONSTRAINT citizen_documents_doc_kind_check
  CHECK (doc_kind IN (
    'national_id',
    'passport',
    'drivers_licence',
    'proof_of_residence',
    'title_deed',
    'settlement_letter',      -- offer/settlement letter proving lawful occupation
    'lodgers_permit',         -- lodger's permit issued by the local authority
    'occupation_certificate', -- certificate of occupation
    'chiefs_letter',          -- councillor / village head / headman / chief confirmation
    'company_registration',
    'tax_clearance',
    'other'
  ));

-- ── 2. Residency verdict on the user ────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS residency_status VARCHAR(16)
  NOT NULL DEFAULT 'unverified'
  CHECK (residency_status IN ('unverified', 'pending', 'verified', 'rejected'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS residency_method VARCHAR(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS residency_verified_at TIMESTAMPTZ;

-- ── 3. Mock Ministry of Lands deeds registry ─────────────────────────────
CREATE TABLE IF NOT EXISTS lands_registry_deeds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deed_number         VARCHAR(32) NOT NULL UNIQUE,
  holder_name         VARCHAR(160) NOT NULL,
  holder_national_id  VARCHAR(32),
  stand_no            VARCHAR(64),
  property_description TEXT,
  district            VARCHAR(80) NOT NULL DEFAULT 'Vungu',
  hectares            NUMERIC(12,4),
  status              VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'transfer_pending', 'cancelled')),
  registered_at       DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lands_registry_deed_number
  ON lands_registry_deeds (UPPER(deed_number));
CREATE INDEX IF NOT EXISTS idx_lands_registry_holder_id
  ON lands_registry_deeds (holder_national_id);

-- Every title-deed lookup is logged; the ministry dashboard reads this.
CREATE TABLE IF NOT EXISTS lands_registry_checks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deed_number   VARCHAR(32) NOT NULL,
  requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  requester_name VARCHAR(160),
  matched       BOOLEAN NOT NULL DEFAULT FALSE,
  holder_match  BOOLEAN NOT NULL DEFAULT FALSE,
  result_status VARCHAR(20),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lands_registry_checks_created
  ON lands_registry_checks (created_at DESC);

-- ── Seed: representative Vungu deeds (idempotent) ────────────────────────
INSERT INTO lands_registry_deeds
  (deed_number, holder_name, holder_national_id, stand_no, property_description, district, hectares, status, registered_at)
VALUES
  ('DT-1123/2019', 'Tapiwa Moyo',        '63-1234567-A-63', 'Stand 114 Maboleni',     'Stand 114 Maboleni Growth Point, Vungu',            'Vungu', 0.2500, 'active',           '2019-04-12'),
  ('DT-2210/2021', 'Rudo Chikwava',      '63-2233445-B-63', 'Stand 27 Insukamini',    'Stand 27 Insukamini Growth Point, Vungu',            'Vungu', 0.3200, 'active',           '2021-08-03'),
  ('DT-0871/2015', 'Blessing Ndlovu',    '63-9988776-C-63', 'Lot 3 of Sherwood',      'Lot 3 of Sherwood Block, Vungu District',            'Vungu', 42.1000, 'active',           '2015-02-20'),
  ('DT-3302/2022', 'Nyasha Gumbo',       '63-5566778-D-63', 'Stand 52 Muchakatata',   'Stand 52 Muchakatata Growth Point, Vungu',           'Vungu', 0.2800, 'active',           '2022-11-15'),
  ('DT-1544/2018', 'Farai Sibanda',      '63-4455667-E-63', 'Subdivision A of Linton','Subdivision A of Linton Farm, Vungu District',       'Vungu', 120.5000, 'transfer_pending', '2018-06-30'),
  ('DT-0099/2009', 'Chipo Dube',         '63-7788990-F-63', 'Stand 8 Maboleni',       'Stand 8 Maboleni Township, Vungu',                   'Vungu', 0.2000, 'active',           '2009-09-09'),
  ('DT-4410/2023', 'Demo Citizen',       '63-1111111-G-63', 'Stand 300 Insukamini',   'Stand 300 Insukamini Extension, Vungu',              'Vungu', 0.3000, 'active',           '2023-05-18'),
  ('DT-2799/2020', 'Tendai Mhofu',       '63-3344556-H-63', 'Rem of Gwai Estate',     'Remainder of Gwai Estate, Vungu District',           'Vungu', 310.0000, 'active',           '2020-01-27'),
  ('DT-1010/2016', 'Sekai Marufu',       '63-6677889-J-63', 'Stand 61 Muchakatata',   'Stand 61 Muchakatata Growth Point, Vungu',           'Vungu', 0.2600, 'cancelled',        '2016-03-14'),
  ('DT-3866/2024', 'Munyaradzi Hove',    '63-2211334-K-63', 'Stand 12 Maboleni',      'Stand 12 Maboleni Growth Point, Vungu',              'Vungu', 0.2400, 'active',           '2024-07-22')
ON CONFLICT (deed_number) DO NOTHING;
