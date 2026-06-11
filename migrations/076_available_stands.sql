-- migrations/076_available_stands.sql
-- Lightweight allocation register for stands the council is offering. The
-- citizen Map → Available tab and the planner allocation queue both read
-- from this table; citizens can read but cannot mutate.

CREATE TABLE IF NOT EXISTS spatial_planning.available_stand (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stand_number  VARCHAR(50) UNIQUE NOT NULL,
  suburb_ward   VARCHAR(100),
  area_sqm      NUMERIC,
  zone          VARCHAR(32),
  status        VARCHAR(20) NOT NULL DEFAULT 'available'
                CHECK (status IN ('available', 'reserved', 'allocated')),
  description   TEXT,
  longitude     DOUBLE PRECISION,
  latitude      DOUBLE PRECISION,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_available_stand_status ON spatial_planning.available_stand(status);

-- Seed two synthetic rows the citizen Map can display. Idempotent via
-- ON CONFLICT on the unique stand_number. Coordinates sit inside the
-- gweru_rural_planning_boundary so the map fits/centres them sensibly.
INSERT INTO spatial_planning.available_stand
  (stand_number, suburb_ward, area_sqm, zone, status, description, longitude, latitude)
VALUES
  ('AVL-001', 'Ward 3 — Midlands', 600,  'residential', 'available',
   'Serviced residential plot adjacent to existing low-density layout.',
   29.390, -19.295),
  ('AVL-002', 'Ward 5 — Gweru Rural', 1200, 'commercial', 'available',
   'Commercial corner plot at the junction onto the regional road.',
   29.420, -19.310)
ON CONFLICT (stand_number) DO NOTHING;
