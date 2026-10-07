-- 147_vungu_plan_land_uses.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Vungu RDC's peri-urban local plan had zone types (one per distinct polygon name) but no
-- land uses and no decisions, so nothing could be recorded against it: a planner's chosen
-- use matched no land use in the plan. This gives the plan a land-use vocabulary, and
-- proposes a reference-class mapping for its zone types.
--
-- WHAT THIS DOES NOT DO: it adds NO decisions. Whether a use is permitted, needs special
-- consent or is prohibited in each of Vungu's zones is Vungu's own scheme to state. Nothing
-- in this repository supplies it: the sample district matrix is for district zones such as
-- Communal Farming, not for Vungu's residential, mixed-business, industry and institutional
-- zones. Every cell stays "not decided" until the council fills it (generate the blank sheet
-- with: node scripts/load-zoning-matrix.js --plan Vungu --template <file>).
--
-- The vocabulary is the sample matrix's 32 coded uses (A, A1 ... Z, UF), the only
-- Zimbabwean council use-class list available. It is copied with provenance, so
-- plan_diff-style tooling can see where each came from, and the planner's card, which
-- already speaks these codes, keeps working.
--
-- The zone-type mappings are PROPOSED only.

BEGIN;

INSERT INTO plan_zone_type_class (plan_zone_type_id, scheme, code, relation)
SELECT t.id, 'HILUCS', c.code, m.rel
  FROM (VALUES
    ('Cemetry','3_3','overlaps'),
    ('Densification Zone [LDR]','5_1','within'),
    ('Economic Corridor [Mixed Business]','3_1','overlaps'),
    ('Economic Corridor [Mixed Business]','5_1','overlaps'),
    ('High Density Residential','5_1','within'),
    ('Institutional','3_3','within'),
    ('Light Industry','2_3','within'),
    ('Low Density Residential','5_1','within'),
    ('Medium Density Residential','5_1','within'),
    ('Mixed Density Residential','5_1','within'),
    ('Railways Common User Facilities','4_1','within'),
    ('Residential Agricultural Plots','5_1','overlaps'),
    ('Residential Agricultural Plots','1_1','overlaps')
  ) AS m(zone_code, short, rel)
  JOIN plan_instrument i ON i.title = 'Vungu RDC peri-urban local plan (as mapped)' AND NOT i.is_template
  JOIN plan_zone_type t ON t.plan_instrument_id = i.id AND t.code = m.zone_code
  JOIN reference_classification c ON c.scheme = 'HILUCS' AND c.short_code = m.short
ON CONFLICT DO NOTHING;

-- The land-use vocabulary: every use of the rural sample template the plan does not have yet.
-- import_plan_items skips existing codes and never copies decisions.
DO $$
DECLARE plan uuid; tmpl uuid; codes text[];
BEGIN
  SELECT id INTO plan FROM plan_instrument WHERE title = 'Vungu RDC peri-urban local plan (as mapped)' AND NOT is_template;
  SELECT id INTO tmpl FROM plan_instrument WHERE is_default_template AND profile_id = (SELECT id FROM plan_profile WHERE code = 'rural');
  IF plan IS NULL OR tmpl IS NULL THEN RETURN; END IF;
  SELECT array_agg(group_code ORDER BY display_order) INTO codes
    FROM land_use_groups WHERE plan_instrument_id = tmpl AND is_active;
  IF codes IS NOT NULL THEN
    PERFORM * FROM import_plan_items(plan, tmpl, '{}', codes);
  END IF;
END $$;

COMMIT;
