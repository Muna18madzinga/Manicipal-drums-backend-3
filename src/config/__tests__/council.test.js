const { COUNCIL, emailLetterhead } = require('../council')

describe('council config', () => {
  it('carries the same identity the frontend renders', () => {
    expect(COUNCIL.name).toBe('VUNGU RURAL DISTRICT COUNCIL')
    expect(COUNCIL.address).toBe('Stand 1, Gweru Road, Gweru, Zimbabwe')
    expect(COUNCIL.email).toBe('admin@vungu.gov.zw')
  })

  it('renders an inline-styled letterhead with no stylesheet dependency', () => {
    const html = emailLetterhead()
    expect(html).toContain('VUNGU RURAL DISTRICT COUNCIL')
    expect(html).toContain('style=')
    expect(html).not.toContain('<style')
  })

  it('uses no remote image, which mail clients block by default', () => {
    expect(emailLetterhead()).not.toContain('<img')
  })
})
