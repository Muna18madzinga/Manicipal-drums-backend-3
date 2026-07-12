-- 105_stand_allocation.sql
-- Stage 4 (H3): Stand Number Allocation authority.
--
-- Before this, allocating a stand was a lossy single-column stamp on stands
-- (allocated_to / allocated_at): no reference number, no authorising officer,
-- no conditions, and reallocation erased the prior record. This adds an
-- auditable allocation register with history + soft delete, and links a stand
-- to its layout/statutory plan so numbering can later be grouped per layout.
--
-- Extends the existing `stands` table (migration 062) — no parallel table.
-- Idempotent: CREATE / ADD COLUMN ... IF NOT EXISTS.

-- Link a stand to the layout/statutory plan it belongs to (nullable: existing
-- stands predate any plan link). FK is soft — statutory_plan lives in its own
-- migration chain and may be absent in bootstrapped DBs, so no REFERENCES.
ALTER TABLE stands
  ADD COLUMN IF NOT EXISTS statutory_plan_id UUID;

CREATE TABLE IF NOT EXISTS stand_allocation (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stand_id       UUID NOT NULL REFERENCES stands(id) ON DELETE CASCADE,
  reference_no   VARCHAR(32) UNIQUE NOT NULL,          -- VRDC-STD-YYYY-NNNNNN
  allocated_to   UUID REFERENCES users(id) ON DELETE SET NULL,
  allottee_name  VARCHAR(160),                          -- denormalised for the certificate
  purpose        VARCHAR(40) NOT NULL DEFAULT 'residential'
                   CHECK (purpose IN ('residential', 'commercial', 'industrial',
                                      'institutional', 'agricultural', 'other')),
  conditions     TEXT,
  authorized_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  allocated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  status         VARCHAR(16) NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'revoked')),
  revoked_at     TIMESTAMP WITH TIME ZONE,
  revoked_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason  TEXT,
  -- Soft delete (Stage 1 rule): allocation records are never hard-deleted.
  deleted_at     TIMESTAMP WITH TIME ZONE,
  deleted_by     UUID,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stand_allocation_stand  ON stand_allocation(stand_id);
CREATE INDEX IF NOT EXISTS idx_stand_allocation_status ON stand_allocation(status);

-- At most one ACTIVE, non-deleted allocation per stand — the DB, not app code,
-- guarantees a stand is never double-allocated even under a race.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stand_allocation_active
  ON stand_allocation(stand_id)
  WHERE status = 'active' AND deleted_at IS NULL;

COMMENT ON TABLE stand_allocation IS
  'Auditable stand-number allocation register (H3): who received which stand, under what reference/conditions, authorised by whom. History preserved via status=revoked + soft delete.';
