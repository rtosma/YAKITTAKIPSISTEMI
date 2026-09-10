import express from 'express';
import cors from 'cors';
import http from 'http';

import { config } from './config/env';
import { initSocketServer } from './socket/socketServer';
import { traceMiddleware, httpLoggerMiddleware } from './middleware/loggerMiddleware';
import { globalErrorHandler, notFoundHandler, registerProcessExceptionHandlers } from './middleware/errorHandler';
import { setupGracefulShutdown, isServerShuttingDown } from './utils/shutdown';
import { logger } from './utils/logger';
import { pool } from './db/postgresPool';
import { redisPool } from './db/redisPool';
import { mqttService } from './iot/mqttClient';
import routes from './routes/routes';
import { getAllHardwareDevices, seedLegacyHardwareDevicesIfMissing, sweepTimedOutCalibrations, getAllTenantIdsWithAiAnomalyEnabled, getAllTenantIds } from './db/adminDb';
import { sweepTimedOutSessions } from './services/dispenseSessionService';
import { broadcastToTenant } from './socket/socketServer';
import { runWithTenant } from './context/tenantContext';
import { generateAndStoreAnomalyReport } from './services/consumptionAnomalyService';
import { resetDueQuotasForCurrentTenant, runDailyStockReconciliationForCurrentTenant } from './db/tenantDb';

// NOTE: environment variables are loaded by ./bootstrap.ts (the real process
// entry point — see package.json `dev`/`build`), BEFORE this module or any of
// its imports evaluate. Do not call dotenv.config() here: by the time this
// file's own top-level code would run, everything it imports above (down to
// tokenService's module-scope JWT secret reads) has already been evaluated,
// so a dotenv.config() call at this point would always be too late.

// Register process-level uncaughtException and unhandledRejection handlers
registerProcessExceptionHandlers();

const app = express();
const PORT = config.PORT;

app.use(cors());

// Graceful Shutdown Check Middleware (returns 503 Service Unavailable if shutting down)
// RES-906 Kritik Not 3: liveness ve legacy /health bu 503'ten MUAF — süreç
// kapanırken de canlıdır; onları da 503'lersek orkestratör liveness probe'u
// başarısız sayıp konteyneri drenaj ortasında öldürür. /health/ready ise
// KASITLI olarak 503 döner (trafik çekilsin).
const LIVENESS_PATHS = new Set(['/api/v1/health', '/api/v1/health/live']);
app.use((req, res, next) => {
  if (isServerShuttingDown() && !LIVENESS_PATHS.has(req.path)) {
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

// Configure express.json to preserve rawBody Buffer for HMAC-SHA256 hardware signature verification.
// IOT-303.1: varsayılan Express limiti (100kb) 1000+ kayıtlık bir sync-batch
// isteğini (ör. 1000 kayıt ≈ 200KB) 413 ile reddediyordu — ticket'ın kendi
// senaryosu "3 günlük kesinti ≈ 1.500 kayıt"ı NORMAL kabul ediyor, kenar
// durum değil. 10mb, 5.000 kayıtlık (Zod'un kendi üst sınırı) bir batch için
// bolca pay bırakıyor.
app.use(express.json({
  limit: '10mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  }
}));

// Global middleware to parse JSON bodies
// Apply Tenant Context is now handled by authenticateJWT middleware per-route.

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

// swaggerJsdoc() route dosyalarını glob'layıp JSDoc parse ediyor — yalnızca
// birisi gerçekten /api-docs'a gittiğinde gereken bir maliyet, her sunucu
// açılışında değil. İlk istekte hesaplanıp bellekte tutulur (memoize).
let cachedSwaggerSpec: object | undefined;
function getSwaggerSpec(): object {
  if (!cachedSwaggerSpec) {
    cachedSwaggerSpec = swaggerJsdoc(swaggerOptions);
  }
  return cachedSwaggerSpec;
}
app.use('/api-docs', swaggerUi.serve, (req: express.Request, res: express.Response, next: express.NextFunction) =>
  swaggerUi.setup(getSwaggerSpec())(req, res, next)
);

// Mount Routes
app.use('/api/v1', routes);

// 404 Handler for Unmatched API Endpoints
app.use('/api/v1', notFoundHandler);

// Global Exception Filter & Error Handler (Must be attached last)
app.use(globalErrorHandler);

// FE-801: Socket.io, Express ile AYNI HTTP sunucusuna (tek port, tek TLS
// sertifikası) bağlanır — bu yüzden app.listen() yerine http.createServer(app)
// kullanılıp Socket.io ona attach edilir, sonra o sunucu dinlemeye başlar.
const httpServer = http.createServer(app);
initSocketServer(httpServer);

/**
 * AUTH-202.3: eski statik REGISTERED_HARDWARE_DEVICES'ın yerini alan 3 demo
 * cihazının hardware_devices tablosuna taşınması, sunucu dinlemeye
 * BAŞLAMADAN ÖNCE tamamlanmalı — aksi halde ilk gelen donanım istekleri
 * (örn. CI'daki testHardwareAuth.ts, /health yeşil olur olmaz başlar) cihazı
 * "kayıtlı değil" bulup 401 alabilir (bkz. adminDb.ts
 * seedLegacyHardwareDevicesIfMissing).
 */
async function startServer(): Promise<void> {
  await seedLegacyHardwareDevicesIfMissing({
    HW_SECRET_ESP32_PUMP_01: config.HW_SECRET_ESP32_PUMP_01,
    HW_SECRET_ESP32_TANK_01: config.HW_SECRET_ESP32_TANK_01,
    HW_SECRET_ESP32_FLOW_ISR: config.HW_SECRET_ESP32_FLOW_ISR
  });

  const server = httpServer.listen(PORT, () => {
    logger.info({
      port: PORT,
      environment: config.NODE_ENV,
      features: ['AsyncLocalStorage RLS', 'HMAC Auth', 'Pino Logger', 'Global Exception Filter', 'Graceful Shutdown', 'MQTT & LWT', 'Socket.io'],
    }, `🚀 [OPS-1101] Yakıttakip Backend Sunucusu Başlatıldı!`);

    // Start MQTT Listener
    if (config.MQTT_URL !== '__CI_SKIP__') {
      mqttService.connect();
    }
  });

  // FUEL-401.3 AC: "15 saniye heartbeat gelmezse oturum düşürülmelidir." Bu
  // kontrol REQUEST-DRIVEN olamaz — cihaz tamamen çökmüşse (heartbeat isteği
  // hiç gelmiyor) hiçbir route tetiklenmez, bu yüzden sunucu periyodik olarak
  // KENDİSİ tüm kayıtlı cihazların oturumlarını süpürür. Ticket'ın önerdiği
  // BullMQ delayed job yerine (bu kod tabanında BullMQ yok) mevcut
  // mqttClient.ts'in manuel-backoff deseniyle tutarlı düz bir setInterval.
  const DISPENSE_TIMEOUT_SWEEP_MS = 5000;
  const dispenseTimeoutSweepInterval = setInterval(async () => {
    try {
      const registeredDevices = await getAllHardwareDevices();
      const timedOutSessions = await sweepTimedOutSessions(registeredDevices.map((d) => d.device_id));
      for (const session of timedOutSessions) {
        mqttService.publishCommand(session.deviceId, 'FORCE_CUTOFF', { reason: 'HEARTBEAT_TIMEOUT', sessionId: session.sessionId });
        broadcastToTenant(session.tenantId, 'dispense:session', session);
      }
    } catch (err) {
      logger.error({ err }, '🚨 [FUEL-401] Heartbeat zaman aşımı süpürmesi başarısız.');
    }
  }, DISPENSE_TIMEOUT_SWEEP_MS);

  // FUEL-404.1: bir kalibrasyon komutu cihaza gönderildikten sonra ack hiç
  // gelmezse (cihaz kapalı/bağlantısız) "BEKLIYOR" durumunda sonsuza kadar
  // kalmamalı — heartbeat süpürücüsüyle AYNI gerekçe/desen.
  const CALIBRATION_TIMEOUT_SWEEP_MS = 30_000;
  const calibrationTimeoutSweepInterval = setInterval(async () => {
    try {
      const timedOut = await sweepTimedOutCalibrations();
      for (const cmd of timedOut) {
        broadcastToTenant(cmd.tenantId, 'calibration:timeout', { commandId: cmd.id, deviceId: cmd.deviceId });
        logger.warn({ commandId: cmd.id, deviceId: cmd.deviceId }, `⏱️ [FUEL-404.1] Kalibrasyon komutu ack zaman aşımına uğradı: '${cmd.deviceId}'.`);
      }
    } catch (err) {
      logger.error({ err }, '🚨 [FUEL-404.1] Kalibrasyon zaman aşımı süpürmesi başarısız.');
    }
  }, CALIBRATION_TIMEOUT_SWEEP_MS);

  // AI-502: ticket "Node.js Scheduled Cron" öneriyor ama bu kod tabanında
  // BullMQ/agenda/@nestjs/schedule yok — yukarıdaki iki süpürücüyle AYNI
  // düz setInterval deseni. GEMINI_API_KEY tanımlı DEĞİLSE interval'ı hiç
  // KURMUYORUZ — aksi halde her 7 günde bir kaçınılmaz biçimde başarısız
  // olacak (ve nafile hata logu üretecek) bir zamanlayıcı sunucu ömrü
  // boyunca boşuna bellekte dururdu.
  const WEEKLY_ANOMALY_SWEEP_MS = 7 * 24 * 60 * 60 * 1000;
  let weeklyAnomalySweepInterval: ReturnType<typeof setInterval> | undefined;
  if (config.GEMINI_API_KEY) {
    weeklyAnomalySweepInterval = setInterval(async () => {
      let tenantIds: string[] = [];
      try {
        tenantIds = await getAllTenantIdsWithAiAnomalyEnabled();
      } catch (err) {
        logger.error({ err }, '🚨 [AI-502] aiAnomaly etkin tenant listesi alınamadı, bu haftalık tur atlandı.');
        return;
      }
      for (const tenantId of tenantIds) {
        try {
          await runWithTenant({ tenantId }, () => generateAndStoreAnomalyReport(7, 'system-weekly-scheduler'));
        } catch (err) {
          // Bir tenant'ın analizi başarısız olması (örn. Gemini geçici hata
          // verdi) DİĞER tenant'ların turunu ENGELLEMEMELİ.
          logger.error({ err, tenantId }, '🚨 [AI-502] Haftalık tüketim anomali analizi başarısız.');
        }
      }
    }, WEEKLY_ANOMALY_SWEEP_MS);
  } else {
    logger.warn('⚠️ [AI-502] GEMINI_API_KEY tanımlı değil — haftalık otomatik tüketim anomali analizi devre dışı (manuel POST /ai/consumption-anomaly-reports yine de GEMINI_API_KEY ayarlanınca kullanılabilir).');
  }

  // FUEL-402.1: kota dönemleri (GÜNLÜK/HAFTALIK/AYLIK) süresi dolunca otomatik
  // sıfırlanmalı, devir politikası uygulanmalı ve kapanan dönem uzlaşma için
  // fuel_quota_history'ye arşivlenmeli. Ticket "@nestjs/schedule cron"
  // öneriyor — bu kod tabanında yok; yukarıdaki süpürücülerle AYNI düz
  // setInterval deseni. Dönem sınırları Europe/Istanbul (sabit UTC+3) olduğu
  // için saatlik bir tur, gün/hafta/ay dönüşlerini en fazla ~1 saat gecikmeyle
  // yakalamak için fazlasıyla yeterli (kalan-kota sorgusu zaten CANLI hesaplar,
  // sweep yalnızca arşiv + devir satırını yazar).
  const QUOTA_RESET_SWEEP_MS = 60 * 60 * 1000;
  const quotaResetSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [FUEL-402.1] Tenant listesi alınamadı, bu kota sıfırlama turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const { reset, expired } = await runWithTenant({ tenantId }, () => resetDueQuotasForCurrentTenant());
        if (reset > 0 || expired > 0) {
          logger.info({ tenantId, reset, expired }, `♻️ [FUEL-402.1] Dönemi dolan kotalar işlendi (sıfırlanan: ${reset}, süresi biten: ${expired}).`);
        }
      } catch (err) {
        // Bir tenant'ın sıfırlaması başarısız olması DİĞER tenant'ların turunu
        // ENGELLEMEMELİ (AI-502 ile aynı gerekçe).
        logger.error({ err, tenantId }, '🚨 [FUEL-402.1] Kota dönemi sıfırlaması başarısız.');
      }
    }
  }, QUOTA_RESET_SWEEP_MS);

  // FUEL-409 AC: "Günlük mutabakat otomatik hesaplanıp kaydedilmelidir."
  // Ticket "BullMQ repeatable job" öneriyor — yok; yukarıdaki süpürücülerle
  // AYNI düz setInterval. Her tenant'ın her tankı için son 24 saatlik rolling
  // teorik/fiziksel stok mutabakatı; fiziksel = tankın o anki
  // current_level_liters'ı (gerçek kurulumda sensör anlık görüntüsü). Tolerans
  // aşımı stock_reconciliations'a MUTABAKAT_ALARMI + audit_logs olarak düşer.
  const DAILY_RECON_SWEEP_MS = 24 * 60 * 60 * 1000;
  const dailyReconSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [FUEL-409] Tenant listesi alınamadı, bu günlük mutabakat turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const { tanksProcessed, alarms } = await runWithTenant({ tenantId }, () => runDailyStockReconciliationForCurrentTenant());
        if (tanksProcessed > 0) {
          logger.info({ tenantId, tanksProcessed, alarms }, `📊 [FUEL-409] Günlük stok mutabakatı tamamlandı (${tanksProcessed} tank, ${alarms} alarm).`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [FUEL-409] Günlük stok mutabakatı başarısız.');
      }
    }
  }, DAILY_RECON_SWEEP_MS);

  // Setup Graceful Shutdown listeners (SIGTERM, SIGINT)
  setupGracefulShutdown(server, {
    timeoutMs: 30000,
    onShutdown: async () => {
      logger.info(`🔌 [Shutdown] Eknak kaynak temizliği çalıştırılıyor...`);

      clearInterval(dispenseTimeoutSweepInterval);
      clearInterval(calibrationTimeoutSweepInterval);
      if (weeklyAnomalySweepInterval) clearInterval(weeklyAnomalySweepInterval);
      clearInterval(quotaResetSweepInterval);
      clearInterval(dailyReconSweepInterval);

      // RES-906 Kritik Not 2: ÖNCE MQTT abonelikleri kapanmalı (yeni telemetri
      // girişi dursun), SONRA tamponlar boşalıp kaynaklar kapatılmalı — ters
      // sıra veri kaybına yol açar.
      await mqttService.disconnect();

      // ioTEventBus senkron bir EventEmitter; ayrı bir async telemetri
      // tamponu/kuyruğu YOK. MQTT kapandıktan sonra yeni 'telemetryData'
      // üretilmez; devam eden senkron dinleyicilerin (socketServer,
      // theftDetectionService) oturması için kısa bir bekleme, ardından
      // birbirinden bağımsız olan Redis + Postgres birlikte kapatılır.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await Promise.all([
        redisPool.close(),
        pool.end()
      ]);
    },
  });
}

startServer().catch((err) => {
  logger.fatal({ err }, '🔥 [Bootstrap] Sunucu başlatılamadı.');
  process.exit(1);
});

export default app;
