-- Development activities: what kind of development an application is for, and what each kind tests.
--
-- permit_application.development_type was a CHECK list. The matrix only answers "is this USE allowed in this zone",
-- which is the right test for a new building or a change of use but not for an extension (standards only), a
-- subdivision (parcel size) or a rezoning (amends the plan). Making the kinds data lets a council add one without a
-- migration and lets the assessment ask each kind the right question.
--
-- The eight codes are exactly those the CHECK allowed, so every existing permit keeps its value. What each kind
-- tests is a PROPOSAL (evidence_status 'proposed'); statutory references are to be added by the planners.
CREATE TABLE IF NOT EXISTS public.development_activity (
  code            text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name            text NOT NULL,
  tests           text NOT NULL CHECK (tests IN ('use', 'standards', 'parcel', 'zone', 'manual')),
  matrix_lookup   boolean NOT NULL DEFAULT FALSE,
  description     text,
  statutory_ref   text,
  evidence_status text NOT NULL DEFAULT 'proposed' CHECK (evidence_status IN ('proposed', 'secondary_source', 'confirmed')),
  display_order   integer NOT NULL DEFAULT 100,
  is_active       boolean NOT NULL DEFAULT TRUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.development_activity (code, name, tests, matrix_lookup, description, display_order) VALUES
  ('new_building',  'New building',  'use',       TRUE,  'The use being built is looked up in the matrix for the parcel''s zone; the zone''s building standards then apply.', 10),
  ('extension',     'Extension',     'standards', FALSE, 'The use is unchanged, so the matrix is not consulted; the extended building must still meet the zone''s standards.', 20),
  ('alteration',    'Alteration',    'standards', FALSE, 'As for an extension; the matrix applies only if the alteration changes the use.', 30),
  ('change_of_use', 'Change of use', 'use',       TRUE,  'From the existing use group to the proposed one; the matrix decides whether the proposed use is permitted, by special consent, or prohibited.', 40),
  ('subdivision',   'Subdivision',   'parcel',    TRUE,  'Tests the resulting parcels against the zone''s minimum stand size, and the intended use against the matrix.', 50),
  ('consolidation', 'Consolidation', 'parcel',    FALSE, 'Merges parcels; tests the combined parcel against the zone''s standards.', 60),
  ('rezoning',      'Rezoning',      'zone',      FALSE, 'Asks to change the zone itself, so the matrix for the current zone does not decide it; follows the plan-amendment route.', 70),
  ('other',         'Other',         'manual',    FALSE, 'Assessed by an officer; no automatic test.', 90)
ON CONFLICT (code) DO NOTHING;

-- Replace the CHECK list with a foreign key (existing values are all present above).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'spatial_planning.permit_application'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ILIKE '%development_type%' AND pg_get_constraintdef(oid) ILIKE '%new_building%'
  LOOP
    EXECUTE format('ALTER TABLE spatial_planning.permit_application DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'permit_application_development_type_fkey') THEN
    ALTER TABLE spatial_planning.permit_application
      ADD CONSTRAINT permit_application_development_type_fkey
      FOREIGN KEY (development_type) REFERENCES public.development_activity (code) ON UPDATE CASCADE;
  END IF;
END $$;

GRANT SELECT ON public.development_activity TO vungu_app;
