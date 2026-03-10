"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurityAuditService = void 0;
class SecurityAuditService {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    /**
     * Log a security event
     */
    async logSecurityEvent(event) {
        try {
            const query = `
        INSERT INTO security_audit_log (event_type, severity, user_id, ip_address, user_agent, details)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
            await this.pool.query(query, [
                event.event_type,
                event.severity,
                event.user_id,
                event.ip_address,
                event.user_agent,
                JSON.stringify(event.details)
            ]);
        }
        catch (error) {
            console.error('Failed to log security event:', error);
        }
    }
    /**
     * Get security metrics
     */
    async getSecurityMetrics(days = 7) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        try {
            // Get total events
            const totalQuery = `
        SELECT COUNT(*) as count 
        FROM security_audit_log 
        WHERE created_at >= $1
      `;
            const totalResult = await this.pool.query(totalQuery, [since]);
            const totalEvents = parseInt(totalResult.rows[0].count);
            // Get events by type
            const typeQuery = `
        SELECT event_type, COUNT(*) as count
        FROM security_audit_log 
        WHERE created_at >= $1
        GROUP BY event_type
      `;
            const typeResult = await this.pool.query(typeQuery, [since]);
            const eventsByType = typeResult.rows.reduce((acc, row) => {
                acc[row.event_type] = parseInt(row.count);
                return acc;
            }, {});
            // Get events by severity
            const severityQuery = `
        SELECT severity, COUNT(*) as count
        FROM security_audit_log 
        WHERE created_at >= $1
        GROUP BY severity
      `;
            const severityResult = await this.pool.query(severityQuery, [since]);
            const eventsBySeverity = severityResult.rows.reduce((acc, row) => {
                acc[row.severity] = parseInt(row.count);
                return acc;
            }, {});
            // Get recent events
            const recentQuery = `
        SELECT * FROM security_audit_log 
        WHERE created_at >= $1
        ORDER BY created_at DESC
        LIMIT 10
      `;
            const recentResult = await this.pool.query(recentQuery, [since]);
            const recentEvents = recentResult.rows.map(row => ({
                ...row,
                details: JSON.parse(row.details)
            }));
            // Get top IPs
            const ipQuery = `
        SELECT ip_address, COUNT(*) as count
        FROM security_audit_log 
        WHERE created_at >= $1
        GROUP BY ip_address
        ORDER BY count DESC
        LIMIT 5
      `;
            const ipResult = await this.pool.query(ipQuery, [since]);
            const topIps = ipResult.rows.map(row => ({
                ip: row.ip_address,
                count: parseInt(row.count)
            }));
            // Get failed login attempts
            const failedLoginQuery = `
        SELECT COUNT(*) as count
        FROM security_audit_log 
        WHERE event_type = 'LOGIN_FAILED' 
        AND created_at >= $1
      `;
            const failedLoginResult = await this.pool.query(failedLoginQuery, [since]);
            const failedLoginAttempts = parseInt(failedLoginResult.rows[0].count);
            // Get suspicious activities
            const suspiciousQuery = `
        SELECT * FROM security_audit_log 
        WHERE severity IN ('high', 'critical')
        AND created_at >= $1
        ORDER BY created_at DESC
        LIMIT 5
      `;
            const suspiciousResult = await this.pool.query(suspiciousQuery, [since]);
            const suspiciousActivities = suspiciousResult.rows.map(row => ({
                ...row,
                details: JSON.parse(row.details)
            }));
            return {
                total_events: totalEvents,
                events_by_type: eventsByType,
                events_by_severity: eventsBySeverity,
                recent_events: recentEvents,
                top_ips: topIps,
                failed_login_attempts: failedLoginAttempts,
                suspicious_activities: suspiciousActivities
            };
        }
        catch (error) {
            console.error('Failed to get security metrics:', error);
            throw error;
        }
    }
    /**
     * Check for suspicious patterns
     */
    async detectSuspiciousActivity() {
        try {
            // Check for multiple failed logins from same IP
            const failedLoginQuery = `
        SELECT ip_address, COUNT(*) as count
        FROM security_audit_log 
        WHERE event_type = 'LOGIN_FAILED'
        AND created_at >= NOW() - INTERVAL '1 hour'
        GROUP BY ip_address
        HAVING COUNT(*) >= 5
      `;
            const failedLoginResult = await this.pool.query(failedLoginQuery);
            for (const row of failedLoginResult.rows) {
                await this.logSecurityEvent({
                    event_type: 'SUSPICIOUS_LOGIN_PATTERN',
                    severity: 'high',
                    ip_address: row.ip_address,
                    details: {
                        failed_attempts: parseInt(row.count),
                        time_window: '1 hour'
                    }
                });
            }
            // Check for rapid API calls from same IP
            const rapidCallQuery = `
        SELECT ip_address, COUNT(*) as count
        FROM security_audit_log 
        WHERE event_type = 'API_CALL'
        AND created_at >= NOW() - INTERVAL '1 minute'
        GROUP BY ip_address
        HAVING COUNT(*) >= 100
      `;
            const rapidCallResult = await this.pool.query(rapidCallQuery);
            for (const row of rapidCallResult.rows) {
                await this.logSecurityEvent({
                    event_type: 'SUSPICIOUS_API_PATTERN',
                    severity: 'medium',
                    ip_address: row.ip_address,
                    details: {
                        api_calls: parseInt(row.count),
                        time_window: '1 minute'
                    }
                });
            }
        }
        catch (error) {
            console.error('Failed to detect suspicious activity:', error);
        }
    }
    /**
     * Create security audit table
     */
    async createAuditTable() {
        try {
            const query = `
        CREATE TABLE IF NOT EXISTS security_audit_log (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(100) NOT NULL,
          severity VARCHAR(20) NOT NULL,
          user_id INTEGER REFERENCES users(id),
          ip_address INET NOT NULL,
          user_agent TEXT,
          details JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_security_audit_created_at ON security_audit_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_security_audit_event_type ON security_audit_log(event_type);
        CREATE INDEX IF NOT EXISTS idx_security_audit_severity ON security_audit_log(severity);
        CREATE INDEX IF NOT EXISTS idx_security_audit_ip_address ON security_audit_log(ip_address);
      `;
            await this.pool.query(query);
        }
        catch (error) {
            console.error('Failed to create security audit table:', error);
            throw error;
        }
    }
}
exports.SecurityAuditService = SecurityAuditService;
exports.default = SecurityAuditService;
//# sourceMappingURL=securityAuditService.js.map