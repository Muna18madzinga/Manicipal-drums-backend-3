-- 174: a parcel records the SI 727 survey class it was surveyed to; the A-D grade stops standing in for state and source.
--
-- Land Survey (General) Regulations 1979 (SI 727), Second Schedule para 1: class A is surveys to determine the position of town survey-marks,
-- class B is surveys in townships, class C is every other survey. There is no class D. The classes set the limits of error a survey is held
-- to (Land Survey Act [Chapter 20:12] s9(1)(c), s13(1)(d)); they say nothing about how far a record has got.
--
-- land.parcel.accuracy_class was A-D and was being used for other things: A for a parcel from a Surveyor-General approved general plan
-- (a state), D for a digitised farm (a source). Those facts already have their own columns:
--   accuracy_basis   surveyed | general_plan | map_digitised | estimated | unknown     (migration 137: how the position was arrived at)
--   sg_ref, general_plan_id, origin                                                   (approved by the Surveyor-General, or not)
-- so this migration:
--   1. adds survey_class  'A' | 'B' | 'C' | NULL   (NULL = not a survey to SI 727, or not known; never defaulted),
--   2. gives every parcel its accuracy_basis if it had none, from what its old class stood for,
--   3. lets accuracy_class be NULL on parcels. Existing values are kept as they are: they are history, not deleted, and the register
--      screens that show them keep working. New writers leave it NULL.
-- Features (gis_ops.feature) and buildings keep their own required A-D grade: that is a map-capture grade for points and lines, not an
-- SI 727 survey, and is a separate decision.

ALTER TABLE land.parcel ADD COLUMN IF NOT EXISTS survey_class char(1);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parcel_survey_class_check' AND conrelid = 'land.parcel'::regclass) THEN
    ALTER TABLE land.parcel ADD CONSTRAINT parcel_survey_class_check CHECK (survey_class IS NULL OR survey_class IN ('A', 'B', 'C'));
  END IF;
END $$;
COMMENT ON COLUMN land.parcel.survey_class IS
  'SI 727 survey class the parcel was surveyed to (A town survey-marks, B townships, C other), as declared by the surveyor. NULL when not declared or not an SI 727 survey. A property of the survey, not of the record''s state (see origin, sg_ref, status).';

ALTER TABLE land.parcel ALTER COLUMN accuracy_class DROP NOT NULL;
COMMENT ON COLUMN land.parcel.accuracy_class IS
  'LEGACY grade A-D from before survey_class existed; A/D stood for state and source, not for an SI 727 class. Kept as history; new writers leave it NULL. Use survey_class, accuracy_basis and sg_ref.';

-- basis from the old meaning, only where nothing was said
UPDATE land.parcel SET accuracy_basis = 'general_plan'  WHERE accuracy_basis IS NULL AND general_plan_id IS NOT NULL;
UPDATE land.parcel SET accuracy_basis = 'map_digitised' WHERE accuracy_basis IS NULL AND accuracy_class = 'D';
UPDATE land.parcel SET accuracy_basis = 'surveyed'      WHERE accuracy_basis IS NULL AND source_relation = 'surveypro';
-- a SurveyPro import already carried the declared SI 727 class in accuracy_class
UPDATE land.parcel SET survey_class = accuracy_class, accuracy_class = NULL
 WHERE source_relation = 'surveypro' AND accuracy_class IN ('B', 'C') AND survey_class IS NULL;
