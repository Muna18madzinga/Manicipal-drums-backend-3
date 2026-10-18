-- 182: Custodian boundary scaffolds — X4 (outbound to Surveyor-General) and
-- X7 (inbound Deeds Registry sale / subdivision notice). These are council-side
-- registers only until those offices expose an interface.

BEGIN;

CREATE TABLE IF NOT EXISTS council_ops.sg_plan_submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stand_number text,
  parcel_ref text,
  plan_type text NOT NULL CHECK (plan_type IN ('general_plan', 'diagram', 'layout', 'other')),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready_to_send', 'sent', 'acknowledged', 'approved', 'returned', 'withdrawn')),
  sg_reference text,
  sent_at timestamptz,
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS council_ops.deeds_transfer_notice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stand_number text,
  deed_number text,
  notice_kind text NOT NULL CHECK (notice_kind IN ('sale', 'subdivision_lease', 'cancellation', 'other')),
  transferor_name text,
  transferee_name text,
  noticed_at date,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'linked', 'actioned', 'ignored')),
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'csv_import', 'api')),
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sg_plan_status ON council_ops.sg_plan_submission (status);
CREATE INDEX IF NOT EXISTS idx_deeds_notice_stand ON council_ops.deeds_transfer_notice (stand_number);

GRANT SELECT, INSERT, UPDATE, DELETE ON council_ops.sg_plan_submission TO vungu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON council_ops.deeds_transfer_notice TO vungu_app;

COMMIT;
