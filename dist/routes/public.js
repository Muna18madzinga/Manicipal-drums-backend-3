"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicRoutes = publicRoutes;
async function publicRoutes(fastify) {
    // Get available layers (cached)
    fastify.get('/layers', {
        schema: {
            description: 'Get all published layers',
            tags: ['Public'],
            response: {
                200: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            name: { type: 'string' },
                            description: { type: 'string' },
                            type: { type: 'string', enum: ['vector', 'raster', 'point', 'polygon'] },
                            bounds: {
                                type: 'array',
                                items: { type: 'number' },
                                minItems: 4,
                                maxItems: 4
                            },
                            visible: { type: 'boolean' },
                            style: { type: 'object' }
                        }
                    }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { rows } = await fastify.pg.query(`
        SELECT 
          id,
          name,
          description,
          type,
          ST_AsGeoJSON(ST_Extent(geom)) as bounds,
          visible,
          style
        FROM layers 
        WHERE published = true 
        ORDER BY name
      `);
            return rows.map(layer => ({
                ...layer,
                bounds: layer.bounds ? JSON.parse(layer.bounds).coordinates[0] : null
            }));
        }
        catch (error) {
            fastify.log.error(error);
            reply.statusCode = 500;
            return reply.send({ error: 'Failed to fetch layers' });
        }
    });
    // Get layer data (streaming for performance)
    fastify.get('/layers/:id/data', {
        schema: {
            description: 'Get layer data as GeoJSON',
            tags: ['Public'],
            params: {
                type: 'object',
                properties: {
                    id: { type: 'string' }
                },
                required: ['id']
            },
            querystring: {
                type: 'object',
                properties: {
                    bbox: {
                        type: 'array',
                        items: { type: 'number' },
                        minItems: 4,
                        maxItems: 4
                    },
                    limit: { type: 'number', minimum: 1, maximum: 10000, default: 1000 }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { id } = request.params;
            const { bbox, limit = 1000 } = request.query;
            let query = `
        SELECT 
          ST_AsGeoJSON(geom) as geometry,
          properties
        FROM layer_data 
        WHERE layer_id = $1
      `;
            const params = [id];
            // Add bbox filter if provided
            if (bbox && bbox.length === 4) {
                query += ` AND geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)`;
                params.push(...bbox);
            }
            query += ` LIMIT $${params.length + 1}`;
            params.push(limit);
            const { rows } = await fastify.pg.query(query, params);
            return {
                type: 'FeatureCollection',
                features: rows.map(row => ({
                    type: 'Feature',
                    geometry: JSON.parse(row.geometry),
                    properties: row.properties || {}
                }))
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch layer data' });
        }
    });
    // Search places (geocoding)
    fastify.get('/search', {
        schema: {
            description: 'Search for places',
            tags: ['Public'],
            querystring: {
                type: 'object',
                properties: {
                    q: { type: 'string', minLength: 2 },
                    limit: { type: 'number', minimum: 1, maximum: 50, default: 10 }
                },
                required: ['q']
            }
        }
    }, async (request, reply) => {
        try {
            const { q, limit = 10 } = request.query;
            const { rows } = await fastify.pg.query(`
        SELECT 
          id,
          name,
          type,
          ST_AsGeoJSON(ST_Centroid(geom)) as center,
          relevance
        FROM places 
        WHERE name ILIKE $1 
        ORDER BY relevance DESC, name
        LIMIT $2
      `, [`%${q}%`, limit]);
            return rows.map(place => ({
                ...place,
                center: JSON.parse(place.center).coordinates
            }));
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Search failed' });
        }
    });
    // Get statistics
    fastify.get('/stats', {
        schema: {
            description: 'Get portal statistics',
            tags: ['Public']
        }
    }, async (request, reply) => {
        try {
            const [layers, places, users] = await Promise.all([
                fastify.pg.query('SELECT COUNT(*) as count FROM layers WHERE published = true'),
                fastify.pg.query('SELECT COUNT(*) as count FROM places'),
                fastify.pg.query('SELECT COUNT(*) as count FROM users WHERE active = true')
            ]);
            return {
                layers: parseInt(layers.rows[0].count),
                places: parseInt(places.rows[0].count),
                users: parseInt(users.rows[0].count),
                lastUpdated: new Date().toISOString()
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch statistics' });
        }
    });
}
//# sourceMappingURL=public.js.map