-- 125_service_desk_tickets.sql
-- Citizen / counter intake for services that do not yet have a dedicated register
-- (rates enquiry, trading licence request, nuisance, road works, social welfare,
-- survey request). Tickets are intake only — they do not issue licences or bills.

BEGIN;

CREATE SCHEMA IF NOT EXISTS council_ops;

CREATE TABLE IF NOT EXISTS council_ops.service_desk_ticket (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id          TEXT NOT NULL,
  department          TEXT NOT NULL,
  title               TEXT NOT NULL,
  requester_user_id   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  requester_name      TEXT,
  contact_phone       TEXT,
  contact_email       TEXT,
  location_text       TEXT,
  details             TEXT,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'in_progress', 'closed', 'referred')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_desk_ticket_service_idx
  ON council_ops.service_desk_ticket (service_id);

CREATE INDEX IF NOT EXISTS service_desk_ticket_status_idx
  ON council_ops.service_desk_ticket (status);

CREATE INDEX IF NOT EXISTS service_desk_ticket_requester_idx
  ON council_ops.service_desk_ticket (requester_user_id);

CREATE INDEX IF NOT EXISTS service_desk_ticket_created_idx
  ON council_ops.service_desk_ticket (created_at DESC);

COMMIT;
