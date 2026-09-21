const { textToHtml } = require('../notifier')

describe('textToHtml', () => {
  it('puts the council letterhead above the body', () => {
    const html = textToHtml('Your application was received.')
    expect(html).toContain('VUNGU RURAL DISTRICT COUNCIL')
    expect(html.indexOf('VUNGU RURAL DISTRICT COUNCIL'))
      .toBeLessThan(html.indexOf('Your application was received.'))
  })

  it('still renders one paragraph per blank-line-separated block', () => {
    const html = textToHtml('First block.\n\nSecond block.')
    expect(html).toContain('<p style="margin:0 0 1em;">First block.</p>')
    expect(html).toContain('<p style="margin:0 0 1em;">Second block.</p>')
  })

  it('still turns single newlines into breaks', () => {
    expect(textToHtml('Line one.\nLine two.')).toContain('Line one.<br>Line two.')
  })

  it('still escapes markup in the body', () => {
    expect(textToHtml('5 < 6 & <script>')).toContain('5 &lt; 6 &amp; &lt;script&gt;')
  })
})

const { enqueue } = require('../notifier')

/** Captures the INSERT parameters so we can read what would be stored. */
function fakePg() {
  const calls = []
  return { calls, query: async (text, params) => { calls.push(params); return { rows: [{ id: 1 }] } } }
}
const BODY_HTML = 6 // index of body_html in the INSERT parameter list

describe('enqueue letterheads every email', () => {
  it('renders html for a template-only caller that passes none', async () => {
    const pg = fakePg()
    await enqueue(pg, {
      email: 'citizen@example.test',
      kind: 'inspection_scheduled',
      templateData: { applicationId: 1, stageNumber: 2, stageName: 'Foundation', when: '2026-10-01' },
    })
    expect(pg.calls[0][BODY_HTML]).toContain('VUNGU RURAL DISTRICT COUNCIL')
  })

  it('leaves in_app rows as plain text', async () => {
    const pg = fakePg()
    await enqueue(pg, {
      userId: 1, channel: 'in_app', kind: 'inspection_scheduled',
      templateData: { applicationId: 1, stageNumber: 2, stageName: 'Foundation', when: '2026-10-01' },
    })
    expect(pg.calls[0][BODY_HTML]).toBeNull()
  })

  it('does not override html a caller supplied', async () => {
    const pg = fakePg()
    await enqueue(pg, {
      email: 'a@b.test', kind: 'inspection_scheduled', subject: 's', text: 't',
      html: '<p>mine</p>',
    })
    expect(pg.calls[0][BODY_HTML]).toBe('<p>mine</p>')
  })
})
