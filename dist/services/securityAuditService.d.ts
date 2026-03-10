import { Pool } from 'pg';
interface SecurityEvent {
    id?: number;
    event_type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    user_id?: number;
    ip_address: string;
    user_agent?: string;
    details: any;
    created_at: Date;
}
interface SecurityMetrics {
    total_events: number;
    events_by_type: Record<string, number>;
    events_by_severity: Record<string, number>;
    recent_events: SecurityEvent[];
    top_ips: Array<{
        ip: string;
        count: number;
    }>;
    failed_login_attempts: number;
    suspicious_activities: SecurityEvent[];
}
export declare class SecurityAuditService {
    private pool;
    constructor(pool: Pool);
    /**
     * Log a security event
     */
    logSecurityEvent(event: Omit<SecurityEvent, 'id' | 'created_at'>): Promise<void>;
    /**
     * Get security metrics
     */
    getSecurityMetrics(days?: number): Promise<SecurityMetrics>;
    /**
     * Check for suspicious patterns
     */
    detectSuspiciousActivity(): Promise<void>;
    /**
     * Create security audit table
     */
    createAuditTable(): Promise<void>;
}
export default SecurityAuditService;
//# sourceMappingURL=securityAuditService.d.ts.map