-- Security Audit System Migration
-- Creates tables and indexes for comprehensive security monitoring

-- Security Audit Log Table
CREATE TABLE IF NOT EXISTS security_audit_log (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip_address INET NOT NULL,
    user_agent TEXT,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Security Metrics Summary Table (for faster dashboard loading)
CREATE TABLE IF NOT EXISTS security_metrics_summary (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    total_events INTEGER DEFAULT 0,
    failed_logins INTEGER DEFAULT 0,
    suspicious_activities INTEGER DEFAULT 0,
    unique_ips INTEGER DEFAULT 0,
    top_event_type VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(date)
);

-- Blocked IPs Table
CREATE TABLE IF NOT EXISTS blocked_ips (
    id SERIAL PRIMARY KEY,
    ip_address INET NOT NULL UNIQUE,
    reason TEXT NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    blocked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    created_by INTEGER REFERENCES users(id),
    notes TEXT
);

-- Security Events Configuration
CREATE TABLE IF NOT EXISTS security_event_types (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL UNIQUE,
    description TEXT NOT NULL,
    default_severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_security_audit_created_at ON security_audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_security_audit_event_type ON security_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_security_audit_severity ON security_audit_log(severity);
CREATE INDEX IF NOT EXISTS idx_security_audit_ip_address ON security_audit_log(ip_address);
CREATE INDEX IF NOT EXISTS idx_security_audit_user_id ON security_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_security_audit_composite ON security_audit_log(created_at, event_type, severity);

CREATE INDEX IF NOT EXISTS idx_blocked_ips_ip_address ON blocked_ips(ip_address);
CREATE INDEX IF NOT EXISTS idx_blocked_ips_active ON blocked_ips(is_active);
CREATE INDEX IF NOT EXISTS idx_blocked_ips_expires_at ON blocked_ips(expires_at);

CREATE INDEX IF NOT EXISTS idx_security_metrics_date ON security_metrics_summary(date);

-- Insert default security event types
INSERT INTO security_event_types (event_type, description, default_severity) VALUES
('LOGIN_SUCCESS', 'User successfully logged in', 'low'),
('LOGIN_FAILED', 'Failed login attempt', 'medium'),
('LOGOUT', 'User logged out', 'low'),
('API_CALL', 'API endpoint called', 'low'),
('SUSPICIOUS_PATTERN', 'Suspicious pattern detected in request', 'high'),
('SUSPICIOUS_LOGIN_PATTERN', 'Multiple failed logins from same IP', 'high'),
('SUSPICIOUS_API_PATTERN', 'Unusual API call pattern detected', 'medium'),
('RATE_LIMIT_EXCEEDED', 'Rate limit exceeded', 'medium'),
('BLOCKED_IP', 'Request from blocked IP address', 'high'),
('SECURITY_VIOLATION', 'Security policy violation', 'critical'),
('DATA_BREACH_ATTEMPT', 'Attempted unauthorized data access', 'critical'),
('PRIVILEGE_ESCALATION', 'Attempted privilege escalation', 'critical')
ON CONFLICT (event_type) DO NOTHING;

-- Function to automatically clean up old audit logs
CREATE OR REPLACE FUNCTION cleanup_old_security_audit_logs()
RETURNS void AS $$
BEGIN
    -- Delete logs older than 90 days, except critical events
    DELETE FROM security_audit_log 
    WHERE created_at < NOW() - INTERVAL '90 days' 
    AND severity != 'critical';
    
    -- Delete blocked IPs that have expired
    DELETE FROM blocked_ips 
    WHERE expires_at IS NOT NULL 
    AND expires_at < NOW();
    
    -- Update metrics summary
    INSERT INTO security_metrics_summary (date, total_events, failed_logins, suspicious_activities, unique_ips, top_event_type)
    SELECT 
        created_at::date,
        COUNT(*) as total_events,
        COUNT(*) FILTER (WHERE event_type = 'LOGIN_FAILED') as failed_logins,
        COUNT(*) FILTER (WHERE severity IN ('high', 'critical')) as suspicious_activities,
        COUNT(DISTINCT ip_address) as unique_ips,
        mode() WITHIN GROUP (ORDER BY event_type) as top_event_type
    FROM security_audit_log 
    WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
    GROUP BY created_at::date
    ON CONFLICT (date) 
    DO UPDATE SET
        total_events = EXCLUDED.total_events,
        failed_logins = EXCLUDED.failed_logins,
        suspicious_activities = EXCLUDED.suspicious_activities,
        unique_ips = EXCLUDED.unique_ips,
        top_event_type = EXCLUDED.top_event_type,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Create a trigger to automatically update the updated_at column
CREATE OR REPLACE FUNCTION update_security_metrics_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER security_metrics_updated_at_trigger
    BEFORE UPDATE ON security_metrics_summary
    FOR EACH ROW
    EXECUTE FUNCTION update_security_metrics_updated_at();

-- Schedule the cleanup function to run daily (requires pg_cron extension)
-- SELECT cron.schedule('cleanup-security-logs', '0 2 * * *', 'SELECT cleanup_old_security_audit_logs();');

-- Grant permissions to the application user
-- GRANT SELECT, INSERT, UPDATE ON security_audit_log TO vungu_app;
-- GRANT SELECT, INSERT, UPDATE ON security_metrics_summary TO vungu_app;
-- GRANT SELECT, INSERT, UPDATE ON blocked_ips TO vungu_app;
-- GRANT SELECT ON security_event_types TO vungu_app;

-- Grant usage on sequences
-- GRANT USAGE, SELECT ON SEQUENCE security_audit_log_id_seq TO vungu_app;
-- GRANT USAGE, SELECT ON SEQUENCE blocked_ips_id_seq TO vungu_app;
-- GRANT USAGE, SELECT ON SEQUENCE security_event_types_id_seq TO vungu_app;

COMMENT ON TABLE security_audit_log IS 'Comprehensive audit log for all security-related events';
COMMENT ON TABLE security_metrics_summary IS 'Daily summary of security metrics for dashboard performance';
COMMENT ON TABLE blocked_ips IS 'IP addresses that have been blocked due to suspicious activity';
COMMENT ON TABLE security_event_types IS 'Configuration of security event types and their default severity levels';

COMMENT ON COLUMN security_audit_log.event_type IS 'Type of security event (LOGIN_SUCCESS, API_CALL, etc.)';
COMMENT ON COLUMN security_audit_log.severity IS 'Severity level: low, medium, high, critical';
COMMENT ON COLUMN security_audit_log.ip_address IS 'Client IP address in INET format';
COMMENT ON COLUMN security_audit_log.details IS 'Additional event details in JSONB format';
COMMENT ON COLUMN blocked_ips.expires_at IS 'When the IP block expires (NULL for permanent blocks)';
