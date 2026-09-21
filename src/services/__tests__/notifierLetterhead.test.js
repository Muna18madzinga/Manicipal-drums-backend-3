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
