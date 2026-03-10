import { Request, Response } from 'express';
import { Pool } from 'pg';
export interface IngestionConfig {
    sourceType: 'shapefile' | 'geopackage' | 'csv' | 'kml' | 'geojson';
    tableName: string;
    encoding?: string;
    coordinateSystem?: string;
    attributeMapping?: Record<string, string>;
    validationRules?: string[];
    styleTemplateId?: string;
    replaceExisting?: boolean;
}
export interface IngestionJob {
    id: string;
    admin_user_id: string;
    job_name: string;
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
    source_type: string;
    source_file_path: string;
    target_table: string;
    configuration: IngestionConfig;
    statistics: Record<string, any>;
    error_log?: string;
    started_at?: Date;
    completed_at?: Date;
    created_at: Date;
}
export declare class IngestionController {
    private fileUploadService;
    private adminUserModel;
    private pool;
    constructor(pool: Pool);
    uploadFile: (req: Request, res: Response) => Promise<void>;
    getJobs: (req: Request, res: Response) => Promise<void>;
    getJob: (req: Request, res: Response) => Promise<void>;
    startJob: (req: Request, res: Response) => Promise<void>;
    cancelJob: (req: Request, res: Response) => Promise<void>;
    private createIngestionJob;
    private parseConfig;
    private validateFile;
}
//# sourceMappingURL=ingestionController.d.ts.map