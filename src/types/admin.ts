// Admin-specific types for Vungu Master Backend

export interface AdminUser {
  id: number;
  email: string;
  password_hash?: string;
  role: 'super_admin' | 'data_manager' | 'style_manager' | 'viewer';
  permissions: string[];
  first_name?: string;
  last_name?: string;
  is_active: boolean;
  last_login?: string;
  created_at: string;
  updated_at: string;
}

export interface IngestionJob {
  id: number;
  job_name: string;
  job_type: 'shapefile' | 'geojson' | 'csv' | 'kml' | 'geopackage';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  file_path?: string;
  file_size?: number;
  config: Record<string, any>;
  results: Record<string, any>;
  errors: any[];
  progress: Record<string, any>;
  started_at?: string;
  completed_at?: string;
  created_by?: number;
  created_at: string;
  updated_at: string;
}

export interface StyleTemplate {
  id: number;
  name: string;
  description?: string;
  geometry_type: 'point' | 'line' | 'polygon';
  style_config: Record<string, any>;
  is_active: boolean;
  created_by?: number;
  created_at: string;
  updated_at: string;
}

export interface ValidationRule {
  id: number;
  name: string;
  description?: string;
  rule_type: 'geometry' | 'attribute' | 'topology';
  geometry_type?: 'point' | 'line' | 'polygon';
  rule_config: Record<string, any>;
  is_active: boolean;
  created_by?: number;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  old_values?: Record<string, any>;
  new_values?: Record<string, any>;
  user_id?: number;
  ip_address?: string;
  user_agent?: string;
  session_id?: string;
  created_at: string;
}

// Phase 2 Types

export interface DataCleaningJob {
  id: number;
  job_id: number;
  cleaning_type: 'duplicate_detection' | 'geometry_validation' | 'attribute_standardization';
  status: 'pending' | 'running' | 'completed' | 'failed';
  config: CleaningConfig;
  results: CleaningResult;
  errors: any[];
  started_at?: string;
  completed_at?: string;
  created_by?: number;
  created_at: string;
  updated_at: string;
}

export interface CleaningConfig {
  layerId: number;
  tolerance?: number;
  attributes?: string[];
  standardization_rules?: Record<string, any>;
  [key: string]: any;
}

export interface CleaningResult {
  total_features: number;
  duplicates_found: number;
  issues_fixed: number;
  processing_time: number;
  [key: string]: any;
}

export interface CleaningIssue {
  id: number;
  job_id: number;
  feature_id: string;
  issue_type: 'duplicate' | 'invalid_geometry' | 'missing_attribute' | 'inconsistent_format';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  suggested_fix?: string;
  original_data: Record<string, any>;
  corrected_data?: Record<string, any>;
  status: 'pending' | 'reviewed' | 'fixed' | 'ignored';
  created_at: string;
}

export interface QmlStyleTemplate {
  id: number;
  name: string;
  description?: string;
  qml_content: string;
  parsed_config: ParsedQmlConfig;
  style_type: 'point' | 'line' | 'polygon' | 'raster';
  version: string;
  is_active: boolean;
  created_by?: number;
  created_at: string;
  updated_at: string;
}

export interface ParsedQmlConfig {
  rendererType: string;
  symbols: any[];
  layers: any[];
  labels: any[];
  legend: any;
  properties: any;
  dataDefinedProperties?: any;
}

export interface StyleComponent {
  id: number;
  template_id: number;
  component_type: 'symbol' | 'color' | 'label' | 'legend';
  component_name: string;
  properties: Record<string, any>;
  is_required: boolean;
  default_value?: Record<string, any>;
  created_at: string;
}

export interface ApprovalWorkflow {
  id: number;
  name: string;
  description?: string;
  workflow_type: 'data_upload' | 'style_change' | 'batch_process';
  steps: WorkflowStep[];
  is_active: boolean;
  created_by?: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowStep {
  step: number;
  name: string;
  role: string;
  required: boolean;
  conditions: string[];
}

export interface ApprovalRequest {
  id: number;
  workflow_id: number;
  request_type: 'data_upload' | 'style_change' | 'batch_process';
  entity_type: 'ingestion_job' | 'qml_template' | 'batch_job';
  entity_id: number;
  title: string;
  description?: string;
  request_data: Record<string, any>;
  status: 'pending' | 'in_review' | 'approved' | 'rejected' | 'cancelled';
  current_step: number;
  total_steps: number;
  requested_by?: number;
  created_at: string;
  updated_at: string;
}

export interface ApprovalAction {
  id: number;
  request_id: number;
  step_number: number;
  action_type: 'approve' | 'reject' | 'request_changes' | 'comment';
  action_by?: number;
  comments?: string;
  action_data: Record<string, any>;
  created_at: string;
}

export interface BatchJob {
  id: number;
  name: string;
  description?: string;
  job_type: 'data_cleaning' | 'style_application' | 'bulk_import' | 'bulk_export';
  status: 'pending' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  config: BatchJobConfig;
  progress: Record<string, any>;
  results: Record<string, any>;
  errors: any[];
  scheduled_at?: string;
  started_at?: string;
  completed_at?: string;
  created_by?: number;
  created_at: string;
  updated_at: string;
}

export interface BatchJobConfig {
  [key: string]: any;
}

export interface BatchJobItem {
  id: number;
  batch_job_id: number;
  item_type: 'file' | 'record' | 'task';
  item_id: string;
  item_data: Record<string, any>;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  result: Record<string, any>;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
}

export interface AuditLogPhase2 {
  id: number;
  entity_type: string;
  entity_id: number;
  action_type: string;
  action_details: Record<string, any>;
  user_id?: number;
  ip_address?: string;
  user_agent?: string;
  session_id?: string;
  created_at: string;
}

// API Response Types
export interface ApiResponse<T = any> {
  data?: T;
  message?: string;
  error?: string;
  pagination?: {
    limit: number;
    offset: number;
    total: number;
  };
}

export interface PaginatedResponse<T = any> extends ApiResponse<T> {
  pagination: {
    limit: number;
    offset: number;
    total: number;
    has_more: boolean;
  };
}

// Authentication Types
export interface LoginCredentials {
  email: string;
  password: string;
  mfaCode?: string;
}

export interface AuthResponse {
  token: string;
  refreshToken: string;
  user: AdminUser;
}

export interface JwtPayload {
  id: number;
  email: string;
  role: string;
  permissions: string[];
  iat: number;
  exp: number;
}

// Request/Response Types for API
export interface CreateCleaningJobRequest {
  jobId: number;
  cleaningType: string;
  config: CleaningConfig;
}

export interface UpdateCleaningIssueRequest {
  status: string;
}

export interface CreateQmlTemplateRequest {
  name: string;
  description?: string;
  qml_content: string;
  style_type: string;
}

export interface CreateApprovalRequestRequest {
  workflow_id: number;
  request_type: string;
  entity_type: string;
  entity_id: number;
  title: string;
  description?: string;
  request_data: Record<string, any>;
}

export interface CreateBatchJobRequest {
  name: string;
  description?: string;
  job_type: string;
  priority?: number;
  config: Record<string, any>;
  scheduled_at?: string;
}

export interface ApprovalActionRequest {
  action_type: string;
  comments?: string;
  action_data?: Record<string, any>;
}

// Utility Types
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface FileUploadOptions {
  maxSize: number;
  allowedTypes: string[];
  destination: string;
}

export interface ProcessingOptions {
  timeout: number;
  retries: number;
  batchSize: number;
}
