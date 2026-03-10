-- Create Vungu RDC Planner User
-- Run this script to create the planner user credentials
-- 
-- RUN WITH:
-- psql -U postgres -d vungu_master_db_v1 -f scripts/create-planner-user.sql
-- OR with password:
-- PGPASSWORD=cairo2025 psql -U postgres -h localhost -p 5432 -d vungu_master_db_v1 -f scripts/create-planner-user.sql

-- Insert the planner user
INSERT INTO users (
  id,
  email,
  name,
  role,
  organization,
  password_hash,
  phone,
  status,
  email_verified,
  active,
  created_at,
  updated_at
) VALUES (
  gen_random_uuid(),
  'planner@vungurdc.gov.zw',
  'Vungu Planner',
  'planner',
  'Vungu Rural District Council',
  -- Password: 'VunguPlanner2025!'
  -- NOTE: In production, use proper bcrypt hashing. This is a placeholder hash.
  'hashed_VunguPlanner2025!',
  '+263 55 2521 500',
  'active',
  true,
  true,
  NOW(),
  NOW()
)
ON CONFLICT (email) DO UPDATE SET
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  organization = EXCLUDED.organization,
  password_hash = EXCLUDED.password_hash,
  updated_at = NOW(),
  active = true;

-- Verify the user was created
SELECT 
  id,
  email,
  name,
  role,
  organization,
  status,
  active,
  created_at
FROM users
WHERE email = 'planner@vungurdc.gov.zw';
