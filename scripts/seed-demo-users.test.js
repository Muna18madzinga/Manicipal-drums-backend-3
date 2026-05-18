const {
  parseDemoUsers,
  DEFAULT_DEMO_USERS,
} = require('./seed-demo-users')

describe('demo user seeding config', () => {
  test('parses DEMO_USERS into bcrypt-seedable records with default password', () => {
    const users = parseDemoUsers({
      DEMO_DEFAULT_PASSWORD: 'demo1234',
      DEMO_USERS: 'demo.admin@vungu.test:Admin User:admin,demo.gis@vungu.test:GIS Officer:gis_officer',
    })

    expect(users).toEqual([
      {
        email: 'demo.admin@vungu.test',
        name: 'Admin User',
        role: 'admin',
        password: 'demo1234',
        organization: 'Vungu Rural District Council',
      },
      {
        email: 'demo.gis@vungu.test',
        name: 'GIS Officer',
        role: 'gis_officer',
        password: 'demo1234',
        organization: 'Vungu Rural District Council',
      },
    ])
  })

  test('supports per-user passwords with a fourth colon-separated field', () => {
    const users = parseDemoUsers({
      DEMO_DEFAULT_PASSWORD: 'fallback123',
      DEMO_USERS: 'demo.clerk@vungu.test:Planning Clerk:planning_clerk:clerk-pass',
    })

    expect(users[0].password).toBe('clerk-pass')
  })

  test('uses the built-in demo accounts when DEMO_USERS is omitted', () => {
    const users = parseDemoUsers({ DEMO_DEFAULT_PASSWORD: 'demo1234' })

    expect(users.map(user => user.email)).toEqual(DEFAULT_DEMO_USERS.map(user => user.email))
    expect(users.every(user => user.password === 'demo1234')).toBe(true)
  })

  test('rejects unknown roles before touching the database', () => {
    expect(() => parseDemoUsers({
      DEMO_USERS: 'demo.bad@vungu.test:Bad Role:superuser',
    })).toThrow('Invalid demo role')
  })
})
