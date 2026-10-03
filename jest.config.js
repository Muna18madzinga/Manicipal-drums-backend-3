const { integration, live } = require('./scripts/test-suites')

/**
 * Match a repo-relative path regardless of the separator Jest hands us.
 * Jest requires these as pattern *strings*, not RegExp objects (it calls
 * .replace() on each), so the escaping happens here and the result is returned
 * as text. Metacharacters are escaped so a suite name cannot widen the pattern
 * into excluding more than it should.
 */
const asPathPattern = (relativePath) =>
  relativePath
    .split('/')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]') + '$'

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // uuid v13 only ships ESM. Map it to a tiny CJS shim so Jest can load it.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/test/helpers/uuid-cjs-shim.cjs',
  },
  // Neither the integration nor the live suites can satisfy their prerequisites
  // from inside `npm test`: one needs a seeded database, the other a listening
  // port. Each has its own command, driven by the same list this file reads --
  // so a suite cannot be excluded here and then quietly never run.
  testPathIgnorePatterns: [...integration, ...live].map(asPathPattern),
  testTimeout: 30000,
}
