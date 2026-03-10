import { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
export declare class QmlParserController {
    private qmlParserService;
    constructor(pool: Pool);
    /**
     * Create a new QML style template
     */
    createQmlTemplate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get QML template by ID
     */
    getQmlTemplate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get all QML templates
     */
    getQmlTemplates: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Update QML template
     */
    updateQmlTemplate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Delete QML template
     */
    deleteQmlTemplate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Validate QML content
     */
    validateQmlContent: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Parse QML content and return parsed configuration
     */
    parseQmlContent: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Convert QML template to web-compatible format
     */
    convertToWebStyle: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get QML template statistics
     */
    getQmlStatistics: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Clone QML template
     */
    cloneQmlTemplate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Preview QML template
     */
    previewQmlTemplate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}
//# sourceMappingURL=qmlParserController.d.ts.map