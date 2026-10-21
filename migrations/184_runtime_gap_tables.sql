-- Local gap fill: tables and columns the running app expects after a thin restore.
-- Idempotent. Safe to re-apply on localhost.

ALTER TABLE public.local_authorities ADD COLUMN IF NOT EXISTS code text;
UPDATE public.local_authorities
   SET code = 'VUNGU'
 WHERE authority_name ILIKE '%vungu%'
   AND (code IS NULL OR btrim(code) = '');
CREATE UNIQUE INDEX IF NOT EXISTS local_authorities_code_key
  ON public.local_authorities (code) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.admin_audit_event (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  actor_email   varchar(255),
  actor_role    varchar(40),
  event         varchar(48) NOT NULL,
  severity      varchar(12) NOT NULL DEFAULT 'low'
                CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  method        varchar(8),
  path          text,
  status        smallint,
  duration_ms   integer,
  entity_type   varchar(48),
  entity_id     varchar(64),
  ip            inet,
  user_agent    text,
  details       jsonb
);

CREATE TABLE IF NOT EXISTS public.admin_login_attempt (
  id           bigserial PRIMARY KEY,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  email        varchar(255) NOT NULL,
  user_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ip           inet,
  user_agent   text,
  succeeded    boolean NOT NULL,
  reason       varchar(40)
               CHECK (reason IS NULL OR reason IN (
                 'no_such_user', 'bad_password', 'suspended', 'deleted',
                 'locked_out', 'mfa_failed', 'ip_blocked'
               ))
);

CREATE TABLE IF NOT EXISTS public.admin_ip_block (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cidr        cidr NOT NULL UNIQUE,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  expires_at  timestamptz,
  released_at timestamptz,
  released_by uuid REFERENCES public.users(id) ON DELETE SET NULL
);

ALTER TABLE public.admin_audit_event ADD COLUMN IF NOT EXISTS details jsonb;

CREATE SCHEMA IF NOT EXISTS integration;
CREATE TABLE IF NOT EXISTS integration.reconciliation_item (
  id               bigserial PRIMARY KEY,
  kind             varchar(40) NOT NULL CHECK (kind IN (
                     'structure_no_account', 'account_no_parcel', 'account_on_retired_parcel',
                     'duplicate_stand_no', 'area_mismatch', 'asset_no_erp_number')),
  ref_key          text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  assigned_to      text,
  resolution_note  text,
  resolved_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_open
  ON integration.reconciliation_item (kind, ref_key) WHERE status = 'open';

ALTER TABLE council_ops.service_desk_ticket
  ADD COLUMN IF NOT EXISTS authority_id integer REFERENCES public.local_authorities(id);
UPDATE council_ops.service_desk_ticket
   SET authority_id = (SELECT id FROM public.local_authorities WHERE code = 'VUNGU' LIMIT 1)
 WHERE authority_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.admin_audit_event, public.admin_login_attempt, public.admin_ip_block, public.page_view
      TO vungu_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vungu_runtime;
    GRANT USAGE ON SCHEMA integration TO vungu_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON integration.reconciliation_item TO vungu_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA integration TO vungu_runtime;
    GRANT SELECT ON public.local_authorities TO vungu_runtime;
  END IF;
END $$;
