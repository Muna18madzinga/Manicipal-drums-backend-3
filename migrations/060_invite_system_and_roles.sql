-- Migration 060: Invite system & role expansion
-- Adds planner/viewer roles, invite table, missing user columns

-- 1. Drop the old role CHECK constraint and re-add with new values
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('public', 'registered', 'admin', 'planner', 'viewer'));

-- 2. Add full_name column (some code uses full_name instead of name)
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
-- Backfill full_name from name for existing rows
UPDATE users SET full_name = name WHERE full_name IS NULL;

-- 3. Add last_login_at (auth.js uses last_login_at, schema has last_login)
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;
UPDATE users SET last_login_at = last_login WHERE last_login_at IS NULL;

-- 4. Add job_title and department columns for employee profiles
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(255);

-- 5. Add phone column
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);

-- 6. Add status column (some queries use status = 'active')
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'
  CHECK (status IN ('active', 'suspended', 'pending'));

-- 7. Invites table
CREATE TABLE IF NOT EXISTS invites (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token       VARCHAR(255) UNIQUE NOT NULL,
  email       VARCHAR(255) NOT NULL,
  role        VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'planner', 'viewer')),
  job_title   VARCHAR(255),
  department  VARCHAR(255),
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  used        BOOLEAN DEFAULT false,
  used_at     TIMESTAMP WITH TIME ZONE,
  expires_at  TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '7 days'),
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invites_token   ON invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_email   ON invites(email);
CREATE INDEX IF NOT EXISTS idx_invites_used    ON invites(used);
CREATE INDEX IF NOT EXISTS idx_invites_expires ON invites(expires_at);

-- 8. Ensure admin user exists with the correct role
INSERT INTO users (email, password_hash, name, full_name, role, status, active, organization)
VALUES (
  'admin@vungu-rdc.org',
  'hashed_admin1234',
  'System Administrator',
  'System Administrator',
  'admin',
  'active',
  true,
  'Vungu RDC'
)
ON CONFLICT (email) DO UPDATE SET
  role   = 'admin',
  status = 'active',
  active = true;
