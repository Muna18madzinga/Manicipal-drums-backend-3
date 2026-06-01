// CJS shim for uuid v13 (ESM-only) so Jest can require() it.
// Uses Node's built-in crypto.randomUUID which is available since Node 14.17.
const crypto = require('crypto')

function v4() {
  return crypto.randomUUID()
}

function v1() {
  // Approximate v1 with a random UUID — sufficient for test environments.
  return crypto.randomUUID()
}

module.exports = { v4, v1 }
