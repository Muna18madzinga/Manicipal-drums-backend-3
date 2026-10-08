-- 161: provisional rules. A decision that rests on a plan not in force, or on a column nobody has reviewed, says so.
--
-- A development control matrix can be drafted ahead of the council's review so the application can be built and tested
-- against it. That is only safe if nothing treats the draft as policy. Two levels:
--   * the PLAN is provisional until it is approved or gazetted (derived from its status, never stored);
--   * each zone column (plan_zone_type) carries a review_status: unreviewed -> in_review -> reviewed, with who and when.
--     Editing any decision in a reviewed column puts it back to in_review, so a review never outlives the content it
--     covered. Marking a column reviewed does not touch the plan's sign-off, which is a separate act.
--
-- Every rule snapshot now records both, so a stored assessment shows afterwards whether it rested on draft rules.
-- Existing rows are 'unreviewed': nobody has reviewed them.

ALTER TABLE public.plan_zone_type
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS reviewed_by   text,
  ADD COLUMN IF NOT EXISTS reviewed_at   timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_zone_type_review_status_check') THEN
    ALTER TABLE public.plan_zone_type ADD CONSTRAINT plan_zone_type_review_status_check
      CHECK (review_status IN ('unreviewed', 'in_review', 'reviewed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_zone_type_review_complete') THEN
    ALTER TABLE public.plan_zone_type ADD CONSTRAINT plan_zone_type_review_complete
      CHECK (review_status <> 'reviewed' OR (reviewed_by IS NOT NULL AND btrim(reviewed_by) <> '' AND reviewed_at IS NOT NULL));
  END IF;
END $$;

-- Is a plan in force? Provisional means no.
CREATE OR REPLACE FUNCTION public.plan_is_provisional(p_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT p_status IS NULL OR p_status NOT IN ('approved', 'gazetted') $$;

-- Editing a decision in a reviewed column puts the column back in review.
CREATE OR REPLACE FUNCTION public.zone_type_review_goes_stale() RETURNS trigger AS $$
DECLARE zt uuid;
BEGIN
  zt := COALESCE(NEW.plan_zone_type_id, OLD.plan_zone_type_id);
  IF zt IS NOT NULL THEN
    UPDATE public.plan_zone_type SET review_status = 'in_review' WHERE id = zt AND review_status = 'reviewed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_zlc_review_stale ON public.zone_land_use_controls;
CREATE TRIGGER trg_zlc_review_stale
  AFTER INSERT OR UPDATE OR DELETE ON public.zone_land_use_controls
  FOR EACH ROW EXECUTE FUNCTION public.zone_type_review_goes_stale();

-- Record a review decision for one zone column. The caller says who reviewed it; the plan keeps the event.
CREATE OR REPLACE FUNCTION public.set_zone_type_review(p_zone_type uuid, p_status text, p_reviewer text, p_actor uuid DEFAULT NULL, p_actor_role text DEFAULT NULL)
RETURNS void AS $$
DECLARE zt record;
BEGIN
  IF p_status NOT IN ('unreviewed', 'in_review', 'reviewed') THEN
    RAISE EXCEPTION 'review status must be unreviewed, in_review or reviewed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_status = 'reviewed' AND (p_reviewer IS NULL OR btrim(p_reviewer) = '') THEN
    RAISE EXCEPTION 'a review needs the name of the reviewer' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO zt FROM public.plan_zone_type WHERE id = p_zone_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such zone type' USING ERRCODE = 'no_data_found'; END IF;
  UPDATE public.plan_zone_type
     SET review_status = p_status,
         reviewed_by = CASE WHEN p_status = 'reviewed' THEN btrim(p_reviewer) ELSE NULL END,
         reviewed_at = CASE WHEN p_status = 'reviewed' THEN now() ELSE NULL END
   WHERE id = p_zone_type;
  INSERT INTO public.plan_event (plan_instrument_id, event_type, actor_id, actor_role, detail)
  VALUES (zt.plan_instrument_id, 'zone_review', p_actor, p_actor_role,
          jsonb_build_object('zone_type', zt.code, 'from', zt.review_status, 'to', p_status, 'reviewer', p_reviewer));
END $$ LANGUAGE plpgsql;

-- The plan a zone polygon belongs to, and whether what it decides is provisional. Runs with the caller's rights.
CREATE OR REPLACE VIEW public.zone_decision_status WITH (security_invoker = true) AS
SELECT z.id AS zone_id, i.id AS plan_id, i.title AS plan_title, i.version AS plan_version, i.status AS plan_status,
       public.plan_is_provisional(i.status) AS provisional,
       t.code AS zone_type_code, t.review_status, t.reviewed_by, t.reviewed_at
  FROM public.proposed_peri_urban_zones z
  JOIN public.plan_instrument i ON i.id = z.plan_instrument_id
  LEFT JOIN public.plan_zone_type t ON t.id = z.plan_zone_type_id;

GRANT SELECT ON public.zone_decision_status TO vungu_app;
GRANT EXECUTE ON FUNCTION public.plan_is_provisional(text), public.set_zone_type_review(uuid, text, text, uuid, text) TO vungu_app;

-- The rule snapshot now says whether the plan is provisional and where the zone column stands in review.
CREATE OR REPLACE FUNCTION public.rule_snapshot(p_layer text, p_id text, p_use text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT jsonb_build_object(
    'computed_at',   NOW(),
    'parcel',        jsonb_build_object('layer', p_layer, 'id', p_id),
    'land_use_code', p_use,
    'unzoned',       NOT EXISTS (SELECT 1 FROM parcel_zoning_for(p_layer, p_id)),
    'provisional',   COALESCE((SELECT bool_or(pi.status NOT IN ('approved', 'gazetted'))
                                 FROM parcel_zoning_for(p_layer, p_id) pq JOIN plan_instrument pi ON pi.id = pq.plan_instrument_id), FALSE),
    'results', COALESCE((
      SELECT jsonb_agg(row_json ORDER BY governing DESC, share DESC NULLS LAST, plan_title, zone_id)
        FROM (
          SELECT pz.zone_id, pz.is_governing AS governing, pz.share_pct AS share, i.title AS plan_title,
                 jsonb_build_object(
                   'plan',  jsonb_build_object('id', i.id, 'title', i.title, 'version', i.version,
                                               'status', i.status, 'provisional', (i.status NOT IN ('approved', 'gazetted')), 'authority', a.authority_name,
                                               'gazette_ref', i.gazette_ref),
                   'zone',  jsonb_build_object('id', pz.zone_id, 'name', pz.zone_name, 'type_code', t.code,
                                               'review_status', t.review_status, 'reviewed_by', t.reviewed_by),
                   'share_pct', pz.share_pct,
                   'governing', pz.is_governing,
                   'method',    pz.method,
                   'land_use',  CASE WHEN g.id IS NULL THEN NULL
                                     ELSE jsonb_build_object('code', g.group_code, 'description', g.description) END,
                   'decision',          c.control_type,
                   'decision_source',   c.source,
                   'conditions',        c.conditions,
                   'notes',             c.notes,
                   'pathway',           CASE WHEN dp.code IS NULL THEN NULL ELSE jsonb_build_object(
                                          'code', dp.code, 'name', dp.name,
                                          'requires_public_notice', dp.requires_public_notice,
                                          'notice_at_applicant_cost', dp.notice_at_applicant_cost,
                                          'adjacent_owners_notified', dp.adjacent_owners_notified,
                                          'objection_days', dp.objection_days,
                                          'decision_body', dp.decision_body,
                                          'statutory_ref', dp.statutory_ref,
                                          'evidence_status', dp.evidence_status) END,
                   'pathway_source',    CASE WHEN dp.code IS NULL THEN NULL
                                             WHEN c.pathway_code IS NOT NULL THEN 'decision' ELSE 'default' END,
                   'standards', COALESCE((
                       SELECT jsonb_agg(jsonb_build_object(
                                'kind', s.kind_code, 'name', k.name, 'unit', k.unit,
                                'min', s.min_value, 'max', s.max_value, 'conditions', s.conditions,
                                'status', s.status, 'source_ref', s.source_ref) ORDER BY s.kind_code)
                         FROM plan_zone_standard s JOIN standard_kind k ON k.code = s.kind_code
                        WHERE s.plan_zone_type_id = pz.plan_zone_type_id
                          AND (s.land_use_group_id IS NULL OR s.land_use_group_id = g.id)), '[]'::jsonb)
                 ) AS row_json
            FROM parcel_zoning_for(p_layer, p_id) pz
            JOIN plan_instrument i ON i.id = pz.plan_instrument_id
            LEFT JOIN local_authorities a ON a.id = i.authority_id
            LEFT JOIN plan_zone_type t ON t.id = pz.plan_zone_type_id
            LEFT JOIN land_use_groups g ON g.plan_instrument_id = pz.plan_instrument_id AND g.group_code = p_use AND g.is_active
            LEFT JOIN zone_effective_controls c ON c.zone_id = pz.zone_id AND c.land_use_group_id = g.id
            LEFT JOIN decision_pathway dp
                   ON dp.code = COALESCE(c.pathway_code,
                                         (SELECT d.code FROM decision_pathway d
                                           WHERE d.is_default_for_decision AND d.decision = c.control_type))
        ) rows), '[]'::jsonb)
  )
$function$;

-- A new plan version keeps the review state of columns it copies unchanged.
CREATE OR REPLACE FUNCTION public.new_plan_version(p_plan uuid, p_actor uuid, p_role text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE src plan_instrument%ROWTYPE; new_id uuid;
BEGIN
  SELECT * INTO src FROM plan_instrument WHERE id = p_plan;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown plan %', p_plan; END IF;
  IF src.is_template THEN RAISE EXCEPTION 'a template is not versioned this way'; END IF;
  IF src.status NOT IN ('approved', 'gazetted') THEN
    RAISE EXCEPTION 'only an approved or gazetted plan needs a new version (this one is %: edit it directly)', src.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM plan_instrument WHERE supersedes_id = p_plan AND status <> 'superseded') THEN
    RAISE EXCEPTION 'a newer version of this plan already exists' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO plan_instrument
    (authority_id, profile_id, plan_type, title, version, status, is_template, derived_from_id, supersedes_id, source_document, notes)
  VALUES
    (src.authority_id, src.profile_id, src.plan_type, src.title,
     (SELECT MAX(version) + 1 FROM plan_instrument WHERE authority_id = src.authority_id AND title = src.title),
     'draft', FALSE, src.derived_from_id, src.id, src.source_document,
     format('Version %s of "%s", copied from version %s on %s.', src.version + 1, src.title, src.version, CURRENT_DATE))
  RETURNING id INTO new_id;

  INSERT INTO plan_zone_type (plan_instrument_id, code, name, display_no, category, colour, std_zone_class, derived_from_id)
  SELECT new_id, code, name, display_no, category, colour, std_zone_class, id
    FROM plan_zone_type WHERE plan_instrument_id = src.id;

  INSERT INTO land_use_groups
    (group_code, description, group_category, development_category, use_scale, notes, is_active, display_order, plan_instrument_id, derived_from_id)
  SELECT group_code, description, group_category, development_category, use_scale, notes, TRUE, display_order, new_id, id
    FROM land_use_groups WHERE plan_instrument_id = src.id AND is_active;

  INSERT INTO zone_land_use_controls
    (plan_zone_type_id, land_use_group_id, control_type, authority, conditions, notes, pathway_code, derived_from_id)
  SELECT nz.id, ng.id, c.control_type, c.authority, c.conditions, c.notes, c.pathway_code, c.id
    FROM zone_land_use_controls c
    JOIN plan_zone_type oz ON oz.id = c.plan_zone_type_id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code
    JOIN land_use_groups og ON og.id = c.land_use_group_id
    JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code
   WHERE c.plan_instrument_id = src.id AND c.deleted_at IS NULL;

  INSERT INTO plan_zone_type_class (plan_zone_type_id, scheme, code, relation, status)
  SELECT nz.id, k.scheme, k.code, k.relation, k.status
    FROM plan_zone_type_class k
    JOIN plan_zone_type oz ON oz.id = k.plan_zone_type_id AND oz.plan_instrument_id = src.id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code;

  INSERT INTO land_use_group_class (land_use_group_id, scheme, code, relation, status)
  SELECT ng.id, k.scheme, k.code, k.relation, k.status
    FROM land_use_group_class k
    JOIN land_use_groups og ON og.id = k.land_use_group_id AND og.plan_instrument_id = src.id
    JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code;

  INSERT INTO plan_zone_standard
    (plan_zone_type_id, kind_code, land_use_group_id, min_value, max_value, conditions, source_ref, status, derived_from_id)
  SELECT nz.id, s.kind_code, ng.id, s.min_value, s.max_value, s.conditions, s.source_ref, s.status, s.id
    FROM plan_zone_standard s
    JOIN plan_zone_type oz ON oz.id = s.plan_zone_type_id AND oz.plan_instrument_id = src.id
    JOIN plan_zone_type nz ON nz.plan_instrument_id = new_id AND nz.code = oz.code
    LEFT JOIN land_use_groups og ON og.id = s.land_use_group_id
    LEFT JOIN land_use_groups ng ON ng.plan_instrument_id = new_id AND ng.group_code = og.group_code
   WHERE s.land_use_group_id IS NULL OR ng.id IS NOT NULL;

  PERFORM log_plan_event(new_id, 'version_created', p_actor, p_role, jsonb_build_object('from', src.id, 'version', src.version + 1));
  PERFORM log_plan_event(src.id, 'new_version_started', p_actor, p_role, jsonb_build_object('new', new_id));
  -- a reviewed column stays reviewed in the copy (the copy itself would otherwise mark it for re-review)
  UPDATE plan_zone_type nz
     SET review_status = oz.review_status, reviewed_by = oz.reviewed_by, reviewed_at = oz.reviewed_at
    FROM plan_zone_type oz
   WHERE nz.plan_instrument_id = new_id AND oz.id = nz.derived_from_id AND oz.review_status = 'reviewed';

  RETURN new_id;
END $function$;
