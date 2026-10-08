-- Land-use group hierarchy: A1-A3 are sub-classes of A, B1-B2 of B, D1 of D, E1-E2 of E, J1 of J.
--
-- The council's schedule names a sub-class by its class letter plus a number, so the parent is derived from the
-- code and stored as a GENERATED column: it cannot drift from the code, and copying a plan (adopt, new version)
-- carries it without any change to those functions. Whether the parent exists in the same plan is not enforced
-- here (a plan may be built up in stages); migration 160's audit reports a sub-class whose class is missing.
--
-- The rule is the council schedule's lettering. The starter palettes number their codes differently (I2, I3 ... with
-- no I), so for them parent_group_code is a candidate that never resolves: land_use_group_tree shows no parent, and
-- the audit ignores plans that do not follow the lettering.
ALTER TABLE public.land_use_groups
  ADD COLUMN IF NOT EXISTS parent_group_code text
  GENERATED ALWAYS AS (CASE WHEN group_code ~ '^[A-Z][0-9]+$' THEN left(group_code, 1) END) STORED;

CREATE INDEX IF NOT EXISTS land_use_groups_parent_idx ON public.land_use_groups (plan_instrument_id, parent_group_code);

-- The tree, resolved to ids. A sub-class whose class is absent from the plan has parent_group_id NULL.
CREATE OR REPLACE VIEW public.land_use_group_tree WITH (security_invoker = true) AS
SELECT g.id, g.plan_instrument_id, g.group_code, g.description, g.group_category, g.parent_group_code,
       p.id AS parent_group_id,
       CASE WHEN g.parent_group_code IS NULL THEN 0 ELSE 1 END AS depth
  FROM public.land_use_groups g
  LEFT JOIN public.land_use_groups p
    ON p.plan_instrument_id IS NOT DISTINCT FROM g.plan_instrument_id
   AND p.group_code = g.parent_group_code
   AND p.is_active;

GRANT SELECT ON public.land_use_group_tree TO vungu_app;
