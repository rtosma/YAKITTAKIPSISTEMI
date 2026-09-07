// MUST be first: loads .env and validates JWT secrets before any other
// module reads process.env at import time.
import { NODE_ENV } from './config/env';
import express from 'express';
import cors from 'cors';

import { traceMiddleware, httpLoggerMiddleware } from './middleware/loggerMiddleware';
import { globalErrorHandler, notFoundHandler, registerProcessExceptionHandlers } from './middleware/errorHandler';
import { setupGracefulShutdown, isServerShuttingDown } from './utils/shutdown';
import { logger } from './utils/logger';
import { pool } from './db/postgresPool';
import { redisPool } from './db/redisPool';
import { mqttService } from './iot/mqttClient';
import routes from './routes/routes';

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

// Global middleware to parse JSON bodies
// Apply Tenant Context is now handled by authenticateJWT middleware per-route.

import path from 'path';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

// Configure Swagger
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Yakıttakip Sistemi API',
      version: '1.0.0',
      description:
        'Saha ikmal ve araç yakıt takip sistemi API dokümantasyonu. ' +
        'Tüm uçlar /api/v1 altında yayınlanır; aşağıdaki yollar bu tabana görelidir.',
    },
    // Relative server URL on purpose. The paths below are written WITHOUT the
    // /api/v1 prefix (routes are mounted with it in this file), so the prefix
    // has to live here. Keeping it relative means "Try it out" resolves against
    // whatever origin served this page - so it works behind the nginx proxy, on
    // a remapped host port and in production without touching the spec.
    // Set SWAGGER_SERVER_URL only when the API lives on a different origin.
    servers: [
      {
        url: process.env.SWAGGER_SERVER_URL || '/api/v1',
        description: 'API tabanı',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'POST /auth/login ile alınan accessToken.',
        },
        // Hardware telemetry is NOT protected by the JWT above - it uses an
        // HMAC-SHA256 signature over `${timestamp}.${rawBody}` with a
        // per-device shared secret (middleware/hardwareAuthMiddleware.ts).
        hardwareAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-signature',
          description:
            'HMAC-SHA256 imza. x-device-id ve x-timestamp başlıklarıyla birlikte gönderilir; ' +
            'imza penceresi 30 saniyedir.',
        },
      },
      schemas: {
        // ---- Envelopes ------------------------------------------------------
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', description: 'Makine tarafından okunabilir hata kodu.', example: 'DB_ERROR' },
            message: { type: 'string', description: 'Türkçe, kullanıcıya gösterilebilir mesaj.' },
            traceId: {
              type: 'string',
              description:
                'Yalnızca globalErrorHandler ve notFoundHandler yanıtlarında bulunur. ' +
                'Route içi catch blokları traceId üretmez.',
            },
          },
          required: ['success', 'error', 'message'],
        },
        ValidationErrorResponse: {
          type: 'object',
          description:
            'validateRequest (Zod) ara katmanının ürettiği gövde. Not: globalErrorHandler ' +
            'aynı VALIDATION_ERROR kodunu farklı bir gövdeyle (details: ham ZodIssue) üretir, ' +
            'ancak validateRequest yanıtı kendi yazıp next() çağırmadığı için doğrulama ' +
            'hataları bu şekilde döner.',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'VALIDATION_ERROR' },
            message: { type: 'string', example: 'Gelen istek verileri doğrulanamadı.' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string', example: 'plate' },
                  message: { type: 'string', example: 'Geçersiz Türkiye plaka formatı. (Örn: 34 CTP 82)' },
                },
                required: ['field', 'message'],
              },
            },
          },
          required: ['success', 'error', 'message', 'errors'],
        },
        SuccessMessage: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string' },
          },
          required: ['success', 'message'],
        },
        TenantInfoResponse: {
          type: 'object',
          description:
            'context alanı kodda yazılıdır ama pratikte HİÇ dönmez: bu route\'a authenticateJWT ' +
            'bağlı olmadığı için AsyncLocalStorage bağlamı kurulmaz, getTenantStore() undefined ' +
            'döner ve JSON.stringify alanı gövdeden düşürür.',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'AsyncLocalStorage context başarıyla okundu.' },
          },
          required: ['success', 'message'],
        },

        // ---- Auth -----------------------------------------------------------
        AuthUser: {
          type: 'object',
          properties: {
            userId: { type: 'string', example: 'usr-camsa-owner' },
            tenantId: { type: 'string', example: 'comp-camsa' },
            username: { type: 'string', example: 'camsa' },
            role: {
              type: 'string',
              enum: ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR', 'DRIVER'],
            },
            siteName: {
              type: 'string',
              nullable: true,
              description:
                'Koşullu alan. Yalnızca kullanıcıya bir şantiye atanmışsa (tipik olarak ' +
                'SITE_MANAGER) gövdede bulunur; COMPANY_OWNER yanıtlarında hiç yer almaz.',
              example: 'Gebze Ana Şantiye',
            },
          },
          required: ['userId', 'tenantId', 'username', 'role'],
        },
        LoginResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string' },
            accessToken: { type: 'string', description: '15 dakika geçerli JWT.' },
            refreshToken: { type: 'string', description: '7 gün geçerli, tek kullanımlık JWT.' },
            tokenType: { type: 'string', example: 'Bearer' },
            expiresInSeconds: { type: 'integer', example: 900 },
            user: { $ref: '#/components/schemas/AuthUser' },
          },
          required: ['success', 'message', 'accessToken', 'refreshToken', 'tokenType', 'expiresInSeconds', 'user'],
        },

        // ---- Domain ---------------------------------------------------------
        Site: {
          type: 'object',
          description: 'POST /sites bu nesneyi döndürür. GET /sites ise yalnızca isim listesi (string[]) döndürür.',
          properties: {
            id: { type: 'string', example: 'site-1788804136365' },
            tenant_id: { type: 'string', example: 'comp-camsa' },
            name: { type: 'string', example: 'Gebze Ana Şantiye' },
            location: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'tenant_id', 'name'],
        },
        CreateSiteRequest: {
          type: 'object',
          description: 'Bu uçta Zod doğrulaması YOKTUR; siteName yalnızca elle boş-string kontrolünden geçer.',
          properties: {
            siteName: { type: 'string', minLength: 1, example: 'Silivri Tesisleri' },
            location: { type: 'string', example: 'Silivri / İstanbul' },
          },
          required: ['siteName'],
        },
        Vehicle: {
          type: 'object',
          description:
            'Yanıt alanları snake_case gelir. created_at BULUNMAZ: getTenantVehicles satırları ' +
            'elle map ettiği için o alanı düşürür (GET /drivers ve GET /tanks ise ham satır ' +
            'döndürdüğü için created_at içerir - bu asimetri kasıtlı değildir).',
          properties: {
            id: { type: 'string', example: 'veh-1' },
            tenant_id: { type: 'string', example: 'comp-camsa' },
            plate: { type: 'string', example: '34 CTP 82' },
            brand_model: { type: 'string', example: 'Volvo FMX 460 Damperli' },
            vehicle_type: { type: 'string', example: 'Kamyon' },
            rfid_tag: { type: 'string', example: 'TAG-882910' },
            site_name: { type: 'string', nullable: true, example: 'Gebze Ana Şantiye' },
            status: { type: 'string', example: 'AKTİF' },
          },
          required: ['id', 'tenant_id', 'plate', 'brand_model', 'vehicle_type', 'rfid_tag', 'status'],
        },
        CreateVehicleRequest: {
          type: 'object',
          description: 'createVehicleSchema (Zod) ile doğrulanır. Girdi camelCase, çıktı snake_case.',
          properties: {
            plate: {
              type: 'string',
              pattern: '^(0[1-9]|[1-7][0-9]|8[0-1])\\s?[A-Z]{1,3}\\s?[0-9]{2,4}$',
              description: 'Türkiye plaka formatı, büyük/küçük harf duyarsız.',
              example: '34 CTP 82',
            },
            brandModel: { type: 'string', minLength: 2, example: 'Volvo FMX 460 Damperli' },
            type: { type: 'string', default: 'Kamyon', example: 'Kamyon' },
            rfidTag: { type: 'string', minLength: 3, example: 'TAG-882910' },
            fuelCapacityLiters: {
              type: 'number',
              minimum: 0,
              exclusiveMinimum: true,
              description: 'Zorunlu ve 0\'dan büyük olmalıdır.',
              example: 400,
            },
            siteName: { type: 'string', example: 'Gebze Ana Şantiye' },
          },
          required: ['plate', 'brandModel', 'rfidTag', 'fuelCapacityLiters'],
        },
        DispenseRequest: {
          type: 'object',
          description: 'dispenseRequestSchema (Zod) ile doğrulanır. amountLiters string olarak da gönderilebilir (z.coerce).',
          properties: {
            vehiclePlate: {
              type: 'string',
              pattern: '^(0[1-9]|[1-7][0-9]|8[0-1])\\s?[A-Z]{1,3}\\s?[0-9]{2,4}$',
              example: '34 CTP 82',
            },
            rfidTag: { type: 'string', minLength: 3, example: 'TAG-882910' },
            amountLiters: { type: 'number', minimum: 0, exclusiveMinimum: true, example: 120.5 },
            pumpCode: { type: 'string', example: 'PMP-1' },
          },
          required: ['vehiclePlate', 'rfidTag', 'amountLiters'],
        },
      },
    },
    // Applied to every operation unless an operation overrides it with
    // `security: []` (public endpoints) or its own scheme (hardware telemetry).
    security: [{ bearerAuth: [] }],
  },
  // swagger-jsdoc parses the TypeScript SOURCE, which must therefore be present
  // at runtime. A single cwd-relative glob silently yields an EMPTY spec when
  // the process starts from anywhere else, so cover both real layouts: cwd at
  // backend/ (container image and `npm run dev`) and cwd at the repo root.
  //
  // Deliberately NOT using __dirname: package.json sets "type": "module" and
  // tsconfig targets ESNext, so `tsx src/index.ts` runs as a real ES module
  // where __dirname does not exist. It only appears to work in production
  // because esbuild bundles to CJS - which is exactly the kind of split that
  // makes a crash show up in dev/CI but never in the container.
  apis: [
    path.join(process.cwd(), 'src/routes/*.ts'),
    path.join(process.cwd(), 'backend/src/routes/*.ts'),
  ],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Raw spec, for client codegen and contract tests. Without this the spec is
// only reachable by scraping the UI bundle.
app.get('/api-docs.json', (_req, res) => {
  res.json(swaggerSpec);
});

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
    environment: NODE_ENV,
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
