const { Pool } = require('pg')
const bcrypt = require('bcryptjs')

const VALID_ROLES = new Set([
  'public',
  'registered',
  'viewer',
  'admin',
  'planner',
  'eo',
  'env_officer',
  'building_inspector',
  'planning_clerk',
  'surveyor',
  'gis_officer',
])

const DEFAULT_DEMO_USERS = [
  { email: 'demo.admin@vungu.test', name: 'Demo Admin', role: 'admin' },
  { email: 'demo.planner@vungu.test', name: 'Demo Planner', role: 'planner' },
  { email: 'demo.eo@vungu.test', name: 'Demo EO Planner', role: 'eo' },
  { email: 'demo.envoffice@vungu.test', name: 'Demo Environmental Officer', role: 'env_officer' },
  { email: 'demo.inspector@vungu.test', name: 'Demo Building Inspector', role: 'building_inspector' },
  { email: 'demo.clerk@vungu.test', name: 'Demo Planning Clerk', role: 'planning_clerk' },
  { email: 'demo.surveyor@vungu.test', name: 'Demo Surveyor', role: 'surveyor' },
  { email: 'demo.gis@vungu.test', name: 'Demo GIS Officer', role: 'gis_officer' },
  { email: 'demo.viewer@vungu.test', name: 'Demo Viewer', role: 'viewer' },
]

function normalizeEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

function parseDemoUsers(env = process.env) {
  const defaultPassword = env.DEMO_DEFAULT_PASSWORD || 'demo1234'
  const organization = env.DEMO_ORGANIZATION || 'Vungu Rural District Council'
  const source = env.DEMO_USERS
    ? env.DEMO_USERS.split(',').map(item => item.trim()).filter(Boolean)
    : DEFAULT_DEMO_USERS.map(user => `${user.email}:${user.name}:${user.role}`)

  return source.map((entry) => {
    const [email, name, role, password] = entry.split(':').map(part => part.trim())
    if (!email || !name || !role) {
      throw new Error(`Invalid DEMO_USERS entry "${entry}". Use email:name:role[:password].`)
    }
    if (!VALID_ROLES.has(role)) {
      throw new Error(`Invalid demo role "${role}" for ${email}.`)
    }
    return {
      email,
      name,
      role,
      password: password || defaultPassword,
      organization,
    }
  })
}

function createPool(env = process.env) {
  return new Pool({
    connectionString: env.DATABASE_URL,
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME || 'vungu_master_db_v1',
    user: env.DB_USER || 'postgres',
    password: env.DB_PASSWORD || '',
    ssl: env.DATABASE_URL && env.DATABASE_URL.includes('render.com')
      ? { rejectUnauthorized: false }
      : undefined,
  })
}

async function upsertDemoUser(pool, user) {
  const passwordHash = await bcrypt.hash(user.password, 10)
  const { rows } = await pool.query(
    `INSERT INTO users (
       email, password_hash, name, full_name, role, status, active,
       organization, created_at
     )
     VALUES ($1, $2, $3, $3, $4, 'active', true, $5, NOW())
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       name = EXCLUDED.name,
       full_name = EXCLUDED.full_name,
       role = EXCLUDED.role,
       status = 'active',
       active = true,
       organization = EXCLUDED.organization
     RETURNING id, email, role`,
    [user.email, passwordHash, user.name, user.role, user.organization],
  )
  return rows[0]
}

async function seedDemoUsers(env = process.env) {
  if (!normalizeEnabled(env.DEMO_SEED_ENABLED)) {
    console.log('[demo-seed] skipped: DEMO_SEED_ENABLED is not true')
    return []
  }

  const users = parseDemoUsers(env)
  const pool = createPool(env)
  try {
    const seeded = []
    for (const user of users) {
      seeded.push(await upsertDemoUser(pool, user))
    }
    console.log(`[demo-seed] seeded ${seeded.length} demo users`)
    return seeded
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  seedDemoUsers().catch((error) => {
    console.error('[demo-seed] failed:', error)
    process.exit(1)
  })
}

module.exports = {
  DEFAULT_DEMO_USERS,
  VALID_ROLES,
  parseDemoUsers,
  seedDemoUsers,
  upsertDemoUser,
}
