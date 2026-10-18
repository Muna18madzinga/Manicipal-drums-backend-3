-- 181: Statutory registers for RDC Act gaps (C15/X6, P10, F7, G11, A5).
-- Safe to re-run. Tables live in council_ops alongside existing asset registers.

CREATE SCHEMA IF NOT EXISTS council_ops;

-- A5: by-laws, model-building chapters, tariffs (ss76, 88–94)
CREATE TABLE IF NOT EXISTS council_ops.bylaw_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('bylaw', 'model_chapter', 'tariff', 'resolution')),
  title text NOT NULL,
  reference_no text,
  chapter_code text,
  area_scope text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'exhibited', 'passed', 'awaiting_minister', 'in_force', 'repealed')),
  exhibited_at date,
  objections_close_at date,
  passed_at date,
  minister_approved_at date,
  in_force_from date,
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- P10: annual district development plan (s74) — approve before 1 August
CREATE TABLE IF NOT EXISTS council_ops.annual_district_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_year int NOT NULL CHECK (plan_year BETWEEN 2000 AND 2100),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'committee', 'council_approved', 'submitted_provincial', 'superseded')),
  drafted_by_committee_at date,
  council_approved_at date,
  submitted_provincial_at date,
  deadline_1_august date GENERATED ALWAYS AS (
    make_date(plan_year, 8, 1)
  ) STORED,
  summary text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_year)
);

-- G11: compulsory acquisition (s78) — Minister consent required
CREATE TABLE IF NOT EXISTS council_ops.compulsory_acquisition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stand_number text,
  parcel_ref text,
  purpose text NOT NULL CHECK (purpose IN ('public_health', 'planning', 'public_benefit', 'other')),
  purpose_detail text,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'awaiting_minister', 'minister_consented', 'gazetted', 'completed', 'withdrawn')),
  minister_consent_ref text,
  minister_consented_at date,
  gazette_ref text,
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- C15 / X6: section 109 rates clearance before transfer
CREATE TABLE IF NOT EXISTS council_ops.rates_clearance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stand_number text NOT NULL,
  applicant_name text NOT NULL,
  applicant_email text,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'under_review', 'cleared', 'refused', 'expired')),
  charges_years_checked int NOT NULL DEFAULT 5,
  charges_outstanding_usd numeric(14,2),
  erp_status_band text,
  certificate_no text UNIQUE,
  issued_at timestamptz,
  valid_until date,
  refusal_reason text,
  requested_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- F7: recover expenses of action under s73 / s151
CREATE TABLE IF NOT EXISTS council_ops.expense_recovery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_notice_id uuid,
  stand_number text,
  description text NOT NULL,
  amount_usd numeric(14,2) NOT NULL CHECK (amount_usd >= 0),
  status text NOT NULL DEFAULT 'assessed'
    CHECK (status IN ('assessed', 'invoiced', 'part_paid', 'paid', 'written_off')),
  assessed_at date NOT NULL DEFAULT CURRENT_DATE,
  recovered_usd numeric(14,2) NOT NULL DEFAULT 0 CHECK (recovered_usd >= 0),
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bylaw_register_status ON council_ops.bylaw_register (status);
CREATE INDEX IF NOT EXISTS idx_rates_clearance_stand ON council_ops.rates_clearance (stand_number);
CREATE INDEX IF NOT EXISTS idx_rates_clearance_status ON council_ops.rates_clearance (status);
CREATE INDEX IF NOT EXISTS idx_acquisition_status ON council_ops.compulsory_acquisition (status);
CREATE INDEX IF NOT EXISTS idx_expense_recovery_status ON council_ops.expense_recovery (status);

GRANT USAGE ON SCHEMA council_ops TO vungu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA council_ops TO vungu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA council_ops GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vungu_app;
