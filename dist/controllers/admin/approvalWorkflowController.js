"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApprovalWorkflowController = void 0;
const approvalWorkflowService_1 = require("../../services/admin/approvalWorkflowService");
class ApprovalWorkflowController {
    approvalWorkflowService;
    constructor(pool) {
        this.approvalWorkflowService = new approvalWorkflowService_1.ApprovalWorkflowService(pool);
    }
    /**
     * Create a new approval workflow
     */
    createWorkflow = async (request, reply) => {
        try {
            const { name, description, workflow_type, steps } = request.body;
            const userId = request.user?.id || 1;
            // Validate input
            if (!name || !workflow_type || !steps) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required fields: name, workflow_type, steps'
                });
                return;
            }
            const validTypes = ['data_upload', 'style_change', 'batch_process'];
            if (!validTypes.includes(workflow_type)) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: `Invalid workflow type. Must be one of: ${validTypes.join(', ')}`
                });
                return;
            }
            // Validate workflow configuration
            const validation = this.approvalWorkflowService.validateWorkflowConfig(steps);
            if (!validation.valid) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Invalid workflow configuration',
                    errors: validation.errors
                });
                return;
            }
            const workflow = await this.approvalWorkflowService.createWorkflow(name, description || '', workflow_type, steps, userId);
            reply.status(201).send({
                data: workflow,
                message: 'Approval workflow created successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to create approval workflow'
            });
        }
    };
    /**
     * Get workflow by ID
     */
    getWorkflow = async (request, reply) => {
        try {
            const { workflowId } = request.params;
            const workflow = await this.approvalWorkflowService.getWorkflow(parseInt(workflowId));
            if (!workflow) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Approval workflow not found'
                });
                return;
            }
            reply.send({
                data: workflow
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get approval workflow'
            });
        }
    };
    /**
     * Get all workflows
     */
    getWorkflows = async (request, reply) => {
        try {
            const { workflow_type } = request.query;
            const workflows = await this.approvalWorkflowService.getWorkflows(workflow_type);
            reply.send({
                data: workflows,
                summary: {
                    total: workflows.length,
                    by_type: {
                        data_upload: workflows.filter(w => w.workflow_type === 'data_upload').length,
                        style_change: workflows.filter(w => w.workflow_type === 'style_change').length,
                        batch_process: workflows.filter(w => w.workflow_type === 'batch_process').length
                    }
                }
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get approval workflows'
            });
        }
    };
    /**
     * Update workflow
     */
    updateWorkflow = async (request, reply) => {
        try {
            const { workflowId } = request.params;
            const updates = request.body;
            const existingWorkflow = await this.approvalWorkflowService.getWorkflow(parseInt(workflowId));
            if (!existingWorkflow) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Approval workflow not found'
                });
                return;
            }
            // If steps are being updated, validate them
            if (updates.steps) {
                const validation = this.approvalWorkflowService.validateWorkflowConfig(updates.steps);
                if (!validation.valid) {
                    reply.status(400).send({
                        error: 'Bad Request',
                        message: 'Invalid workflow configuration',
                        errors: validation.errors
                    });
                    return;
                }
            }
            const updatedWorkflow = await this.approvalWorkflowService.updateWorkflow(parseInt(workflowId), updates);
            reply.send({
                data: updatedWorkflow,
                message: 'Approval workflow updated successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to update approval workflow'
            });
        }
    };
    /**
     * Delete workflow
     */
    deleteWorkflow = async (request, reply) => {
        try {
            const { workflowId } = request.params;
            const existingWorkflow = await this.approvalWorkflowService.getWorkflow(parseInt(workflowId));
            if (!existingWorkflow) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Approval workflow not found'
                });
                return;
            }
            await this.approvalWorkflowService.deleteWorkflow(parseInt(workflowId));
            reply.send({
                message: 'Approval workflow deleted successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to delete approval workflow'
            });
        }
    };
    /**
     * Create a new approval request
     */
    createApprovalRequest = async (request, reply) => {
        try {
            const { workflow_id, request_type, entity_type, entity_id, title, description, request_data } = request.body;
            const userId = request.user?.id || 1;
            // Validate input
            if (!workflow_id || !request_type || !entity_type || !entity_id || !title) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required fields: workflow_id, request_type, entity_type, entity_id, title'
                });
                return;
            }
            const approvalRequest = await this.approvalWorkflowService.createApprovalRequest(workflow_id, request_type, entity_type, entity_id, title, description || '', request_data || {}, userId);
            reply.status(201).send({
                data: approvalRequest,
                message: 'Approval request created successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to create approval request'
            });
        }
    };
    /**
     * Get approval request by ID
     */
    getApprovalRequest = async (request, reply) => {
        try {
            const { requestId } = request.params;
            const approvalRequest = await this.approvalWorkflowService.getApprovalRequest(parseInt(requestId));
            if (!approvalRequest) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Approval request not found'
                });
                return;
            }
            // Get approval actions
            const actions = await this.approvalWorkflowService.getApprovalActions(parseInt(requestId));
            reply.send({
                data: {
                    ...approvalRequest,
                    actions
                }
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get approval request'
            });
        }
    };
    /**
     * Get all approval requests
     */
    getApprovalRequests = async (request, reply) => {
        try {
            const { status, workflow_type, limit = 50, offset = 0 } = request.query;
            const requests = await this.approvalWorkflowService.getApprovalRequests(status, workflow_type, parseInt(limit), parseInt(offset));
            reply.send({
                data: requests,
                pagination: {
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    total: requests.length
                }
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get approval requests'
            });
        }
    };
    /**
     * Add approval action to a request
     */
    addApprovalAction = async (request, reply) => {
        try {
            const { requestId } = request.params;
            const { action_type, comments, action_data } = request.body;
            const userId = request.user?.id || 1;
            // Validate input
            if (!action_type) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required field: action_type'
                });
                return;
            }
            const validActions = ['approve', 'reject', 'request_changes', 'comment'];
            if (!validActions.includes(action_type)) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: `Invalid action type. Must be one of: ${validActions.join(', ')}`
                });
                return;
            }
            // Get current request to determine step
            const currentRequest = await this.approvalWorkflowService.getApprovalRequest(parseInt(requestId));
            if (!currentRequest) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Approval request not found'
                });
                return;
            }
            const action = await this.approvalWorkflowService.addApprovalAction(parseInt(requestId), currentRequest.current_step, action_type, userId, comments, action_data);
            reply.status(201).send({
                data: action,
                message: 'Approval action added successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to add approval action'
            });
        }
    };
    /**
     * Get pending requests for current user
     */
    getPendingRequests = async (request, reply) => {
        try {
            const user = request.user;
            if (!user) {
                reply.status(401).send({
                    error: 'Unauthorized',
                    message: 'Authentication required'
                });
                return;
            }
            const pendingRequests = await this.approvalWorkflowService.getPendingRequests(user.id, user.role);
            reply.send({
                data: pendingRequests,
                summary: {
                    total: pendingRequests.length,
                    by_type: {
                        data_upload: pendingRequests.filter(r => r.request_type === 'data_upload').length,
                        style_change: pendingRequests.filter(r => r.request_type === 'style_change').length,
                        batch_process: pendingRequests.filter(r => r.request_type === 'batch_process').length
                    }
                }
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get pending requests'
            });
        }
    };
    /**
     * Cancel approval request
     */
    cancelApprovalRequest = async (request, reply) => {
        try {
            const { requestId } = request.params;
            const userId = request.user?.id || 1;
            const existingRequest = await this.approvalWorkflowService.getApprovalRequest(parseInt(requestId));
            if (!existingRequest) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Approval request not found'
                });
                return;
            }
            if (!['pending', 'in_review'].includes(existingRequest.status)) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Can only cancel pending or in-review requests'
                });
                return;
            }
            await this.approvalWorkflowService.cancelApprovalRequest(parseInt(requestId), userId);
            reply.send({
                message: 'Approval request cancelled successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to cancel approval request'
            });
        }
    };
    /**
     * Get workflow statistics
     */
    getWorkflowStatistics = async (request, reply) => {
        try {
            const statistics = await this.approvalWorkflowService.getWorkflowStatistics();
            reply.send({
                data: statistics
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get workflow statistics'
            });
        }
    };
    /**
     * Clone workflow
     */
    cloneWorkflow = async (request, reply) => {
        try {
            const { workflowId } = request.params;
            const { name } = request.body;
            const userId = request.user?.id || 1;
            const originalWorkflow = await this.approvalWorkflowService.getWorkflow(parseInt(workflowId));
            if (!originalWorkflow) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Approval workflow not found'
                });
                return;
            }
            const clonedWorkflow = await this.approvalWorkflowService.cloneWorkflow(parseInt(workflowId), name || `${originalWorkflow.name} (Copy)`, userId);
            reply.status(201).send({
                data: clonedWorkflow,
                message: 'Approval workflow cloned successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to clone approval workflow'
            });
        }
    };
    /**
     * Get user's approval history
     */
    getUserApprovalHistory = async (request, reply) => {
        try {
            const user = request.user;
            if (!user) {
                reply.status(401).send({
                    error: 'Unauthorized',
                    message: 'Authentication required'
                });
                return;
            }
            const history = await this.approvalWorkflowService.getUserApprovalHistory(user.id);
            reply.send({
                data: history,
                summary: {
                    total: history.length,
                    by_action: {
                        approve: history.filter(h => h.action_type === 'approve').length,
                        reject: history.filter(h => h.action_type === 'reject').length,
                        request_changes: history.filter(h => h.action_type === 'request_changes').length,
                        comment: history.filter(h => h.action_type === 'comment').length
                    }
                }
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get user approval history'
            });
        }
    };
}
exports.ApprovalWorkflowController = ApprovalWorkflowController;
//# sourceMappingURL=approvalWorkflowController.js.map