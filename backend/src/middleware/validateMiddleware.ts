import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { getZodIssues } from '../utils/errors';

export interface RequestValidationSchemas {
  body?: ZodSchema<any>;
  query?: ZodSchema<any>;
  params?: ZodSchema<any>;
}

/**
 * Express Middleware for strict Zod validation and input sanitization.
 * Silently strips unknown fields and returns structured 400 Bad Request
 * with field-level Turkish error messages if validation fails.
 */
export function validateRequest(schemas: RequestValidationSchemas) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // body/query/params birbirinden bağımsız doğrulanır — sırayla await
      // etmek yerine birlikte çalıştırılır (bugün hiçbir route birden fazlasını
      // aynı anda kullanmıyor, ama desen ileride sessizce seri bir maliyete
      // dönüşmesin diye baştan paralel).
      const tasks: Promise<void>[] = [];
      if (schemas.body) tasks.push(schemas.body.parseAsync(req.body).then((v) => { req.body = v; }));
      if (schemas.query) tasks.push(schemas.query.parseAsync(req.query).then((v) => { req.query = v; }));
      if (schemas.params) tasks.push(schemas.params.parseAsync(req.params).then((v) => { req.params = v; }));
      await Promise.all(tasks);
      next();
    } catch (error: any) {
      if (error instanceof ZodError || error?.name === 'ZodError' || error?.issues) {
        const issues = getZodIssues(error);
        const formattedErrors = issues.map((err: any) => ({
          field: err.path ? err.path.join('.') : 'general',
          message: err.message
        }));

        res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Gelen istek verileri doğrulanamadı.',
          errors: formattedErrors
        });
        return;
      }

      res.status(400).json({
        success: false,
        error: 'BAD_REQUEST',
        message: 'Girdi verileri okunamadı.'
      });
    };
  };
}
