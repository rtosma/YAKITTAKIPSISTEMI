import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

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
      if (schemas.body) {
        req.body = await schemas.body.parseAsync(req.body);
      }
      if (schemas.query) {
        req.query = await schemas.query.parseAsync(req.query);
      }
      if (schemas.params) {
        req.params = await schemas.params.parseAsync(req.params);
      }
      next();
    } catch (error: any) {
      if (error instanceof ZodError || error?.name === 'ZodError' || error?.issues) {
        const issues = error?.issues || error?.errors || [];
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
