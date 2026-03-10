"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spatialDataRoutes = spatialDataRoutes;
async function spatialDataRoutes(fastify) {
    // Test database connection
    fastify.get('/test-connection', {
        schema: {
            description: 'Test database connection',
            tags: ['Spatial Data']
        }
    }, async (request, reply) => {
        try {
            const { rows } = await fastify.pg.query('SELECT COUNT(*) as count FROM gweru_chief_homesteads');
            return {
                success: true,
                message: 'Database connection successful',
                chief_homesteads_count: rows[0].count
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Database connection failed', details: error.message });
        }
    });
    // Get land parcels from your actual gweru_chief_homesteads table
    fastify.get('/land-parcels', {
        schema: {
            description: 'Get land parcels from chief homesteads',
            tags: ['Spatial Data'],
            querystring: {
                type: 'object',
                properties: {
                    project_id: { type: 'string', default: 'default-project' }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { project_id = 'default-project' } = request.query;
            // Use your actual gweru_chief_homesteads table with real geometry
            const query = `
        SELECT 
          gid,
          admin3name,
          admin2name,
          admin1name,
          village_na as village_name,
          sector,
          'chief_homestead' as type,
          ST_AsGeoJSON(geom) as geometry
        FROM gweru_chief_homesteads
        WHERE geom IS NOT NULL
        LIMIT 50
      `;
            const { rows } = await fastify.pg.query(query);
            // Parse real geometry from PostGIS
            const features = rows.map(row => ({
                type: 'Feature',
                geometry: JSON.parse(row.geometry),
                properties: {
                    id: row.gid,
                    name: row.admin3name,
                    village: row.village_name,
                    sector: row.sector,
                    admin2: row.admin2name,
                    admin1: row.admin1name,
                    type: row.type,
                    project_id: project_id
                }
            }));
            return {
                type: 'FeatureCollection',
                features: features
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to load land parcels' });
        }
    });
    // Get coordinate points from your actual gweru_schools and gweru_health_centres tables
    fastify.get('/coordinate-points', {
        schema: {
            description: 'Get coordinate points from schools and health facilities',
            tags: ['Spatial Data'],
            querystring: {
                type: 'object',
                properties: {
                    project_id: { type: 'string', default: 'default-project' }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { project_id = 'default-project' } = request.query;
            // Get schools and health facilities from your actual tables with real geometry
            const query = `
        SELECT gid, name, 'school' as type, ST_AsGeoJSON(geom) as geometry
        FROM gweru_schools WHERE geom IS NOT NULL
        UNION ALL
        SELECT gid, nameoffaci as name, 'health_facility' as type, ST_AsGeoJSON(geom) as geometry
        FROM gweru_health_centres WHERE geom IS NOT NULL
        ORDER BY type, name
        LIMIT 100
      `;
            const { rows } = await fastify.pg.query(query);
            const features = rows.map(row => ({
                type: 'Feature',
                geometry: JSON.parse(row.geometry),
                properties: {
                    id: row.gid,
                    name: row.name,
                    type: row.type,
                    project_id: project_id
                }
            }));
            return {
                type: 'FeatureCollection',
                features: features
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to load coordinate points' });
        }
    });
    // Get roads from your actual gweru_roads table
    fastify.get('/roads', {
        schema: {
            description: 'Get road network data',
            tags: ['Spatial Data'],
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'number', default: 500 }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { limit = 500 } = request.query;
            const query = `
        SELECT 
          id, 
          ST_AsGeoJSON(geom) as geometry,
          name,
          fclass,
          ref,
          oneway,
          maxspeed
        FROM gweru_roads
        WHERE geom IS NOT NULL
        LIMIT $1
      `;
            const { rows } = await fastify.pg.query(query, [limit]);
            const features = rows.map(row => ({
                type: 'Feature',
                geometry: JSON.parse(row.geometry),
                properties: {
                    id: row.id,
                    name: row.name,
                    roadClass: row.fclass,
                    reference: row.ref,
                    oneway: row.oneway,
                    maxspeed: row.maxspeed
                }
            }));
            return {
                type: 'FeatureCollection',
                features: features
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to load roads' });
        }
    });
    // Get planning boundaries from your actual gcc_boundary table
    fastify.get('/planning-boundaries', {
        schema: {
            description: 'Get planning boundaries',
            tags: ['Spatial Data']
        }
    }, async (request, reply) => {
        try {
            const query = `
        SELECT 
          id,
          ST_AsGeoJSON(geom) as geometry,
          'planning_boundary' as type
        FROM gcc_boundary
        WHERE geom IS NOT NULL
        LIMIT 10
      `;
            const { rows } = await fastify.pg.query(query);
            const features = rows.map(row => ({
                type: 'Feature',
                geometry: JSON.parse(row.geometry),
                properties: {
                    id: row.id,
                    type: row.type
                }
            }));
            return {
                type: 'FeatureCollection',
                features: features
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to load planning boundaries' });
        }
    });
    // Get proposed peri-urban zones (placeholder - no land use zones table exists yet)
    fastify.get('/proposed-peri-urban-zones', {
        schema: {
            description: 'Get proposed peri-urban zones',
            tags: ['Spatial Data']
        }
    }, async (request, reply) => {
        try {
            // Return empty feature collection since combined_land_use_zones table doesn't exist yet
            // This prevents the 500 error in the frontend
            return {
                type: 'FeatureCollection',
                features: []
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to load peri-urban zones', details: error.message });
        }
    });
    // Get all available layers with their actual data counts
    fastify.get('/layers', {
        schema: {
            description: 'Get all available layers with real data counts',
            tags: ['Spatial Data']
        }
    }, async (request, reply) => {
        try {
            const layers = [
                { name: 'Chief Homesteads', table: 'gweru_chief_homesteads', type: 'point' },
                { name: 'Schools', table: 'gweru_schools', type: 'point' },
                { name: 'Health Facilities', table: 'gweru_health_centres', type: 'point' },
                { name: 'Roads', table: 'gweru_roads', type: 'line' },
                { name: 'Planning Boundary', table: 'gcc_boundary', type: 'polygon' },
                { name: 'Land Use Zones', table: 'combined_land_use_zones', type: 'polygon' }
            ];
            const layerData = [];
            for (const layer of layers) {
                try {
                    const countQuery = `SELECT COUNT(*) as count FROM ${layer.table} WHERE geom IS NOT NULL`;
                    const { rows } = await fastify.pg.query(countQuery);
                    layerData.push({
                        id: layer.table,
                        name: layer.name,
                        description: `Actual ${layer.name.toLowerCase()} data`,
                        type: layer.type,
                        published: true,
                        visible: true,
                        style: getDefaultStyle(layer.type),
                        featureCount: parseInt(rows[0].count)
                    });
                }
                catch (error) {
                    console.warn(`Could not get count for ${layer.table}:`, error.message);
                }
            }
            return {
                success: true,
                data: layerData
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to load layers' });
        }
    });
    // Helper function to get default styles
    function getDefaultStyle(type) {
        const styles = {
            point: { color: '#96CEB4', radius: 8 },
            line: { color: '#DDA0DD', strokeWidth: 3 },
            polygon: { color: '#FF6B6B', fillOpacity: 0.3, strokeColor: '#FF6B6B' }
        };
        return styles[type] || styles.point;
    }
}
//# sourceMappingURL=spatial-data.js.map