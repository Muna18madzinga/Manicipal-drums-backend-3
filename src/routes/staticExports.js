/**
 * Static-export endpoints — Stream D seam.
 *
 *   GET  /api/static/version/:table    → { version, bytes } | 404
 *   POST /api/static/build/:table      → { ok, file?, reason? }
 *
 * Build execution shells out to tippecanoe/ogr2ogr (see
 * docs/STREAM-D-DESIGN.md). Missing tooling returns HTTP 501 with a
 * reason, never a partial file.
 */
async function staticExportsRoutes(fastify) {
  const staticTiles = require('../services/staticTiles');

  fastify.get('/version/:table', async (request, reply) => {
    const v = staticTiles.staticVersion(request.params.table);
    if (!v) return reply.code(404).send({ ok: false, reason: 'no_static_build_for_table' });
    return { ok: true, ...v };
  });

  fastify.post('/build/:table', async (request, reply) => {
    const result = await staticTiles.buildPmTiles({ table: request.params.table, ...request.body });
    if (!result.ok) return reply.code(501).send(result);
    return result;
  });
}

module.exports = { staticExportsRoutes };
