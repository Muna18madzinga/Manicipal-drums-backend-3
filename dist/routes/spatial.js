"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spatialRoutes = spatialRoutes;
async function spatialRoutes(fastify) {
    // Spatial query - find features within bounds
    fastify.post('/query', {
        schema: {
            description: 'Perform spatial query',
            tags: ['Spatial'],
            headers: {
                type: 'object',
                properties: {
                    Authorization: { type: 'string' }
                },
                required: ['Authorization']
            },
            body: {
                type: 'object',
                properties: {
                    bbox: {
                        type: 'array',
                        items: { type: 'number' },
                        minItems: 4,
                        maxItems: 4
                    },
                    layerIds: {
                        type: 'array',
                        items: { type: 'string' }
                    },
                    geometryType: {
                        type: 'string',
                        enum: ['point', 'line', 'polygon', 'all'],
                        default: 'all'
                    },
                    limit: { type: 'number', minimum: 1, maximum: 10000, default: 1000 }
                },
                required: ['bbox']
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    layer_id: { type: 'string' },
                                    geometry: { type: 'string' },
                                    properties: { type: 'object' },
                                    area: { type: 'number' }
                                }
                            }
                        },
                        count: { type: 'number' }
                    }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { bbox, layerIds, geometryType = 'all', limit = 1000 } = request.body;
            const [minX, minY, maxX, maxY] = bbox;
            let query = `
        SELECT 
          layer_id,
          ST_AsGeoJSON(ST_Intersection(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))) as geometry,
          properties,
          ST_Area(ST_Intersection(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))) as area
        FROM layer_data 
        WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      `;
            const params = [minX, minY, maxX, maxY];
            // Filter by layers if specified
            if (layerIds && layerIds.length > 0) {
                query += ` AND layer_id = ANY($${params.length + 1})`;
                params.push(layerIds);
            }
            // Filter by geometry type if specified
            if (geometryType !== 'all') {
                const geometryTypeMap = {
                    point: 'ST_GeometryType(geom) = \'ST_Point\'',
                    line: 'ST_GeometryType(geom) IN (\'ST_LineString\', \'ST_MultiLineString\')',
                    polygon: 'ST_GeometryType(geom) IN (\'ST_Polygon\', \'ST_MultiPolygon\')'
                };
                query += ` AND ${geometryTypeMap[geometryType]}`;
            }
            query += ` LIMIT $${params.length + 1}`;
            params.push(limit);
            const { rows } = await fastify.pg.query(query, params);
            return {
                type: 'FeatureCollection',
                features: rows.map(row => ({
                    type: 'Feature',
                    geometry: JSON.parse(row.geometry),
                    properties: {
                        ...row.properties,
                        layerId: row.layer_id,
                        area: parseFloat(row.area) || 0
                    }
                })),
                bbox,
                count: rows.length
            };
        }
        catch (error) {
            fastify.log.error(error);
            reply.statusCode = 500;
            return reply.send({ error: 'Spatial query failed' });
        }
    });
    // Point in polygon query
    fastify.post('/point-in-polygon', {
        schema: {
            description: 'Check if point is in polygons',
            tags: ['Spatial'],
            headers: {
                type: 'object',
                properties: {
                    Authorization: { type: 'string' }
                },
                required: ['Authorization']
            },
            body: {
                type: 'object',
                required: ['point', 'layerIds'],
                properties: {
                    point: {
                        type: 'array',
                        items: { type: 'number' },
                        minItems: 2,
                        maxItems: 2
                    },
                    layerIds: {
                        type: 'array',
                        items: { type: 'string' }
                    }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    layer_id: { type: 'string' },
                                    geometry: { type: 'string' },
                                    properties: { type: 'object' }
                                }
                            }
                        },
                        count: { type: 'number' }
                    }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { point, layerIds } = request.body;
            const [x, y] = point;
            const { rows } = await fastify.pg.query(`
        SELECT 
          layer_id,
          ST_AsGeoJSON(geom) as geometry,
          properties,
          ST_Distance(ST_Centroid(geom), ST_Point($1, $2)) as distance
        FROM layer_data 
        WHERE layer_id = ANY($3)
        AND ST_Contains(geom, ST_Point($1, $2))
        ORDER BY distance
      `, [x, y, layerIds]);
            return {
                type: 'FeatureCollection',
                features: rows.map(row => ({
                    type: 'Feature',
                    geometry: JSON.parse(row.geometry),
                    properties: {
                        ...row.properties,
                        layerId: row.layer_id,
                        distance: parseFloat(row.distance)
                    }
                })),
                point,
                count: rows.length
            };
        }
        catch (error) {
            fastify.log.error(error);
            reply.statusCode = 500;
            return reply.send({ error: 'Point in polygon query failed' });
        }
    });
    // Buffer analysis
    fastify.post('/buffer', {
        schema: {
            description: 'Create buffer around features',
            tags: ['Spatial'],
            headers: {
                type: 'object',
                properties: {
                    Authorization: { type: 'string' }
                },
                required: ['Authorization']
            },
            body: {
                type: 'object',
                required: ['layerId', 'distance'],
                properties: {
                    layerId: { type: 'string' },
                    distance: { type: 'number', minimum: 0 },
                    units: {
                        type: 'string',
                        enum: ['meters', 'kilometers', 'degrees'],
                        default: 'meters'
                    },
                    where: { type: 'string' } // Optional SQL WHERE clause
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    geometry: { type: 'string' },
                                    properties: { type: 'object' },
                                    id: { type: 'string' }
                                }
                            }
                        },
                        count: { type: 'number' }
                    }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { layerId, distance, units = 'meters', where } = request.body;
            let query = `
        SELECT 
          ST_AsGeoJSON(ST_Buffer(geom, $2, $3)) as geometry,
          properties,
          id
        FROM layer_data 
        WHERE layer_id = $1
      `;
            const params = [layerId, distance];
            // Add units parameter
            if (units === 'kilometers') {
                params.push('kilometers');
            }
            else if (units === 'degrees') {
                params.push('degrees');
            }
            else {
                params.push('meters');
            }
            // Add optional WHERE clause
            if (where) {
                query += ` AND ${where}`;
            }
            const { rows } = await fastify.pg.query(query, params);
            return {
                type: 'FeatureCollection',
                features: rows.map(row => ({
                    type: 'Feature',
                    geometry: JSON.parse(row.geometry),
                    properties: {
                        ...row.properties,
                        originalId: row.id,
                        bufferDistance: distance,
                        bufferUnits: units
                    }
                })),
                buffer: { distance, units },
                count: rows.length
            };
        }
        catch (error) {
            fastify.log.error(error);
            reply.statusCode = 500;
            return reply.send({ error: 'Buffer analysis failed' });
        }
    });
    // Intersection analysis
    fastify.post('/intersection', {
        schema: {
            description: 'Find intersections between layers',
            tags: ['Spatial'],
            headers: {
                type: 'object',
                properties: {
                    Authorization: { type: 'string' }
                },
                required: ['Authorization']
            },
            body: {
                type: 'object',
                required: ['layer1', 'layer2'],
                properties: {
                    layer1: { type: 'string' },
                    layer2: { type: 'string' },
                    intersectionType: {
                        type: 'string',
                        enum: ['intersects', 'contains', 'within', 'touches'],
                        default: 'intersects'
                    }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    layer1_id: { type: 'string' },
                                    layer2_id: { type: 'string' },
                                    geometry: { type: 'string' },
                                    properties: { type: 'object' }
                                }
                            }
                        },
                        count: { type: 'number' }
                    }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { layer1, layer2, intersectionType = 'intersects' } = request.body;
            const intersectionMap = {
                intersects: 'ST_Intersects(l1.geom, l2.geom)',
                contains: 'ST_Contains(l1.geom, l2.geom)',
                within: 'ST_Within(l1.geom, l2.geom)',
                touches: 'ST_Touches(l1.geom, l2.geom)'
            };
            const { rows } = await fastify.pg.query(`
        SELECT 
          ST_AsGeoJSON(ST_Intersection(l1.geom, l2.geom)) as geometry,
          l1.properties as properties1,
          l2.properties as properties2,
          l1.id as id1,
          l2.id as id2,
          ST_Area(ST_Intersection(l1.geom, l2.geom)) as intersection_area
        FROM layer_data l1, layer_data l2
        WHERE l1.layer_id = $1 
        AND l2.layer_id = $2
        AND ${intersectionMap[intersectionType]}
      `, [layer1, layer2]);
            return {
                type: 'FeatureCollection',
                features: rows.map(row => ({
                    type: 'Feature',
                    geometry: JSON.parse(row.geometry),
                    properties: {
                        layer1: {
                            ...row.properties1,
                            id: row.id1
                        },
                        layer2: {
                            ...row.properties2,
                            id: row.id2
                        },
                        intersectionArea: parseFloat(row.intersection_area) || 0
                    }
                })),
                intersection: {
                    layer1,
                    layer2,
                    type: intersectionType
                },
                count: rows.length
            };
        }
        catch (error) {
            fastify.log.error(error);
            reply.statusCode = 500;
            return reply.send({ error: 'Intersection analysis failed' });
        }
    });
    // Aggregate statistics for polygons
    fastify.post('/aggregate', {
        schema: {
            description: 'Calculate aggregate statistics',
            tags: ['Spatial'],
            headers: {
                type: 'object',
                properties: {
                    Authorization: { type: 'string' }
                },
                required: ['Authorization']
            },
            body: {
                type: 'object',
                required: ['layerId', 'aggregation'],
                properties: {
                    layerId: { type: 'string' },
                    aggregation: {
                        type: 'object',
                        properties: {
                            groupBy: { type: 'string' },
                            metrics: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        field: { type: 'string' },
                                        function: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count'] }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        data: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    group_key: { type: 'string' },
                                    metrics: { type: 'object' }
                                }
                            }
                        },
                        count: { type: 'number' }
                    }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { layerId, aggregation } = request.body;
            const { groupBy, metrics } = aggregation;
            let selectClause = ['properties->$2 as group_key'];
            let whereClause = 'WHERE layer_id = $1';
            // Build aggregate functions
            metrics.forEach((metric, index) => {
                const paramIndex = index + 3;
                selectClause.push(`${metric.function}(properties->>$${paramIndex}) as ${metric.field}_${metric.function}`);
            });
            const query = `
        SELECT ${selectClause.join(', ')}, COUNT(*) as feature_count
        FROM layer_data 
        ${whereClause}
        GROUP BY properties->$2
        ORDER BY feature_count DESC
      `;
            const params = [layerId, groupBy];
            metrics.forEach((metric) => {
                params.push(metric.field);
            });
            const { rows } = await fastify.pg.query(query, params);
            return {
                layerId,
                groupBy,
                aggregations: rows,
                count: rows.length
            };
        }
        catch (error) {
            fastify.log.error(error);
            reply.statusCode = 500;
            return reply.send({ error: 'Aggregation failed' });
        }
    });
    // Debug endpoint to drop vungu_master_alpha database
    fastify.get('/debug/drop-alpha', {
        schema: {
            description: 'Debug: Drop vungu_master_alpha database',
            tags: ['Debug']
        }
    }, async (request, reply) => {
        try {
            // Drop the vungu_master_alpha database
            const dropQuery = `DROP DATABASE IF EXISTS vungu_master_alpha`;
            await fastify.pg.query(dropQuery);
            return {
                success: true,
                message: 'vungu_master_alpha database dropped successfully',
                remaining_database: 'vungu_master_db'
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to drop vungu_master_alpha database' });
        }
    });
    // Debug endpoint to list all databases
    fastify.get('/debug/databases', {
        schema: {
            description: 'Debug: List all databases',
            tags: ['Debug']
        }
    }, async (request, reply) => {
        try {
            const query = `SELECT datname FROM pg_database WHERE datname LIKE '%vungu%' ORDER BY datname`;
            const { rows } = await fastify.pg.query(query);
            return { databases: rows };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to list databases' });
        }
    });
    // Debug endpoint to check database connection
    fastify.get('/debug/connection', {
        schema: {
            description: 'Debug: Show database connection info',
            tags: ['Debug']
        }
    }, async (request, reply) => {
        try {
            // Get current database name
            const dbQuery = `SELECT current_database() as database_name`;
            const { rows: dbResult } = await fastify.pg.query(dbQuery);
            // Get connection info
            const connQuery = `
        SELECT 
          inet_server_addr() as server_addr,
          inet_server_port() as server_port,
          version() as postgres_version,
          current_user as current_user
      `;
            const { rows: connResult } = await fastify.pg.query(connQuery);
            return {
                database_name: dbResult[0].database_name,
                server_addr: connResult[0].server_addr,
                server_port: connResult[0].server_port,
                postgres_version: connResult[0].postgres_version,
                current_user: connResult[0].current_user,
                environment: {
                    DATABASE_HOST: process.env.DATABASE_HOST,
                    DATABASE_PORT: process.env.DATABASE_PORT,
                    DATABASE_NAME: process.env.DATABASE_NAME,
                    DATABASE_USER: process.env.DATABASE_USER
                }
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to get connection info' });
        }
    });
    // Debug endpoint to check existing table structures
    fastify.get('/debug/table-structures', {
        schema: {
            description: 'Debug: Check structure of existing spatial tables',
            tags: ['Debug']
        }
    }, async (request, reply) => {
        try {
            // Check structure of key tables
            const tables = ['layers', 'layer_data', 'places'];
            const structures = {};
            for (const tableName of tables) {
                try {
                    const structureQuery = `
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = $1 
            AND table_schema = 'public'
            ORDER BY ordinal_position
          `;
                    const { rows: columns } = await fastify.pg.query(structureQuery, [tableName]);
                    // Get sample data
                    let sampleData = [];
                    try {
                        const sampleQuery = `SELECT * FROM ${tableName} LIMIT 3`;
                        const { rows: samples } = await fastify.pg.query(sampleQuery);
                        sampleData = samples;
                    }
                    catch (sampleError) {
                        sampleData = [{ error: 'No sample data available' }];
                    }
                    structures[tableName] = {
                        columns: columns,
                        sample_data: sampleData,
                        row_count: 0
                    };
                    // Get row count
                    try {
                        const countQuery = `SELECT COUNT(*) as count FROM ${tableName}`;
                        const { rows: countResult } = await fastify.pg.query(countQuery);
                        structures[tableName].row_count = parseInt(countResult[0].count);
                    }
                    catch (countError) {
                        structures[tableName].row_count = 0;
                    }
                }
                catch (error) {
                    structures[tableName] = {
                        error: error.message,
                        columns: [],
                        sample_data: [],
                        row_count: 0
                    };
                }
            }
            return {
                database: 'vungu_master_db',
                table_structures: structures
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to check table structures' });
        }
    });
    // Debug endpoint to check all schemas and tables
    fastify.get('/debug/all-schemas', {
        schema: {
            description: 'Debug: Check all schemas and their tables',
            tags: ['Debug']
        }
    }, async (request, reply) => {
        try {
            // Get all schemas
            const schemasQuery = `
        SELECT schema_name 
        FROM information_schema.schemata 
        WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
        ORDER BY schema_name
      `;
            const { rows: schemas } = await fastify.pg.query(schemasQuery);
            const schemaDetails = {};
            for (const schema of schemas) {
                try {
                    // Get tables in this schema
                    const tablesQuery = `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = $1
            ORDER BY table_name
          `;
                    const { rows: tables } = await fastify.pg.query(tablesQuery, [schema.schema_name]);
                    // Check which tables have geometry
                    const spatialTables = [];
                    for (const table of tables) {
                        try {
                            const geomCheck = `
                SELECT COUNT(*) as has_geometry
                FROM information_schema.columns 
                WHERE table_name = $1 
                AND table_schema = $2 
                AND data_type = 'USER-DEFINED'
              `;
                            const { rows: geomResult } = await fastify.pg.query(geomCheck, [table.table_name, schema.schema_name]);
                            if (geomResult[0].has_geometry > 0) {
                                // Get row count
                                let rowCount = 0;
                                try {
                                    const countQuery = `SELECT COUNT(*) as count FROM ${schema.schema_name}.${table.table_name}`;
                                    const { rows: countResult } = await fastify.pg.query(countQuery);
                                    rowCount = parseInt(countResult[0].count);
                                }
                                catch (countError) {
                                    rowCount = 0;
                                }
                                spatialTables.push({
                                    table_name: table.table_name,
                                    row_count: rowCount
                                });
                            }
                        }
                        catch (error) {
                            // Skip tables that cause errors
                        }
                    }
                    schemaDetails[schema.schema_name] = {
                        total_tables: tables.length,
                        spatial_tables: spatialTables,
                        all_tables: tables
                    };
                }
                catch (error) {
                    schemaDetails[schema.schema_name] = {
                        error: error.message,
                        total_tables: 0,
                        spatial_tables: [],
                        all_tables: []
                    };
                }
            }
            return {
                current_database: 'vungu_master_db',
                schemas: schemaDetails,
                total_schemas: schemas.length
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to check all schemas' });
        }
    });
    // Debug endpoint to list ALL tables including spatial ones
    fastify.get('/debug/all-tables', {
        schema: {
            description: 'Debug: List ALL tables in database',
            tags: ['Debug']
        }
    }, async (request, reply) => {
        try {
            // Get ALL tables without limit
            const tablesQuery = `
        SELECT table_name, table_schema 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `;
            const { rows: allTables } = await fastify.pg.query(tablesQuery);
            // Check which tables have geometry columns
            const spatialTables = [];
            for (const table of allTables) {
                try {
                    const geomCheck = `
            SELECT COUNT(*) as has_geometry
            FROM information_schema.columns 
            WHERE table_name = $1 
            AND table_schema = 'public' 
            AND data_type = 'USER-DEFINED'
          `;
                    const { rows: geomResult } = await fastify.pg.query(geomCheck, [table.table_name]);
                    if (geomResult[0].has_geometry > 0) {
                        // Get row count
                        let rowCount = 0;
                        try {
                            const countQuery = `SELECT COUNT(*) as count FROM ${table.table_name}`;
                            const { rows: countResult } = await fastify.pg.query(countQuery);
                            rowCount = parseInt(countResult[0].count);
                        }
                        catch (countError) {
                            rowCount = 0;
                        }
                        spatialTables.push({
                            table_name: table.table_name,
                            row_count: rowCount,
                            has_geometry: true
                        });
                    }
                }
                catch (error) {
                    // Skip tables that cause errors
                }
            }
            return {
                total_tables: allTables.length,
                spatial_tables: spatialTables,
                all_tables: allTables
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to list all tables' });
        }
    });
    // Debug endpoint to check database tables
    fastify.get('/debug/tables', {
        schema: {
            description: 'Debug: List all tables in database',
            tags: ['Debug']
        }
    }, async (request, reply) => {
        try {
            // Get all tables
            const tablesQuery = `
        SELECT table_name, table_schema 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name
      `;
            const { rows: tables } = await fastify.pg.query(tablesQuery);
            // Check specific spatial tables
            const spatialTables = ['land_parcels', 'coordinate_points', 'proposed_peri_urban_zones'];
            const tableStatus = {};
            for (const tableName of spatialTables) {
                try {
                    const countQuery = `SELECT COUNT(*) as count FROM ${tableName}`;
                    const { rows: countResult } = await fastify.pg.query(countQuery);
                    tableStatus[tableName] = {
                        exists: true,
                        count: parseInt(countResult[0].count)
                    };
                }
                catch (error) {
                    tableStatus[tableName] = {
                        exists: false,
                        count: 0,
                        error: error.message
                    };
                }
            }
            return {
                all_tables: tables,
                spatial_tables: tableStatus
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to check database tables' });
        }
    });
    // Get land parcels for a project
    fastify.get('/land-parcels', {
        schema: {
            description: 'Get land parcels for a project',
            tags: ['Spatial'],
            querystring: {
                type: 'object',
                properties: {
                    project_id: { type: 'string' }
                },
                required: ['project_id']
            }
        }
    }, async (request, reply) => {
        try {
            const { project_id } = request.query;
            // Check if table exists first
            const tableCheck = await fastify.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'land_parcels'
        )
      `);
            if (!tableCheck.rows[0].exists) {
                // Return empty array if table doesn't exist
                return { type: 'FeatureCollection', features: [] };
            }
            const query = `
        SELECT id, stand, description, area_m2, 
               ST_AsGeoJSON(geom) as geom
        FROM land_parcels 
        WHERE project_id = $1
        ORDER BY stand
      `;
            const { rows } = await fastify.pg.query(query, [project_id]);
            // Convert to proper GeoJSON FeatureCollection
            const features = rows.map(row => ({
                type: 'Feature',
                geometry: JSON.parse(row.geom),
                properties: {
                    id: row.id,
                    stand: row.stand,
                    description: row.description,
                    area_m2: row.area_m2
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
    // Get coordinate points for a project
    fastify.get('/coordinate-points', {
        schema: {
            description: 'Get coordinate points for a project',
            tags: ['Spatial'],
            querystring: {
                type: 'object',
                properties: {
                    project_id: { type: 'string' }
                },
                required: ['project_id']
            }
        }
    }, async (request, reply) => {
        try {
            const { project_id } = request.query;
            // Check if table exists first
            const tableCheck = await fastify.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'coordinate_points'
        )
      `);
            if (!tableCheck.rows[0].exists) {
                // Return empty array if table doesn't exist
                return { type: 'FeatureCollection', features: [] };
            }
            const query = `
        SELECT id, name, y, x, description,
               ST_AsGeoJSON(ST_SetSRID(ST_MakePoint(x, y), 4326)) as geom
        FROM coordinate_points 
        WHERE project_id = $1
        ORDER BY name
      `;
            const { rows } = await fastify.pg.query(query, [project_id]);
            // Convert to proper GeoJSON FeatureCollection
            const features = rows.map(row => ({
                type: 'Feature',
                geometry: JSON.parse(row.geom),
                properties: {
                    id: row.id,
                    name: row.name,
                    y: row.y,
                    x: row.x,
                    description: row.description
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
    // Get proposed peri-urban zones
    fastify.get('/proposed-peri-urban-zones', {
        schema: {
            description: 'Get proposed peri-urban zones',
            tags: ['Spatial']
        }
    }, async (request, reply) => {
        try {
            // Check if table exists first
            const tableCheck = await fastify.pg.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'proposed_peri_urban_zones'
        )
      `);
            if (!tableCheck.rows[0].exists) {
                // Return empty array if table doesn't exist
                return { type: 'FeatureCollection', features: [] };
            }
            const query = `
        SELECT id, zone_name, zone_type, area_ha,
               ST_AsGeoJSON(geom) as geom
        FROM proposed_peri_urban_zones
        ORDER BY zone_name
      `;
            const { rows } = await fastify.pg.query(query);
            // Convert to proper GeoJSON FeatureCollection
            const features = rows.map(row => ({
                type: 'Feature',
                geometry: JSON.parse(row.geom),
                properties: {
                    id: row.id,
                    zone_name: row.zone_name,
                    zone_type: row.zone_type,
                    area_ha: row.area_ha
                }
            }));
            return {
                type: 'FeatureCollection',
                features: features
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to load proposed peri-urban zones' });
        }
    });
}
//# sourceMappingURL=spatial.js.map