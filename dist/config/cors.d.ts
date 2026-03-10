export declare const corsConfig: {
    development: {
        origin: string[];
        credentials: boolean;
        methods: string[];
        allowedHeaders: string[];
        exposedHeaders: string[];
        maxAge: number;
    };
    production: {
        origin: (origin: string, callback: Function) => any;
        credentials: boolean;
        methods: string[];
        allowedHeaders: string[];
        exposedHeaders: string[];
        maxAge: number;
    };
    getConfig: () => /*elided*/ any | {
        origin: string[];
        credentials: boolean;
        methods: string[];
        allowedHeaders: string[];
        exposedHeaders: string[];
        maxAge: number;
    } | {
        origin: (origin: string, callback: Function) => any;
        credentials: boolean;
        methods: string[];
        allowedHeaders: string[];
        exposedHeaders: string[];
        maxAge: number;
    };
};
export default corsConfig;
//# sourceMappingURL=cors.d.ts.map