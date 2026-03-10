"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBatchProcessingRoutes = createBatchProcessingRoutes;
const batchProcessingController_1 = require("../../controllers/admin/batchProcessingController");
function createBatchProcessingRoutes(server, pool) {
    const batchProcessingController = new batchProcessingController_1.BatchProcessingController(pool);
    // Create a new batch job
    server.post('/batch/jobs', {
        schema: {
            description: 'Create a new batch job',
            tags: ['Batch Processing'],
            body: {
                type: 'object',
                required: ['name', 'job_type'],
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    job_type: {
                        type: 'string',
                        enum: ['data_cleaning', 'style_application', 'bulk_import', 'bulk_export']
                    },
                    config: { type: 'object' },
                    priority: { type: 'number', default: 1 },
                    scheduled_at: { type: 'string', format: 'date-time' }
                }
            }
        }
    }, batchProcessingController.createBatchJob);
    // Get batch job by ID
    server.get('/batch/jobs/:jobId', {
        schema: {
            description: 'Get batch job by ID',
            tags: ['Batch Processing'],
            params: {
                type: 'object',
                required: ['jobId'],
                properties: {
                    jobId: { type: 'number' }
                }
            }
        }
    }, batchProcessingController.getBatchJob);
    // Get all batch jobs
    server.get('/batch/jobs', {
        schema: {
            description: 'Get all batch jobs',
            tags: ['Batch Processing'],
            querystring: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        enum: ['pending', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled']
                    },
                    job_type: {
                        type: 'string',
                        enum: ['data_cleaning', 'style_application', 'bulk_import', 'bulk_export']
                    },
                    limit: { type: 'number', default: 50 },
                    offset: { type: 'number', default: 0 }
                }
            }
        }
    }, batchProcessingController.getBatchJobs);
    // Start batch job
    server.post('/batch/jobs/:jobId/start', {
        schema: {
            description: 'Start batch job',
            tags: ['Batch Processing'],
            params: {
                type: 'object',
                required: ['jobId'],
                properties: {
                    jobId: { type: 'number' }
                }
            }
        }
    }, batchProcessingController.startBatchJob);
    // Cancel batch job
    server.post('/batch/jobs/:jobId/cancel', {
        schema: {
            description: 'Cancel batch job',
            tags: ['Batch Processing'],
            params: {
                type: 'object',
                required: ['jobId'],
                properties: {
                    jobId: { type: 'number' }
                }
            }
        }
    }, batchProcessingController.cancelBatchJob);
    // Pause batch job
    server.post('/batch/jobs/:jobId/pause', {
        schema: {
            description: 'Pause batch job',
            tags: ['Batch Processing'],
            params: {
                type: 'object',
                required: ['jobId'],
                properties: {
                    jobId: { type: 'number' }
                }
            }
        }
    }, batchProcessingController.pauseBatchJob);
    // Resume batch job
    server.post('/batch/jobs/:jobId/resume', {
        schema: {
            description: 'Resume batch job',
            tags: ['Batch Processing'],
            params: {
                type: 'object',
                required: ['jobId'],
                properties: {
                    jobId: { type: 'number' }
                }
            }
        }
    }, batchProcessingController.resumeBatchJob);
    // Retry failed items
    server.post('/batch/jobs/:jobId/retry', {
        schema: {
            description: 'Retry failed batch job items',
            tags: ['Batch Processing'],
            params: {
                type: 'object',
                required: ['jobId'],
                properties: {
                    jobId: { type: 'number' }
                }
            }
        }
    }, batchProcessingController.retryFailedItems);
    // Add items to batch job
    server.post('/batch/jobs/:jobId/items', {
        schema: {
            description: 'Add items to batch job',
            tags: ['Batch Processing'],
            params: {
                type: 'object',
                required: ['jobId'],
                properties: {
                    jobId: { type: 'number' }
                }
            },
            body: {
                type: 'object',
                required: ['items'],
                properties: {
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['item_type', 'item_id', 'item_data'],
                            properties: {
                                item_type: {
                                    type: 'string',
                                    enum: ['file', 'record', 'task']
                                },
                                item_id: { type: 'string' },
                                item_data: { type: 'object' }
                            }
                        }
                    }
                }
            }
        }
    }, batchProcessingController.addBatchJobItems);
    // Get batch job items
    server.get('/batch/jobs/:jobId/items', {
        schema: {
            description: 'Get batch job items',
            tags: ['Batch Processing'],
            params: {
                type: 'object',
                required: ['jobId'],
                properties: {
                    jobId: { type: 'number' }
                }
            },
            querystring: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        enum: ['pending', 'processing', 'completed', 'failed', 'skipped']
                    },
                    limit: { type: 'number', default: 100 },
                    offset: { type: 'number', default: 0 }
                }
            }
        }
    }, batchProcessingController.getBatchJobItems);
    // Get batch processing statistics
    server.get('/batch/statistics', {
        schema: {
            description: 'Get batch processing statistics',
            tags: ['Batch Processing']
        }
    }, batchProcessingController.getBatchStatistics);
    // Create bulk import job
    server.post('/batch/jobs/bulk-import', {
        schema: {
            description: 'Create bulk import job',
            tags: ['Batch Processing'],
            body: {
                type: 'object',
                required: ['name', 'files'],
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    files: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                name: { type: 'string' },
                                path: { type: 'string' },
                                size: { type: 'number' },
                                type: { type: 'string' }
                            }
                        }
                    },
                    config: { type: 'object' }
                }
            }
        }
    }, batchProcessingController.createBulkImportJob);
    // Create bulk export job
    server.post('/batch/jobs/bulk-export', {
        schema: {
            description: 'Create bulk export job',
            tags: ['Batch Processing'],
            body: {
                type: 'object',
                required: ['name', 'layers', 'format'],
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    layers: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'number' },
                                name: { type: 'string' },
                                type: { type: 'string' },
                                filters: { type: 'object' }
                            }
                        }
                    },
                    format: {
                        type: 'string',
                        enum: ['geojson', 'shapefile', 'kml', 'csv']
                    },
                    config: { type: 'object' }
                }
            }
        }
    }, batchProcessingController.createBulkExportJob);
    // Create data cleaning job
    server.post('/batch/jobs/data-cleaning', {
        schema: {
            description: 'Create data cleaning job',
            tags: ['Batch Processing'],
            body: {
                type: 'object',
                required: ['name', 'layer_id', 'cleaning_operations'],
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    layer_id: { type: 'number' },
                    cleaning_operations: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                type: {
                                    type: 'string',
                                    enum: ['duplicate_detection', 'geometry_validation', 'attribute_standardization']
                                },
                                parameters: { type: 'object' }
                            }
                        }
                    },
                    config: { type: 'object' }
                }
            }
        }
    }, batchProcessingController.createDataCleaningJob);
    // Create style application job
    server.post('/batch/jobs/style-application', {
        schema: {
            description: 'Create style application job',
            tags: ['Batch Processing'],
            body: {
                type: 'object',
                required: ['name', 'template_id', 'layers'],
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    template_id: { type: 'number' },
                    layers: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'number' },
                                name: { type: 'string' },
                                style_config: { type: 'object' }
                            }
                        }
                    },
                    config: { type: 'object' }
                }
            }
        }
    }, batchProcessingController.createStyleApplicationJob);
}
//# sourceMappingURL=batchProcessing.js.map