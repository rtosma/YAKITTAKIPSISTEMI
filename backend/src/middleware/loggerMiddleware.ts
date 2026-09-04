import { Request, Response, NextFunction } from 'express';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { getLoggingTenantContext } from '../utils/requestContext';

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
    }
  }
}

/**
 * Trace ID Middleware
 * Assigns or preserves X-Trace-ID correlation ID on incoming requests and outgoing headers.
 */
export const traceMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const incomingTraceId = req.headers['x-trace-id'] as string;
  const traceId = incomingTraceId && incomingTraceId.trim().length > 0 ? incomingTraceId : randomUUID();
  
  req.traceId = traceId;
  res.setHeader('X-Trace-ID', traceId);
  next();
};

/**
 * Pino HTTP Request Logging Middleware
 * Formats request logs with traceId, tenantId, userId, statusCode, responseTime.
 */
export const httpLoggerMiddleware = pinoHttp({
  logger,
  genReqId: (req: Request) => req.traceId || (req.headers['x-trace-id'] as string) || randomUUID(),
  customProps: (req: Request) => ({
    traceId: req.traceId,
    ...getLoggingTenantContext(req),
  }),
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) {
      return 'error';
    }
    if (res.statusCode >= 400) {
      return 'warn';
    }
    return 'info';
  },
  customSuccessMessage: (req, res, responseTime) => {
    return `${req.method} ${req.url} completed with status ${res.statusCode} in ${responseTime}ms`;
  },
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} failed with status ${res.statusCode}: ${err.message}`;
  },
});
