import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, getZodIssues } from '../utils/errors';
import { logger } from '../utils/logger';
import { getTraceId, getLoggingTenantContext } from '../utils/requestContext';

/**
 * 404 Not Found Middleware for unhandled routes
 */
export const notFoundHandler = (req: Request, res: Response, next: NextFunction): void => {
  const traceId = getTraceId(req);
  res.status(404).json({
    success: false,
    traceId,
    error: 'NOT_FOUND',
    message: `İstenen kaynak bulunamadı: ${req.method} ${req.originalUrl}`,
  });
};

/**
 * Global Exception Handler Middleware
 * Catch-all error filter that prevents stack trace leaks to client and logs structured errors.
 */
export const globalErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const traceId = getTraceId(req);
  const { tenantId, userId } = getLoggingTenantContext(req);

  // Handle Operational AppError (4xx or explicit operational 5xx)
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({
        err,
        traceId,
        tenantId,
        userId,
        path: req.originalUrl,
        method: req.method,
      }, `[AppError ${err.statusCode}] ${err.message}`);
    } else {
      logger.warn({
        traceId,
        tenantId,
        userId,
        statusCode: err.statusCode,
        path: req.originalUrl,
        method: req.method,
      }, `[AppError ${err.statusCode}] ${err.message}`);
    }

    res.status(err.statusCode).json({
      success: false,
      traceId,
      error: err.constructor.name,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  // Handle Zod Validation Error
  if (err instanceof ZodError || err?.name === 'ZodError') {
    const issues = getZodIssues(err);
    logger.warn({
      traceId,
      tenantId,
      userId,
      path: req.originalUrl,
      method: req.method,
      issues,
    }, `[ZodValidationError] Girdi doğrulama başarısız`);

    res.status(400).json({
      success: false,
      traceId,
      error: 'VALIDATION_ERROR',
      message: 'Girdi doğrulama hatası',
      details: issues,
    });
    return;
  }

  // Handle Unhandled Unexpected 500 Internal Server Errors
  logger.error({
    err,
    stack: err.stack,
    traceId,
    tenantId,
    userId,
    path: req.originalUrl,
    method: req.method,
    body: req.body,
  }, `💥 [CRITICAL_UNHANDLED_EXCEPTION] ${err.message || 'Bilinmeyen Sunucu Hatası'}`);

  // Secure client response: NEVER expose stack traces or internal DB/system details to the client
  res.status(500).json({
    success: false,
    traceId,
    error: 'INTERNAL_SERVER_ERROR',
    message: 'Sunucu tarafında beklenmeyen bir hata oluştu. Lütfen traceId ile sistem yöneticisine başvurun.',
  });
};

/**
 * Register Node.js process level exception handlers
 */
export const registerProcessExceptionHandlers = (): void => {
  process.on('uncaughtException', (error: Error) => {
    logger.fatal({ err: error, stack: error.stack }, `🔥 [UNCAUGHT_EXCEPTION] İşlenmeyen İstisna: ${error.message}`);
  });

  process.on('unhandledRejection', (reason: any) => {
    logger.fatal({ reason }, `🔥 [UNHANDLED_REJECTION] İşlenmeyen Promise Reddi`);
  });
};
