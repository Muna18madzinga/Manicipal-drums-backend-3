import { FastifyRequest, FastifyReply } from 'fastify';
declare class InputSanitizer {
    static middleware: (request: FastifyRequest, reply: FastifyReply, done: () => void) => void;
    private static sanitizeObject;
    private static sanitizeValue;
    private static sanitizeString;
    static sanitizeEmail(email: string): string;
    static sanitizePhoneNumber(phone: string): string;
    static sanitizeFilename(filename: string): string;
    static sanitizeSQL(query: string): string;
}
export default InputSanitizer;
//# sourceMappingURL=inputSanitizer.d.ts.map