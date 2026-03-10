-- Create users table and planner user
-- Run with: PGPASSWORD=cairo2025 psql -U postgres -h localhost -p 5432 -d vungu_master_db_v1 -f scripts/setup-and-create-planner.sql

-- Create users table if it doesn't exist
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'user',
  organization VARCHAR(255),
  password_hash VARCHAR(255),
  phone VARCHAR(50),
  status VARCHAR(50) DEFAULT 'active',
  email_verified BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_login_at TIMESTAMP
);

-- Add columns if they don't exist (for backwards compatibility)
ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;

-- Create planner user
-- Password: 'VunguPlanner2025!'
-- NOTE: Using plaintext hash placeholder - in production use bcrypt
INSERT INTO users (
  id,
  email,
  full_name,
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
  'Vungu Planner',
  'planner',
  'Vungu Rural District Council',
  'hashed_VunguPlanner2025!',
  '+263 55 2521 500',
  'active',
  true,
  true,
  NOW(),
  NOW()
)
ON CONFLICT (email) DO UPDATE SET
  full_name = EXCLUDED.full_name,
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
  COALESCE(full_name, name) as name,
  role,
  organization,
  status,
  active,
  created_at
FROM users
WHERE email = 'planner@vungurdc.gov.zw';
