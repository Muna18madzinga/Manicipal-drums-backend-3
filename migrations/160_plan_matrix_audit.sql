-- Matrix audit: findings about a plan's development control matrix that a planner should settle before trusting it.
--
-- Written after a draft local-plan matrix turned out to hold the urban columns copied under rural zone names
-- (docs/DEVELOPMENT-CONTROL-MATRIX-DERIVATION.md). These are checks on plausibility, not on the rules of any Act, so
-- they are ADVISORY: nothing is blocked. Severity:
--   error    a column that cannot be right (a residential zone that permits no dwelling outright)
--   warning  a column that looks unconsidered (copied, filled with one value, incomplete)
--   review   a point to confirm (a sub-class more permissive than its class, a consent with no condition)
--
-- The view runs with the caller's rights (security_invoker), so each authority audits only plans it can see.
CREATE OR REPLACE VIEW public.plan_matrix_audit WITH (security_invoker = true) AS
WITH cells AS (
  SELECT z.plan_instrument_id, z.id AS zid, z.code AS zcode, z.category AS zcat,
         g.id AS gid, g.group_code, g.parent_group_code, g.description,
         c.control_type, c.conditions
    FROM public.plan_zone_type z
    JOIN public.land_use_groups g ON g.plan_instrument_id = z.plan_instrument_id AND g.is_active
    LEFT JOIN public.zone_land_use_controls c
           ON c.plan_zone_type_id = z.id AND c.land_use_group_id = g.id AND c.deleted_at IS NULL
), per_zone AS (
  SELECT plan_instrument_id, zid, zcode, zcat,
         count(*)                                                        AS uses,
         count(control_type)                                             AS decided,
         count(*) FILTER (WHERE control_type = 'permitted')              AS permitted,
         count(*) FILTER (WHERE control_type = 'special_consent'
                            AND btrim(coalesce(conditions, '')) = '')    AS special_bare,
         string_agg(group_code, ', ' ORDER BY group_code) FILTER (WHERE control_type IS NULL) AS missing
    FROM cells
   GROUP BY plan_instrument_id, zid, zcode, zcat
)
-- a zone that decides some uses but not all
SELECT plan_instrument_id, 'warning'::text AS severity, 'no_decision'::text AS kind, zcode AS zone_code, NULL::text AS group_code,
       format('%s of %s uses have no decision: %s', uses - decided, uses, missing) AS detail
  FROM per_zone WHERE decided > 0 AND decided < uses
UNION ALL
-- two zones that decide (almost) every use identically
SELECT a.plan_instrument_id, 'warning', 'near_identical_columns', a.zcode, NULL,
       format('decides %s of %s uses exactly as zone "%s" does: copied rather than considered?',
              count(*) FILTER (WHERE a.control_type IS NOT DISTINCT FROM b.control_type), count(*), b.zcode)
  FROM cells a
  JOIN cells b ON b.plan_instrument_id = a.plan_instrument_id AND b.gid = a.gid AND a.zid < b.zid
 GROUP BY a.plan_instrument_id, a.zid, a.zcode, b.zid, b.zcode
HAVING count(*) FILTER (WHERE a.control_type IS NOT NULL) >= 10
   AND count(*) FILTER (WHERE a.control_type IS DISTINCT FROM b.control_type) <= 1
UNION ALL
-- a zone that permits nearly everything
SELECT plan_instrument_id, 'warning', 'default_fill', zcode, NULL,
       format('permits %s of %s uses outright: looks like a default fill, not a considered column', permitted, uses)
  FROM per_zone WHERE uses >= 8 AND decided > 0 AND permitted >= 0.875 * uses
UNION ALL
-- a residential zone with no dwelling permitted (dwelling = a use classed within HILUCS 5_1 Residential use)
SELECT pz.plan_instrument_id, 'error', 'residential_zone_without_dwellings', pz.zcode, NULL,
       'a residential zone that permits no dwelling use outright: the column may be shifted or mislabelled'
  FROM per_zone pz
 WHERE pz.zcat = 'residential' AND pz.decided > 0
   AND EXISTS (SELECT 1 FROM cells c JOIN public.land_use_group_class k
                 ON k.land_use_group_id = c.gid AND k.code = '5_1_ResidentialUse' AND k.relation = 'within'
                WHERE c.plan_instrument_id = pz.plan_instrument_id AND c.zid = pz.zid)
   AND NOT EXISTS (SELECT 1 FROM cells c JOIN public.land_use_group_class k
                     ON k.land_use_group_id = c.gid AND k.code = '5_1_ResidentialUse' AND k.relation = 'within'
                    WHERE c.plan_instrument_id = pz.plan_instrument_id AND c.zid = pz.zid AND c.control_type = 'permitted')
UNION ALL
-- a sub-class permitted where its class is prohibited
SELECT ch.plan_instrument_id, 'review', 'sub_class_more_permissive_than_class', ch.zcode, ch.group_code,
       format('%s (%s) is permitted but its class %s is prohibited', ch.group_code, ch.description, ch.parent_group_code)
  FROM cells ch
  JOIN cells pr ON pr.plan_instrument_id = ch.plan_instrument_id AND pr.zid = ch.zid AND pr.group_code = ch.parent_group_code
 WHERE ch.control_type = 'permitted' AND pr.control_type = 'prohibited'
UNION ALL
-- special consent decisions that state no condition
SELECT plan_instrument_id, 'review', 'special_consent_without_condition', zcode, NULL,
       format('%s special-consent decision(s) state no condition: an officer cannot tell what to assess', special_bare)
  FROM per_zone WHERE special_bare > 0
UNION ALL
-- a sub-class whose class is not in the plan (L1 without L). Only for plans that follow the lettered schedule
-- (at least one sub-class there does resolve to its class): the starter palettes number their codes differently.
SELECT t.plan_instrument_id, 'review', 'sub_class_without_class', NULL, t.group_code,
       format('%s is a sub-class of %s, but this plan has no %s: is a use class missing?', t.group_code, t.parent_group_code, t.parent_group_code)
  FROM public.land_use_group_tree t
  JOIN public.land_use_groups g ON g.id = t.id AND g.is_active
 WHERE t.plan_instrument_id IS NOT NULL AND t.parent_group_code IS NOT NULL AND t.parent_group_id IS NULL
   AND EXISTS (SELECT 1 FROM public.land_use_group_tree o WHERE o.plan_instrument_id = t.plan_instrument_id AND o.parent_group_id IS NOT NULL);

-- One line per plan, for the workbench list.
CREATE OR REPLACE VIEW public.plan_matrix_audit_summary WITH (security_invoker = true) AS
SELECT i.id AS plan_instrument_id, i.title,
       count(a.*) FILTER (WHERE a.severity = 'error')   AS errors,
       count(a.*) FILTER (WHERE a.severity = 'warning') AS warnings,
       count(a.*) FILTER (WHERE a.severity = 'review')  AS reviews
  FROM public.plan_instrument i
  LEFT JOIN public.plan_matrix_audit a ON a.plan_instrument_id = i.id
 GROUP BY i.id, i.title;

GRANT SELECT ON public.plan_matrix_audit, public.plan_matrix_audit_summary TO vungu_app;
