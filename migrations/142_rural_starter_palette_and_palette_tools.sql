-- 142_rural_starter_palette_and_palette_tools.sql
-- ─────────────────────────────────────────────────────────────────────────
-- 1. A profile can now have several templates; exactly one is its DEFAULT (the one the
--    loader, readers and adopt script use when none is named). The rural sample template
--    and the urban starter palette are the defaults.
-- 2. A rural starter palette: a second rural template of generic zone types and land uses
--    from best-practice categories, with NO decisions and NO standards. It sits beside the
--    sample template; it does not change it.
-- 3. Tools for bringing palettes together without guessing:
--      plan_compare(a, b)           which zone types and land uses of two plans cover the same
--                                   reference (HILUCS) class, and where one has no counterpart
--      import_plan_items(t, s, ...) copy chosen zone types / land uses (with their crosswalk)
--                                   from one plan into another. Never copies decisions.
--
-- Like 141, the starter content is not law. Decisions come from each authority's instrument.

BEGIN;

-- 1. Default template per profile ------------------------------------------------------
ALTER TABLE plan_instrument ADD COLUMN IF NOT EXISTS is_default_template boolean NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_instrument_default_is_template') THEN
    ALTER TABLE plan_instrument ADD CONSTRAINT plan_instrument_default_is_template
      CHECK (NOT is_default_template OR is_template);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_default_template_per_profile
  ON plan_instrument (profile_id) WHERE is_default_template;

UPDATE plan_instrument SET is_default_template = TRUE
 WHERE is_template AND NOT is_default_template
   AND title IN ('Rural profile v0: district development control matrix (sample)',
                 'Urban profile v0: best-practice starter palette (reference)');

-- The summary view gains the flag (added at the end so existing readers are unaffected).
CREATE OR REPLACE VIEW plan_instrument_summary AS
SELECT i.id,
       i.title,
       i.plan_type,
       i.version,
       i.status,
       i.is_template,
       i.effective_from,
       i.effective_to,
       i.gazette_ref,
       a.id             AS authority_id,
       a.code           AS authority_code,
       a.authority_name AS authority_name,
       a.kind           AS authority_kind,
       p.code           AS profile_code,
       (SELECT COUNT(*) FROM plan_zone_type t WHERE t.plan_instrument_id = i.id)::int AS zone_types,
       (SELECT COUNT(*) FROM land_use_groups g WHERE g.plan_instrument_id = i.id AND g.is_active)::int AS land_uses,
       (SELECT COUNT(*) FROM zone_land_use_controls c WHERE c.plan_instrument_id = i.id AND c.deleted_at IS NULL)::int AS decisions,
       (SELECT COUNT(*) FROM proposed_peri_urban_zones z WHERE z.plan_instrument_id = i.id)::int AS zone_polygons,
       i.is_default_template
  FROM plan_instrument i
  JOIN plan_profile p ON p.id = i.profile_id
  LEFT JOIN local_authorities a ON a.id = i.authority_id;

-- The transitional "older writers land in the rural template" lookup uses the default.
CREATE OR REPLACE FUNCTION zlc_sync_plan_refs() RETURNS trigger AS $$
DECLARE tmpl uuid; grp_plan uuid; grp_template boolean;
BEGIN
  IF NEW.plan_zone_type_id IS NOT NULL THEN
    SELECT t.plan_instrument_id INTO NEW.plan_instrument_id
      FROM plan_zone_type t WHERE t.id = NEW.plan_zone_type_id;
  ELSIF NEW.zone_type IS NOT NULL THEN
    SELECT i.id INTO tmpl
      FROM plan_instrument i JOIN plan_profile p ON p.id = i.profile_id
     WHERE i.is_default_template AND p.code = 'rural'
     LIMIT 1;
    NEW.plan_instrument_id := tmpl;
    SELECT t.id INTO NEW.plan_zone_type_id
      FROM plan_zone_type t WHERE t.plan_instrument_id = tmpl AND t.code = NEW.zone_type;
  ELSIF NEW.zone_id IS NOT NULL THEN
    SELECT z.plan_instrument_id INTO NEW.plan_instrument_id
      FROM proposed_peri_urban_zones z WHERE z.id = NEW.zone_id;
  END IF;

  SELECT g.plan_instrument_id, COALESCE(i.is_template, FALSE) INTO grp_plan, grp_template
    FROM land_use_groups g LEFT JOIN plan_instrument i ON i.id = g.plan_instrument_id
   WHERE g.id = NEW.land_use_group_id;

  IF NEW.plan_zone_type_id IS NOT NULL THEN
    IF grp_plan IS DISTINCT FROM NEW.plan_instrument_id THEN
      RAISE EXCEPTION 'land use % belongs to a different plan than the zone type', NEW.land_use_group_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.zone_id IS NOT NULL THEN
    IF grp_plan IS NOT NULL AND grp_plan IS DISTINCT FROM NEW.plan_instrument_id AND NOT grp_template THEN
      RAISE EXCEPTION 'land use % belongs to a different plan than the zone polygon', NEW.land_use_group_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- 2. Rural starter palette -----------------------------------------------------------------
INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title, version, status, is_template, source_document, notes)
SELECT NULL, p.id, 'district_master', 'Rural profile v0: best-practice starter palette (reference)', 1, 'draft', TRUE,
       'Compiled from general best-practice vocabularies; see notes.',
       'A structural starting point only, NOT Zimbabwean law and not any authority''s plan. Generic rural categories (agriculture, forestry, conservation and tourism, mining, settlement and service centres, infrastructure) of the kind found in best-practice zoning vocabularies. Names are original. It adds categories the sample district matrix does not have (settlement and growth points, wetlands, mining, rural service centres, tourism). It holds no decisions and no standards. Compare it with the sample template using plan_compare().'
  FROM plan_profile p
 WHERE p.code = 'rural'
   AND NOT EXISTS (SELECT 1 FROM plan_instrument WHERE is_template AND title = 'Rural profile v0: best-practice starter palette (reference)');

INSERT INTO plan_zone_type (plan_instrument_id, code, name, display_no, category)
SELECT i.id, v.code, v.code, v.n, v.category
  FROM plan_instrument i,
  (VALUES
    ('Communal Agriculture',1,'agricultural'),
    ('Commercial Agriculture',2,'agricultural'),
    ('Smallholder and Resettlement Agriculture',3,'agricultural'),
    ('Irrigation Scheme',4,'agricultural'),
    ('Forestry',5,'forestry'),
    ('Wildlife and Tourism',6,'conservation'),
    ('Conservation and Protected Area',7,'conservation'),
    ('Wetland and Water Resource Protection',8,'conservation'),
    ('Mining and Quarrying',9,'industrial'),
    ('Settlement / Growth Point',10,'mixed'),
    ('Rural Service Centre',11,'mixed'),
    ('Rural Commercial',12,'commercial'),
    ('Rural Industry and Agro-processing',13,'industrial'),
    ('Institutional and Community',14,'institutional'),
    ('Infrastructure and Utilities',15,'infrastructure'),
    ('Future Urban / Development Reserve',16,'reserve'),
    ('Special Development',17,'special')
  ) AS v(code, n, category)
 WHERE i.is_template AND i.title = 'Rural profile v0: best-practice starter palette (reference)'
ON CONFLICT (plan_instrument_id, code) DO NOTHING;

INSERT INTO land_use_groups (group_code, description, group_category, is_active, display_order, plan_instrument_id)
SELECT v.code, v.descr, v.cat, TRUE, v.n, i.id
  FROM plan_instrument i,
  (VALUES
    ('H1','Farm homestead or dwelling','residential',1),
    ('H2','Farm worker housing','residential',2),
    ('H3','Housing in a rural settlement','residential',3),
    ('H4','Staff or institutional accommodation','residential',4),
    ('F1','Crop farming','agricultural',5),
    ('F2','Livestock farming','agricultural',6),
    ('F3','Irrigated farming','agricultural',7),
    ('F4','Farm buildings and stores','agricultural',8),
    ('F5','Agro-processing','industrial',9),
    ('F6','Aquaculture','agricultural',10),
    ('F7','Forestry and woodlots','agricultural',11),
    ('N1','Wildlife reserve or conservancy','conservation',12),
    ('N2','Safari and hunting','conservation',13),
    ('N3','Lodge, camp or tourist accommodation','commercial',14),
    ('N4','Recreation and campsite','recreation',15),
    ('M1','Mining','industrial',16),
    ('M2','Quarrying and borrow pits','industrial',17),
    ('T1','Shop or general dealer','commercial',18),
    ('T2','Market and informal trading','commercial',19),
    ('T3','Service station','commercial',20),
    ('T4','Offices','commercial',21),
    ('T5','Workshop or light industry','industrial',22),
    ('S1','School','institutional',23),
    ('S2','Clinic','institutional',24),
    ('S3','Place of worship','institutional',25),
    ('S4','Community hall or place of assembly','institutional',26),
    ('S5','Government or public offices','institutional',27),
    ('S6','Cemetery','institutional',28),
    ('W1','Water supply and boreholes','infrastructure',29),
    ('W2','Power generation and distribution','infrastructure',30),
    ('W3','Telecommunication mast','infrastructure',31),
    ('W4','Transport depot, airstrip or storage','infrastructure',32)
  ) AS v(code, descr, cat, n)
 WHERE i.is_template AND i.title = 'Rural profile v0: best-practice starter palette (reference)'
   AND NOT EXISTS (SELECT 1 FROM land_use_groups g WHERE g.plan_instrument_id = i.id AND g.group_code = v.code);

-- Crosswalk (all proposed):
INSERT INTO plan_zone_type_class (plan_zone_type_id, scheme, code, relation)
SELECT t.id, 'HILUCS', c.code, m.rel
  FROM (VALUES
    ('Communal Agriculture','1_1','within'),
    ('Commercial Agriculture','1_1','within'),
    ('Smallholder and Resettlement Agriculture','1_1','within'),
    ('Irrigation Scheme','1_1','within'),
    ('Forestry','1_2','within'),
    ('Wildlife and Tourism','6_1','overlaps'),
    ('Wildlife and Tourism','3_4','overlaps'),
    ('Conservation and Protected Area','6_1','within'),
    ('Wetland and Water Resource Protection','6_3','overlaps'),
    ('Wetland and Water Resource Protection','6_1','overlaps'),
    ('Mining and Quarrying','1_3','within'),
    ('Settlement / Growth Point','5_1','overlaps'),
    ('Settlement / Growth Point','3_1','overlaps'),
    ('Rural Service Centre','3_1','overlaps'),
    ('Rural Service Centre','3_3','overlaps'),
    ('Rural Commercial','3_1','within'),
    ('Rural Industry and Agro-processing','2_3','within'),
    ('Institutional and Community','3_3','within'),
    ('Infrastructure and Utilities','4_1','overlaps'),
    ('Infrastructure and Utilities','4_3','overlaps'),
    ('Future Urban / Development Reserve','1_1','overlaps')
  ) AS m(zone_code, short, rel)
  JOIN plan_instrument i ON i.is_template AND i.title = 'Rural profile v0: best-practice starter palette (reference)'
  JOIN plan_zone_type t ON t.plan_instrument_id = i.id AND t.code = m.zone_code
  JOIN reference_classification c ON c.scheme = 'HILUCS' AND c.short_code = m.short
ON CONFLICT DO NOTHING;

INSERT INTO land_use_group_class (land_use_group_id, scheme, code, relation)
SELECT g.id, 'HILUCS', c.code, m.rel
  FROM (VALUES
    ('H1','5_1','within'),('H2','5_1','within'),('H3','5_1','within'),('H4','5_1','overlaps'),
    ('F1','1_1','within'),('F2','1_1','within'),('F3','1_1','within'),('F4','1_1','within'),
    ('F5','2_3','within'),('F6','1_4','within'),('F7','1_2','within'),
    ('N1','6_1','within'),('N2','1_5','within'),('N3','3_1','within'),('N4','3_4','within'),
    ('M1','1_3','within'),('M2','1_3','within'),
    ('T1','3_1','within'),('T2','3_1','within'),('T3','3_1','within'),('T4','3_2','within'),('T5','2_3','within'),
    ('S1','3_3','within'),('S2','3_3','within'),('S3','3_3','within'),('S4','3_4','overlaps'),
    ('S5','3_3','within'),('S6','3_3','overlaps'),
    ('W1','4_3','within'),('W2','4_3','within'),('W2','2_4','overlaps'),('W3','4_3','within'),
    ('W4','4_2','overlaps'),('W4','4_1','overlaps')
  ) AS m(code, short, rel)
  JOIN plan_instrument i ON i.is_template AND i.title = 'Rural profile v0: best-practice starter palette (reference)'
  JOIN land_use_groups g ON g.plan_instrument_id = i.id AND g.group_code = m.code
  JOIN reference_classification c ON c.scheme = 'HILUCS' AND c.short_code = m.short
ON CONFLICT DO NOTHING;

-- 3a. Compare two plans by reference class ------------------------------------------------
-- One row per HILUCS class either plan maps to, listing each plan's zone types and land uses
-- there. 'presence' says whether both plans cover the class or only one does. This is how to
-- see what a second palette adds and where the two overlap.
CREATE OR REPLACE FUNCTION plan_compare(p_a uuid, p_b uuid)
RETURNS TABLE (class_code text, class_label text,
               a_zone_types text[], b_zone_types text[], a_land_uses text[], b_land_uses text[],
               presence text) AS $$
  WITH items AS (
    SELECT i.id AS plan, 'zt' AS kind, t.code AS item, k.code AS class_code
      FROM plan_instrument i
      JOIN plan_zone_type t ON t.plan_instrument_id = i.id
      JOIN plan_zone_type_class k ON k.plan_zone_type_id = t.id AND k.scheme = 'HILUCS'
     WHERE i.id IN (p_a, p_b)
    UNION ALL
    SELECT i.id, 'lu', g.group_code, k.code
      FROM plan_instrument i
      JOIN land_use_groups g ON g.plan_instrument_id = i.id AND g.is_active
      JOIN land_use_group_class k ON k.land_use_group_id = g.id AND k.scheme = 'HILUCS'
     WHERE i.id IN (p_a, p_b))
  SELECT c.code, c.label,
         COALESCE(array_agg(DISTINCT x.item ORDER BY x.item) FILTER (WHERE x.plan = p_a AND x.kind = 'zt'), '{}'),
         COALESCE(array_agg(DISTINCT x.item ORDER BY x.item) FILTER (WHERE x.plan = p_b AND x.kind = 'zt'), '{}'),
         COALESCE(array_agg(DISTINCT x.item ORDER BY x.item) FILTER (WHERE x.plan = p_a AND x.kind = 'lu'), '{}'),
         COALESCE(array_agg(DISTINCT x.item ORDER BY x.item) FILTER (WHERE x.plan = p_b AND x.kind = 'lu'), '{}'),
         CASE WHEN bool_or(x.plan = p_a) AND bool_or(x.plan = p_b) THEN 'both'
              WHEN bool_or(x.plan = p_a) THEN 'only_a' ELSE 'only_b' END
    FROM items x
    JOIN reference_classification c ON c.scheme = 'HILUCS' AND c.code = x.class_code
   GROUP BY c.code, c.label
   ORDER BY c.code
$$ LANGUAGE sql STABLE;

-- 3b. Bring chosen items from one plan into another -----------------------------------------
-- Copies the named zone types and land uses (and their crosswalk) with provenance. A code the
-- target already has is skipped, never overwritten. Decisions are NEVER copied: a zone or use
-- from another palette arrives "not decided", because what is permitted there is for the
-- target plan's own instrument to say.
CREATE OR REPLACE FUNCTION import_plan_items(
  p_target uuid, p_source uuid, p_zone_codes text[] DEFAULT '{}', p_use_codes text[] DEFAULT '{}'
) RETURNS TABLE (kind text, code text, outcome text) AS $$
DECLARE r record; new_id uuid; n integer;
BEGIN
  IF p_target = p_source THEN RAISE EXCEPTION 'target and source are the same plan'; END IF;
  IF NOT EXISTS (SELECT 1 FROM plan_instrument WHERE id = p_target) THEN RAISE EXCEPTION 'unknown target plan %', p_target; END IF;
  IF NOT EXISTS (SELECT 1 FROM plan_instrument WHERE id = p_source) THEN RAISE EXCEPTION 'unknown source plan %', p_source; END IF;

  FOR r IN SELECT c AS code FROM unnest(p_zone_codes) AS c LOOP
    kind := 'zone_type'; code := r.code;
    IF NOT EXISTS (SELECT 1 FROM plan_zone_type WHERE plan_instrument_id = p_source AND plan_zone_type.code = r.code) THEN
      outcome := 'not in source'; RETURN NEXT; CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM plan_zone_type WHERE plan_instrument_id = p_target AND plan_zone_type.code = r.code) THEN
      outcome := 'skipped: target already has it'; RETURN NEXT; CONTINUE;
    END IF;
    INSERT INTO plan_zone_type (plan_instrument_id, code, name, display_no, category, colour, std_zone_class, derived_from_id)
    SELECT p_target, s.code, s.name,
           (SELECT COALESCE(MAX(display_no), 0) + 1 FROM plan_zone_type WHERE plan_instrument_id = p_target),
           s.category, s.colour, s.std_zone_class, s.id
      FROM plan_zone_type s WHERE s.plan_instrument_id = p_source AND s.code = r.code
    RETURNING id INTO new_id;
    INSERT INTO plan_zone_type_class (plan_zone_type_id, scheme, code, relation, status)
    SELECT new_id, k.scheme, k.code, k.relation, k.status
      FROM plan_zone_type_class k JOIN plan_zone_type s ON s.id = k.plan_zone_type_id
     WHERE s.plan_instrument_id = p_source AND s.code = r.code;
    outcome := 'copied (no decisions)'; RETURN NEXT;
  END LOOP;

  FOR r IN SELECT c AS code FROM unnest(p_use_codes) AS c LOOP
    kind := 'land_use'; code := r.code;
    IF NOT EXISTS (SELECT 1 FROM land_use_groups WHERE plan_instrument_id = p_source AND is_active AND group_code = r.code) THEN
      outcome := 'not in source'; RETURN NEXT; CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM land_use_groups WHERE plan_instrument_id = p_target AND group_code = r.code) THEN
      outcome := 'skipped: target already has it'; RETURN NEXT; CONTINUE;
    END IF;
    INSERT INTO land_use_groups
      (group_code, description, group_category, development_category, use_scale, notes, is_active, display_order, plan_instrument_id, derived_from_id)
    SELECT s.group_code, s.description, s.group_category, s.development_category, s.use_scale, s.notes, TRUE,
           (SELECT COALESCE(MAX(display_order), 0) + 1 FROM land_use_groups WHERE plan_instrument_id = p_target),
           p_target, s.id
      FROM land_use_groups s WHERE s.plan_instrument_id = p_source AND s.group_code = r.code AND s.is_active
    RETURNING id INTO new_id;
    INSERT INTO land_use_group_class (land_use_group_id, scheme, code, relation, status)
    SELECT new_id, k.scheme, k.code, k.relation, k.status
      FROM land_use_group_class k JOIN land_use_groups s ON s.id = k.land_use_group_id
     WHERE s.plan_instrument_id = p_source AND s.group_code = r.code;
    outcome := 'copied (no decisions)'; RETURN NEXT;
  END LOOP;
END $$ LANGUAGE plpgsql;

COMMIT;
