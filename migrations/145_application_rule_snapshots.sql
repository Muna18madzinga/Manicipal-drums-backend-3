-- 145_application_rule_snapshots.sql
-- ─────────────────────────────────────────────────────────────────────────
-- An application keeps the rules it was judged under. rule_snapshot(layer, parcel, use)
-- works out, on the server, which plan(s) and zone(s) govern the parcel, what each decides
-- for the land use (with its conditions, pathway and standards), and returns it as one JSON
-- document. The application stores that document; later edits to the plan never change it,
-- and a database trigger refuses to rewrite a stored snapshot.
--
-- The snapshot is computed by the server from the parcel's position. It is never taken from
-- what the browser says the rules are.
--
-- A parcel in two plans returns BOTH, each marked with whether it is that plan's governing
-- zone. Which plan wins where authorities overlap is an open question and is not guessed.
-- A decision of null means "not decided" (or the plan has no such land use), never "allowed".

BEGIN;

ALTER TABLE development_applications
  ADD COLUMN IF NOT EXISTS plan_instrument_id uuid REFERENCES plan_instrument (id),
  ADD COLUMN IF NOT EXISTS rules_snapshot     jsonb,
  ADD COLUMN IF NOT EXISTS snapshot_at        timestamptz;

CREATE OR REPLACE FUNCTION rule_snapshot(p_layer text, p_id text, p_use text) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'computed_at',   NOW(),
    'parcel',        jsonb_build_object('layer', p_layer, 'id', p_id),
    'land_use_code', p_use,
    'unzoned',       NOT EXISTS (SELECT 1 FROM parcel_zoning_for(p_layer, p_id)),
    'results', COALESCE((
      SELECT jsonb_agg(row_json ORDER BY governing DESC, share DESC NULLS LAST, plan_title, zone_id)
        FROM (
          SELECT pz.zone_id, pz.is_governing AS governing, pz.share_pct AS share, i.title AS plan_title,
                 jsonb_build_object(
                   'plan',  jsonb_build_object('id', i.id, 'title', i.title, 'version', i.version,
                                               'status', i.status, 'authority', a.authority_name,
                                               'gazette_ref', i.gazette_ref),
                   'zone',  jsonb_build_object('id', pz.zone_id, 'name', pz.zone_name, 'type_code', t.code),
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
$$ LANGUAGE sql STABLE;

-- A stored snapshot is never rewritten.
CREATE OR REPLACE FUNCTION development_applications_keep_snapshot() RETURNS trigger AS $$
BEGIN
  IF OLD.rules_snapshot IS NOT NULL AND (NEW.rules_snapshot IS DISTINCT FROM OLD.rules_snapshot
                                          OR NEW.plan_instrument_id IS DISTINCT FROM OLD.plan_instrument_id
                                          OR NEW.snapshot_at IS DISTINCT FROM OLD.snapshot_at) THEN
    RAISE EXCEPTION 'the rules snapshot of an application cannot be changed once it is stored'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_development_applications_keep_snapshot ON development_applications;
CREATE TRIGGER trg_development_applications_keep_snapshot
  BEFORE UPDATE ON development_applications
  FOR EACH ROW EXECUTE FUNCTION development_applications_keep_snapshot();

COMMIT;
