import { Pool } from 'pg';
import { BaseService } from './baseService';
import { ApprovalWorkflow, ApprovalRequest, ApprovalAction, WorkflowStep } from '../../types/admin';
export declare class ApprovalWorkflowService extends BaseService {
    constructor(pool: Pool);
    /**
     * Validate service-specific tables
     */
    protected validateServiceTables(): Promise<void>;
    /**
     * Validate workflow configuration
     */
    validateWorkflowConfig(steps: WorkflowStep[]): {
        valid: boolean;
        errors: string[];
    };
    /**
     * Create a new approval workflow
     */
    createWorkflow(name: string, description: string, workflowType: string, steps: WorkflowStep[], createdBy: number): Promise<ApprovalWorkflow>;
    /**
     * Create a new approval request
     */
    createApprovalRequest(workflowId: number, requestType: string, entityType: string, entityId: number, title: string, description: string, requestData: any, requestedBy: number): Promise<ApprovalRequest>;
    /**
     * Add approval action to a request
     */
    addApprovalAction(requestId: number, stepNumber: number, actionType: string, actionBy: number, comments?: string, actionData?: any): Promise<ApprovalAction>;
    /**
     * Get workflow by ID
     */
    getWorkflow(workflowId: number): Promise<ApprovalWorkflow | null>;
    /**
     * Get all workflows
     */
    getWorkflows(workflowType?: string): Promise<ApprovalWorkflow[]>;
    /**
     * Get approval request by ID
     */
    getApprovalRequest(requestId: number): Promise<ApprovalRequest | null>;
    /**
     * Get all approval requests
     */
    getApprovalRequests(status?: string, workflowType?: string, limit?: number, offset?: number): Promise<ApprovalRequest[]>;
    /**
     * Get approval actions for a request
     */
    getApprovalActions(requestId: number): Promise<ApprovalAction[]>;
    /**
     * Update request status based on action
     */
    private updateRequestStatus;
    /**
     * Get pending requests for a user
     */
    getPendingRequests(userId: number, userRole: string): Promise<ApprovalRequest[]>;
    /**
     * Get workflow statistics
     */
    getWorkflowStatistics(): Promise<any>;
    /**
     * Update workflow
     */
    updateWorkflow(workflowId: number, updates: Partial<ApprovalWorkflow>): Promise<ApprovalWorkflow>;
    /**
     * Delete workflow (soft delete)
     */
    deleteWorkflow(workflowId: number): Promise<void>;
    /**
     * Cancel approval request
     */
    cancelApprovalRequest(requestId: number, cancelledBy: number): Promise<void>;
    /**
     * Get user's approval history
     */
    getUserApprovalHistory(userId: number): Promise<any[]>;
    /**
     * Clone workflow
     */
    cloneWorkflow(workflowId: number, newName: string, createdBy: number): Promise<ApprovalWorkflow>;
}
//# sourceMappingURL=approvalWorkflowService.d.ts.map