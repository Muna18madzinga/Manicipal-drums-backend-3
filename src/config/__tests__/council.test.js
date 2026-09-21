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

describe('council name casing', () => {
  it('offers a title-case name for prose, distinct from the letterhead name', () => {
    expect(COUNCIL.displayName).toBe('Vungu Rural District Council')
    expect(COUNCIL.name).toBe(COUNCIL.name.toUpperCase())
    expect(COUNCIL.displayName).not.toBe(COUNCIL.name)
  })

  it('agrees on the council between the two casings', () => {
    expect(COUNCIL.displayName.toUpperCase()).toBe(COUNCIL.name)
  })
})
