-- Which development standards apply to which kind of development.
--
-- standard_kind (the list of kinds, with units) and plan_zone_standard.kind_code's foreign key already exist
-- (migration 143). What was missing is the link from a kind of development (migration 157) to the kinds of standard
-- it must meet, so the assessment can say "a subdivision is tested against minimum stand area and frontage" rather
-- than listing every standard the zone has. The mapping is a PROPOSAL (evidence_status 'proposed') for the planners
-- to confirm; no standard VALUES are supplied here, those belong to each plan.
CREATE TABLE IF NOT EXISTS public.activity_standard_kind (
  activity_code   text NOT NULL REFERENCES public.development_activity (code) ON UPDATE CASCADE ON DELETE CASCADE,
  kind_code       text NOT NULL REFERENCES public.standard_kind (code) ON UPDATE CASCADE ON DELETE CASCADE,
  evidence_status text NOT NULL DEFAULT 'proposed' CHECK (evidence_status IN ('proposed', 'secondary_source', 'confirmed')),
  PRIMARY KEY (activity_code, kind_code)
);

INSERT INTO public.activity_standard_kind (activity_code, kind_code)
SELECT a.activity_code, k FROM (VALUES
  ('new_building',  ARRAY['max_height','max_storeys','max_coverage','max_floor_area_ratio','setback_front','setback_side','setback_rear','parking_per_unit']),
  ('extension',     ARRAY['max_height','max_storeys','max_coverage','max_floor_area_ratio','setback_front','setback_side','setback_rear']),
  ('alteration',    ARRAY['max_height','max_storeys','setback_front','setback_side','setback_rear']),
  ('change_of_use', ARRAY['parking_per_unit']),
  ('subdivision',   ARRAY['min_stand_area','min_frontage']),
  ('consolidation', ARRAY['max_stand_area'])
) AS a(activity_code, kinds), unnest(a.kinds) AS k
ON CONFLICT DO NOTHING;

GRANT SELECT ON public.activity_standard_kind TO vungu_app;
