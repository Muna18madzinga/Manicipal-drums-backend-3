-- An existing use, as a land-use group.
--
-- spatial_planning.existing_use.land_use was free text, so a change of use could not be tested against the matrix
-- ("from what?"). The group CODE is recorded, not an id: groups belong to a plan, an existing use is a fact about a
-- property, and the code is the shared schedule (A, D1, M ...). It is resolved against whichever plan governs the
-- parcel at assessment time with land_use_group_for().
ALTER TABLE spatial_planning.existing_use
  ADD COLUMN IF NOT EXISTS land_use_group_code text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'existing_use_group_code_format') THEN
    ALTER TABLE spatial_planning.existing_use
      ADD CONSTRAINT existing_use_group_code_format
      CHECK (land_use_group_code IS NULL OR land_use_group_code ~ '^[A-Z]{1,2}[0-9]*$');
  END IF;
END $$;

-- The active group with this code in this plan, or NULL.
CREATE OR REPLACE FUNCTION public.land_use_group_for(p_plan uuid, p_code text) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM public.land_use_groups WHERE plan_instrument_id = p_plan AND group_code = p_code AND is_active LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public.land_use_group_for(uuid, text) TO vungu_app;
