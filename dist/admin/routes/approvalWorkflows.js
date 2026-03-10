"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApprovalWorkflowRoutes = createApprovalWorkflowRoutes;
const approvalWorkflowController_1 = require("../../controllers/admin/approvalWorkflowController");
function createApprovalWorkflowRoutes(server, pool) {
    const approvalWorkflowController = new approvalWorkflowController_1.ApprovalWorkflowController(pool);
    // Create a new approval workflow
    server.post('/workflows', {
        schema: {
            description: 'Create a new approval workflow',
            tags: ['Approval Workflows'],
            body: {
                type: 'object',
                required: ['name', 'workflow_type', 'steps'],
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    workflow_type: {
                        type: 'string',
                        enum: ['data_upload', 'style_change', 'batch_process']
                    },
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['step', 'name', 'role'],
                            properties: {
                                step: { type: 'number' },
                                name: { type: 'string' },
                                role: { type: 'string' },
                                required: { type: 'boolean' },
                                conditions: {
                                    type: 'array',
                                    items: { type: 'string' }
                                }
                            }
                        }
                    }
                }
            }
        }
    }, approvalWorkflowController.createWorkflow);
    // Get workflow by ID
    server.get('/workflows/:workflowId', {
        schema: {
            description: 'Get approval workflow by ID',
            tags: ['Approval Workflows'],
            params: {
                type: 'object',
                required: ['workflowId'],
                properties: {
                    workflowId: { type: 'number' }
                }
            }
        }
    }, approvalWorkflowController.getWorkflow);
    // Get all workflows
    server.get('/workflows', {
        schema: {
            description: 'Get all approval workflows',
            tags: ['Approval Workflows'],
            querystring: {
                type: 'object',
                properties: {
                    workflow_type: {
                        type: 'string',
                        enum: ['data_upload', 'style_change', 'batch_process']
                    }
                }
            }
        }
    }, approvalWorkflowController.getWorkflows);
    // Update workflow
    server.put('/workflows/:workflowId', {
        schema: {
            description: 'Update approval workflow',
            tags: ['Approval Workflows'],
            params: {
                type: 'object',
                required: ['workflowId'],
                properties: {
                    workflowId: { type: 'number' }
                }
            },
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    workflow_type: {
                        type: 'string',
                        enum: ['data_upload', 'style_change', 'batch_process']
                    },
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['step', 'name', 'role'],
                            properties: {
                                step: { type: 'number' },
                                name: { type: 'string' },
                                role: { type: 'string' },
                                required: { type: 'boolean' },
                                conditions: {
                                    type: 'array',
                                    items: { type: 'string' }
                                }
                            }
                        }
                    },
                    is_active: { type: 'boolean' }
                }
            }
        }
    }, approvalWorkflowController.updateWorkflow);
    // Delete workflow
    server.delete('/workflows/:workflowId', {
        schema: {
            description: 'Delete approval workflow',
            tags: ['Approval Workflows'],
            params: {
                type: 'object',
                required: ['workflowId'],
                properties: {
                    workflowId: { type: 'number' }
                }
            }
        }
    }, approvalWorkflowController.deleteWorkflow);
    // Clone workflow
    server.post('/workflows/:workflowId/clone', {
        schema: {
            description: 'Clone approval workflow',
            tags: ['Approval Workflows'],
            params: {
                type: 'object',
                required: ['workflowId'],
                properties: {
                    workflowId: { type: 'number' }
                }
            },
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string' }
                }
            }
        }
    }, approvalWorkflowController.cloneWorkflow);
    // Create a new approval request
    server.post('/requests', {
        schema: {
            description: 'Create a new approval request',
            tags: ['Approval Requests'],
            body: {
                type: 'object',
                required: ['workflow_id', 'request_type', 'entity_type', 'entity_id', 'title'],
                properties: {
                    workflow_id: { type: 'number' },
                    request_type: {
                        type: 'string',
                        enum: ['data_upload', 'style_change', 'batch_process']
                    },
                    entity_type: {
                        type: 'string',
                        enum: ['ingestion_job', 'qml_template', 'batch_job']
                    },
                    entity_id: { type: 'number' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    request_data: { type: 'object' }
                }
            }
        }
    }, approvalWorkflowController.createApprovalRequest);
    // Get approval request by ID
    server.get('/requests/:requestId', {
        schema: {
            description: 'Get approval request by ID',
            tags: ['Approval Requests'],
            params: {
                type: 'object',
                required: ['requestId'],
                properties: {
                    requestId: { type: 'number' }
                }
            }
        }
    }, approvalWorkflowController.getApprovalRequest);
    // Get all approval requests
    server.get('/requests', {
        schema: {
            description: 'Get all approval requests',
            tags: ['Approval Requests'],
            querystring: {
                type: 'object',
                properties: {
                    status: {
                        type: 'string',
                        enum: ['pending', 'in_review', 'approved', 'rejected', 'cancelled']
                    },
                    workflow_type: {
                        type: 'string',
                        enum: ['data_upload', 'style_change', 'batch_process']
                    },
                    limit: { type: 'number', default: 50 },
                    offset: { type: 'number', default: 0 }
                }
            }
        }
    }, approvalWorkflowController.getApprovalRequests);
    // Add approval action to a request
    server.post('/requests/:requestId/actions', {
        schema: {
            description: 'Add approval action to a request',
            tags: ['Approval Requests'],
            params: {
                type: 'object',
                required: ['requestId'],
                properties: {
                    requestId: { type: 'number' }
                }
            },
            body: {
                type: 'object',
                required: ['action_type'],
                properties: {
                    action_type: {
                        type: 'string',
                        enum: ['approve', 'reject', 'request_changes', 'comment']
                    },
                    comments: { type: 'string' },
                    action_data: { type: 'object' }
                }
            }
        }
    }, approvalWorkflowController.addApprovalAction);
    // Cancel approval request
    server.post('/requests/:requestId/cancel', {
        schema: {
            description: 'Cancel approval request',
            tags: ['Approval Requests'],
            params: {
                type: 'object',
                required: ['requestId'],
                properties: {
                    requestId: { type: 'number' }
                }
            }
        }
    }, approvalWorkflowController.cancelApprovalRequest);
    // Get pending requests for current user
    server.get('/requests/pending', {
        schema: {
            description: 'Get pending requests for current user',
            tags: ['Approval Requests']
        }
    }, approvalWorkflowController.getPendingRequests);
    // Get workflow statistics
    server.get('/workflows/statistics', {
        schema: {
            description: 'Get workflow statistics',
            tags: ['Approval Workflows']
        }
    }, approvalWorkflowController.getWorkflowStatistics);
    // Get user's approval history
    server.get('/history', {
        schema: {
            description: 'Get user\'s approval history',
            tags: ['Approval Workflows']
        }
    }, approvalWorkflowController.getUserApprovalHistory);
}
//# sourceMappingURL=approvalWorkflows.js.map