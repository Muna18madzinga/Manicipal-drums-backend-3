// Advanced Performance Monitoring Service
// Real-time performance tracking and optimization

const EventEmitter = require('events');
const os = require('os');
const { performance } = require('perf_hooks');
const { Pool } = require('pg');
const cron = require('node-cron');

class PerformanceMonitorService extends EventEmitter {
  constructor() {
    super();
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL
    });
    
    // Monitoring configuration
    this.metricsInterval = 30000; // 30 seconds
    this.alertThresholds = {
      cpu_usage: 80,
      memory_usage: 85,
      disk_usage: 90,
      response_time: 1000,
      error_rate: 5,
      db_connections: 80
    };
    
    // State tracking
    this.isMonitoring = false;
    this.metrics = {
      system: {},
      database: {},
      application: {},
      alerts: []
    };
    
    // Historical data
    this.metricsHistory = [];
    this.maxHistorySize = 1440; // 24 hours at 30-second intervals
    
    // Performance counters
    this.counters = {
      requests: 0,
      errors: 0,
      slow_queries: 0,
      cache_hits: 0,
      cache_misses: 0
    };
    
    // Initialize service
    this.initialize();
  }

  async initialize() {
    try {
      console.log('[PerfMonitor] 📊 Initializing performance monitoring service...');
      
      // Start metrics collection
      this.startMetricsCollection();
      
      // Setup database monitoring
      await this.setupDatabaseMonitoring();
      
      // Setup alert system
      this.setupAlertSystem();
      
      // Start periodic cleanup
      this.startPeriodicCleanup();
      
      console.log('[PerfMonitor] ✅ Performance monitoring service initialized');
      
    } catch (error) {
      console.error('[PerfMonitor] ❌ Failed to initialize:', error);
      this.emit('error', error);
    }
  }

  startMetricsCollection() {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    console.log('[PerfMonitor] 📈 Starting metrics collection...');
    
    // Collect metrics every 30 seconds
    this.metricsTimer = setInterval(async () => {
      if (this.isMonitoring) {
        await this.collectMetrics();
      }
    }, this.metricsInterval);
  }

  async collectMetrics() {
    try {
      const timestamp = new Date();
      
      // Collect system metrics
      const systemMetrics = await this.collectSystemMetrics();
      
      // Collect database metrics
      const databaseMetrics = await this.collectDatabaseMetrics();
      
      // Collect application metrics
      const applicationMetrics = await this.collectApplicationMetrics();
      
      // Combine metrics
      const currentMetrics = {
        timestamp: timestamp,
        system: systemMetrics,
        database: databaseMetrics,
        application: applicationMetrics
      };
      
      // Update current metrics
      this.metrics = currentMetrics;
      
      // Add to history
      this.metricsHistory.push(currentMetrics);
      
      // Trim history if needed
      if (this.metricsHistory.length > this.maxHistorySize) {
        this.metricsHistory = this.metricsHistory.slice(-this.maxHistorySize);
      }
      
      // Check for alerts
      await this.checkAlerts(currentMetrics);
      
      // Emit metrics event
      this.emit('metrics-collected', currentMetrics);
      
    } catch (error) {
      console.error('[PerfMonitor] ❌ Failed to collect metrics:', error);
      this.emit('error', error);
    }
  }

  async collectSystemMetrics() {
    try {
      const cpus = os.cpus();
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;
      
      // CPU usage (simplified calculation)
      let cpuUsage = 0;
      try {
        const startUsage = process.cpuUsage();
        await new Promise(resolve => setTimeout(resolve, 100));
        const endUsage = process.cpuUsage(startUsage);
        cpuUsage = (endUsage.user + endUsage.system) / 1000000; // Convert to seconds
      } catch (error) {
        cpuUsage = 0;
      }
      
      // Disk usage (simplified - would use proper disk stats in production)
      const stats = await fs.promises.stat(process.cwd());
      const diskUsage = 50; // Placeholder - would calculate actual disk usage
      
      return {
        cpu_count: cpus.length,
        cpu_usage: Math.min(cpuUsage * 100, 100), // Convert to percentage
        memory_total: totalMemory,
        memory_used: usedMemory,
        memory_free: freeMemory,
        memory_usage: (usedMemory / totalMemory) * 100,
        disk_usage: diskUsage,
        uptime: os.uptime(),
        load_average: os.loadavg(),
        platform: os.platform(),
        arch: os.arch()
      };
      
    } catch (error) {
      console.error('[PerfMonitor] ❌ Failed to collect system metrics:', error);
      return {};
    }
  }

  async collectDatabaseMetrics() {
    try {
      // Test database connection
      const startQuery = performance.now();
      const result = await this.pool.query('SELECT 1 as test');
      const queryTime = performance.now() - startQuery;
      
      // Get database statistics
      const statsQuery = `
        SELECT 
          count(*) as total_connections,
          count(*) FILTER (WHERE state = 'active') as active_connections,
          pg_database_size(current_database()) as database_size
        FROM pg_stat_activity
        WHERE datname = current_database()
      `;
      
      const stats = await this.pool.query(statsQuery);
      const dbStats = stats.rows[0];
      
      // Get slow queries (simplified)
      const slowQueriesQuery = `
        SELECT count(*) as slow_queries
        FROM pg_stat_statements 
        WHERE mean_exec_time > 1000
      `;
      
      let slowQueries = 0;
      try {
        const slowResult = await this.pool.query(slowQueriesQuery);
        slowQueries = parseInt(slowResult.rows[0]?.slow_queries || '0');
      } catch (error) {
        // pg_stat_statements might not be enabled
        slowQueries = 0;
      }
      
      return {
        connection_time: queryTime,
        total_connections: parseInt(dbStats.total_connections),
        active_connections: parseInt(dbStats.active_connections),
        database_size: parseInt(dbStats.database_size),
        slow_queries: slowQueries,
        cache_hit_ratio: await this.getCacheHitRatio()
      };
      
    } catch (error) {
      console.error('[PerfMonitor] ❌ Failed to collect database metrics:', error);
      return {
        connection_time: -1,
        error: error.message
      };
    }
  }

  async collectApplicationMetrics() {
    try {
      const memUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      
      return {
        node_version: process.version,
        memory_usage: {
          rss: memUsage.rss,
          heap_total: memUsage.heapTotal,
          heap_used: memUsage.heapUsed,
          external: memUsage.external,
          array_buffers: memUsage.arrayBuffers
        },
        cpu_usage: {
          user: cpuUsage.user,
          system: cpuUsage.system
        },
        uptime: process.uptime(),
        request_count: this.counters.requests,
        error_count: this.counters.errors,
        slow_query_count: this.counters.slow_queries,
        cache_hits: this.counters.cache_hits,
        cache_misses: this.counters.cache_misses,
        cache_hit_rate: this.calculateCacheHitRate()
      };
      
    } catch (error) {
      console.error('[PerfMonitor] ❌ Failed to collect application metrics:', error);
      return {};
    }
  }

  async getCacheHitRatio() {
    try {
      const query = `
        SELECT 
          sum(heap_blks_hit) as hits,
          sum(heap_blks_read) as reads
        FROM pg_stat_database 
        WHERE datname = current_database()
      `;
      
      const result = await this.pool.query(query);
      const stats = result.rows[0];
      
      if (stats.hits + stats.reads > 0) {
        return (stats.hits / (stats.hits + stats.reads)) * 100;
      }
      
      return 0;
      
    } catch (error) {
      return 0;
    }
  }

  calculateCacheHitRate() {
    const total = this.counters.cache_hits + this.counters.cache_misses;
    if (total > 0) {
      return (this.counters.cache_hits / total) * 100;
    }
    return 0;
  }

  async setupDatabaseMonitoring() {
    try {
      console.log('[PerfMonitor] 🗄️ Setting up database monitoring...');
      
      // Monitor slow queries
      this.pool.on('error', (error) => {
        console.error('[PerfMonitor] ❌ Database pool error:', error);
        this.incrementCounter('errors');
        this.emit('database-error', error);
      });
      
      // Monitor connection events
      this.pool.on('connect', (client) => {
        console.log('[PerfMonitor] 🔗 New database connection established');
      });
      
      this.pool.on('remove', (client) => {
        console.log('[PerfMonitor] 🔌 Database connection removed');
      });
      
    } catch (error) {
      console.error('[PerfMonitor] ❌ Failed to setup database monitoring:', error);
    }
  }

  setupAlertSystem() {
    console.log('[PerfMonitor] 🚨 Setting up alert system...');
    
    // Check alerts every minute
    this.alertTimer = setInterval(async () => {
      if (this.metrics && Object.keys(this.metrics).length > 0) {
        await this.checkAlerts(this.metrics);
      }
    }, 60000);
  }

  async checkAlerts(metrics) {
    const alerts = [];
    const timestamp = new Date();
    
    // Check CPU usage
    if (metrics.system?.cpu_usage > this.alertThresholds.cpu_usage) {
      alerts.push({
        type: 'cpu_high',
        severity: 'warning',
        message: `CPU usage is ${metrics.system.cpu_usage.toFixed(2)}% (threshold: ${this.alertThresholds.cpu_usage}%)`,
        value: metrics.system.cpu_usage,
        threshold: this.alertThresholds.cpu_usage,
        timestamp: timestamp
      });
    }
    
    // Check memory usage
    if (metrics.system?.memory_usage > this.alertThresholds.memory_usage) {
      alerts.push({
        type: 'memory_high',
        severity: 'warning',
        message: `Memory usage is ${metrics.system.memory_usage.toFixed(2)}% (threshold: ${this.alertThresholds.memory_usage}%)`,
        value: metrics.system.memory_usage,
        threshold: this.alertThresholds.memory_usage,
        timestamp: timestamp
      });
    }
    
    // Check database connection time
    if (metrics.database?.connection_time > this.alertThresholds.response_time) {
      alerts.push({
        type: 'db_slow',
        severity: 'critical',
        message: `Database response time is ${metrics.database.connection_time.toFixed(2)}ms (threshold: ${this.alertThresholds.response_time}ms)`,
        value: metrics.database.connection_time,
        threshold: this.alertThresholds.response_time,
        timestamp: timestamp
      });
    }
    
    // Check error rate
    const errorRate = this.calculateErrorRate();
    if (errorRate > this.alertThresholds.error_rate) {
      alerts.push({
        type: 'error_rate_high',
        severity: 'critical',
        message: `Error rate is ${errorRate.toFixed(2)}% (threshold: ${this.alertThresholds.error_rate}%)`,
        value: errorRate,
        threshold: this.alertThresholds.error_rate,
        timestamp: timestamp
      });
    }
    
    // Check database connections
    if (metrics.database?.active_connections > this.alertThresholds.db_connections) {
      alerts.push({
        type: 'db_connections_high',
        severity: 'warning',
        message: `Database connections: ${metrics.database.active_connections} (threshold: ${this.alertThresholds.db_connections})`,
        value: metrics.database.active_connections,
        threshold: this.alertThresholds.db_connections,
        timestamp: timestamp
      });
    }
    
    // Process alerts
    if (alerts.length > 0) {
      for (const alert of alerts) {
        this.metrics.alerts.push(alert);
        this.emit('alert', alert);
        console.warn(`[PerfMonitor] 🚨 ${alert.severity.toUpperCase()}: ${alert.message}`);
      }
      
      // Keep only last 100 alerts
      if (this.metrics.alerts.length > 100) {
        this.metrics.alerts = this.metrics.alerts.slice(-100);
      }
    }
  }

  calculateErrorRate() {
    const total = this.counters.requests;
    const errors = this.counters.errors;
    
    if (total > 0) {
      return (errors / total) * 100;
    }
    
    return 0;
  }

  startPeriodicCleanup() {
    // Cleanup old metrics every hour
    cron.schedule('0 * * * *', async () => {
      await this.cleanupOldMetrics();
    });
  }

  async cleanupOldMetrics() {
    try {
      // Keep only last 24 hours of metrics
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const originalSize = this.metricsHistory.length;
      
      this.metricsHistory = this.metricsHistory.filter(
        metric => metric.timestamp > cutoff
      );
      
      const cleaned = originalSize - this.metricsHistory.length;
      if (cleaned > 0) {
        console.log(`[PerfMonitor] 🧹 Cleaned up ${cleaned} old metric records`);
      }
      
    } catch (error) {
      console.error('[PerfMonitor] ❌ Failed to cleanup old metrics:', error);
    }
  }

  // Public API methods
  incrementCounter(counter) {
    if (this.counters.hasOwnProperty(counter)) {
      this.counters[counter]++;
    }
  }

  getMetrics() {
    return this.metrics;
  }

  getMetricsHistory(minutes = 60) {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    return this.metricsHistory.filter(metric => metric.timestamp > cutoff);
  }

  getAlerts(severity = null) {
    if (severity) {
      return this.metrics.alerts.filter(alert => alert.severity === severity);
    }
    return this.metrics.alerts;
  }

  getPerformanceReport() {
    const latestMetrics = this.metrics;
    const recentHistory = this.getMetricsHistory(60); // Last hour
    
    return {
      current: latestMetrics,
      summary: {
        avg_cpu_usage: this.calculateAverage(recentHistory, 'system.cpu_usage'),
        avg_memory_usage: this.calculateAverage(recentHistory, 'system.memory_usage'),
        avg_response_time: this.calculateAverage(recentHistory, 'database.connection_time'),
        total_requests: this.counters.requests,
        error_rate: this.calculateErrorRate(),
        cache_hit_rate: this.calculateCacheHitRate(),
        uptime: process.uptime()
      },
      alerts: this.getAlerts().slice(-10), // Last 10 alerts
      counters: this.counters
    };
  }

  calculateAverage(history, path) {
    if (history.length === 0) return 0;
    
    const values = history.map(metric => {
      const keys = path.split('.');
      let value = metric;
      for (const key of keys) {
        value = value?.[key];
      }
      return value || 0;
    }).filter(value => value > 0);
    
    if (values.length === 0) return 0;
    
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  async generateOptimizationRecommendations() {
    const report = this.getPerformanceReport();
    const recommendations = [];
    
    // CPU recommendations
    if (report.summary.avg_cpu_usage > 70) {
      recommendations.push({
        category: 'cpu',
        priority: 'high',
        title: 'High CPU Usage Detected',
        description: 'Average CPU usage is above 70%. Consider optimizing queries or scaling horizontally.',
        action: 'Review slow queries and consider adding worker processes'
      });
    }
    
    // Memory recommendations
    if (report.summary.avg_memory_usage > 80) {
      recommendations.push({
        category: 'memory',
        priority: 'high',
        title: 'High Memory Usage',
        description: 'Memory usage is consistently high. Monitor for memory leaks.',
        action: 'Check for memory leaks and consider increasing available memory'
      });
    }
    
    // Database recommendations
    if (report.summary.avg_response_time > 500) {
      recommendations.push({
        category: 'database',
        priority: 'medium',
        title: 'Slow Database Queries',
        description: 'Database response times are elevated. Query optimization may be needed.',
        action: 'Review and optimize slow queries, consider adding indexes'
      });
    }
    
    // Cache recommendations
    if (report.summary.cache_hit_rate < 80) {
      recommendations.push({
        category: 'cache',
        priority: 'medium',
        title: 'Low Cache Hit Rate',
        description: 'Cache hit rate is below 80%. Consider optimizing cache strategy.',
        action: 'Review cache configuration and query patterns'
      });
    }
    
    // Error rate recommendations
    if (report.summary.error_rate > 2) {
      recommendations.push({
        category: 'errors',
        priority: 'high',
        title: 'High Error Rate',
        description: 'Error rate is elevated. Investigate and fix underlying issues.',
        action: 'Review error logs and fix recurring issues'
      });
    }
    
    return recommendations;
  }

  async stop() {
    console.log('[PerfMonitor] 🛑 Stopping performance monitoring service...');
    
    this.isMonitoring = false;
    
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }
    
    if (this.alertTimer) {
      clearInterval(this.alertTimer);
    }
    
    await this.pool.end();
    
    console.log('[PerfMonitor] ✅ Performance monitoring service stopped');
  }
}

module.exports = PerformanceMonitorService;
