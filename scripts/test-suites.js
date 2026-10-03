/**
 * The test suites that cannot run in a bare `npm test`, and what each one needs.
 *
 * This file is the single source of truth. Three callers read it:
 *   - jest.config.js                  excludes every listed suite from `npm test`
 *   - scripts/prepare-acceptance-db.js  builds the database, runs `integration`
 *   - scripts/run-live-server-tests.js   boots a server, runs `live`
 *
 * Keeping one list means a suite cannot be excluded from `npm test` while some
 * other command forgets to run it -- which is how tests quietly stop being run
 * at all.
 *
 * The split is by *prerequisite*, not by subject matter. A suite earns a place
 * here when `npm test` fails on it for want of something the suite cannot
 * reasonably build for itself.
 */

/**
 * Need seeded data: demo users, the Tsamba township, and the migration chain.
 * These build their app in-process with app.inject, so no listening port is
 * required -- only a prepared database.
 *
 *   geometry-validation  a self-minted user session; asserts the geometry and
 *                        migration 107 topology gates
 *   gms.acceptance       demo users with the GIS roles + the Tsamba township
 *   gms.editing          same
 *   permit-workflow      demo.planner and demo.admin (statutory chain, EO gate)
 *   soft-delete          a session, and rows of its own to tombstone
 *   stand-allocation     a session; places stands against the topology trigger
 *
 * Run with: npm run test:db
 */
const integration = [
  'src/routes/__tests__/geometry-validation.test.js',
  'src/routes/__tests__/gms.acceptance.test.js',
  'src/routes/__tests__/gms.editing.test.js',
  'src/routes/__tests__/permit-workflow.test.js',
  'src/routes/__tests__/soft-delete.test.js',
  'src/routes/__tests__/stand-allocation.test.js',
]

/**
 * Need a server actually listening on PORT -- they drive the real HTTP surface
 * over axios rather than app.inject, so no in-process Fastify instance will do.
 *
 *   permit-applications.citizen  the citizen-facing permit endpoints end to end
 *   surveyor.routes              the surveyor mobile API end to end
 *
 * These fail with ECONNREFUSED, not an assertion, when the server is down --
 * which reads like a broken feature but only means nobody started it.
 *
 * Run with: npm run test:live
 */
const live = [
  'src/routes/__tests__/permit-applications.citizen.test.js',
  'src/routes/__tests__/surveyor.routes.test.js',
]

module.exports = { integration, live }
