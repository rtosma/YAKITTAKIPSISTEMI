import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { TenantContextService } from './middleware/tenantMiddleware';
import { traceMiddleware, httpLoggerMiddleware } from './middleware/loggerMiddleware';
import { globalErrorHandler, notFoundHandler, registerProcessExceptionHandlers } from './middleware/errorHandler';
import { setupGracefulShutdown, isServerShuttingDown } from './utils/shutdown';
import { logger } from './utils/logger';
import { pool } from './db/postgresPool';
import { redisPool } from './db/redisPool';
import { mqttService } from './iot/mqttClient';
import routes from './routes/routes';

dotenv.config();

// Register process-level uncaughtException and unhandledRejection handlers
registerProcessExceptionHandlers();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

// Graceful Shutdown Check Middleware (returns 503 Service Unavailable if shutting down)
app.use((req, res, next) => {
  if (isServerShuttingDown()) {
    res.setHeader('Connection', 'close');
    return res.status(503).json({
      success: false,
      error: 'SERVICE_UNAVAILABLE',
      message: 'Sunucu kapanma modunda, yeni istek kabul edilmiyor.',
    });
  }
  next();
});

// Trace ID & Structured Pino Request Logger
app.use(traceMiddleware);
app.use(httpLoggerMiddleware);

// Configure express.json to preserve rawBody Buffer for HMAC-SHA256 hardware signature verification
app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  }
}));

// Apply Tenant Context Middleware across API routes
// Unprotected health, auth, and telemetry routes pass without requiring X-Tenant-ID header
app.use('/api/v1', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth/') || req.path.startsWith('/telemetry/')) {
    return TenantContextService.middleware({ requireTenant: false })(req, res, next);
  }
  return TenantContextService.middleware({ requireTenant: true })(req, res, next);
});

import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

// Configure Swagger
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Yakıttakip Sistemi API',
      version: '1.0.0',
      description: 'Saha ikmal ve araç yakıt takip sistemi API dokümantasyonu',
    },
    servers: [
      {
        url: 'http://localhost:5000',
        description: 'Development Server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/routes/*.ts'], // read JSDoc from routes
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Mount Routes
app.use('/api/v1', routes);

// 404 Handler for Unmatched API Endpoints
app.use('/api/v1', notFoundHandler);

// Global Exception Filter & Error Handler (Must be attached last)
app.use(globalErrorHandler);

const server = app.listen(PORT, () => {
  logger.info({
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    features: ['AsyncLocalStorage RLS', 'HMAC Auth', 'Pino Logger', 'Global Exception Filter', 'Graceful Shutdown', 'MQTT & LWT'],
  }, `🚀 [OPS-1101] Yakıttakip Backend Sunucusu Başlatıldı!`);

  // Start MQTT Listener
  if (process.env.MQTT_URL !== '__CI_SKIP__') {
    mqttService.connect();
  }
});

// Setup Graceful Shutdown listeners (SIGTERM, SIGINT)
setupGracefulShutdown(server, {
  timeoutMs: 30000,
  onShutdown: async () => {
    logger.info(`🔌 [Shutdown] Eknak kaynak temizliği çalıştırılıyor...`);
    
    // MQTT disconnect
    await mqttService.disconnect();
    
    // Redis disconnect
    await redisPool.close();
    
    logger.info(`🔌 [Shutdown] Veritabanı bağlantı havuzu kapatılıyor...`);
    await pool.end();
  },
});

export default app;
