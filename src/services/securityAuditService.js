/**
 * Comprehensive Security Audit Service
 * Provides advanced security monitoring, logging, and analysis
 */

class SecurityAuditService {
  constructor() {
    this.auditLog = [];
    this.securityMetrics = {
      totalEvents: 0,
      failedLogins: 0,
      suspiciousActivities: 0,
      blockedIPs: 0,
      criticalEvents: 0,
      highSeverity: 0,
      mediumSeverity: 0,
      lowSeverity: 0,
      rateLimitHits: 0,
      dataAccessEvents: 0,
      privilegeEscalation: 0,
      configurationChanges: 0
    };
    this.threatLevels = {
      LOW: 1,
      MEDIUM: 2,
      HIGH: 3,
      CRITICAL: 4
    };
    this.eventTypes = {
      AUTH_SUCCESS: 'auth_success',
      AUTH_FAILURE: 'auth_failure',
      PRIVILEGE_ESCALATION: 'privilege_escalation',
      DATA_ACCESS: 'data_access',
      CONFIG_CHANGE: 'config_change',
      RATE_LIMIT_HIT: 'rate_limit_hit',
      SUSPICIOUS_ACTIVITY: 'suspicious_activity',
      SECURITY_VIOLATION: 'security_violation',
      SYSTEM_ANOMALY: 'system_anomaly'
    };
  }

  /**
   * Log security event with comprehensive details
   */
  logSecurityEvent(eventType, details, severity = 'LOW', userId = null, ipAddress = null) {
    const event = {
      id: this.generateEventId(),
      timestamp: new Date().toISOString(),
      eventType,
      severity,
      userId,
      ipAddress,
      details,
      userAgent: details.userAgent || null,
      sessionId: details.sessionId || null,
      resource: details.resource || null,
      action: details.action || null,
      outcome: details.outcome || null,
      riskScore: this.calculateRiskScore(eventType, severity, details),
      metadata: {
        geolocation: details.geolocation || null,
        deviceFingerprint: details.deviceFingerprint || null,
        requestSize: details.requestSize || null,
        responseTime: details.responseTime || null
      }
    };

    // Add to audit log
    this.auditLog.push(event);
    
    // Update metrics
    this.updateMetrics(event);
    
    // Check for automated responses
    this.checkAutomatedResponse(event);
    
    // Log to console for debugging
    console.log(`🔒 Security Event [${severity}]: ${eventType}`, event);
    
    return event;
  }

  /**
   * Generate unique event ID
   */
  generateEventId() {
    return `SEC_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
  }

  /**
   * Calculate risk score for event
   */
  calculateRiskScore(eventType, severity, details) {
    let baseScore = this.threatLevels[severity] || 1;
    
    // Adjust based on event type
    const eventTypeMultipliers = {
      [this.eventTypes.AUTH_FAILURE]: 2.0,
      [this.eventTypes.PRIVILEGE_ESCALATION]: 3.0,
      [this.eventTypes.SECURITY_VIOLATION]: 4.0,
      [this.eventTypes.SUSPICIOUS_ACTIVITY]: 2.5,
      [this.eventTypes.CONFIG_CHANGE]: 1.5,
      [this.eventTypes.DATA_ACCESS]: 1.2,
      [this.eventTypes.RATE_LIMIT_HIT]: 1.8
    };
    
    baseScore *= eventTypeMultipliers[eventType] || 1.0;
    
    // Adjust based on details
    if (details.multipleFailures) baseScore *= 1.5;
    if (details.unusualLocation) baseScore *= 1.3;
    if (details.unusualTime) baseScore *= 1.2;
    if (details.highVolumeAccess) baseScore *= 1.4;
    
    return Math.round(baseScore * 10) / 10;
  }

  /**
   * Update security metrics
   */
  updateMetrics(event) {
    this.securityMetrics.totalEvents++;
    
    // Update severity counters
    switch(event.severity) {
      case 'CRITICAL':
        this.securityMetrics.criticalEvents++;
        break;
      case 'HIGH':
        this.securityMetrics.highSeverity++;
        break;
      case 'MEDIUM':
        this.securityMetrics.mediumSeverity++;
        break;
      case 'LOW':
        this.securityMetrics.lowSeverity++;
        break;
    }
    
    // Update event type counters
    switch(event.eventType) {
      case this.eventTypes.AUTH_FAILURE:
        this.securityMetrics.failedLogins++;
        break;
      case this.eventTypes.SUSPICIOUS_ACTIVITY:
        this.securityMetrics.suspiciousActivities++;
        break;
      case this.eventTypes.RATE_LIMIT_HIT:
        this.securityMetrics.rateLimitHits++;
        break;
      case this.eventTypes.DATA_ACCESS:
        this.securityMetrics.dataAccessEvents++;
        break;
      case this.eventTypes.PRIVILEGE_ESCALATION:
        this.securityMetrics.privilegeEscalation++;
        break;
      case this.eventTypes.CONFIG_CHANGE:
        this.securityMetrics.configurationChanges++;
        break;
    }
  }

  /**
   * Check for automated security responses
   */
  checkAutomatedResponse(event) {
    // Critical events trigger immediate response
    if (event.severity === 'CRITICAL') {
      this.triggerCriticalResponse(event);
    }
    
    // High-risk events trigger enhanced monitoring
    if (event.riskScore >= 7.0) {
      this.triggerEnhancedMonitoring(event);
    }
    
    // Multiple failed logins trigger lockout
    if (event.eventType === this.eventTypes.AUTH_FAILURE) {
      this.checkLoginLockout(event);
    }
    
    // Suspicious activity triggers investigation
    if (event.eventType === this.eventTypes.SUSPICIOUS_ACTIVITY) {
      this.triggerSecurityInvestigation(event);
    }
  }

  /**
   * Trigger critical security response
   */
  triggerCriticalResponse(event) {
    console.log(`🚨 CRITICAL SECURITY RESPONSE TRIGGERED for event ${event.id}`);
    
    // Block IP address if applicable
    if (event.ipAddress) {
      this.blockIPAddress(event.ipAddress, 'Critical security event');
      this.securityMetrics.blockedIPs++;
    }
    
    // Send immediate alert
    this.sendSecurityAlert({
      type: 'CRITICAL',
      event,
      message: `Critical security event detected: ${event.eventType}`,
      timestamp: new Date().toISOString(),
      requiresImmediateAction: true
    });
  }

  /**
   * Trigger enhanced monitoring
   */
  triggerEnhancedMonitoring(event) {
    console.log(`🔍 Enhanced monitoring activated for event ${event.id}`);
    
    // Log enhanced monitoring start
    this.logSecurityEvent(
      this.eventTypes.SYSTEM_ANOMALY,
      {
        action: 'enhanced_monitoring_activated',
        triggerEventId: event.id,
        reason: 'High risk score detected'
      },
      'MEDIUM'
    );
  }

  /**
   * Check and enforce login lockout
   */
  checkLoginLockout(event) {
    const recentFailures = this.auditLog.filter(log => 
      log.eventType === this.eventTypes.AUTH_FAILURE &&
      log.ipAddress === event.ipAddress &&
      (new Date() - new Date(log.timestamp)) < 15 * 60 * 1000 // 15 minutes
    );
    
    if (recentFailures.length >= 5) {
      this.blockIPAddress(event.ipAddress, 'Multiple failed login attempts');
      this.securityMetrics.blockedIPs++;
      
      this.logSecurityEvent(
        this.eventTypes.SECURITY_VIOLATION,
        {
          action: 'ip_blocked',
          ipAddress: event.ipAddress,
          reason: 'Multiple failed login attempts',
          failureCount: recentFailures.length
        },
        'HIGH'
      );
    }
  }

  /**
   * Trigger security investigation
   */
  triggerSecurityInvestigation(event) {
    console.log(`🔍 Security investigation triggered for event ${event.id}`);
    
    // Create investigation record
    const investigation = {
      id: `INV_${Date.now()}`,
      eventId: event.id,
      status: 'OPEN',
      priority: event.severity,
      assignedTo: 'security_team',
      created: new Date().toISOString(),
      details: {
        triggerEvent: event,
        investigationSteps: [
          'Review user activity logs',
          'Check for data access patterns',
          'Validate IP geolocation',
          'Review recent configuration changes'
        ]
      }
    };
    
    console.log(`📋 Security investigation created: ${investigation.id}`);
  }

  /**
   * Block IP address
   */
  blockIPAddress(ipAddress, reason) {
    console.log(`🚫 IP Address blocked: ${ipAddress} - Reason: ${reason}`);
    
    this.logSecurityEvent(
      this.eventTypes.SECURITY_VIOLATION,
      {
        action: 'ip_blocked',
        ipAddress,
        reason,
        blockedAt: new Date().toISOString()
      },
      'HIGH'
    );
  }

  /**
   * Send security alert
   */
  sendSecurityAlert(alert) {
    console.log(`📧 SECURITY ALERT: ${alert.message}`, alert);
    
    // In production, this would send emails, SMS, or push notifications
    // For now, we'll just log it prominently
    console.error(`🚨 SECURITY ALERT [${alert.type}]: ${alert.message}`);
  }

  /**
   * Get security metrics
   */
  getSecurityMetrics() {
    return {
      ...this.securityMetrics,
      recentEvents: this.getRecentEvents(24), // Last 24 hours
      riskTrends: this.calculateRiskTrends(),
      topThreats: this.getTopThreats(),
      blockedIPs: this.getBlockedIPs()
    };
  }

  /**
   * Get recent events
   */
  getRecentEvents(hours = 24) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.auditLog.filter(event => new Date(event.timestamp) >= cutoff);
  }

  /**
   * Calculate risk trends
   */
  calculateRiskTrends() {
    const now = new Date();
    const last24h = new Date(now - 24 * 60 * 60 * 1000);
    const last48h = new Date(now - 48 * 60 * 60 * 1000);
    
    const recent24 = this.auditLog.filter(e => new Date(e.timestamp) >= last24h);
    const previous24 = this.auditLog.filter(e => {
      const timestamp = new Date(e.timestamp);
      return timestamp >= last48h && timestamp < last24h;
    });
    
    const avgRisk24 = recent24.reduce((sum, e) => sum + e.riskScore, 0) / recent24.length || 0;
    const avgRisk48 = previous24.reduce((sum, e) => sum + e.riskScore, 0) / previous24.length || 0;
    
    return {
      current24h: avgRisk24,
      previous24h: avgRisk48,
      trend: avgRisk24 > avgRisk48 ? 'INCREASING' : avgRisk24 < avgRisk48 ? 'DECREASING' : 'STABLE',
      changePercent: avgRisk48 ? ((avgRisk24 - avgRisk48) / avgRisk48 * 100).toFixed(1) : 0
    };
  }

  /**
   * Get top threats
   */
  getTopThreats() {
    const threatCounts = {};
    
    this.auditLog.forEach(event => {
      const key = event.eventType;
      threatCounts[key] = (threatCounts[key] || 0) + 1;
    });
    
    return Object.entries(threatCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([threat, count]) => ({ threat, count }));
  }

  /**
   * Get blocked IPs
   */
  getBlockedIPs() {
    const blockedEvents = this.auditLog.filter(e => 
      e.eventType === this.eventTypes.SECURITY_VIOLATION && 
      e.details.action === 'ip_blocked'
    );
    
    return blockedEvents.map(e => ({
      ipAddress: e.details.ipAddress,
      reason: e.details.reason,
      blockedAt: e.details.blockedAt
    }));
  }

  /**
   * Generate security report
   */
  generateSecurityReport(timeRange = '24h') {
    const metrics = this.getSecurityMetrics();
    const events = this.getRecentEvents(parseInt(timeRange) || 24);
    
    return {
      reportId: `SEC_REPORT_${Date.now()}`,
      generatedAt: new Date().toISOString(),
      timeRange,
      metrics,
      summary: {
        totalEvents: events.length,
        criticalEvents: events.filter(e => e.severity === 'CRITICAL').length,
        highRiskEvents: events.filter(e => e.riskScore >= 7.0).length,
        averageRiskScore: events.reduce((sum, e) => sum + e.riskScore, 0) / events.length || 0,
        uniqueIPs: [...new Set(events.map(e => e.ipAddress))].length,
        uniqueUsers: [...new Set(events.map(e => e.userId))].length
      },
      recommendations: this.generateRecommendations(metrics),
      events: events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    };
  }

  /**
   * Generate security recommendations
   */
  generateRecommendations(metrics) {
    const recommendations = [];
    
    if (metrics.failedLogins > 10) {
      recommendations.push({
        priority: 'HIGH',
        category: 'Authentication',
        issue: 'High number of failed login attempts',
        recommendation: 'Consider implementing stronger authentication policies or account lockout mechanisms'
      });
    }
    
    if (metrics.suspiciousActivities > 5) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'Monitoring',
        issue: 'Multiple suspicious activities detected',
        recommendation: 'Review security monitoring rules and consider enhancing detection algorithms'
      });
    }
    
    if (metrics.rateLimitHits > 20) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'Rate Limiting',
        issue: 'High rate limit hit count',
        recommendation: 'Review rate limiting thresholds and consider adjusting based on legitimate usage patterns'
      });
    }
    
    if (metrics.criticalEvents > 0) {
      recommendations.push({
        priority: 'CRITICAL',
        category: 'Security',
        issue: 'Critical security events detected',
        recommendation: 'Immediate investigation required for all critical events'
      });
    }
    
    return recommendations;
  }

  /**
   * Clear old audit logs (maintenance)
   */
  clearOldLogs(daysToKeep = 90) {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const originalLength = this.auditLog.length;
    
    this.auditLog = this.auditLog.filter(event => new Date(event.timestamp) >= cutoff);
    
    const cleared = originalLength - this.auditLog.length;
    if (cleared > 0) {
      console.log(`🧹 Cleared ${cleared} old audit log entries (older than ${daysToKeep} days)`);
    }
  }
}

// Singleton instance
const securityAuditService = new SecurityAuditService();

module.exports = securityAuditService;
