"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QmlParserController = void 0;
const qmlParserService_1 = require("../../services/admin/qmlParserService");
class QmlParserController {
    qmlParserService;
    constructor(pool) {
        this.qmlParserService = new qmlParserService_1.QmlParserService(pool);
    }
    /**
     * Create a new QML style template
     */
    createQmlTemplate = async (request, reply) => {
        try {
            const { name, description, qml_content, style_type } = request.body;
            const userId = request.user?.id || 1;
            // Validate input
            if (!name || !qml_content || !style_type) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required fields: name, qml_content, style_type'
                });
                return;
            }
            const validTypes = ['point', 'line', 'polygon', 'raster'];
            if (!validTypes.includes(style_type)) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: `Invalid style type. Must be one of: ${validTypes.join(', ')}`
                });
                return;
            }
            // Validate QML content
            const validation = await this.qmlParserService.validateQmlContent(qml_content);
            if (!validation.valid) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Invalid QML content',
                    errors: validation.errors
                });
                return;
            }
            const template = await this.qmlParserService.createQmlTemplate(name, description || '', qml_content, style_type, userId);
            reply.status(201).send({
                data: template,
                message: 'QML template created successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to create QML template'
            });
        }
    };
    /**
     * Get QML template by ID
     */
    getQmlTemplate = async (request, reply) => {
        try {
            const { templateId } = request.params;
            const template = await this.qmlParserService.getQmlTemplate(parseInt(templateId));
            if (!template) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'QML template not found'
                });
                return;
            }
            reply.send({
                data: template
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get QML template'
            });
        }
    };
    /**
     * Get all QML templates
     */
    getQmlTemplates = async (request, reply) => {
        try {
            const { style_type } = request.query;
            const templates = await this.qmlParserService.getQmlTemplates(style_type);
            reply.send({
                data: templates,
                summary: {
                    total: templates.length,
                    by_type: {
                        point: templates.filter(t => t.style_type === 'point').length,
                        line: templates.filter(t => t.style_type === 'line').length,
                        polygon: templates.filter(t => t.style_type === 'polygon').length,
                        raster: templates.filter(t => t.style_type === 'raster').length
                    }
                }
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get QML templates'
            });
        }
    };
    /**
     * Update QML template
     */
    updateQmlTemplate = async (request, reply) => {
        try {
            const { templateId } = request.params;
            const updates = request.body;
            const existingTemplate = await this.qmlParserService.getQmlTemplate(parseInt(templateId));
            if (!existingTemplate) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'QML template not found'
                });
                return;
            }
            // If QML content is being updated, validate it
            if (updates.qml_content) {
                const validation = await this.qmlParserService.validateQmlContent(updates.qml_content);
                if (!validation.valid) {
                    reply.status(400).send({
                        error: 'Bad Request',
                        message: 'Invalid QML content',
                        errors: validation.errors
                    });
                    return;
                }
            }
            const updatedTemplate = await this.qmlParserService.updateQmlTemplate(parseInt(templateId), updates);
            reply.send({
                data: updatedTemplate,
                message: 'QML template updated successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to update QML template'
            });
        }
    };
    /**
     * Delete QML template
     */
    deleteQmlTemplate = async (request, reply) => {
        try {
            const { templateId } = request.params;
            const existingTemplate = await this.qmlParserService.getQmlTemplate(parseInt(templateId));
            if (!existingTemplate) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'QML template not found'
                });
                return;
            }
            await this.qmlParserService.deleteQmlTemplate(parseInt(templateId));
            reply.send({
                message: 'QML template deleted successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to delete QML template'
            });
        }
    };
    /**
     * Validate QML content
     */
    validateQmlContent = async (request, reply) => {
        try {
            const { qml_content } = request.body;
            if (!qml_content) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required field: qml_content'
                });
                return;
            }
            const validation = await this.qmlParserService.validateQmlContent(qml_content);
            reply.send({
                data: validation,
                message: validation.valid ? 'QML content is valid' : 'QML content has errors'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to validate QML content'
            });
        }
    };
    /**
     * Parse QML content and return parsed configuration
     */
    parseQmlContent = async (request, reply) => {
        try {
            const { qml_content } = request.body;
            if (!qml_content) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required field: qml_content'
                });
                return;
            }
            const parsedConfig = await this.qmlParserService.parseQmlContent(qml_content);
            reply.send({
                data: parsedConfig,
                message: 'QML content parsed successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to parse QML content'
            });
        }
    };
    /**
     * Convert QML template to web-compatible format
     */
    convertToWebStyle = async (request, reply) => {
        try {
            const { templateId } = request.params;
            const webStyle = await this.qmlParserService.convertToWebStyle(parseInt(templateId));
            reply.send({
                data: webStyle,
                message: 'QML template converted to web format successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to convert QML template to web format'
            });
        }
    };
    /**
     * Get QML template statistics
     */
    getQmlStatistics = async (request, reply) => {
        try {
            const templates = await this.qmlParserService.getQmlTemplates();
            const totalTemplates = templates.length;
            const activeTemplates = templates.filter(t => t.is_active).length;
            const inactiveTemplates = totalTemplates - activeTemplates;
            const templatesByType = {
                point: templates.filter(t => t.style_type === 'point').length,
                line: templates.filter(t => t.style_type === 'line').length,
                polygon: templates.filter(t => t.style_type === 'polygon').length,
                raster: templates.filter(t => t.style_type === 'raster').length
            };
            // Calculate average complexity (number of symbols)
            const totalSymbols = templates.reduce((sum, template) => {
                const config = template.parsed_config;
                return sum + (config.symbols?.length || 0);
            }, 0);
            const avgComplexity = totalTemplates > 0 ? (totalSymbols / totalTemplates).toFixed(2) : 0;
            reply.send({
                data: {
                    overview: {
                        total_templates: totalTemplates,
                        active_templates: activeTemplates,
                        inactive_templates: inactiveTemplates,
                        average_complexity: parseFloat(String(avgComplexity))
                    },
                    by_type: templatesByType,
                    recent_templates: templates.slice(0, 5).map(template => ({
                        id: template.id,
                        name: template.name,
                        style_type: template.style_type,
                        is_active: template.is_active,
                        created_at: template.created_at,
                        version: template.version
                    }))
                }
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get QML statistics'
            });
        }
    };
    /**
     * Clone QML template
     */
    cloneQmlTemplate = async (request, reply) => {
        try {
            const { templateId } = request.params;
            const { name, description } = request.body;
            const userId = request.user?.id || 1;
            const originalTemplate = await this.qmlParserService.getQmlTemplate(parseInt(templateId));
            if (!originalTemplate) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'QML template not found'
                });
                return;
            }
            const clonedTemplate = await this.qmlParserService.createQmlTemplate(name || `${originalTemplate.name} (Copy)`, description || `${originalTemplate.description || ''} (Cloned)`, originalTemplate.qml_content, originalTemplate.style_type, userId);
            reply.status(201).send({
                data: clonedTemplate,
                message: 'QML template cloned successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to clone QML template'
            });
        }
    };
    /**
     * Preview QML template
     */
    previewQmlTemplate = async (request, reply) => {
        try {
            const { templateId } = request.params;
            const template = await this.qmlParserService.getQmlTemplate(parseInt(templateId));
            if (!template) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'QML template not found'
                });
                return;
            }
            const parsedConfig = template.parsed_config;
            // Create a preview representation
            const preview = {
                id: template.id,
                name: template.name,
                style_type: template.style_type,
                version: template.version,
                symbols_count: parsedConfig.symbols?.length || 0,
                layers_count: parsedConfig.symbols?.reduce((sum, symbol) => sum + (symbol.layers?.length || 0), 0) || 0,
                has_data_defined_properties: !!parsedConfig.dataDefinedProperties,
                renderer_type: parsedConfig.rendererType,
                symbols: parsedConfig.symbols?.slice(0, 3).map((symbol, index) => ({
                    index: index + 1,
                    type: symbol.type,
                    name: symbol.name,
                    layers_count: symbol.layers?.length || 0,
                    alpha: symbol.alpha,
                    clip_to_extent: symbol.clipToExtent
                })) || []
            };
            reply.send({
                data: preview,
                message: 'QML template preview generated successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to preview QML template'
            });
        }
    };
}
exports.QmlParserController = QmlParserController;
//# sourceMappingURL=qmlParserController.js.map