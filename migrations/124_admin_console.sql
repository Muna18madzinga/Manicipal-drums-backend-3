-- 124_admin_console.sql
-- ─────────────────────────────────────────────────────────────────────────
-- The IT Admin console's own record: audit trail, sign-in security, system
-- settings, service announcements and the council org structure.
--
-- WHY THIS EXISTS RATHER THAN 041_security_audit.sql
-- Migration 041 declared `security_audit_log`, and src/middleware/auditLog.js
-- has been writing to it on every mutating request ever since. The table has
-- never existed in any Vungu database, for two reasons that are both in the
-- 041 file:
--
--   1. `security_event_types` carries CHECK (severity IN (...)) on a column
--      actually named `default_severity`, so the whole script aborts on the
--      fourth CREATE TABLE and nothing after it is applied.
--   2. Every user_id is `INTEGER REFERENCES users(id)`, and users.id is uuid.
--      Even with (1) fixed, the FK could not be created.
--
-- The effect was silent: the plugin catches its own INSERT failure and logs a
-- warning, so the council has run with NO audit trail while appearing to have
-- one. For a planning authority whose permit and enforcement decisions must be
-- traceable to an officer, that is the single most serious gap in the system.
-- 041 is superseded, not repaired — it is not in migrate-render.js's allowlist
-- and re-running it would still abort.
--
-- NAMING
-- Everything here is prefixed `admin_` and lives in `public`, so an operator
-- reading \dt can see the console's own tables as one group and tell them from
-- the planning record in spatial_planning.
--
-- Idempotent. Apply individually (docs/db-rebuild-2026-09-21.md):
--   node scripts/apply-local-migration.js migrations/124_admin_console.sql
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. AUDIT TRAIL
-- ═══════════════════════════════════════════════════════════════════════
-- One row per mutating request by an identified user. Written from an
-- onResponse hook, so it records what the server actually did (status code
-- included) rather than what was asked for.
--
-- actor_email and actor_role are DENORMALISED on purpose. The FK is ON DELETE
-- SET NULL so deleting a user never destroys the trail, but a trail that then
-- says "someone" is useless in a disciplinary or audit context. The email as
-- it stood at the time is the evidence; the FK is only the live link.

CREATE TABLE IF NOT EXISTS public.admin_audit_event (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz  NOT NULL DEFAULT now(),

  actor_id      uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  actor_email   varchar(255),
  actor_role    varchar(40),

  -- What happened, in the console's vocabulary (USER_MGMT, PERMIT, PAYMENT…).
  event         varchar(48)  NOT NULL,
  severity      varchar(12)  NOT NULL DEFAULT 'low'
                CHECK (severity IN ('low', 'medium', 'high', 'critical')),

  -- How it happened, in HTTP terms.
  method        varchar(8),
  path          text,
  status        smallint,
  duration_ms   integer,

  -- What it happened TO, when the route makes that knowable. Both nullable:
  -- a login has an actor and no subject.
  entity_type   varchar(48),
  entity_id     varchar(64),

  ip            inet,
  user_agent    text,
  details       jsonb        NOT NULL DEFAULT '{}'::jsonb
);

-- The console's default view is "newest first, last 7 days", and every filter
-- narrows from there — so occurred_at leads every index.
CREATE INDEX IF NOT EXISTS idx_admin_audit_at       ON public.admin_audit_event (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor    ON public.admin_audit_event (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_event    ON public.admin_audit_event (event, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_severity ON public.admin_audit_event (severity, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_entity   ON public.admin_audit_event (entity_type, entity_id);

COMMENT ON TABLE  public.admin_audit_event IS
  'Append-only audit trail: one row per mutating authenticated request. Supersedes the never-created security_audit_log of migration 041.';
COMMENT ON COLUMN public.admin_audit_event.actor_email IS
  'The actor''s email as it stood at the time. Kept when the user row is deleted, because the FK is nullable and a nameless trail proves nothing.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. SIGN-IN SECURITY
-- ═══════════════════════════════════════════════════════════════════════
-- Every sign-in attempt, successful or not. This is the raw material for the
-- lockout rule AND for the console's "who is trying to get in" view, which is
-- the question a council IT admin is actually asked after an incident.
--
-- email is stored rather than user_id because the interesting attempts are the
-- ones against addresses that do not exist.

CREATE TABLE IF NOT EXISTS public.admin_login_attempt (
  id          bigserial PRIMARY KEY,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  email       varchar(255) NOT NULL,
  user_id     uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  ip          inet,
  user_agent  text,
  succeeded   boolean      NOT NULL,
  -- Why it failed, in terms the admin can act on. NULL when it succeeded.
  reason      varchar(40)
              CHECK (reason IS NULL OR reason IN (
                'no_such_user', 'bad_password', 'suspended', 'deleted',
                'locked_out', 'mfa_failed', 'ip_blocked'
              ))
);

-- lower(email) so the lockout count cannot be dodged by changing case.
CREATE INDEX IF NOT EXISTS idx_login_attempt_email ON public.admin_login_attempt (lower(email), attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempt_at    ON public.admin_login_attempt (attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempt_ip    ON public.admin_login_attempt (ip, attempted_at DESC);

COMMENT ON TABLE public.admin_login_attempt IS
  'Every sign-in attempt. Drives the lockout rule (security.max_failed_attempts) and the console''s sign-in security view.';

-- Blocked addresses. `expires_at IS NULL` is a permanent block.
CREATE TABLE IF NOT EXISTS public.admin_ip_block (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cidr        cidr        NOT NULL UNIQUE,
  reason      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  expires_at  timestamptz,
  -- Released rather than deleted: why an address was blocked, and who lifted
  -- it, is part of the incident record.
  released_at timestamptz,
  released_by uuid        REFERENCES public.users(id) ON DELETE SET NULL
);

-- cidr, not inet, so a whole range can be blocked in one row; `>>=` containment
-- then answers "is this request's address blocked" with one index scan.
CREATE INDEX IF NOT EXISTS idx_ip_block_live ON public.admin_ip_block (cidr)
  WHERE released_at IS NULL;

COMMENT ON COLUMN public.admin_ip_block.cidr IS
  'A single address is stored as a /32 (or /128). Containment `cidr >>= $ip` covers both cases.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. SYSTEM SETTINGS
-- ═══════════════════════════════════════════════════════════════════════
-- Council-owned configuration, typed so the console can render the right
-- control and the server can coerce without guessing.
--
-- `enforced` is the honest bit. A setting the server actually reads and acts
-- on is enforced=true; one that is only recorded (contact details on a
-- letterhead, say) is enforced=false and the console labels it "record only",
-- so nobody believes they have switched something off when they have not.

CREATE TABLE IF NOT EXISTS public.admin_setting (
  key         varchar(80)  PRIMARY KEY,
  value       text,
  value_type  varchar(12)  NOT NULL DEFAULT 'string'
              CHECK (value_type IN ('string', 'number', 'boolean', 'json', 'text')),
  category    varchar(40)  NOT NULL DEFAULT 'general',
  label       varchar(160) NOT NULL,
  description text,
  -- The permitted range/choices, for the console to render and the server to
  -- validate against. {"min":6,"max":128} or {"choices":["a","b"]}.
  constraints jsonb        NOT NULL DEFAULT '{}'::jsonb,
  enforced    boolean      NOT NULL DEFAULT false,
  -- A setting whose value would be a secret is never returned in full.
  secret      boolean      NOT NULL DEFAULT false,
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  updated_by  uuid         REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_setting_category ON public.admin_setting (category, key);

COMMENT ON COLUMN public.admin_setting.enforced IS
  'true when the server reads this key and changes behaviour. false = recorded only. The console shows the difference so an admin is never misled about what a switch does.';

-- Seed. ON CONFLICT DO UPDATE on the METADATA only — never on `value`, or
-- re-applying the migration would silently reset the council's choices.
INSERT INTO public.admin_setting (key, value, value_type, category, label, description, constraints, enforced) VALUES
  ('security.password_min_length', '8', 'number', 'security',
   'Minimum password length',
   'Rejected below this length when a password is set or reset.',
   '{"min":8,"max":128}', true),

  ('security.max_failed_attempts', '5', 'number', 'security',
   'Failed sign-ins before lockout',
   'Consecutive failures against one address before it is locked out. 0 disables lockout.',
   '{"min":0,"max":50}', true),

  ('security.lockout_minutes', '15', 'number', 'security',
   'Lockout duration (minutes)',
   'How long an account stays locked after the limit above is reached.',
   '{"min":1,"max":1440}', true),

  ('security.session_max_hours', '12', 'number', 'security',
   'Session lifetime (hours)',
   'How long a sign-in lasts before the officer must authenticate again.',
   '{"min":1,"max":168}', true),

  -- RECORD ONLY. Enforcing this needs a "pending enrolment" session: refusing
  -- a session outright would lock out precisely the officers who have to sign
  -- in to enrol. Until that exists, this is the council's recorded policy and
  -- the console says so rather than implying an unenrolled planner is barred.
  -- Officers can already enrol voluntarily via /auth/mfa/setup.
  ('security.mfa_required_roles', '[]', 'json', 'security',
   'Roles that should use two-factor authentication',
   'The council''s policy. Enrolment is currently voluntary — officers turn it on from their own profile — and is not yet refused to anyone who has not.',
   '{"choices":["admin","planner","eo","env_officer","building_inspector","gis_officer","planning_clerk","surveyor"]}', false),

  ('audit.retention_days', '365', 'number', 'security',
   'Audit trail retention (days)',
   'Events older than this may be pruned. Critical events are never pruned.',
   '{"min":30,"max":3650}', true),

  ('system.maintenance_mode', 'false', 'boolean', 'system',
   'Maintenance mode',
   'Blocks every change to council records except by IT Admin. Reading stays available.',
   '{}', true),

  ('system.maintenance_message', 'Vungu RDC planning portal is under maintenance. Please try again shortly.', 'text', 'system',
   'Maintenance message',
   'Shown to staff and citizens while maintenance mode is on.',
   '{"max":400}', true),

  ('council.name', 'Vungu Rural District Council', 'string', 'council',
   'Council name', 'Appears on generated documents and the public portal.', '{"max":160}', false),
  ('council.email', 'info@vungurdc.gov.zw', 'string', 'council',
   'Council email', 'Contact address on notices and correspondence.', '{"max":160}', false),
  ('council.phone', '', 'string', 'council',
   'Council telephone', 'Contact number on notices and correspondence.', '{"max":60}', false),
  ('council.address', '', 'text', 'council',
   'Council postal address', 'Address block on the council letterhead.', '{"max":400}', false),

  -- Read by src/workers/emailWorker.js on every poll. Note the asymmetry:
  -- email_enabled is enforced because the email worker exists and honours it;
  -- sms_enabled is record-only because no SMS transport exists at all, and a
  -- switch that claims to stop something that never starts is the exact lie
  -- the `enforced` flag is here to prevent.
  ('notifications.email_enabled', 'true', 'boolean', 'notifications',
   'Send email notifications',
   'When off, messages are still queued and held as pending — nothing is lost, and the queue resumes when this is switched back on.',
   '{}', true),
  ('notifications.sms_enabled', 'false', 'boolean', 'notifications',
   'Send SMS notifications',
   'The council''s intent. There is no SMS transport in this deployment, so SMS messages are queued and never dispatched regardless of this setting.',
   '{}', false),
  ('notifications.outbox_max_attempts', '5', 'number', 'notifications',
   'Delivery attempts before giving up',
   'How many times the email worker retries a message before marking it failed and leaving it for a manual retry.',
   '{"min":1,"max":20}', true)
ON CONFLICT (key) DO UPDATE SET
  value_type  = EXCLUDED.value_type,
  category    = EXCLUDED.category,
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  constraints = EXCLUDED.constraints,
  enforced    = EXCLUDED.enforced;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. SERVICE ANNOUNCEMENTS
-- ═══════════════════════════════════════════════════════════════════════
-- "The portal is down on Saturday for the migration." The IT Admin's only way
-- to say something to every user without emailing them, and the reason the
-- council's staff currently phone the IT office instead.

CREATE TABLE IF NOT EXISTS public.admin_announcement (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       varchar(160) NOT NULL,
  body        text         NOT NULL,
  level       varchar(12)  NOT NULL DEFAULT 'info'
              CHECK (level IN ('info', 'warning', 'critical')),
  -- Who sees it. 'all' includes citizens on the public portal; 'staff' does not.
  audience    varchar(12)  NOT NULL DEFAULT 'staff'
              CHECK (audience IN ('all', 'staff', 'admin')),
  starts_at   timestamptz  NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  created_by  uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  -- Withdrawn rather than deleted: an announcement that was live is a fact.
  withdrawn_at timestamptz,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_announcement_live ON public.admin_announcement (starts_at DESC)
  WHERE withdrawn_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. ORGANISATION STRUCTURE
-- ═══════════════════════════════════════════════════════════════════════
-- The council's establishment: which posts exist, who reports to whom, who
-- holds each one and which system role the post carries.
--
-- A POST IS NOT A USER. The Vungu establishment has three vacant posts today
-- (GIS Officer, Planning Clerk, Surveyor); a structure keyed on users could
-- not represent them, which is why the chart in AdminView was hardcoded. The
-- holder is nullable and a vacancy is simply holder_id IS NULL.

CREATE TABLE IF NOT EXISTS public.admin_org_position (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        varchar(160) NOT NULL,
  department   varchar(120),
  -- The system role this post carries. Advisory: it is what the post SHOULD
  -- have, and the console flags a holder whose account disagrees.
  system_role  varchar(40),
  holder_id    uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  reports_to   uuid         REFERENCES public.admin_org_position(id) ON DELETE SET NULL,
  -- Left-to-right order among siblings; ties fall back to title.
  sort_order   integer      NOT NULL DEFAULT 0,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  CHECK (reports_to IS NULL OR reports_to <> id)
);

CREATE INDEX IF NOT EXISTS idx_org_position_parent ON public.admin_org_position (reports_to, sort_order);
CREATE INDEX IF NOT EXISTS idx_org_position_holder ON public.admin_org_position (holder_id);

COMMENT ON TABLE public.admin_org_position IS
  'Establishment posts, not people. holder_id IS NULL is a vacancy — the case the hardcoded org chart in AdminView.vue could not represent.';

-- Seed the Planning & Environment establishment as AdminView had it hardcoded,
-- so the chart survives the move to real data. Holders are matched by email
-- where an account exists and left vacant otherwise — never invented.
-- Guarded on emptiness: re-applying must not duplicate the establishment.
DO $$
DECLARE
  v_ceo uuid;
  v_eo  uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.admin_org_position) THEN
    RETURN;
  END IF;

  INSERT INTO public.admin_org_position (title, department, system_role, sort_order)
  VALUES ('Chief Executive Officer', 'Executive', 'admin', 0)
  RETURNING id INTO v_ceo;

  INSERT INTO public.admin_org_position (title, department, system_role, reports_to, sort_order)
  VALUES ('Executive Officer — Planning & Environment', 'Planning & Environment', 'eo', v_ceo, 0)
  RETURNING id INTO v_eo;

  INSERT INTO public.admin_org_position (title, department, system_role, reports_to, sort_order) VALUES
    ('Town Planning Officer',        'Planning & Environment', 'planner',           v_eo, 0),
    ('Planning Clerk',               'Planning & Environment', 'planning_clerk',    v_eo, 1),
    ('GIS Officer',                  'Planning & Environment', 'gis_officer',       v_eo, 2),
    ('Building Inspector',           'Planning & Environment', 'building_inspector', v_eo, 3),
    ('Environmental Health Officer', 'Planning & Environment', 'env_officer',       v_eo, 4),
    ('Surveyor',                     'Planning & Environment', 'surveyor',          v_eo, 5);
END $$;

-- Fill holders from the staff register where the role matches exactly one
-- active account. Safe to re-run: it only ever fills a vacancy.
UPDATE public.admin_org_position p
   SET holder_id = m.id, updated_at = now()
  FROM (
    -- (array_agg(id))[1] rather than min(id): there is no min() for uuid, and
    -- the HAVING already guarantees there is exactly one row to take.
    SELECT role, (array_agg(id))[1] AS id
      FROM public.users
     WHERE deleted_at IS NULL AND active AND role IS NOT NULL
     GROUP BY role
    HAVING count(*) = 1
  ) m
 WHERE p.holder_id IS NULL AND p.system_role = m.role;

COMMIT;
