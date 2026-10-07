-- 141_reference_classification_and_urban_starter.sql
-- ─────────────────────────────────────────────────────────────────────────
-- 1. A reference classification (INSPIRE HILUCS, levels 1-2) and a crosswalk from each
--    plan's own zone types and land uses to it. Local codes stay local; the crosswalk is
--    what lets plans of different authorities be compared.
-- 2. The urban profile's starter palette: a generic set of zone types and land uses drawn
--    from best-practice vocabularies, with NO decisions and NO standards.
--
-- WHAT THIS IS NOT. Whether a use is permitted, needs special consent or is prohibited in a
-- zone is law, set by each authority's own instrument. Nothing here supplies decisions. The
-- starter palette is a structure to adopt and fill in, not Zimbabwean planning law.
-- Every crosswalk row is 'proposed' until someone confirms it.
--
-- HILUCS source: INSPIRE register code list HILUCSValue (levels 1 and 2 only; level 3 is
-- not loaded). Retrieved 2026-10-07 through a summarising fetch, so the labels should be
-- checked against https://inspire.ec.europa.eu/codelist/HILUCSValue before this is relied on.
-- Relation values: exact (same meaning), within (the local item falls inside the class),
-- overlaps (the local item straddles the class and others).

BEGIN;

-- 1. Reference classification ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS reference_classification (
  scheme       text NOT NULL,
  code         text NOT NULL,
  short_code   text NOT NULL,
  label        text NOT NULL,
  parent_code  text,
  level        integer NOT NULL,
  source_url   text,
  retrieved_on date,
  PRIMARY KEY (scheme, code),
  UNIQUE (scheme, short_code),
  FOREIGN KEY (scheme, parent_code) REFERENCES reference_classification (scheme, code)
);

INSERT INTO reference_classification (scheme, code, short_code, label, parent_code, level, source_url, retrieved_on) VALUES
 ('HILUCS','1_PrimaryProduction','1','Primary production',NULL,1,'https://inspire.ec.europa.eu/codelist/HILUCSValue','2026-10-07'),
 ('HILUCS','2_SecondaryProduction','2','Secondary production',NULL,1,'https://inspire.ec.europa.eu/codelist/HILUCSValue','2026-10-07'),
 ('HILUCS','3_TertiaryProduction','3','Tertiary production',NULL,1,'https://inspire.ec.europa.eu/codelist/HILUCSValue','2026-10-07'),
 ('HILUCS','4_TransportNetworksLogisticsAndUtilities','4','Transport networks, logistics and utilities',NULL,1,'https://inspire.ec.europa.eu/codelist/HILUCSValue','2026-10-07'),
 ('HILUCS','5_ResidentialUseAndRelatedServices','5','Residential use and related services',NULL,1,'https://inspire.ec.europa.eu/codelist/HILUCSValue','2026-10-07'),
 ('HILUCS','6_AgriculturalNatureManagementAndOtherAreas','6','Agricultural, nature management and other areas',NULL,1,'https://inspire.ec.europa.eu/codelist/HILUCSValue','2026-10-07')
ON CONFLICT DO NOTHING;

INSERT INTO reference_classification (scheme, code, short_code, label, parent_code, level, source_url, retrieved_on)
SELECT 'HILUCS', v.code, v.short, v.label,
       (SELECT code FROM reference_classification p WHERE p.scheme = 'HILUCS' AND p.short_code = split_part(v.short, '_', 1)),
       2, 'https://inspire.ec.europa.eu/codelist/HILUCSValue', DATE '2026-10-07'
  FROM (VALUES
    ('1_1_Agriculture','1_1','Agriculture'),
    ('1_2_Forestry','1_2','Forestry'),
    ('1_3_MiningAndQuarrying','1_3','Mining and quarrying'),
    ('1_4_AquacultureAndFishing','1_4','Aquaculture and fishing'),
    ('1_5_OtherPrimaryProduction','1_5','Other primary production'),
    ('2_1_RawIndustry','2_1','Raw industry'),
    ('2_2_HeavyEndProductIndustry','2_2','Heavy end product industry'),
    ('2_3_LightEndProductIndustry','2_3','Light end product industry'),
    ('2_4_EnergyProduction','2_4','Energy production'),
    ('2_5_OtherIndustry','2_5','Other industry'),
    ('3_1_CommercialServices','3_1','Commercial services'),
    ('3_2_FinancialProfessionalAndInformationServices','3_2','Financial, professional and information services'),
    ('3_3_CommunityServices','3_3','Community services'),
    ('3_4_CulturalEntertainmentAndRecreationalServices','3_4','Cultural, entertainment and recreational services'),
    ('3_5_OtherServices','3_5','Other services'),
    ('4_1_TransportNetworks','4_1','Transport networks'),
    ('4_2_LogisticalAndStorageServices','4_2','Logistical and storage services'),
    ('4_3_Utilities','4_3','Utilities'),
    ('5_1_ResidentialUse','5_1','Residential use'),
    ('5_2_RelatedServices','5_2','Related services'),
    ('6_1_AgriculturalNatureManagementAreas','6_1','Agricultural nature management areas'),
    ('6_2_OtherAreasWithoutOrWithVeryLimitedVegetationOrWaterBodies','6_2','Other areas without or with very limited vegetation, or water bodies'),
    ('6_3_WaterBodies','6_3','Water bodies')
  ) AS v(code, short, label)
ON CONFLICT DO NOTHING;

-- 2. The crosswalk ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_zone_type_class (
  plan_zone_type_id uuid NOT NULL REFERENCES plan_zone_type(id) ON DELETE CASCADE,
  scheme   text NOT NULL,
  code     text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('exact','within','overlaps')),
  status   text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed')),
  PRIMARY KEY (plan_zone_type_id, scheme, code),
  FOREIGN KEY (scheme, code) REFERENCES reference_classification (scheme, code)
);

CREATE TABLE IF NOT EXISTS land_use_group_class (
  land_use_group_id uuid NOT NULL REFERENCES land_use_groups(id) ON DELETE CASCADE,
  scheme   text NOT NULL,
  code     text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('exact','within','overlaps')),
  status   text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed')),
  PRIMARY KEY (land_use_group_id, scheme, code),
  FOREIGN KEY (scheme, code) REFERENCES reference_classification (scheme, code)
);

-- 3. Urban starter palette ---------------------------------------------------------------
UPDATE plan_profile
   SET status = 'draft',
       description = 'Draft v0: a generic starter palette of zone types and land uses from best-practice vocabularies (no decisions, no standards). To be replaced or refined from real urban samples and the national standard if one exists.'
 WHERE code = 'urban' AND status = 'skeleton';

INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title, version, status, is_template, source_document, notes)
SELECT NULL, p.id, 'district_master', 'Urban profile v0: best-practice starter palette (reference)', 1, 'draft', TRUE,
       'Compiled from general best-practice vocabularies; see notes.',
       'A structural starting point only, NOT Zimbabwean law and not any authority''s plan. Zone types and land uses are generic categories of the kind used in NSW Standard Instrument zoning, the NZ National Planning Standards and INSPIRE HILUCS; names are original, not copied. It holds no decisions (permitted / special consent / prohibited) and no standards: those must come from each authority''s own instrument.'
  FROM plan_profile p
 WHERE p.code = 'urban'
   AND NOT EXISTS (SELECT 1 FROM plan_instrument WHERE is_template AND title = 'Urban profile v0: best-practice starter palette (reference)');

INSERT INTO plan_zone_type (plan_instrument_id, code, name, display_no, category)
SELECT i.id, v.code, v.code, v.n, v.category
  FROM plan_instrument i,
  (VALUES
    ('Low-Density Residential',1,'residential'),
    ('Medium-Density Residential',2,'residential'),
    ('High-Density Residential',3,'residential'),
    ('Town Centre / Mixed Use',4,'mixed'),
    ('Local Commercial',5,'commercial'),
    ('Light Industrial',6,'industrial'),
    ('General Industrial',7,'industrial'),
    ('Institutional and Community',8,'institutional'),
    ('Open Space and Recreation',9,'open_space'),
    ('Environmental Conservation',10,'conservation'),
    ('Transport and Utilities',11,'infrastructure'),
    ('Urban Agriculture / Peri-urban Fringe',12,'agricultural'),
    ('Future Urban / Development Reserve',13,'reserve'),
    ('Special / Comprehensive Development',14,'special')
  ) AS v(code, n, category)
 WHERE i.is_template AND i.title = 'Urban profile v0: best-practice starter palette (reference)'
ON CONFLICT (plan_instrument_id, code) DO NOTHING;

INSERT INTO land_use_groups (group_code, description, group_category, is_active, display_order, plan_instrument_id)
SELECT v.code, v.descr, v.cat, TRUE, v.n, i.id
  FROM plan_instrument i,
  (VALUES
    ('R1','Dwelling house (detached)','residential',1),
    ('R2','Semi-detached and terraced housing','residential',2),
    ('R3','Flats / apartments','residential',3),
    ('R4','Boarding house or hostel','residential',4),
    ('R5','Home occupation','residential',5),
    ('C1','Shop','commercial',6),
    ('C2','Market and informal trading','commercial',7),
    ('C3','Restaurant or food outlet','commercial',8),
    ('C4','Hotel, lodge or guest house','commercial',9),
    ('C5','Petrol or service station','commercial',10),
    ('C6','Offices','commercial',11),
    ('C7','Medical consulting rooms','institutional',12),
    ('I1','Light industry or workshop','industrial',13),
    ('I2','General industry','industrial',14),
    ('I3','Noxious or heavy industry','industrial',15),
    ('I4','Warehouse or storage','industrial',16),
    ('I5','Transport depot or lorry park','industrial',17),
    ('S1','School or educational institution','institutional',18),
    ('S2','Clinic or hospital','institutional',19),
    ('S3','Place of worship','institutional',20),
    ('S4','Community hall or place of assembly','institutional',21),
    ('S5','Government or public offices','institutional',22),
    ('S6','Cemetery','institutional',23),
    ('O1','Park or public open space','recreation',24),
    ('O2','Sports ground or recreation facility','recreation',25),
    ('O3','Nature conservation','conservation',26),
    ('A1','Urban agriculture or market garden','agricultural',27),
    ('A2','Livestock keeping','agricultural',28),
    ('U1','Utility installation (water, sewer, power)','infrastructure',29),
    ('U2','Telecommunication mast','infrastructure',30)
  ) AS v(code, descr, cat, n)
 WHERE i.is_template AND i.title = 'Urban profile v0: best-practice starter palette (reference)'
   AND NOT EXISTS (SELECT 1 FROM land_use_groups g WHERE g.plan_instrument_id = i.id AND g.group_code = v.code);

-- 4. Crosswalk rows: urban starter palette and the rural template ----------------------------
-- (short HILUCS code, relation). Everything is 'proposed'. Zone types:
INSERT INTO plan_zone_type_class (plan_zone_type_id, scheme, code, relation)
SELECT t.id, 'HILUCS', c.code, m.rel
  FROM (VALUES
    ('Urban profile v0: best-practice starter palette (reference)','Low-Density Residential','5_1','within'),
    ('Urban profile v0: best-practice starter palette (reference)','Medium-Density Residential','5_1','within'),
    ('Urban profile v0: best-practice starter palette (reference)','High-Density Residential','5_1','within'),
    ('Urban profile v0: best-practice starter palette (reference)','Town Centre / Mixed Use','3_1','overlaps'),
    ('Urban profile v0: best-practice starter palette (reference)','Town Centre / Mixed Use','5_1','overlaps'),
    ('Urban profile v0: best-practice starter palette (reference)','Local Commercial','3_1','within'),
    ('Urban profile v0: best-practice starter palette (reference)','Light Industrial','2_3','within'),
    ('Urban profile v0: best-practice starter palette (reference)','General Industrial','2_1','overlaps'),
    ('Urban profile v0: best-practice starter palette (reference)','General Industrial','2_2','overlaps'),
    ('Urban profile v0: best-practice starter palette (reference)','Institutional and Community','3_3','within'),
    ('Urban profile v0: best-practice starter palette (reference)','Open Space and Recreation','3_4','within'),
    ('Urban profile v0: best-practice starter palette (reference)','Environmental Conservation','6_1','within'),
    ('Urban profile v0: best-practice starter palette (reference)','Transport and Utilities','4_1','overlaps'),
    ('Urban profile v0: best-practice starter palette (reference)','Transport and Utilities','4_3','overlaps'),
    ('Urban profile v0: best-practice starter palette (reference)','Urban Agriculture / Peri-urban Fringe','1_1','within'),
    ('Urban profile v0: best-practice starter palette (reference)','Future Urban / Development Reserve','1_1','overlaps'),
    ('Rural profile v0: district development control matrix (sample)','Communal Farming Zone','1_1','within'),
    ('Rural profile v0: district development control matrix (sample)','High Intensive Commercial Farming Zone','1_1','within'),
    ('Rural profile v0: district development control matrix (sample)','Estates Zone (Large Farms)','1_1','within'),
    ('Rural profile v0: district development control matrix (sample)','Irrigation Scheme Zone','1_1','within'),
    ('Rural profile v0: district development control matrix (sample)','Smallholder Estates Zone','1_1','within'),
    ('Rural profile v0: district development control matrix (sample)','Forestry / Conservation Zone','1_2','overlaps'),
    ('Rural profile v0: district development control matrix (sample)','Forestry / Conservation Zone','6_1','overlaps'),
    ('Rural profile v0: district development control matrix (sample)','Game Park Zone','6_1','within'),
    ('Rural profile v0: district development control matrix (sample)','Game Corridor Zone','6_1','overlaps'),
    ('Rural profile v0: district development control matrix (sample)','Urban Expansion Zone','5_1','overlaps'),
    ('Rural profile v0: district development control matrix (sample)','Industrial Zone','2','exact'),
    ('Rural profile v0: district development control matrix (sample)','Commercial Zone','3_1','within')
  ) AS m(plan_title, zone_code, short, rel)
  JOIN plan_instrument i ON i.is_template AND i.title = m.plan_title
  JOIN plan_zone_type t ON t.plan_instrument_id = i.id AND t.code = m.zone_code
  JOIN reference_classification c ON c.scheme = 'HILUCS' AND c.short_code = m.short
ON CONFLICT DO NOTHING;

-- Land uses:
INSERT INTO land_use_group_class (land_use_group_id, scheme, code, relation)
SELECT g.id, 'HILUCS', c.code, m.rel
  FROM (VALUES
    ('U','R1','5_1','within'),('U','R2','5_1','within'),('U','R3','5_1','within'),
    ('U','R4','5_1','overlaps'),('U','R5','5_1','overlaps'),
    ('U','C1','3_1','within'),('U','C2','3_1','within'),('U','C3','3_1','within'),('U','C4','3_1','within'),
    ('U','C5','3_1','within'),('U','C6','3_2','within'),('U','C7','3_3','within'),
    ('U','I1','2_3','within'),('U','I2','2_1','overlaps'),('U','I2','2_2','overlaps'),('U','I3','2_1','overlaps'),
    ('U','I4','4_2','within'),('U','I5','4_1','overlaps'),('U','I5','4_2','overlaps'),
    ('U','S1','3_3','within'),('U','S2','3_3','within'),('U','S3','3_3','within'),('U','S4','3_4','overlaps'),
    ('U','S5','3_3','within'),('U','S6','3_3','overlaps'),
    ('U','O1','3_4','within'),('U','O2','3_4','within'),('U','O3','6_1','within'),
    ('U','A1','1_1','within'),('U','A2','1_1','within'),('U','U1','4_3','within'),('U','U2','4_3','within'),
    ('R','A','5_1','within'),('R','A1','5_1','within'),('R','A2','5_1','within'),('R','A3','5_1','within'),
    ('R','B','5_1','overlaps'),('R','B1','5_1','overlaps'),('R','B2','5_1','overlaps'),
    ('R','C','3_3','within'),('R','D','3_1','within'),('R','D1','3_1','overlaps'),('R','D1','1_1','overlaps'),
    ('R','E','3_2','within'),('R','E1','3_2','within'),('R','E2','3_3','overlaps'),('R','F','3_3','within'),
    ('R','G','3_1','within'),('R','H','4_2','within'),('R','I','3_3','within'),
    ('R','J','3_4','overlaps'),('R','J1','3_4','overlaps'),('R','K','3_3','within'),
    ('R','L1','2','exact'),('R','M','2','exact'),
    ('R','P','1_1','within'),('R','Q','1_1','within'),('R','R','3_1','within'),
    ('R','S','4_1','overlaps'),('R','S','3_1','overlaps'),('R','T','3_2','within'),
    ('R','U','4_1','overlaps'),('R','V','3_1','overlaps'),('R','X','6_1','within'),
    ('R','Z','1_1','within'),('R','UF','1_2','overlaps')
  ) AS m(profile, code, short, rel)
  JOIN plan_instrument i ON i.is_template
       AND i.title = CASE m.profile WHEN 'U' THEN 'Urban profile v0: best-practice starter palette (reference)'
                                    ELSE 'Rural profile v0: district development control matrix (sample)' END
  JOIN land_use_groups g ON g.plan_instrument_id = i.id AND g.group_code = m.code
  JOIN reference_classification c ON c.scheme = 'HILUCS' AND c.short_code = m.short
ON CONFLICT DO NOTHING;

-- 5. Adopting a template also copies its crosswalk ---------------------------------------------
-- (Same function as migration 140, with the crosswalk copy added before RETURN.)
CREATE OR REPLACE FUNCTION adopt_plan_template(
  p_template  uuid,
  p_authority integer,
  p_title     text,
  p_plan_type text DEFAULT 'local',
  p_status    text DEFAULT 'draft'
) RETURNS uuid AS $$
DECLARE tmpl plan_instrument%ROWTYPE; auth local_authorities%ROWTYPE; new_id uuid;
BEGIN
  SELECT * INTO tmpl FROM plan_instrument WHERE id = p_template;
  IF NOT FOUND OR NOT tmpl.is_template THEN
    RAISE EXCEPTION '% is not a plan template', p_template;
  END IF;
  SELECT * INTO auth FROM local_authorities WHERE id = p_authority;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority % does not exist', p_authority;
  END IF;

  INSERT INTO plan_instrument
    (authority_id, profile_id, plan_type, title, version, status, is_template, derived_from_id, notes)
  VALUES
    (auth.id, tmpl.profile_id, p_plan_type, p_title, 1, p_status, FALSE, tmpl.id,
     format('Adopted from template "%s" on %s. Edit this copy; plan_diff() shows how it differs from the template.', tmpl.title, CURRENT_DATE))
  RETURNING id INTO new_id;

  INSERT INTO plan_zone_type (plan_instrument_id, code, name, display_no, category, colour, std_zone_class, derived_from_id)
  SELECT new_id, code, name, display_no, category, colour, std_zone_class, id
    FROM plan_zone_type WHERE plan_instrument_id = tmpl.id;

  INSERT INTO land_use_groups
    (group_code, description, group_category, development_category, use_scale, notes, is_active, display_order, plan_instrument_id, derived_from_id)
  SELECT group_code, description, group_category, development_category, use_scale, notes, TRUE, display_order, new_id, id
    FROM land_use_groups WHERE plan_instrument_id = tmpl.id AND is_active;

  INSERT INTO zone_land_use_controls
    (plan_zone_type_id, land_use_group_id, control_type, authority, conditions, notes, derived_from_id)
  SELECT nz.id, ng.id, c.control_type, auth.authority_name, c.conditions, c.notes, c.id
    FROM zone_land_use_controls c
    JOIN plan_zone_type oz ON oz.id = c.plan_zone_type_id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code
    JOIN land_use_groups og ON og.id = c.land_use_group_id
    JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code
   WHERE c.plan_instrument_id = tmpl.id AND c.deleted_at IS NULL;

  INSERT INTO plan_zone_type_class (plan_zone_type_id, scheme, code, relation, status)
  SELECT nz.id, k.scheme, k.code, k.relation, k.status
    FROM plan_zone_type_class k
    JOIN plan_zone_type oz ON oz.id = k.plan_zone_type_id AND oz.plan_instrument_id = tmpl.id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code;

  INSERT INTO land_use_group_class (land_use_group_id, scheme, code, relation, status)
  SELECT ng.id, k.scheme, k.code, k.relation, k.status
    FROM land_use_group_class k
    JOIN land_use_groups og ON og.id = k.land_use_group_id AND og.plan_instrument_id = tmpl.id
    JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code;

  RETURN new_id;
END $$ LANGUAGE plpgsql;

COMMIT;
