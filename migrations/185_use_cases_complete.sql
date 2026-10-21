-- Use cases that staff and citizens could not finish:
-- C8 public objection is an API on an existing table.
-- C14 / F4–F6 section 73 notice, service, appeal and gated action.
-- X6 recorded hand-off of a section 109 certificate to the Deeds Registry.
-- X7 cancellation of a section 116 notice.
-- X9 transfer lineage.
-- G10 Minister's approval before an estate stand is allocated.

BEGIN;

-- ── X6 deeds hand-off on an issued clearance ────────────────────────
ALTER TABLE council_ops.rates_clearance
  ADD COLUMN IF NOT EXISTS deeds_handoff_at timestamptz,
  ADD COLUMN IF NOT EXISTS deeds_handoff_ref text,
  ADD COLUMN IF NOT EXISTS deeds_handed_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- ── X4 courier dispatch is explicit ─────────────────────────────────
ALTER TABLE council_ops.sg_plan_submission
  ADD COLUMN IF NOT EXISTS dispatch_method text NOT NULL DEFAULT 'courier';

-- ── X7 a notice can be cancelled ────────────────────────────────────
ALTER TABLE council_ops.deeds_transfer_notice DROP CONSTRAINT IF EXISTS deeds_transfer_notice_status_check;
ALTER TABLE council_ops.deeds_transfer_notice
  ADD CONSTRAINT deeds_transfer_notice_status_check
  CHECK (status IN ('received', 'linked', 'actioned', 'ignored', 'cancelled'));

ALTER TABLE council_ops.deeds_transfer_notice
  ADD COLUMN IF NOT EXISTS child_stand_number text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

-- ── X9 identity change, including a transfer ────────────────────────
ALTER TABLE spatial_planning.parcel_lineage DROP CONSTRAINT IF EXISTS parcel_lineage_action_check;
ALTER TABLE spatial_planning.parcel_lineage
  ADD CONSTRAINT parcel_lineage_action_check
  CHECK (action IN ('subdivision', 'consolidation', 'transfer'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'land' AND table_name = 'parcel_lineage'
  ) THEN
    ALTER TABLE land.parcel_lineage DROP CONSTRAINT IF EXISTS parcel_lineage_event_check;
    ALTER TABLE land.parcel_lineage
      ADD CONSTRAINT parcel_lineage_event_check
      CHECK (event IN ('subdivision', 'consolidation', 'transfer'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS council_ops.parcel_identity_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_stand text NOT NULL,
  child_stand text NOT NULL,
  action text NOT NULL CHECK (action IN ('subdivision', 'consolidation', 'transfer')),
  deeds_notice_id uuid REFERENCES council_ops.deeds_transfer_notice(id) ON DELETE SET NULL,
  note text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_stand, child_stand, action)
);

-- ── G10 estate development needs the Minister (RDC Act s86) ─────────
CREATE TABLE IF NOT EXISTS council_ops.estate_development_approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  area_scope text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'advertised', 'awaiting_minister', 'approved', 'refused')),
  advertised_at date,
  objections_close_at date,
  minister_ref text,
  minister_approved_at date,
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.stands
  ADD COLUMN IF NOT EXISTS requires_minister_approval boolean NOT NULL DEFAULT false;

-- ── F4–F6 / C14 section 73 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS council_ops.title_notice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stand_number text NOT NULL,
  condition_text text NOT NULL,
  condition_class text NOT NULL
    CHECK (condition_class IN ('use_restriction', 'building_requirements', 'scheme_or_plan', 'other')),
  proposed_action text NOT NULL
    CHECK (proposed_action IN ('demolish', 'prohibit_use', 'execute_work')),
  grounds text NOT NULL,
  wilful boolean NOT NULL DEFAULT false,
  work_description text,
  no_occupier_reason text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'issued', 'withdrawn')),
  issued_at timestamptz,
  issued_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  withdraw_reason text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS council_ops.title_notice_service (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id uuid NOT NULL REFERENCES council_ops.title_notice(id) ON DELETE CASCADE,
  party text NOT NULL CHECK (party IN ('owner', 'occupier', 'both')),
  party_name text NOT NULL,
  party_email text,
  served_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('personal', 'registered_post', 'affixed')),
  proof text,
  served_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS council_ops.title_notice_appeal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id uuid NOT NULL REFERENCES council_ops.title_notice(id) ON DELETE CASCADE,
  lodged_at date NOT NULL,
  outcome text CHECK (outcome IS NULL OR outcome IN ('dismissed', 'allowed', 'withdrawn', 'abandoned')),
  decided_at date,
  court_ref text,
  notes text,
  recorded_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS council_ops.title_notice_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id uuid NOT NULL REFERENCES council_ops.title_notice(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('demolish', 'prohibit_use', 'execute_work')),
  taken_at date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  taken_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION council_ops.title_notice_stage(p_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  n council_ops.title_notice%ROWTYPE;
  owner_served boolean;
  occupier_served boolean;
  last_service date;
  appeal_open boolean;
  appeal_outcome text;
  acted boolean;
BEGIN
  SELECT * INTO n FROM council_ops.title_notice WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF n.status = 'withdrawn' THEN RETURN 'withdrawn'; END IF;
  IF n.status <> 'issued' THEN RETURN 'draft'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM council_ops.title_notice_service s
     WHERE s.notice_id = p_id AND s.party IN ('owner', 'both')
  ) INTO owner_served;
  SELECT EXISTS (
    SELECT 1 FROM council_ops.title_notice_service s
     WHERE s.notice_id = p_id AND s.party IN ('occupier', 'both')
  ) INTO occupier_served;

  IF NOT owner_served OR (NOT occupier_served AND n.no_occupier_reason IS NULL) THEN
    RETURN 'awaiting_service';
  END IF;

  SELECT EXISTS (SELECT 1 FROM council_ops.title_notice_action a WHERE a.notice_id = p_id) INTO acted;
  IF acted THEN RETURN 'actioned'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM council_ops.title_notice_appeal a
     WHERE a.notice_id = p_id AND a.outcome IS NULL
  ) INTO appeal_open;
  IF appeal_open THEN RETURN 'appeal_pending'; END IF;

  SELECT a.outcome INTO appeal_outcome
    FROM council_ops.title_notice_appeal a
   WHERE a.notice_id = p_id AND a.outcome IS NOT NULL
   ORDER BY a.decided_at DESC NULLS LAST, a.created_at DESC
   LIMIT 1;
  IF appeal_outcome = 'allowed' THEN RETURN 'appeal_allowed'; END IF;

  IF n.condition_class = 'other' THEN
    RETURN 'may_act';
  END IF;

  SELECT MAX(s.served_on) INTO last_service
    FROM council_ops.title_notice_service s WHERE s.notice_id = p_id;
  IF last_service IS NULL OR CURRENT_DATE <= (last_service + 28) THEN
    RETURN 'window_open';
  END IF;
  RETURN 'may_act';
END $$;

CREATE OR REPLACE FUNCTION council_ops.title_notice_action_gate()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  proposed text;
  stage text;
BEGIN
  SELECT proposed_action INTO proposed FROM council_ops.title_notice WHERE id = NEW.notice_id;
  stage := council_ops.title_notice_stage(NEW.notice_id);
  IF stage IS DISTINCT FROM 'may_act' THEN
    RAISE EXCEPTION 'title_notice_action_refused: stage is %', stage USING ERRCODE = '23514';
  END IF;
  IF NEW.action IS DISTINCT FROM proposed THEN
    RAISE EXCEPTION 'title_notice_action_refused: action must match the notice' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_title_notice_action_gate ON council_ops.title_notice_action;
CREATE TRIGGER trg_title_notice_action_gate
  BEFORE INSERT ON council_ops.title_notice_action
  FOR EACH ROW EXECUTE FUNCTION council_ops.title_notice_action_gate();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_runtime') THEN
    GRANT USAGE ON SCHEMA council_ops TO vungu_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA council_ops TO vungu_runtime;
    GRANT EXECUTE ON FUNCTION council_ops.title_notice_stage(uuid) TO vungu_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    GRANT USAGE ON SCHEMA council_ops TO vungu_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA council_ops TO vungu_app;
    GRANT EXECUTE ON FUNCTION council_ops.title_notice_stage(uuid) TO vungu_app;
  END IF;
END $$;

COMMIT;
