/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // uuid v13 only ships ESM. Map it to a tiny CJS shim so Jest can load it.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/test/helpers/uuid-cjs-shim.cjs',
  },
  testTimeout: 30000,
}
