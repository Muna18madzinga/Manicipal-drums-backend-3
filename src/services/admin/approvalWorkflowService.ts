import { Pool } from 'pg';
import { BaseService } from './baseService';
import { 
  ApprovalWorkflow,
  ApprovalRequest,
  ApprovalAction,
  WorkflowStep
} from '../../types/admin';

export class ApprovalWorkflowService extends BaseService {
  constructor(pool: Pool) {
    super(pool, 'ApprovalWorkflowService');
  }

  /**
   * Validate service-specific tables
   */
  protected async validateServiceTables(): Promise<void> {
    const tables = ['approval_workflows', 'approval_requests', 'approval_actions'];
    
    for (const table of tables) {
      const exists = await this.tableExists(table);
      if (exists) {
        const count = await this.getTableRowCount(table);
        console.log(`   ✅ ${table}: ${count} rows`);
      } else {
        console.warn(`   ❌ ${table}: Table not found`);
      }
    }
  }

  /**
   * Validate workflow configuration
   */
  validateWorkflowConfig(steps: WorkflowStep[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!Array.isArray(steps)) {
      errors.push('Steps must be an array');
      return { valid: false, errors };
    }
    
    if (steps.length === 0) {
      errors.push('At least one step is required');
      return { valid: false, errors };
    }
    
    // Check for duplicate step numbers
    const stepNumbers = steps.map(s => s.step);
    const uniqueSteps = Array.from(new Set(stepNumbers));
    if (stepNumbers.length !== uniqueSteps.length) {
      errors.push('Duplicate step numbers found');
    }
    
    // Validate each step
    steps.forEach((step, index) => {
      if (!step.name || typeof step.name !== 'string') {
        errors.push(`Step ${index + 1}: Name is required and must be a string`);
      }
      
      if (!step.role || typeof step.role !== 'string') {
        errors.push(`Step ${index + 1}: Role is required and must be a string`);
      }
      
      if (typeof step.step !== 'number' || step.step < 1) {
        errors.push(`Step ${index + 1}: Step number must be a positive number`);
      }
      
      if (step.conditions && !Array.isArray(step.conditions)) {
        errors.push(`Step ${index + 1}: Conditions must be an array`);
      }
    });
    
    return { valid: errors.length === 0, errors };
  }

  /**
   * Create a new approval workflow
   */
  async createWorkflow(
    name: string,
    description: string,
    workflowType: string,
    steps: WorkflowStep[],
    createdBy: number
  ): Promise<ApprovalWorkflow> {
    try {
      const query = `
        INSERT INTO approval_workflows (name, description, workflow_type, steps, created_by)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        RETURNING *
      `;
      
      const values = [name, description, workflowType, JSON.stringify(steps), createdBy];
      const result = await this.safeQuery(query, values);
      
      return result.rows[0];
    } catch (error) {
      return this.handleError(error, 'createWorkflow');
    }
  }

  /**
   * Create a new approval request
   */
  async createApprovalRequest(
    workflowId: number,
    requestType: string,
    entityType: string,
    entityId: number,
    title: string,
    description: string,
    requestData: any,
    requestedBy: number
  ): Promise<ApprovalRequest> {
    // Get workflow to determine steps
    const workflow = await this.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error('Workflow not found');
    }

    const query = `
      INSERT INTO approval_requests (
        workflow_id, request_type, entity_type, entity_id, 
        title, description, request_data, status, 
        current_step, total_steps, requested_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    
    const values = [
      workflowId,
      requestType,
      entityType,
      entityId,
      title,
      description,
      requestData,
      'pending',
      1,
      workflow.steps.length,
      requestedBy
    ];
    
    const result = await this.pool.query(query, values);
    return result.rows[0];
  }

  /**
   * Add approval action to a request
   */
  async addApprovalAction(
    requestId: number,
    stepNumber: number,
    actionType: string,
    actionBy: number,
    comments?: string,
    actionData?: any
  ): Promise<ApprovalAction> {
    const query = `
      INSERT INTO approval_actions (
        request_id, step_number, action_type, action_by, comments, action_data
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    
    const values = [requestId, stepNumber, actionType, actionBy, comments, actionData];
    const result = await this.pool.query(query, values);
    
    // Update request status based on action
    await this.updateRequestStatus(requestId, actionType, stepNumber);
    
    return result.rows[0];
  }

  /**
   * Get workflow by ID
   */
  async getWorkflow(workflowId: number): Promise<ApprovalWorkflow | null> {
    const result = await this.pool.query(
      'SELECT * FROM approval_workflows WHERE id = $1',
      [workflowId]
    );
    
    return result.rows[0] || null;
  }

  /**
   * Get all workflows
   */
  async getWorkflows(workflowType?: string): Promise<ApprovalWorkflow[]> {
    let query = 'SELECT * FROM approval_workflows WHERE is_active = true';
    const params: any[] = [];
    
    if (workflowType) {
      query += ' AND workflow_type = $1';
      params.push(workflowType);
    }
    
    query += ' ORDER BY name';
    
    const result = await this.pool.query(query, params);
    return result.rows;
  }

  /**
   * Get approval request by ID
   */
  async getApprovalRequest(requestId: number): Promise<ApprovalRequest | null> {
    const query = `
      SELECT ar.*, aw.name as workflow_name, aw.steps as workflow_steps
      FROM approval_requests ar
      LEFT JOIN approval_workflows aw ON ar.workflow_id = aw.id
      WHERE ar.id = $1
    `;
    
    const result = await this.pool.query(query, [requestId]);
    return result.rows[0] || null;
  }

  /**
   * Get all approval requests
   */
  async getApprovalRequests(
    status?: string,
    workflowType?: string,
    limit = 50,
    offset = 0
  ): Promise<ApprovalRequest[]> {
    let query = `
      SELECT ar.*, aw.name as workflow_name, aw.workflow_type
      FROM approval_requests ar
      LEFT JOIN approval_workflows aw ON ar.workflow_id = aw.id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND ar.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (workflowType) {
      query += ` AND aw.workflow_type = $${paramIndex}`;
      params.push(workflowType);
      paramIndex++;
    }

    query += ' ORDER BY ar.created_at DESC LIMIT $' + paramIndex + ' OFFSET $' + (paramIndex + 1);
    params.push(limit, offset);
    
    const result = await this.pool.query(query, params);
    return result.rows;
  }

  /**
   * Get approval actions for a request
   */
  async getApprovalActions(requestId: number): Promise<ApprovalAction[]> {
    const query = `
      SELECT aa.*, au.first_name, au.last_name, au.email
      FROM approval_actions aa
      LEFT JOIN admin_users au ON aa.action_by = au.id
      WHERE aa.request_id = $1
      ORDER BY aa.step_number ASC, aa.created_at ASC
    `;
    
    const result = await this.pool.query(query, [requestId]);
    return result.rows;
  }

  /**
   * Update request status based on action
   */
  private async updateRequestStatus(requestId: number, actionType: string, stepNumber: number): Promise<void> {
    const request = await this.getApprovalRequest(requestId);
    if (!request) return;

    const workflow = await this.getWorkflow(request.workflow_id);
    if (!workflow) return;

    let newStatus = request.status;
    let newStep = request.current_step;

    switch (actionType) {
      case 'approve':
        if (stepNumber >= workflow.steps.length) {
          newStatus = 'approved';
        } else {
          newStatus = 'in_review';
          newStep = stepNumber + 1;
        }
        break;
      case 'reject':
        newStatus = 'rejected';
        break;
      case 'request_changes':
        newStatus = 'in_review';
        break;
      case 'comment':
        // Comments don't change status
        break;
    }

    const updateQuery = `
      UPDATE approval_requests 
      SET status = $1, current_step = $2, updated_at = NOW()
      WHERE id = $3
    `;
    
    await this.pool.query(updateQuery, [newStatus, newStep, requestId]);
  }

  /**
   * Get pending requests for a user
   */
  async getPendingRequests(userId: number, userRole: string): Promise<ApprovalRequest[]> {
    const query = `
      SELECT ar.*, aw.name as workflow_name, aw.workflow_type, aw.steps
      FROM approval_requests ar
      LEFT JOIN approval_workflows aw ON ar.workflow_id = aw.id
      WHERE ar.status IN ('pending', 'in_review')
      AND aw.is_active = true
      ORDER BY ar.created_at ASC
    `;
    
    const result = await this.pool.query(query);
    const allRequests = result.rows;
    
    // Filter requests where user's role matches the current step
    const filteredRequests = allRequests.filter(request => {
      const steps = request.steps as WorkflowStep[];
      const currentStep = steps[request.current_step - 1];
      return currentStep && currentStep.role === userRole;
    });
    
    return filteredRequests;
  }

  /**
   * Get workflow statistics
   */
  async getWorkflowStatistics(): Promise<any> {
    const workflowsQuery = 'SELECT * FROM approval_workflows WHERE is_active = true';
    const workflowsResult = await this.pool.query(workflowsQuery);
    const workflows = workflowsResult.rows;

    const requestsQuery = 'SELECT * FROM approval_requests';
    const requestsResult = await this.pool.query(requestsQuery);
    const requests = requestsResult.rows;

    const totalWorkflows = workflows.length;
    const activeWorkflows = workflows.filter(w => w.is_active).length;
    const totalRequests = requests.length;
    const pendingRequests = requests.filter(r => r.status === 'pending').length;
    const inReviewRequests = requests.filter(r => r.status === 'in_review').length;
    const approvedRequests = requests.filter(r => r.status === 'approved').length;
    const rejectedRequests = requests.filter(r => r.status === 'rejected').length;

    const requestsByType = {
      data_upload: requests.filter(r => r.request_type === 'data_upload').length,
      style_change: requests.filter(r => r.request_type === 'style_change').length,
      batch_process: requests.filter(r => r.request_type === 'batch_process').length
    };

    const workflowsByType = {
      data_upload: workflows.filter(w => w.workflow_type === 'data_upload').length,
      style_change: workflows.filter(w => w.workflow_type === 'style_change').length,
      batch_process: workflows.filter(w => w.workflow_type === 'batch_process').length
    };

    // Calculate average approval time
    const completedRequests = requests.filter(r => r.status === 'approved' && r.completed_at);
    const avgApprovalTime = completedRequests.length > 0 
      ? completedRequests.reduce((sum, r) => {
          const created = new Date(r.created_at).getTime();
          const completed = new Date(r.completed_at!).getTime();
          return sum + (completed - created);
        }, 0) / completedRequests.length / (1000 * 60 * 60) // Convert to hours
      : 0;

    return {
      overview: {
        total_workflows: totalWorkflows,
        active_workflows: activeWorkflows,
        total_requests: totalRequests,
        pending_requests: pendingRequests,
        in_review_requests: inReviewRequests,
        approved_requests: approvedRequests,
        rejected_requests: rejectedRequests,
        approval_rate: totalRequests > 0 ? (approvedRequests / totalRequests * 100).toFixed(2) : 0,
        avg_approval_time_hours: avgApprovalTime.toFixed(2)
      },
      by_type: {
        workflows: workflowsByType,
        requests: requestsByType
      },
      recent_requests: requests.slice(0, 5).map(request => ({
        id: request.id,
        title: request.title,
        request_type: request.request_type,
        status: request.status,
        current_step: request.current_step,
        total_steps: request.total_steps,
        created_at: request.created_at,
        requested_by: request.requested_by
      }))
    };
  }

  /**
   * Update workflow
   */
  async updateWorkflow(
    workflowId: number,
    updates: Partial<ApprovalWorkflow>
  ): Promise<ApprovalWorkflow> {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (key !== 'id' && key !== 'created_at' && key !== 'updated_at') {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    fields.push(`updated_at = NOW()`);
    values.push(workflowId);

    const query = `
      UPDATE approval_workflows 
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await this.pool.query(query, values);
    return result.rows[0];
  }

  /**
   * Delete workflow (soft delete)
   */
  async deleteWorkflow(workflowId: number): Promise<void> {
    await this.pool.query(
      'UPDATE approval_workflows SET is_active = false WHERE id = $1',
      [workflowId]
    );
  }

  /**
   * Cancel approval request
   */
  async cancelApprovalRequest(requestId: number, cancelledBy: number): Promise<void> {
    const query = `
      UPDATE approval_requests 
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
    `;
    
    await this.pool.query(query, [requestId]);
    
    // Add cancellation action
    await this.addApprovalAction(
      requestId,
      0, // Step 0 for cancellation
      'cancel',
      cancelledBy,
      'Request cancelled'
    );
  }

  /**
   * Get user's approval history
   */
  async getUserApprovalHistory(userId: number): Promise<any[]> {
    const query = `
      SELECT aa.*, ar.title, ar.request_type, ar.status as request_status
      FROM approval_actions aa
      LEFT JOIN approval_requests ar ON aa.request_id = ar.id
      WHERE aa.action_by = $1
      ORDER BY aa.created_at DESC
      LIMIT 50
    `;
    
    const result = await this.pool.query(query, [userId]);
    return result.rows;
  }

  /**
   * Clone workflow
   */
  async cloneWorkflow(
    workflowId: number,
    newName: string,
    createdBy: number
  ): Promise<ApprovalWorkflow> {
    const originalWorkflow = await this.getWorkflow(workflowId);
    if (!originalWorkflow) {
      throw new Error('Original workflow not found');
    }

    const clonedWorkflow = await this.createWorkflow(
      newName,
      `${originalWorkflow.description || ''} (Cloned)`,
      originalWorkflow.workflow_type,
      originalWorkflow.steps,
      createdBy
    );

    return clonedWorkflow;
  }
}
