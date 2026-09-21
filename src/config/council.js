/**
 * The council's identity for outbound mail.
 *
 * This mirrors `src/documents/council.ts` in the frontend repo, which cannot
 * be imported across the repo boundary. The test beside this file asserts the
 * fields, so the two cannot drift without a red build. If you change one,
 * change both.
 */

const COUNCIL = {
  name: 'VUNGU RURAL DISTRICT COUNCIL',
  address: 'Stand 1, Gweru Road, Gweru, Zimbabwe',
  telephone: '+263 54 123 456',
  email: 'admin@vungu.gov.zw',
}

/**
 * The letterhead as inline-styled email HTML.
 *
 * Typographic, with no image. Mail clients block remote images by default and
 * strip `<style>` blocks, so artwork can never be the thing carrying the
 * council's identity in an email — it would simply be absent for most
 * recipients.
 */
function emailLetterhead() {
  return [
    '<div style="border-bottom:2px solid #1a3d2b;padding-bottom:12px;margin-bottom:20px;">',
    `<div style="font-size:15px;font-weight:700;color:#1a3d2b;letter-spacing:.02em;">${COUNCIL.name}</div>`,
    `<div style="font-size:12px;color:#4a5a50;line-height:1.5;">${COUNCIL.address}</div>`,
    `<div style="font-size:12px;color:#4a5a50;line-height:1.5;">Tel: ${COUNCIL.telephone} | ${COUNCIL.email}</div>`,
    '</div>',
  ].join('')
}

module.exports = { COUNCIL, emailLetterhead }
