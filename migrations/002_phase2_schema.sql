-- Phase 2 Database Schema Extensions
-- Advanced Features: Data Cleaning, QML Parser, Approval Workflows, Batch Processing

-- 1. Advanced Data Cleaning Tables
CREATE TABLE IF NOT EXISTS data_cleaning_jobs (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
    cleaning_type VARCHAR(50) NOT NULL, -- 'duplicate_detection', 'geometry_validation', 'attribute_standardization'
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
    config JSONB NOT NULL DEFAULT '{}',
    results JSONB NOT NULL DEFAULT '{}',
    errors JSONB DEFAULT '[]',
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_by INTEGER REFERENCES admin_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cleaning_issues (
    id SERIAL PRIMARY KEY,
    job_id INTEGER REFERENCES data_cleaning_jobs(id) ON DELETE CASCADE,
    feature_id VARCHAR(100),
    issue_type VARCHAR(50) NOT NULL, -- 'duplicate', 'invalid_geometry', 'missing_attribute', 'inconsistent_format'
    severity VARCHAR(20) DEFAULT 'medium', -- 'low', 'medium', 'high', 'critical'
    description TEXT NOT NULL,
    suggested_fix TEXT,
    original_data JSONB,
    corrected_data JSONB,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'reviewed', 'fixed', 'ignored'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. QML Parser and Style Management
CREATE TABLE IF NOT EXISTS qml_style_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    qml_content TEXT NOT NULL,
    parsed_config JSONB NOT NULL DEFAULT '{}',
    style_type VARCHAR(50) NOT NULL, -- 'point', 'line', 'polygon', 'raster'
    version VARCHAR(20) DEFAULT '1.0',
    is_active BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES admin_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS style_components (
    id SERIAL PRIMARY KEY,
    template_id INTEGER REFERENCES qml_style_templates(id) ON DELETE CASCADE,
    component_type VARCHAR(50) NOT NULL, -- 'symbol', 'color', 'label', 'legend'
    component_name VARCHAR(100) NOT NULL,
    properties JSONB NOT NULL DEFAULT '{}',
    is_required BOOLEAN DEFAULT false,
    default_value JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Approval Workflow System
CREATE TABLE IF NOT EXISTS approval_workflows (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    workflow_type VARCHAR(50) NOT NULL, -- 'data_upload', 'style_change', 'batch_process'
    steps JSONB NOT NULL DEFAULT '[]', -- Array of workflow steps with roles and conditions
    is_active BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES admin_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_requests (
    id SERIAL PRIMARY KEY,
    workflow_id INTEGER REFERENCES approval_workflows(id),
    request_type VARCHAR(50) NOT NULL, -- 'data_upload', 'style_change', 'batch_process'
    entity_type VARCHAR(50) NOT NULL, -- 'ingestion_job', 'qml_template', 'batch_job'
    entity_id INTEGER NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    request_data JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'in_review', 'approved', 'rejected', 'cancelled'
    current_step INTEGER DEFAULT 1,
    total_steps INTEGER DEFAULT 1,
    requested_by INTEGER REFERENCES admin_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approval_actions (
    id SERIAL PRIMARY KEY,
    request_id INTEGER REFERENCES approval_requests(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    action_type VARCHAR(20) NOT NULL, -- 'approve', 'reject', 'request_changes', 'comment'
    action_by INTEGER REFERENCES admin_users(id),
    comments TEXT,
    action_data JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Batch Processing System
CREATE TABLE IF NOT EXISTS batch_jobs (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    job_type VARCHAR(50) NOT NULL, -- 'data_cleaning', 'style_application', 'bulk_import', 'bulk_export'
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'queued', 'running', 'completed', 'failed', 'cancelled'
    priority INTEGER DEFAULT 5, -- 1-10, 1 being highest
    config JSONB NOT NULL DEFAULT '{}',
    progress JSONB NOT NULL DEFAULT '{"total": 0, "completed": 0, "failed": 0, "percentage": 0}',
    results JSONB DEFAULT '{}',
    errors JSONB DEFAULT '[]',
    scheduled_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_by INTEGER REFERENCES admin_users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS batch_job_items (
    id SERIAL PRIMARY KEY,
    batch_job_id INTEGER REFERENCES batch_jobs(id) ON DELETE CASCADE,
    item_type VARCHAR(50) NOT NULL, -- 'file', 'record', 'task'
    item_id VARCHAR(100) NOT NULL,
    item_data JSONB DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed', 'skipped'
    result JSONB DEFAULT '{}',
    error_message TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Enhanced Audit Logging for Phase 2
CREATE TABLE IF NOT EXISTS audit_logs_phase2 (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL,
    entity_id INTEGER NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    action_details JSONB NOT NULL DEFAULT '{}',
    user_id INTEGER REFERENCES admin_users(id),
    ip_address INET,
    user_agent TEXT,
    session_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_data_cleaning_jobs_job_id ON data_cleaning_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_data_cleaning_jobs_status ON data_cleaning_jobs(status);
CREATE INDEX IF NOT EXISTS idx_cleaning_issues_job_id ON cleaning_issues(job_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_issues_status ON cleaning_issues(status);
CREATE INDEX IF NOT EXISTS idx_qml_style_templates_type ON qml_style_templates(style_type);
CREATE INDEX IF NOT EXISTS idx_qml_style_templates_active ON qml_style_templates(is_active);
CREATE INDEX IF NOT EXISTS idx_style_components_template_id ON style_components(template_id);
CREATE INDEX IF NOT EXISTS idx_approval_workflows_type ON approval_workflows(workflow_type);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_entity ON approval_requests(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_approval_actions_request_id ON approval_actions(request_id);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_priority ON batch_jobs(priority);
CREATE INDEX IF NOT EXISTS idx_batch_job_items_batch_job_id ON batch_job_items(batch_job_id);
CREATE INDEX IF NOT EXISTS idx_batch_job_items_status ON batch_job_items(status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_phase2_entity ON audit_logs_phase2(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_phase2_created_at ON audit_logs_phase2(created_at);

-- 7. Triggers for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_data_cleaning_jobs_updated_at BEFORE UPDATE ON data_cleaning_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_qml_style_templates_updated_at BEFORE UPDATE ON qml_style_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_approval_workflows_updated_at BEFORE UPDATE ON approval_workflows FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_approval_requests_updated_at BEFORE UPDATE ON approval_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_batch_jobs_updated_at BEFORE UPDATE ON batch_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 8. Insert default Phase 2 data
INSERT INTO approval_workflows (name, description, workflow_type, steps, created_by) VALUES
(
    'Data Upload Approval',
    'Standard workflow for approving data uploads',
    'data_upload',
    '[
        {
            "step": 1,
            "name": "Data Validation",
            "role": "data_manager",
            "required": true,
            "conditions": ["data_quality_check", "schema_validation"]
        },
        {
            "step": 2,
            "name": "Style Review",
            "role": "style_manager",
            "required": false,
            "conditions": ["style_applicability"]
        },
        {
            "step": 3,
            "name": "Final Approval",
            "role": "super_admin",
            "required": true,
            "conditions": ["compliance_check"]
        }
    ]'::jsonb,
    1
),
(
    'Style Template Approval',
    'Workflow for approving new QML style templates',
    'style_change',
    '[
        {
            "step": 1,
            "name": "Style Validation",
            "role": "style_manager",
            "required": true,
            "conditions": ["qml_syntax_check", "style_completeness"]
        },
        {
            "step": 2,
            "name": "Final Approval",
            "role": "super_admin",
            "required": true,
            "conditions": ["standards_compliance"]
        }
    ]'::jsonb,
    1
),
(
    'Batch Processing Approval',
    'Workflow for approving large batch processing jobs',
    'batch_process',
    '[
        {
            "step": 1,
            "name": "Resource Review",
            "role": "data_manager",
            "required": true,
            "conditions": ["resource_availability", "impact_assessment"]
        },
        {
            "step": 2,
            "name": "Final Approval",
            "role": "super_admin",
            "required": true,
            "conditions": ["system_load_check"]
        }
    ]'::jsonb,
    1
)
ON CONFLICT (name) DO NOTHING;

-- 9. Create default QML style templates
INSERT INTO qml_style_templates (name, description, qml_content, parsed_config, style_type, created_by) VALUES
(
    'Default Point Style',
    'Basic point style with red circle marker',
    '<?xml version="1.0" encoding="UTF-8"?>
<qml xmlns="http://www.qgis.org/qml/2.0">
  <renderer-v2 type="singleSymbol" symbollevels="0" enableorderby="0">
    <symbols>
      <symbol type="marker" name="symbol0" clip_to_extent="1" force_rhr="0" alpha="1">
        <layer class="SimpleMarker" pass="0" enabled="1" locked="0">
          <prop k="angle" v="0"/>
          <prop k="color" v="255,0,0,255"/>
          <prop k="horizontal_anchor_point" v="1"/>
          <prop k="joinstyle" v="bevel"/>
          <prop k="name" v="circle"/>
          <prop k="offset" v="0,0"/>
          <prop k="offset_map_unit_scale" v="3x:0,0,0,0,0,0"/>
          <prop k="offset_unit" v="MM"/>
          <prop k="outline_color" v="0,0,0,255"/>
          <prop k="outline_style" v="solid"/>
          <prop k="outline_width" v="0"/>
          <prop k="outline_width_map_unit_scale" v="3x:0,0,0,0,0,0"/>
          <prop k="outline_width_unit" v="MM"/>
          <prop k="scale_method" v="diameter"/>
          <prop k="size" v="2"/>
          <prop k="size_map_unit_scale" v="3x:0,0,0,0,0,0"/>
          <prop k="size_unit" v="MM"/>
          <prop k="vertical_anchor_point" v="1"/>
          <data_defined_properties>
            <Option type="Map">
              <Option type="QString" name="name" value=""/>
              <Option name="properties"/>
              <Option type="QString" name="type" value="collection"/>
            </Option>
          </data_defined_properties>
        </layer>
      </symbol>
    </symbols>
    <rotation/>
    <sizescale/>
  </renderer-v2>
</qml>',
    '{
        "symbol": {
            "type": "marker",
            "color": "255,0,0,255",
            "size": 2,
            "outline_color": "0,0,0,255",
            "outline_width": 0,
            "name": "circle"
        }
    }'::jsonb,
    'point',
    1
),
(
    'Default Line Style',
    'Basic line style with solid blue stroke',
    '<?xml version="1.0" encoding="UTF-8"?>
<qml xmlns="http://www.qgis.org/qml/2.0">
  <renderer-v2 type="singleSymbol" symbollevels="0" enableorderby="0">
    <symbols>
      <symbol type="line" name="symbol0" clip_to_extent="1" force_rhr="0" alpha="1">
        <layer class="SimpleLine" pass="0" enabled="1" locked="0">
          <prop k="capstyle" v="square"/>
          <prop k="customdash" v="5;2"/>
          <prop k="customdash_map_unit_scale" v="3x:0,0,0,0,0,0"/>
          <prop k="customdash_unit" v="MM"/>
          <prop k="dash_pattern_offset" v="0"/>
          <prop k="dash_pattern_offset_map_unit_scale" v="3x:0,0,0,0,0,0"/>
          <prop k="dash_pattern_offset_unit" v="MM"/>
          <prop k="draw_inside_polygon" v="0"/>
          <prop k="joinstyle" v="bevel"/>
          <prop k="line_color" v="0,0,255,255"/>
          <prop k="line_style" v="solid"/>
          <prop k="line_width" v="0.26"/>
          <prop k="line_width_unit" v="MM"/>
          <prop k="offset" v="0"/>
          <prop k="offset_map_unit_scale" v="3x:0,0,0,0,0,0"/>
          <prop k="offset_unit" v="MM"/>
          <prop k="ring_filter" v="0"/>
          <prop k="use_custom_dash" v="0"/>
          <prop k="width_map_unit_scale" v="3x:0,0,0,0,0,0"/>
          <data_defined_properties>
            <Option type="Map">
              <Option type="QString" name="name" value=""/>
              <Option name="properties"/>
              <Option type="QString" name="type" value="collection"/>
            </Option>
          </data_defined_properties>
        </layer>
      </symbol>
    </symbols>
    <rotation/>
    <sizescale/>
  </renderer-v2>
</qml>',
    '{
        "symbol": {
            "type": "line",
            "color": "0,0,255,255",
            "width": 0.26,
            "style": "solid",
            "capstyle": "square",
            "joinstyle": "bevel"
        }
    }'::jsonb,
    'line',
    1
),
(
    'Default Polygon Style',
    'Basic polygon style with green fill and black outline',
    '<?xml version="1.0" encoding="UTF-8"?>
<qml xmlns="http://www.qgis.org/qml/2.0">
  <renderer-v2 type="singleSymbol" symbollevels="0" enableorderby="0">
    <symbols>
      <symbol type="fill" name="symbol0" clip_to_extent="1" force_rhr="0" alpha="1">
        <layer class="SimpleFill" pass="0" enabled="1" locked="0">
          <prop k="border_width_map_unit_scale" v="3x:0,0,0,0,0,0"/>
          <prop k="color" v="0,255,0,255"/>
          <prop k="joinstyle" v="bevel"/>
          <prop k="offset" v="0,0"/>
          <prop k="offset_map_unit_scale" v="3x:0,0,0,0,0,0"/>
          <prop k="offset_unit" v="MM"/>
          <prop k="outline_color" v="0,0,0,255"/>
          <prop k="outline_style" v="solid"/>
          <prop k="outline_width" v="0.26"/>
          <prop k="outline_width_unit" v="MM"/>
          <prop k="style" v="solid"/>
          <data_defined_properties>
            <Option type="Map">
              <Option type="QString" name="name" value=""/>
              <Option name="properties"/>
              <Option type="QString" name="type" value="collection"/>
            </Option>
          </data_defined_properties>
        </layer>
      </symbol>
    </symbols>
    <rotation/>
    <sizescale/>
  </renderer-v2>
</qml>',
    '{
        "symbol": {
            "type": "fill",
            "color": "0,255,0,255",
            "outline_color": "0,0,0,255",
            "outline_width": 0.26,
            "style": "solid"
        }
    }'::jsonb,
    'polygon',
    1
)
ON CONFLICT (name) DO NOTHING;

-- 10. Add Phase 2 permissions to existing admin users
UPDATE admin_users SET permissions = permissions || '{
    "data_cleaning.create",
    "data_cleaning.read", 
    "data_cleaning.update",
    "data_cleaning.delete",
    "qml_templates.create",
    "qml_templates.read",
    "qml_templates.update", 
    "qml_templates.delete",
    "workflows.create",
    "workflows.read",
    "workflows.update",
    "workflows.delete",
    "batch_jobs.create",
    "batch_jobs.read",
    "batch_jobs.update",
    "batch_jobs.delete"
}' WHERE role = 'super_admin';

COMMENT ON TABLE data_cleaning_jobs IS 'Jobs for advanced data cleaning operations';
COMMENT ON TABLE cleaning_issues IS 'Issues detected during data cleaning processes';
COMMENT ON TABLE qml_style_templates IS 'QML style templates with parsed configuration';
COMMENT ON TABLE style_components IS 'Individual components within QML style templates';
COMMENT ON TABLE approval_workflows IS 'Configurable approval workflows for different processes';
COMMENT ON TABLE approval_requests IS 'Individual approval requests following workflow steps';
COMMENT ON TABLE approval_actions IS 'Actions taken on approval requests';
COMMENT ON TABLE batch_jobs IS 'Batch processing jobs with queue management';
COMMENT ON TABLE batch_job_items IS 'Individual items within batch jobs';
COMMENT ON TABLE audit_logs_phase2 IS 'Enhanced audit logging for Phase 2 features';
