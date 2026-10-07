-- Migration 138: district development control matrix (zone type x coded land use)
--
-- The council's development control matrix is keyed by ZONE TYPE (eleven
-- district land-use zones: Communal Farming, Estates, Game Park, ...) against
-- ~32 specific, coded land uses (A detached dwellings, A1 cluster housing, D
-- shops, V funeral parlour, ...), each cell being P (permitted), X
-- (prohibited), SC (special consent), or blank (not decided). Its own footnote
-- says "all local plans will propose separate development control tables for
-- their specific plan areas".
--
-- zone_land_use_controls could not hold that:
--   * it was keyed by zone POLYGON only (36 polygons of the peri-urban plan),
--     so a district-wide zone type had nowhere to live;
--   * its vocabulary was ten broad groups, two of which (P = "Prohibited Uses",
--     SC = "Special Consent") were decisions pretending to be land uses.
--
-- This migration:
--   1. adds the district zone types to ref_zone_types (six already existed);
--   2. retires the ten broad groups (nothing references them) and loads the
--      coded land uses, in the matrix's own order;
--   3. lets a control row target either a zone polygon (local plan) or a zone
--      type (district plan), never both;
--   4. adds zone_effective_controls: for every polygon, its own rules plus the
--      rules of its zone type, polygon rules winning. Readers of "what applies
--      here" use the view; the table stays the place rules are written.
--
-- A blank cell in the matrix is simply no row, which readers already treat as
-- "unknown". Idempotent; safe to re-run.

BEGIN;

-- 1. Zone types ---------------------------------------------------------------
ALTER TABLE ref_zone_types ADD COLUMN IF NOT EXISTS display_order integer;

INSERT INTO ref_zone_types (code, label, category) VALUES
  ('Smallholder Estates Zone',     'Smallholder Estates Zone',     'agricultural'),
  ('Forestry / Conservation Zone', 'Forestry / Conservation Zone', 'conservation'),
  ('Game Park Zone',               'Game Park Zone',               'conservation'),
  ('Game Corridor Zone',           'Game Corridor Zone',           'conservation'),
  ('Urban Expansion Zone',         'Urban Expansion Zone',         'mixed')
ON CONFLICT (code) DO NOTHING;

-- The matrix's own column order (1-11).
UPDATE ref_zone_types AS z SET display_order = v.n
FROM (VALUES
  ('Communal Farming Zone', 1),
  ('High Intensive Commercial Farming Zone', 2),
  ('Estates Zone (Large Farms)', 3),
  ('Irrigation Scheme Zone', 4),
  ('Smallholder Estates Zone', 5),
  ('Forestry / Conservation Zone', 6),
  ('Game Park Zone', 7),
  ('Game Corridor Zone', 8),
  ('Urban Expansion Zone', 9),
  ('Industrial Zone', 10),
  ('Commercial Zone', 11)
) AS v(code, n)
WHERE z.code = v.code;

-- 2. Land uses ----------------------------------------------------------------
ALTER TABLE land_use_groups ADD COLUMN IF NOT EXISTS display_order integer;

-- The old group code 'P' ("Prohibited Uses") collides with matrix use P
-- (Agricultural small holdings). Move it aside before anything else.
UPDATE land_use_groups SET group_code = 'LEGACY-P'
 WHERE group_code = 'P' AND description = 'Prohibited Uses';

-- Retire the ten broad groups. They stay in the table (history, no deletes)
-- but no longer appear anywhere.
UPDATE land_use_groups
   SET is_active = FALSE,
       notes = CASE WHEN COALESCE(notes, '') LIKE '%Retired%' THEN notes
                    ELSE concat_ws(' ', notes, 'Retired by migration 138: replaced by the coded land uses of the district development control matrix.') END
 WHERE group_code IN ('LEGACY-P', 'AG', 'SC', 'R1', 'C1', 'OS', 'I2', 'I1', 'R2', 'C2')
   AND is_active;

INSERT INTO land_use_groups (group_code, description, group_category, display_order, notes, is_active) VALUES
  ('A',  'Detached (SFD) dwelling houses',            'residential',   1, NULL, TRUE),
  ('A1', 'Cluster housing',                           'residential',   2, NULL, TRUE),
  ('A2', 'Attached and semi-detached dwelling houses','residential',   3, NULL, TRUE),
  ('A3', 'Flats',                                     'residential',   4, NULL, TRUE),
  ('B',  'Residential buildings',                     'residential',   5, NULL, TRUE),
  ('B1', 'Residential buildings (licensed)',          'residential',   6, 'Label is cut off in the source matrix; confirm the wording.', TRUE),
  ('B2', 'Residential building (institutional)',      'residential',   7, 'Label is cut off in the source matrix; confirm the wording.', TRUE),
  ('C',  'Schools and residential colleges',          'institutional', 8, NULL, TRUE),
  ('D',  'Shops',                                     'commercial',    9, NULL, TRUE),
  ('D1', 'Farm stores',                               'commercial',   10, NULL, TRUE),
  ('E',  'Offices',                                   'commercial',   11, NULL, TRUE),
  ('E1', 'Corporate offices',                         'commercial',   12, NULL, TRUE),
  ('E2', 'Surgeries and medical chambers',            'commercial',   13, NULL, TRUE),
  ('F',  'Institutions',                              'institutional',14, NULL, TRUE),
  ('G',  'Wholesale warehouse',                       'commercial',   15, NULL, TRUE),
  ('H',  'Storage warehouse',                         'industrial',   16, NULL, TRUE),
  ('I',  'Public buildings',                          'institutional',17, NULL, TRUE),
  ('J',  'Places of assembly',                        'institutional',18, NULL, TRUE),
  ('J1', 'Special places of assembly',                'institutional',19, NULL, TRUE),
  ('K',  'Place of public worship',                   'institutional',20, NULL, TRUE),
  ('L1', 'General industrial buildings',              'industrial',   21, NULL, TRUE),
  ('M',  'Industrial buildings',                      'industrial',   22, NULL, TRUE),
  ('P',  'Agricultural small holdings',               'agricultural', 23, NULL, TRUE),
  ('Q',  'Agricultural buildings',                    'agricultural', 24, NULL, TRUE),
  ('R',  'Petrol filling and service station',        'commercial',   25, NULL, TRUE),
  ('S',  'Lorry parking lot and rest house',          'commercial',   26, NULL, TRUE),
  ('T',  'Newspaper offices',                         'commercial',   27, NULL, TRUE),
  ('U',  'Parking garage',                            'commercial',   28, NULL, TRUE),
  ('V',  'Funeral parlour',                           'commercial',   29, NULL, TRUE),
  ('X',  'Game park',                                 'recreation',   30, NULL, TRUE),
  ('Z',  'Horticulture',                              'agricultural', 31, NULL, TRUE),
  ('UF', 'Urban forestry',                            'agricultural', 32, 'The source matrix gives this row no letter code; UF is assigned here.', TRUE)
ON CONFLICT (group_code) DO UPDATE SET
  description    = EXCLUDED.description,
  group_category = EXCLUDED.group_category,
  display_order  = EXCLUDED.display_order,
  notes          = EXCLUDED.notes,
  is_active      = TRUE;

-- 3. A control row targets a zone polygon OR a zone type ------------------------
ALTER TABLE zone_land_use_controls ALTER COLUMN zone_id DROP NOT NULL;
ALTER TABLE zone_land_use_controls ADD COLUMN IF NOT EXISTS zone_type varchar(100);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zlc_zone_type_fkey') THEN
    ALTER TABLE zone_land_use_controls
      ADD CONSTRAINT zlc_zone_type_fkey FOREIGN KEY (zone_type)
      REFERENCES ref_zone_types (code) ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zlc_one_target') THEN
    ALTER TABLE zone_land_use_controls
      ADD CONSTRAINT zlc_one_target CHECK ((zone_id IS NOT NULL) <> (zone_type IS NOT NULL));
  END IF;
END $$;

-- One decision per zone type and use (the polygon-level pair is already unique).
CREATE UNIQUE INDEX IF NOT EXISTS uq_zlc_zone_type_group
  ON zone_land_use_controls (zone_type, land_use_group_id)
  WHERE zone_type IS NOT NULL;

-- 4. What applies to a polygon: its own rules, else its zone type's -------------
CREATE OR REPLACE VIEW zone_effective_controls AS
SELECT DISTINCT ON (z.id, c.land_use_group_id)
       c.id,
       z.id AS zone_id,
       c.land_use_group_id,
       c.control_type,
       c.authority,
       c.notes,
       c.conditions,
       c.created_at,
       c.updated_at,
       c.deleted_at,
       c.deleted_by,
       CASE WHEN c.zone_id IS NOT NULL THEN 'zone' ELSE 'zone_type' END AS source
  FROM proposed_peri_urban_zones z
  JOIN zone_land_use_controls c
    ON c.deleted_at IS NULL
   AND (c.zone_id = z.id OR (c.zone_id IS NULL AND c.zone_type = z.zone_type))
 ORDER BY z.id, c.land_use_group_id, (c.zone_id IS NULL);   -- polygon rules first

COMMENT ON VIEW zone_effective_controls IS
  'Per zone polygon: its own control rows plus those of its zone type; the polygon''s own rule wins for a given land use.';

COMMIT;
