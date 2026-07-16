const notifier = require('../notifier')

describe('staff_invite template', () => {
  const base = notifier.TEMPLATES.staff_invite({
    inviteUrl: 'https://portal.test/invite?token=abc123',
    role: 'planning_clerk',
    jobTitle: 'Planning Officer',
    department: 'Planning & Environment',
    invitedByName: 'A Magura',
    expiresAt: '2026-08-01T10:00:00.000Z',
  })

  it('includes the absolute invite link so it works from an email client', () => {
    expect(base.text).toContain('https://portal.test/invite?token=abc123')
  })

  it('renders a human role label and the inviter', () => {
    expect(base.text).toContain('Planning Clerk')      // prettyStatus(role)
    expect(base.text).toContain('A Magura')
    expect(base.subject).toMatch(/invited/i)
  })

  it('has no exclamation marks (brand voice)', () => {
    expect(base.text).not.toContain('!')
    expect(base.subject).not.toContain('!')
  })
})

describe('enqueueStaffInvite', () => {
  it('writes one email row to the outbox with rendered subject/text/html', async () => {
    const captured = []
    const pg = {
      query: async (_sql, params) => {
        captured.push(params)
        return { rows: [{ id: 'row-1' }] }
      },
    }

    const id = await notifier.enqueueStaffInvite(pg, {
      email: 'clerk@vungurdc.gov.zw',
      inviteUrl: 'https://portal.test/invite?token=xyz',
      role: 'viewer',
      jobTitle: 'Records Officer',
      department: 'IT',
      invitedByName: 'IT Admin',
      expiresAt: '2026-08-01T10:00:00.000Z',
    })

    expect(id).toBe('row-1')
    const [userId, email, channel, kind, subject, bodyText, bodyHtml] = captured[0]
    expect(userId).toBeNull()
    expect(email).toBe('clerk@vungurdc.gov.zw')
    expect(channel).toBe('email')
    expect(kind).toBe('staff_invite')
    expect(subject).toMatch(/invited/i)
    expect(bodyText).toContain('https://portal.test/invite?token=xyz')
    expect(bodyHtml).toContain('<p')            // textToHtml wrapped it
    expect(bodyHtml).toContain('portal.test')
  })
})
