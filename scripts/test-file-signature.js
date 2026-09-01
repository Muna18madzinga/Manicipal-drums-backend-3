const { validateFileSignature } = require('../src/utils/fileSignature')

const allowed = new Set(['image/jpeg', 'application/pdf'])

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const pdf = Buffer.from('%PDF-1.4\n')
const fake = Buffer.from('MZ')

console.assert(validateFileSignature(jpeg, 'image/jpeg', allowed).ok)
console.assert(validateFileSignature(pdf, 'application/pdf', allowed).ok)
console.assert(!validateFileSignature(fake, 'image/jpeg', allowed).ok)
console.assert(!validateFileSignature(jpeg, 'application/pdf', allowed).ok)
console.log('fileSignature ok')
