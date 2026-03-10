import { Pool } from 'pg';
export declare abstract class BaseService {
    protected pool: Pool;
    protected serviceName: string;
    constructor(pool: Pool, serviceName: string);
    /**
     * Validate database connection and log service status
     */
    private validateConnection;
    /**
     * Validate service-specific tables (to be implemented by subclasses)
     */
    protected validateServiceTables(): Promise<void>;
    /**
     * Safe database query with error handling
     */
    protected safeQuery(query: string, params?: any[]): Promise<any>;
    /**
     * Check if table exists
     */
    protected tableExists(tableName: string): Promise<boolean>;
    /**
     * Get table row count
     */
    protected getTableRowCount(tableName: string): Promise<number>;
    /**
     * Log service statistics
     */
    protected logServiceStats(): Promise<void>;
    /**
     * Graceful error handler
     */
    protected handleError(error: any, context: string, fallbackData?: any): any;
}
//# sourceMappingURL=baseService.d.ts.map