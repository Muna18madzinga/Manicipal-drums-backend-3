import { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
export declare class ApprovalWorkflowController {
    private approvalWorkflowService;
    constructor(pool: Pool);
    /**
     * Create a new approval workflow
     */
    createWorkflow: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get workflow by ID
     */
    getWorkflow: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get all workflows
     */
    getWorkflows: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Update workflow
     */
    updateWorkflow: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Delete workflow
     */
    deleteWorkflow: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Create a new approval request
     */
    createApprovalRequest: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get approval request by ID
     */
    getApprovalRequest: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get all approval requests
     */
    getApprovalRequests: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Add approval action to a request
     */
    addApprovalAction: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get pending requests for current user
     */
    getPendingRequests: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Cancel approval request
     */
    cancelApprovalRequest: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get workflow statistics
     */
    getWorkflowStatistics: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Clone workflow
     */
    cloneWorkflow: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get user's approval history
     */
    getUserApprovalHistory: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}
//# sourceMappingURL=approvalWorkflowController.d.ts.map