-- Development Application Schema Migration
-- Creates tables for the map-centric development application system

-- Ensure Supabase-style roles referenced by the RLS/GRANT block below exist
-- on vanilla Postgres (Render). NOLOGIN since auth is enforced at the app
-- layer via JWT; these roles exist only so GRANTs and RLS policies parse.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated_users') THEN
        CREATE ROLE authenticated_users NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_users') THEN
        CREATE ROLE admin_users NOLOGIN;
    END IF;
END
$$;

-- Main development applications table
CREATE TABLE IF NOT EXISTS development_applications (
    id VARCHAR(20) PRIMARY KEY,                    -- Format: DEV-123456
    user_id VARCHAR(50) NOT NULL,                  -- User who submitted
    selection_data JSONB NOT NULL,                 -- Selected parcel information
    eligibility_data JSONB NOT NULL,               -- Eligibility analysis results
    form_data JSONB NOT NULL,                      -- Application form data
    fees_data JSONB,                               -- Calculated fees information
    status VARCHAR(50) DEFAULT 'submitted',        -- Application status
    submitted_at TIMESTAMP WITH TIME ZONE,         -- Submission timestamp
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Application documents table
CREATE TABLE IF NOT EXISTS application_documents (
    id SERIAL PRIMARY KEY,
    application_id VARCHAR(20) NOT NULL REFERENCES development_applications(id) ON DELETE CASCADE,
    document_name VARCHAR(255) NOT NULL,
    document_type VARCHAR(100) NOT NULL,
    file_size BIGINT,
    file_url TEXT,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Application timeline/history table
CREATE TABLE IF NOT EXISTS application_timeline (
    id SERIAL PRIMARY KEY,
    application_id VARCHAR(20) NOT NULL REFERENCES development_applications(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,              -- submitted, status_change, review, etc.
    event_description TEXT,
    event_date TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Application comments table
CREATE TABLE IF NOT EXISTS application_comments (
    id SERIAL PRIMARY KEY,
    application_id VARCHAR(20) NOT NULL REFERENCES development_applications(id) ON DELETE CASCADE,
    comment_text TEXT NOT NULL,
    is_internal BOOLEAN DEFAULT FALSE,            -- Internal staff comments vs public
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Draft applications table
CREATE TABLE IF NOT EXISTS application_drafts (
    id VARCHAR(25) PRIMARY KEY,                   -- Format: DRAFT-123456
    user_id VARCHAR(50) NOT NULL,
    draft_data JSONB NOT NULL,                    -- All draft data
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_development_applications_user_id ON development_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_development_applications_status ON development_applications(status);
CREATE INDEX IF NOT EXISTS idx_development_applications_submitted_at ON development_applications(submitted_at);
CREATE INDEX IF NOT EXISTS idx_development_applications_selection_data ON development_applications USING GIN(selection_data);
CREATE INDEX IF NOT EXISTS idx_development_applications_form_data ON development_applications USING GIN(form_data);

CREATE INDEX IF NOT EXISTS idx_application_documents_application_id ON application_documents(application_id);
CREATE INDEX IF NOT EXISTS idx_application_documents_type ON application_documents(document_type);

CREATE INDEX IF NOT EXISTS idx_application_timeline_application_id ON application_timeline(application_id);
CREATE INDEX IF NOT EXISTS idx_application_timeline_date ON application_timeline(event_date);

CREATE INDEX IF NOT EXISTS idx_application_comments_application_id ON application_comments(application_id);
CREATE INDEX IF NOT EXISTS idx_application_comments_internal ON application_comments(is_internal);

CREATE INDEX IF NOT EXISTS idx_application_drafts_user_id ON application_drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_application_drafts_updated_at ON application_drafts(updated_at);

-- Triggers to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_development_applications_updated_at 
    BEFORE UPDATE ON development_applications 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_application_drafts_updated_at 
    BEFORE UPDATE ON application_drafts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Views for common queries
CREATE OR REPLACE VIEW application_summary AS
SELECT 
    da.id,
    da.user_id,
    da.status,
    da.submitted_at,
    da.updated_at,
    (da.selection_data->>'name_cfu') as parcel_name,
    (da.selection_data->>'parcel_id') as parcel_id,
    (da.form_data->>'applicantName') as applicant_name,
    (da.form_data->>'contactEmail') as contact_email,
    (da.form_data->>'developmentType') as development_type,
    (da.fees_data->>'total')::DECIMAL as total_fees,
    (SELECT COUNT(*) FROM application_documents ad WHERE ad.application_id = da.id) as document_count
FROM development_applications da;

-- Application status enum type for consistency
CREATE TYPE application_status AS ENUM (
    'draft',
    'submitted',
    'under_review',
    'requires_more_info',
    'approved',
    'rejected',
    'withdrawn'
);

-- Function to get application statistics
CREATE OR REPLACE FUNCTION get_application_statistics(
    start_date TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    end_date TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    status_filter VARCHAR DEFAULT NULL
)
RETURNS TABLE (
    total_applications BIGINT,
    submitted_count BIGINT,
    under_review_count BIGINT,
    approved_count BIGINT,
    rejected_count BIGINT,
    requires_info_count BIGINT,
    avg_fees DECIMAL,
    avg_processing_days DECIMAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*)::BIGINT,
        COUNT(CASE WHEN da.status = 'submitted' THEN 1 END)::BIGINT,
        COUNT(CASE WHEN da.status = 'under_review' THEN 1 END)::BIGINT,
        COUNT(CASE WHEN da.status = 'approved' THEN 1 END)::BIGINT,
        COUNT(CASE WHEN da.status = 'rejected' THEN 1 END)::BIGINT,
        COUNT(CASE WHEN da.status = 'requires_more_info' THEN 1 END)::BIGINT,
        AVG((da.fees_data->>'total')::DECIMAL),
        AVG(EXTRACT(DAY FROM (da.updated_at - da.submitted_at)))
    FROM development_applications da
    WHERE 
        (start_date IS NULL OR da.submitted_at >= start_date)
        AND (end_date IS NULL OR da.submitted_at <= end_date)
        AND (status_filter IS NULL OR da.status = status_filter);
END;
$$ LANGUAGE plpgsql;

-- Function to search applications
CREATE OR REPLACE FUNCTION search_applications(
    search_query TEXT,
    status_filter VARCHAR DEFAULT NULL,
    limit_count INTEGER DEFAULT 20,
    offset_count INTEGER DEFAULT 0
)
RETURNS TABLE (
    id VARCHAR,
    status VARCHAR,
    submitted_at TIMESTAMP WITH TIME ZONE,
    parcel_name VARCHAR,
    applicant_name VARCHAR,
    total_fees DECIMAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        da.id,
        da.status,
        da.submitted_at,
        (da.selection_data->>'name_cfu') as parcel_name,
        (da.form_data->>'applicantName') as applicant_name,
        (da.fees_data->>'total')::DECIMAL as total_fees
    FROM development_applications da
    WHERE 
        (
            da.id ILIKE '%' || search_query || '%' OR
            (da.form_data->>'applicantName') ILIKE '%' || search_query || '%' OR
            (da.selection_data->>'name_cfu') ILIKE '%' || search_query || '%' OR
            (da.selection_data->>'parcel_id') ILIKE '%' || search_query || '%'
        )
        AND (status_filter IS NULL OR da.status = status_filter)
    ORDER BY da.submitted_at DESC
    LIMIT limit_count
    OFFSET offset_count;
END;
$$ LANGUAGE plpgsql;

-- Row Level Security (RLS) for multi-tenant isolation
ALTER TABLE development_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_drafts ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own applications
CREATE POLICY user_applications_policy ON development_applications
    FOR ALL TO authenticated_users
    USING (user_id = current_user_id());

-- Policy: Users can only see their own drafts
CREATE POLICY user_drafts_policy ON application_drafts
    FOR ALL TO authenticated_users
    USING (user_id = current_user_id());

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON development_applications TO authenticated_users;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_documents TO authenticated_users;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_timeline TO authenticated_users;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_comments TO authenticated_users;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_drafts TO authenticated_users;

GRANT SELECT ON application_summary TO authenticated_users;
GRANT EXECUTE ON FUNCTION get_application_statistics TO authenticated_users;
GRANT EXECUTE ON FUNCTION search_applications TO authenticated_users;

-- Admin permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON development_applications TO admin_users;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_documents TO admin_users;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_timeline TO admin_users;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_comments TO admin_users;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_drafts TO admin_users;

GRANT SELECT ON application_summary TO admin_users;
GRANT EXECUTE ON FUNCTION get_application_statistics TO admin_users;
GRANT EXECUTE ON FUNCTION search_applications TO admin_users;

-- Sample data for testing (optional)
-- INSERT INTO development_applications (
--     id, user_id, selection_data, eligibility_data, form_data, fees_data, status, submitted_at
-- ) VALUES (
--     'DEV-000001',
--     'test-user',
--     '{"parcel_id": "12345", "name_cfu": "Test Parcel", "area_hectares": 0.5}',
--     '{"eligible": true, "zoneName": "Estates", "zoneOverlap": 85.5}',
--     '{"applicantName": "John Doe", "contactEmail": "john@example.com"}',
--     '{"application": 500, "planning": 25, "processing": 200, "total": 725}',
--     'submitted',
--     NOW()
-- );

COMMIT;

-- Log migration completion
DO $$
BEGIN
    RAISE NOTICE '✅ Development application schema migration completed successfully';
    RAISE NOTICE '📊 Tables created: development_applications, application_documents, application_timeline, application_comments, application_drafts';
    RAISE NOTICE '🔍 Indexes and triggers created for performance';
    RAISE NOTICE '🔐 Row Level Security enabled for multi-tenant isolation';
    RAISE NOTICE '📈 Statistics and search functions created';
END $$;
