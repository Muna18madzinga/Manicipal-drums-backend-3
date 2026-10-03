/**
 * Build a Jest config for running a specific set of suites that `npm test`
 * deliberately excludes.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * jest.config.js excludes the integration and live suites via
 * testPathIgnorePatterns. Jest applies that list to paths passed explicitly on
 * the command line too -- so invoking
 *
 *     jest src/routes/__tests__/permit-workflow.test.js
 *
 * silently matches nothing and exits with "no tests found". The suites would
 * appear to have passed because they never ran.
 *
 * So the runners hand Jest a config built from the real one with the ignore
 * list removed, rather than trying to defeat it with a clever pattern.
 *
 * Deriving the config from jest.config.js (instead of restating it) means the
 * moduleNameMapper, timeout and environment the suites run under stay identical
 * to `npm test` -- there is no second copy to drift.
 */

const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')

/** @param {string[]} _suites kept for call-site clarity; the config is path-agnostic */
function configForSuites(_suites) {
  const base = require(path.join(REPO, 'jest.config.js'))

  const config = { ...base }
  // Spread first, then drop: mutating the required module would corrupt the
  // config for anything else that loads it in this process.
  delete config.testPathIgnorePatterns

  // An inline --config has no directory to resolve against, so pin it. Without
  // this, <rootDir> in moduleNameMapper stops resolving and uuid imports fail.
  config.rootDir = REPO

  return config
}

module.exports = { configForSuites, REPO }
