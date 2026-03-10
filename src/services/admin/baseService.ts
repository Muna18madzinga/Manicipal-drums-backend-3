import { Pool } from 'pg';

export abstract class BaseService {
  protected pool: Pool;
  protected serviceName: string;

  constructor(pool: Pool, serviceName: string) {
    this.pool = pool;
    this.serviceName = serviceName;
    this.validateConnection();
  }

  /**
   * Validate database connection and log service status
   */
  private async validateConnection(): Promise<void> {
    try {
      // Test basic connection
      const client = await this.pool.connect();
      const result = await client.query('SELECT NOW() as server_time');
      client.release();
      
      console.log(`✅ [${this.serviceName}] Database connection validated`);
      console.log(`   Server time: ${result.rows[0].server_time}`);
      
      // Test service-specific tables
      await this.validateServiceTables();
      
    } catch (error) {
      console.error(`❌ [${this.serviceName}] Database connection failed:`, error);
      console.error(`   Error details: ${error instanceof Error ? error.message : String(error)}`);
      
      // Don't throw - allow service to continue with graceful degradation
      console.warn(`⚠️  [${this.serviceName}] Service will operate in degraded mode`);
    }
  }

  /**
   * Validate service-specific tables (to be implemented by subclasses)
   */
  protected async validateServiceTables(): Promise<void> {
    // Base implementation - override in subclasses
    console.log(`ℹ️  [${this.serviceName}] No specific table validation required`);
  }

  /**
   * Safe database query with error handling
   */
  protected async safeQuery(query: string, params: any[] = []): Promise<any> {
    try {
      const result = await this.pool.query(query, params);
      return result;
    } catch (error) {
      console.error(`❌ [${this.serviceName}] Query failed:`, {
        query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
        params: params,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Check if table exists
   */
  protected async tableExists(tableName: string): Promise<boolean> {
    try {
      const result = await this.safeQuery(
        'SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1) as exists',
        [tableName]
      );
      return result.rows[0].exists;
    } catch (error) {
      console.warn(`⚠️  [${this.serviceName}] Could not check table ${tableName}:`, error);
      return false;
    }
  }

  /**
   * Get table row count
   */
  protected async getTableRowCount(tableName: string): Promise<number> {
    try {
      const result = await this.safeQuery(`SELECT COUNT(*) as count FROM ${tableName}`);
      return parseInt(result.rows[0].count);
    } catch (error) {
      console.warn(`⚠️  [${this.serviceName}] Could not count rows in ${tableName}:`, error);
      return 0;
    }
  }

  /**
   * Log service statistics
   */
  protected async logServiceStats(): Promise<void> {
    console.log(`📊 [${this.serviceName}] Service Statistics:`);
    // Override in subclasses to provide specific stats
  }

  /**
   * Graceful error handler
   */
  protected handleError(error: any, context: string, fallbackData?: any): any {
    const errorDetails = {
      service: this.serviceName,
      context,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    };
    
    console.error(`❌ [${this.serviceName}] Error in ${context}:`, errorDetails);
    
    // Return fallback data if provided
    if (fallbackData !== undefined) {
      console.warn(`⚠️  [${this.serviceName}] Returning fallback data for ${context}`);
      return fallbackData;
    }
    
    throw error;
  }
}
