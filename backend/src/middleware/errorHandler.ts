import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, getZodIssues } from '../utils/errors';
import { logger } from '../utils/logger';
import { getTraceId, getLoggingTenantContext } from '../utils/requestContext';
import { redactSensitiveFields } from '../utils/redaction';
import { captureServerError } from '../observability/sentry';

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
  const { tenantId, userId } = getLoggingTenantContext();

  // Handle Operational AppError (4xx or explicit operational 5xx)
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      // RES-907: 503 "geçici/beklenen" (AI anahtarı yok, DB meşgul...) — Sentry'yi kirletmesin; 500/502 gerçek arıza sayılır.
      if (err.statusCode !== 503) captureServerError(err, { traceId, tenantId, userId, method: req.method, path: req.originalUrl });
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

  // Handle well-formed 4xx errors from Express/body-parser (örn.
  // PayloadTooLargeError — büyük bir batch senkronizasyon isteği, bkz.
  // IOT-303.1) — bunlar bir istemci hatasıdır, bir sunucu çökmesi DEĞİL.
  // `expose: true`, Express'in http-errors kütüphanesinin "bu mesaj
  // istemciye güvenle gösterilebilir" işaretidir (rastgele bir üçüncü parti
  // kütüphane hatasını yanlışlıkla 4xx'e düşürmemek için bu işarete
  // bakılıyor, yalnızca statusCode'a değil).
  const exposedStatus = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : undefined;
  if (err?.expose === true && exposedStatus !== undefined && exposedStatus >= 400 && exposedStatus < 500) {
    logger.warn({
      traceId,
      tenantId,
      userId,
      path: req.originalUrl,
      method: req.method,
    }, `[ExpressClientError ${exposedStatus}] ${err.message}`);

    res.status(exposedStatus).json({
      success: false,
      traceId,
      error: err.type ? String(err.type).toUpperCase() : 'BAD_REQUEST',
      message: err.message || 'Geçersiz istek.',
    });
    return;
  }

  // Veritabanı meşgul: kilit bekleme (55P03 lock_not_available), sorgu zaman
  // aşımı (57014 query_canceled) ya da havuzdan bağlantı alınamaması. Bunlar
  // kalıcı bir sunucu hatası değil, yeniden denenebilir geçici yoğunluk —
  // istemci 500 yerine 503 alır (bkz. postgresPool.ts zaman aşımları).
  // TEST-1007: veritabanına HİÇ ulaşılamıyorsa (konteyner durdu/ağ koptu/yeniden başlıyor) da aynı sınıf: yeniden denenebilir 503.
  // Önceden opak bir 500 + "CRITICAL_UNHANDLED_EXCEPTION" (Sentry'de sahte kritik alarm) dönüyordu.
  const dbUnreachable = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006'].includes(err?.code)
    || /Connection terminated|connection.*(refused|reset|closed)|getaddrinfo (ENOTFOUND|EAI_AGAIN)|the database system is (starting up|shutting down)/i.test(String(err?.message));
  if (dbUnreachable) {
    logger.warn({ err, traceId, tenantId, userId, path: req.originalUrl, method: req.method }, '[DB_UNAVAILABLE] Veritabanına ulaşılamıyor.');
    res.setHeader('Retry-After', '5');
    res.status(503).json({
      success: false,
      traceId,
      error: 'DB_UNAVAILABLE',
      message: 'Veritabanına şu anda ulaşılamıyor. Lütfen birkaç saniye sonra tekrar deneyin.'
    });
    return;
  }
  if (err?.code === '55P03' || err?.code === '57014' || /timeout exceeded when trying to connect/i.test(String(err?.message))) {
    logger.warn({ err, traceId, tenantId, userId, path: req.originalUrl, method: req.method }, '[DB_BUSY] Veritabanı geçici olarak meşgul.');
    res.status(503).json({
      success: false,
      traceId,
      error: 'DB_BUSY',
      message: 'Sistem şu anda yoğun. Lütfen birkaç saniye sonra tekrar deneyin.'
    });
    return;
  }

  // Handle Unhandled Unexpected 500 Internal Server Errors
  captureServerError(err, { traceId, tenantId, userId, method: req.method, path: req.originalUrl });
  logger.error({
    err,
    stack: err.stack,
    traceId,
    tenantId,
    userId,
    path: req.originalUrl,
    method: req.method,
    // RES-902 AC: "Hassas alanlar loglarda redakte edilmelidir" — bir login/
    // parola-değiştirme isteği sırasında beklenmeyen bir 500 oluşursa, gövde
    // olduğu gibi loglanırsa parola/secret DÜZ METİN olarak log dosyasına
    // yazılırdı (KVKK/COMP-606 ihlali riski, ticket'ın kendi notu).
    body: redactSensitiveFields(req.body),
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
    captureServerError(error, {});
    logger.fatal({ err: error, stack: error.stack }, `🔥 [UNCAUGHT_EXCEPTION] İşlenmeyen İstisna: ${error.message}`);
  });

  process.on('unhandledRejection', (reason: any) => {
    captureServerError(reason instanceof Error ? reason : new Error(String(reason)), {});
    logger.fatal({ reason }, `🔥 [UNHANDLED_REJECTION] İşlenmeyen Promise Reddi`);
  });
};
