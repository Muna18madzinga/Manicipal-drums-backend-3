-- 164: land.parcel can hold farms as well as surveyed stands, and says where each row came from.
--
-- Concept cadastral_parcel (migration 162). land.parcel was designed for surveyed urban stands (township, general plan, survey
-- accuracy class) and is empty; the parcels the application actually reads are flat imports (vungu_parcels, 733 farms) with
-- text attributes and areas that disagree with the geometry. To make land.parcel the one parcel model, it needs:
--   parcel_kind     stand | farm | plot, so a farm does not have to pretend to be a stand in a township;
--   cadastre_ref    the map sheet or farm number the source gives;
--   tenure_class    what the imports call "status" (Commercial, City, State Land, Resettlement ...), kept apart from the
--                   lifecycle `status` column (current, legacy, retired);
--   authority_id    the authority whose area the parcel lies in (provenance, not row-level security: the cadastre is
--                   national data);
--   origin          custodian (as received from the custodian) or authority (edited locally), so changes an authority
--                   makes can later be offered back to the custodian instead of being lost or overwriting it;
--   source_relation, source_key   the table and key it was loaded from, so a load can be repeated and checked.
--
-- Nothing reads land.parcel through these columns yet, and no consumer is switched: see docs/SPATIAL-NAMING-CONVENTION.md.

ALTER TABLE land.parcel
  ADD COLUMN IF NOT EXISTS parcel_kind     text NOT NULL DEFAULT 'stand',
  ADD COLUMN IF NOT EXISTS cadastre_ref    text,
  ADD COLUMN IF NOT EXISTS tenure_class    text,
  ADD COLUMN IF NOT EXISTS authority_id    integer REFERENCES public.local_authorities (id),
  ADD COLUMN IF NOT EXISTS origin          text NOT NULL DEFAULT 'custodian',
  ADD COLUMN IF NOT EXISTS source_relation text,
  ADD COLUMN IF NOT EXISTS source_key      text;

ALTER TABLE land.parcel ALTER COLUMN township_code DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parcel_kind_check') THEN
    ALTER TABLE land.parcel ADD CONSTRAINT parcel_kind_check CHECK (parcel_kind IN ('stand', 'farm', 'plot'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parcel_origin_check') THEN
    ALTER TABLE land.parcel ADD CONSTRAINT parcel_origin_check CHECK (origin IN ('custodian', 'authority'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parcel_stand_needs_township') THEN
    ALTER TABLE land.parcel ADD CONSTRAINT parcel_stand_needs_township CHECK (parcel_kind <> 'stand' OR township_code IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parcel_source_pair') THEN
    ALTER TABLE land.parcel ADD CONSTRAINT parcel_source_pair CHECK ((source_relation IS NULL) = (source_key IS NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS parcel_source_key_uq ON land.parcel (source_relation, source_key) WHERE source_relation IS NOT NULL;
CREATE INDEX IF NOT EXISTS parcel_authority_idx ON land.parcel (authority_id);
CREATE INDEX IF NOT EXISTS parcel_stand_no_idx ON land.parcel (upper(btrim(stand_no)));

UPDATE public.spatial_concept_source
   SET note = 'the designed parcel model, now able to hold farms (migration 164); loaded from vungu_parcels by scripts/load-parcels-into-land.js, consumers not yet switched'
 WHERE relation = 'land.parcel';
