"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataCleaningService = void 0;
const baseService_1 = require("./baseService");
class DataCleaningService extends baseService_1.BaseService {
    constructor(pool) {
        super(pool, 'DataCleaningService');
    }
    /**
     * Validate service-specific tables
     */
    async validateServiceTables() {
        const tables = ['data_cleaning_jobs', 'cleaning_issues'];
        for (const table of tables) {
            const exists = await this.tableExists(table);
            if (exists) {
                const count = await this.getTableRowCount(table);
                console.log(`   ✅ ${table}: ${count} rows`);
            }
            else {
                console.warn(`   ❌ ${table}: Table not found`);
            }
        }
    }
    /**
     * Generate a unique job ID
     */
    async generateJobId() {
        try {
            const result = await this.safeQuery('SELECT COALESCE(MAX(job_id), 0) + 1 as next_job_id FROM data_cleaning_jobs');
            return result.rows[0].next_job_id;
        }
        catch (error) {
            return this.handleError(error, 'generateJobId');
        }
    }
    /**
     * Create a new data cleaning job
     */
    async createCleaningJob(jobId, cleaningType, config, createdBy) {
        try {
            const query = `
        INSERT INTO data_cleaning_jobs (job_id, cleaning_type, config, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;
            const values = [jobId, cleaningType, config, createdBy];
            const result = await this.safeQuery(query, values);
            return result.rows[0];
        }
        catch (error) {
            return this.handleError(error, 'createCleaningJob');
        }
    }
    /**
     * Start data cleaning process
     */
    async startCleaningJob(jobId) {
        try {
            await this.safeQuery('UPDATE data_cleaning_jobs SET status = $1, started_at = NOW() WHERE id = $2', ['running', jobId]);
        }
        catch (error) {
            this.handleError(error, 'startCleaningJob');
        }
    }
    /**
     * Complete data cleaning job
     */
    async completeCleaningJob(jobId, results, errors = []) {
        const query = `
      UPDATE data_cleaning_jobs 
      SET status = $1, results = $2, errors = $3, completed_at = NOW()
      WHERE id = $4
    `;
        await this.pool.query(query, ['completed', results, errors, jobId]);
    }
    /**
     * Fail data cleaning job
     */
    async failCleaningJob(jobId, errors) {
        await this.pool.query('UPDATE data_cleaning_jobs SET status = $1, errors = $2, completed_at = NOW() WHERE id = $3', ['failed', errors, jobId]);
    }
    /**
     * Add cleaning issue
     */
    async addCleaningIssue(jobId, issue) {
        const query = `
      INSERT INTO cleaning_issues (job_id, feature_id, issue_type, severity, description, suggested_fix, original_data, corrected_data, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
        const values = [
            jobId,
            issue.feature_id,
            issue.issue_type,
            issue.severity,
            issue.description,
            issue.suggested_fix,
            issue.original_data,
            issue.corrected_data,
            issue.status
        ];
        const result = await this.pool.query(query, values);
        return result.rows[0];
    }
    /**
     * Get cleaning job by ID
     */
    async getCleaningJob(jobId) {
        const result = await this.pool.query('SELECT * FROM data_cleaning_jobs WHERE id = $1', [jobId]);
        return result.rows[0] || null;
    }
    /**
     * Get cleaning issues for a job
     */
    async getCleaningIssues(jobId) {
        const result = await this.pool.query('SELECT * FROM cleaning_issues WHERE job_id = $1 ORDER BY severity DESC, created_at ASC', [jobId]);
        return result.rows;
    }
    /**
     * Duplicate Detection Algorithm
     */
    async detectDuplicates(jobId, config) {
        const { tolerance = 0.001, attributes = [] } = config;
        try {
            await this.startCleaningJob(jobId);
            // Get all features from the ingestion job
            const featuresQuery = `
        SELECT id, ST_AsGeoJSON(geom) as geom_json, properties 
        FROM layer_data 
        WHERE layer_id = $1
      `;
            const featuresResult = await this.pool.query(featuresQuery, [config.layerId]);
            const features = featuresResult.rows;
            const duplicates = [];
            const processed = new Set();
            for (let i = 0; i < features.length; i++) {
                if (processed.has(features[i].id))
                    continue;
                const feature1 = features[i];
                const geom1 = JSON.parse(feature1.geom_json);
                for (let j = i + 1; j < features.length; j++) {
                    if (processed.has(features[j].id))
                        continue;
                    const feature2 = features[j];
                    const geom2 = JSON.parse(feature2.geom_json);
                    // Check geometric similarity
                    const isDuplicate = await this.checkGeometricDuplicate(geom1, geom2, tolerance);
                    if (isDuplicate) {
                        // Check attribute similarity if specified
                        const attributeMatch = attributes.length === 0 ||
                            await this.checkAttributeSimilarity(feature1.properties, feature2.properties, attributes);
                        if (attributeMatch) {
                            duplicates.push({
                                primary: feature1.id,
                                duplicate: feature2.id,
                                similarity: 'high'
                            });
                            processed.add(feature2.id);
                            // Add cleaning issue
                            await this.addCleaningIssue(jobId, {
                                feature_id: feature2.id.toString(),
                                issue_type: 'duplicate',
                                severity: 'medium',
                                description: `Duplicate feature found similar to feature ${feature1.id}`,
                                suggested_fix: 'Remove duplicate feature',
                                original_data: feature2,
                                corrected_data: undefined,
                                status: 'pending'
                            });
                        }
                    }
                }
            }
            const results = {
                total_features: features.length,
                duplicates_found: duplicates.length,
                issues_fixed: 0,
                processing_time: 0
            };
            await this.completeCleaningJob(jobId, results);
        }
        catch (error) {
            await this.failCleaningJob(jobId, [error]);
            throw error;
        }
    }
    /**
     * Geometry Validation
     */
    async validateGeometry(jobId, config) {
        const { layerId } = config;
        try {
            await this.startCleaningJob(jobId);
            // Get invalid geometries
            const invalidQuery = `
        SELECT id, ST_AsGeoJSON(geom) as geom_json, properties,
               ST_IsValidReason(geom) as invalid_reason
        FROM layer_data 
        WHERE layer_id = $1 AND NOT ST_IsValid(geom)
      `;
            const invalidResult = await this.pool.query(invalidQuery, [layerId]);
            const invalidFeatures = invalidResult.rows;
            for (const feature of invalidFeatures) {
                await this.addCleaningIssue(jobId, {
                    feature_id: feature.id.toString(),
                    issue_type: 'invalid_geometry',
                    severity: 'high',
                    description: `Invalid geometry: ${feature.invalid_reason}`,
                    suggested_fix: 'Attempt geometry repair or manual correction',
                    original_data: feature,
                    corrected_data: undefined,
                    status: 'pending'
                });
            }
            const totalQuery = `SELECT COUNT(*) as total FROM layer_data WHERE layer_id = $1`;
            const totalResult = await this.pool.query(totalQuery, [layerId]);
            const totalFeatures = parseInt(totalResult.rows[0].total);
            const results = {
                total_features: totalFeatures,
                duplicates_found: 0,
                issues_fixed: 0,
                processing_time: 0
            };
            await this.completeCleaningJob(jobId, results);
        }
        catch (error) {
            await this.failCleaningJob(jobId, [error]);
            throw error;
        }
    }
    /**
     * Attribute Standardization
     */
    async standardizeAttributes(jobId, config) {
        const { layerId, standardization_rules = {} } = config;
        try {
            await this.startCleaningJob(jobId);
            // Get all features
            const featuresQuery = `
        SELECT id, properties 
        FROM layer_data 
        WHERE layer_id = $1
      `;
            const featuresResult = await this.pool.query(featuresQuery, [layerId]);
            const features = featuresResult.rows;
            for (const feature of features) {
                const properties = feature.properties || {};
                const issues = [];
                // Check for missing required attributes
                for (const [attr, rule] of Object.entries(standardization_rules)) {
                    const ruleConfig = rule;
                    if (ruleConfig.required && !properties[attr]) {
                        issues.push(`Missing required attribute: ${attr}`);
                        await this.addCleaningIssue(jobId, {
                            feature_id: feature.id.toString(),
                            issue_type: 'missing_attribute',
                            severity: 'medium',
                            description: `Missing required attribute: ${attr}`,
                            suggested_fix: `Add ${attr} with value: ${ruleConfig.default || 'N/A'}`,
                            original_data: feature,
                            corrected_data: { ...properties, [attr]: ruleConfig.default },
                            status: 'pending'
                        });
                    }
                    // Check attribute format
                    if (properties[attr] && ruleConfig.format) {
                        const isValid = this.validateAttributeFormat(properties[attr], ruleConfig.format);
                        if (!isValid) {
                            issues.push(`Invalid format for attribute: ${attr}`);
                            await this.addCleaningIssue(jobId, {
                                feature_id: feature.id.toString(),
                                issue_type: 'inconsistent_format',
                                severity: 'low',
                                description: `Invalid format for attribute: ${attr}`,
                                suggested_fix: `Format should be: ${ruleConfig.format}`,
                                original_data: feature,
                                corrected_data: undefined,
                                status: 'pending'
                            });
                        }
                    }
                }
            }
            const results = {
                total_features: features.length,
                duplicates_found: 0,
                issues_fixed: 0,
                processing_time: 0
            };
            await this.completeCleaningJob(jobId, results);
        }
        catch (error) {
            await this.failCleaningJob(jobId, [error]);
            throw error;
        }
    }
    /**
     * Check geometric similarity for duplicate detection
     */
    async checkGeometricDuplicate(geom1, geom2, tolerance) {
        // Simple distance-based duplicate detection
        // In a real implementation, this would use more sophisticated algorithms
        if (geom1.type !== geom2.type)
            return false;
        if (geom1.type === 'Point') {
            const distance = Math.sqrt(Math.pow(geom1.coordinates[0] - geom2.coordinates[0], 2) +
                Math.pow(geom1.coordinates[1] - geom2.coordinates[1], 2));
            return distance <= tolerance;
        }
        // For other geometry types, use PostGIS functions
        const query = `
      SELECT ST_DWithin(
        ST_GeomFromGeoJSON($1)::geometry,
        ST_GeomFromGeoJSON($2)::geometry,
        $3
      ) as is_duplicate
    `;
        const result = await this.pool.query(query, [
            JSON.stringify(geom1),
            JSON.stringify(geom2),
            tolerance
        ]);
        return result.rows[0].is_duplicate;
    }
    /**
     * Check attribute similarity
     */
    async checkAttributeSimilarity(props1, props2, attributes) {
        for (const attr of attributes) {
            const val1 = props1[attr];
            const val2 = props2[attr];
            if (val1 && val2) {
                // Simple string similarity check
                if (typeof val1 === 'string' && typeof val2 === 'string') {
                    const similarity = this.calculateStringSimilarity(val1.toLowerCase(), val2.toLowerCase());
                    if (similarity < 0.8)
                        return false;
                }
                else if (val1 !== val2) {
                    return false;
                }
            }
        }
        return true;
    }
    /**
     * Calculate string similarity (Levenshtein distance)
     */
    calculateStringSimilarity(str1, str2) {
        const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
        for (let i = 0; i <= str1.length; i++)
            matrix[0][i] = i;
        for (let j = 0; j <= str2.length; j++)
            matrix[j][0] = j;
        for (let j = 1; j <= str2.length; j++) {
            for (let i = 1; i <= str1.length; i++) {
                const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[j][i] = Math.min(matrix[j][i - 1] + 1, matrix[j - 1][i] + 1, matrix[j - 1][i - 1] + indicator);
            }
        }
        const distance = matrix[str2.length][str1.length];
        const maxLength = Math.max(str1.length, str2.length);
        return maxLength === 0 ? 1 : (maxLength - distance) / maxLength;
    }
    /**
     * Validate attribute format
     */
    validateAttributeFormat(value, format) {
        switch (format) {
            case 'email':
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
            case 'numeric':
                return !isNaN(parseFloat(value)) && isFinite(value);
            case 'integer':
                return Number.isInteger(Number(value));
            case 'date':
                return !isNaN(Date.parse(value));
            default:
                return true;
        }
    }
    /**
     * Get all cleaning jobs
     */
    async getCleaningJobs(limit = 50, offset = 0) {
        const query = `
      SELECT dcj.*, COALESCE(ij.job_name, 'N/A') as job_name 
      FROM data_cleaning_jobs dcj
      LEFT JOIN ingestion_jobs ij ON dcj.job_id = ij.id
      ORDER BY dcj.created_at DESC
      LIMIT $1 OFFSET $2
    `;
        const result = await this.pool.query(query, [limit, offset]);
        return result.rows;
    }
    /**
     * Update cleaning issue status
     */
    async updateCleaningIssueStatus(issueId, status) {
        const query = `
      UPDATE cleaning_issues 
      SET status = $1 
      WHERE id = $2 
      RETURNING *
    `;
        const result = await this.pool.query(query, [status, issueId]);
        return result.rows[0];
    }
}
exports.DataCleaningService = DataCleaningService;
//# sourceMappingURL=dataCleaningService.js.map