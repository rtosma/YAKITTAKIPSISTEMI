import express from 'express';
import cors from 'cors';
import http from 'http';

import { config } from './config/env';
import { initSocketServer } from './socket/socketServer';
import { traceMiddleware, httpLoggerMiddleware } from './middleware/loggerMiddleware';
import { globalErrorHandler, notFoundHandler, registerProcessExceptionHandlers } from './middleware/errorHandler';
import { httpMetricsMiddleware, metricsHandler, startBusinessMetricsRefresher } from './observability/metrics';
import { setupGracefulShutdown, isServerShuttingDown } from './utils/shutdown';
import { logger } from './utils/logger';
import { pool } from './db/postgresPool';
import { redisPool } from './db/redisPool';
import { mqttService } from './iot/mqttClient';
import routes from './routes/routes';
import { getAllHardwareDevices, seedLegacyHardwareDevicesIfMissing, sweepTimedOutCalibrations, getAllTenantIdsWithAiAnomalyEnabled, getAllTenantIds, listCompaniesDueForPeriodicArchive, sweepExpiredArchives, touchArchiveLastGenerated } from './db/adminDb';
import { generateArchiveForTenant } from './services/tenantArchiveService';
import { sweepTimedOutSessions } from './services/dispenseSessionService';
import { initSentry, flushSentry } from './observability/sentry';
import { createSentryTunnelHandlers } from './observability/sentryTunnel';
import { sentryTunnelRateLimiter } from './middleware/rateLimitMiddleware';
import { runRetentionPurge, purgeColdArchives } from './services/retentionService';
import { anonymizeExpiredSubjects } from './services/privacyService';
import { broadcastToTenant, drainSocketClients } from './socket/socketServer';
import { runWithTenant } from './context/tenantContext';
import { generateAndStoreAnomalyReport } from './services/consumptionAnomalyService';
import { resetDueQuotasForCurrentTenant, runDailyStockReconciliationForCurrentTenant, runAnomalyDetectionForCurrentTenant, runAlarmEscalationForCurrentTenant, runDespatchAdviceTransmissionSweepForCurrentTenant, runDespatchAdviceStatusPollForCurrentTenant, runDespatchAdviceStuckDetectionForCurrentTenant, runMaintenanceReminderSweepForCurrentTenant, runFleetComplianceSweepForCurrentTenant, runInventoryCriticalStockSweepForCurrentTenant, runTankStockAlertSweepForCurrentTenant, runDriverBehaviorScoreSweepForCurrentTenant, runDeviceHealthScoreSweepForCurrentTenant } from './db/tenantDb';
import { runNotificationRetrySweepForCurrentTenant, notifyAlarmEscalationRecipients } from './services/notificationService';
import { runReportScheduleSweepForCurrentTenant } from './services/reportScheduleService';
import { runMonthlyManagementReportSweepForCurrentTenant } from './services/monthlyManagementReportService';
import { runLicenseExpiryWarningSweep } from './services/licenseWarningService';
import { runUsageMeteringSweepForPreviousMonth } from './services/usageMeteringService';

// NOTE: environment variables are loaded by ./bootstrap.ts (the real process
// entry point — see package.json `dev`/`build`), BEFORE this module or any of
// its imports evaluate. Do not call dotenv.config() here: by the time this
// file's own top-level code would run, everything it imports above (down to
// tokenService's module-scope JWT secret reads) has already been evaluated,
// so a dotenv.config() call at this point would always be too late.

// Register process-level uncaughtException and unhandledRejection handlers
registerProcessExceptionHandlers();
// RES-907: hata izleme (DSN yoksa no-op). Sürüm etiketi APP_VERSION (OPS-1110). Kişisel veri: observability/sentryScrub.ts.
initSentry();

const app = express();
const PORT = config.PORT;

// TEST_PLAN.md §5.1 (OWASP A05 — Security Misconfiguration): Express
// varsayılan olarak her yanıta `X-Powered-By: Express` ekler. Tek başına bir
// açık değil ama saldırgana bedava parmak izi verir (hangi yığın, dolayısıyla
// hangi CVE'leri denemeli). Kapatmanın hiçbir işlevsel maliyeti yok.
app.disable('x-powered-by');

// TEST_PLAN.md §5 (OWASP A04/A07) — Express önündeki TEK reverse proxy'ye güven.
//
// BULGU (canlı kanıtlandı): bu ayar yoktu. Tüm tarayıcı trafiği nginx
// üzerinden geldiği için Express her isteğin IP'sini NGINX KONTEYNERİNİN IP'si
// sanıyordu (`rl:auth-login:172.18.0.5`). Sonuç: IP bazlı rate limiter'lar
// kişi başına değil PLATFORM GENELİNDE tek bir kova gibi çalışıyordu.
// Ölçülen etki: 172.18.0.8'deki bir "saldırgan" kimlik bilgisi olmadan 10 istek
// attı; 172.18.0.7'deki meşru kullanıcı doğru şifreyle 429 aldı — yani 15
// dakikada 10 istekle HERKESİN girişi kilitlenebiliyordu. Aynı sebeple audit
// log / oturum kayıtlarındaki IP'ler de hep nginx'i gösteriyordu.
//
// Neden `1` (sayı) ve 'loopback, uniquelocal' gibi bir aralık DEĞİL: dağıtım
// topolojisi tam olarak tek atlama (istemci → nginx → backend). nginx
// `$proxy_add_x_forwarded_for` ile gerçek `$remote_addr`'i listenin SONUNA
// ekliyor; `trust proxy = 1` Express'in yalnızca bu son girdiyi almasını sağlar,
// istemcinin kendi gönderdiği sahte X-Forwarded-For girdileri (listenin
// solunda kalır) YOK SAYILIR. Aralık tabanlı güven ise özel ağdaki bir
// istemcinin sahte başlıkla limiti atlatmasına izin verirdi.
//
// ÖNKOŞUL: backend'in portu dışarıya YAYINLANMAMALI (OPS-1102 bunu zaten
// kaldırdı) — doğrudan erişilebilen bir backend'de istemci X-Forwarded-For'u
// kendisi yazıp her istekte "farklı IP" olarak görünebilir. Araya ikinci bir
// proxy (ör. bulut load balancer) eklenirse bu sayı 2 olmalıdır.
app.set('trust proxy', 1);

// TEST_PLAN.md §5.2 — CORS artık VARSAYILAN OLARAK KAPALI.
// Eskiden `app.use(cors())` çağrılıyordu; bu, her yanıta
// `Access-Control-Allow-Origin: *` ekleyip API'yi her origin'e açıyordu.
// Gerekli değildi: nginx SPA'yı ve /api'yi aynı origin'den sunuyor, frontend
// göreli yol (`/api/v1`) kullanıyor, saha cihazları ise tarayıcı olmadığı
// için CORS'a tabi değil. Artık yalnızca CORS_ALLOWED_ORIGINS ile AÇIKÇA
// izin verilen origin'ler geçer (bkz. config/env.ts).
const corsAllowedOrigins = (config.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (corsAllowedOrigins.length > 0) {
  app.use(cors({ origin: corsAllowedOrigins, credentials: true }));
  logger.info({ corsAllowedOrigins }, '🌐 [CORS] Yalnızca tanımlı origin listesine izin veriliyor.');
} else {
  logger.info('🌐 [CORS] Kapalı (same-origin). Gerekirse CORS_ALLOWED_ORIGINS ile açın.');
}

// OPS-1107: HTTP süre/sayaç metrikleri EN ERKEN middleware — kapanma 503'leri ve tüm yollar ölçülür. /metrics API dışıdır (nginx proxy'lemez).
app.use(httpMetricsMiddleware);
app.get('/metrics', metricsHandler());

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
// durum değil. FLEET-1409: 10MB'lık bir araç belgesi base64'e çevrilince
// ~%33 şişer (≈13.3MB) — JSON gövdesi (dosya + birkaç metadata alanı) bu
// yüzden 10mb sınırını AŞARDI, limit 15mb'a çekildi (13.3MB + pay).
app.use(express.json({
  limit: '15mb',
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
// RES-907: tarayıcı hata olayları için same-origin Sentry tüneli (kimliksiz; IP limitli; yalnızca yapılandırılmış DSN'e iletir, PII sunucuda temizlenir).
app.post('/api/v1/monitoring/sentry-tunnel', sentryTunnelRateLimiter, ...createSentryTunnelHandlers());
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
  // CI'daki OPS-1101 SIGTERM testi POSTGRES_HOST=__CI_SKIP__ ile (DB'siz)
  // çalışır — MQTT_URL'deki AYNI sözleşme. Bu kontrol olmadan seed, listen ve
  // setupGracefulShutdown'dan ÖNCE DB'ye bağlanmaya çalışıp takılıyor/çöküyor;
  // SIGTERM handler'sız bir sürece gelip testi (AUTH-202.3'ten beri) kırıyordu.
  if (config.POSTGRES_HOST !== '__CI_SKIP__') {
    await seedLegacyHardwareDevicesIfMissing({
      HW_SECRET_ESP32_PUMP_01: config.HW_SECRET_ESP32_PUMP_01,
      HW_SECRET_ESP32_TANK_01: config.HW_SECRET_ESP32_TANK_01,
      HW_SECRET_ESP32_FLOW_ISR: config.HW_SECRET_ESP32_FLOW_ISR
    });
  }

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

  // BILL-1702 AC: "süre bitimine 30/15/7 gün kala uyarı." Ticket "NOTIF-1601"
  // (ayrı bildirim servisi) öneriyor — yok; yukarıdakilerle AYNI setInterval.
  // Gün granülaritesinde bir eşik olduğu için günlük bir tur yeterli
  // (mantığın kendisi licenseWarningService.ts'te — `POST
  // /admin/license-expiry-sweep` ile de manuel/anlık tetiklenebilir).
  const LICENSE_WARNING_SWEEP_MS = 24 * 60 * 60 * 1000;
  const licenseWarningSweepInterval = setInterval(async () => {
    try {
      const { checked, warned } = await runLicenseExpiryWarningSweep();
      if (warned > 0) {
        logger.info({ checked, warned }, `⏳ [BILL-1702] Lisans süresi uyarı turu tamamlandı (${warned}/${checked} firma uyarıldı).`);
      }
    } catch (err) {
      logger.error({ err }, '🚨 [BILL-1702] Lisans süresi uyarı turu başarısız.');
    }
  }, LICENSE_WARNING_SWEEP_MS);

  // BILL-1704 AC: "ölçüm boyutlarının dönemsel toplanması." Ticket
  // "TimescaleDB continuous aggregates + BullMQ" öneriyor — yok;
  // yukarıdakilerle AYNI setInterval. Günlük tur her seferinde bir önceki
  // AYI hesaplamaya çalışır — usageMeteringService.ts'in ON CONFLICT DO
  // NOTHING'i sayesinde ay içinde her gün tekrar denemek zararsızdır
  // (yalnızca ayın ilk turunda gerçekten INSERT eder).
  const USAGE_METERING_SWEEP_MS = 24 * 60 * 60 * 1000;
  const usageMeteringSweepInterval = setInterval(async () => {
    try {
      const { tenantsProcessed, recordsComputed } = await runUsageMeteringSweepForPreviousMonth();
      if (recordsComputed > 0) {
        logger.info({ tenantsProcessed, recordsComputed }, `📊 [BILL-1704] Kullanım ölçümü turu tamamlandı (${recordsComputed}/${tenantsProcessed} firma için yeni kayıt).`);
      }
    } catch (err) {
      logger.error({ err }, '🚨 [BILL-1704] Kullanım ölçümü turu başarısız.');
    }
  }, USAGE_METERING_SWEEP_MS);

  // AI-504 AC: "Mesai dışı alımlar işaretlenip bildirim üretmelidir." Ticket
  // "ARCH-102 event handler" öneriyor — yok; yukarıdakilerle AYNI setInterval.
  // Son 2 saatlik ikmalleri tarar (üst üste binme (transaction_id, anomaly_type)
  // benzersizliğiyle zararsız); kural tabanlı, harici bağımlılık yok.
  const ANOMALY_SWEEP_MS = 60 * 60 * 1000;
  const anomalySweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [AI-504] Tenant listesi alınamadı, bu anomali tarama turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runAnomalyDetectionForCurrentTenant({ sinceHours: 2 }));
        const newTotal = r.newFlags.MESAI_DISI + r.newFlags.KISA_ARALIK_MUKERRER;
        if (newTotal > 0) {
          broadcastToTenant(tenantId, 'anomaly:flagged', { source: 'scheduled-sweep', ...r });
          logger.info({ tenantId, newFlags: r.newFlags }, `🕵️ [AI-504] Anomali taraması: ${newTotal} yeni işaret.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [AI-504] Anomali taraması başarısız.');
      }
    }
  }, ANOMALY_SWEEP_MS);

  // AI-507/NOTIF-1606 AC: "Yanıtsız kritik alarm tanımlı süre sonra üst
  // kademeye iletilmelidir." Saatlik: atanmamış + susturulmamış CRITICAL/
  // WARNING/OPEN alarmların tanımlı zincirdeki (bkz. tenantDb.ts
  // ALARM_ESCALATION_CHAINS) sırası gelen kademesindeki ROLE'e bildirim
  // gönderilir + WebSocket'te yayınlanır.
  const ALARM_ESCALATION_SWEEP_MS = 60 * 60 * 1000;
  const alarmEscalationSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [AI-507] Tenant listesi alınamadı, bu eskalasyon turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const escalated = await runWithTenant({ tenantId }, () => runAlarmEscalationForCurrentTenant());
        await notifyAlarmEscalationRecipients(tenantId, escalated);
        for (const a of escalated) {
          broadcastToTenant(tenantId, 'alarm:escalated', { id: a.id, title: a.title, escalationLevel: a.escalation_level, siteName: a.site_name, notifyRole: a.notify_role, chainExhausted: a.chain_exhausted });
          logger.warn({ tenantId, alarmId: a.id, level: a.escalation_level, role: a.notify_role }, `⛰️ [NOTIF-1606] Alarm eskalasyonu (kademe ${a.escalation_level} → ${a.notify_role ?? 'ALICI YOK'}): ${a.title}`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [AI-507] Alarm eskalasyon süpürmesi başarısız.');
      }
    }
  }, ALARM_ESCALATION_SWEEP_MS);

  // COMP-602.1 AC: "gönderim sırası korunmalı, tek worker eşzamanlılığı."
  // Ticket NestJS + BullMQ repeatable job öneriyor — yok; yukarıdaki
  // süpürücülerle AYNI düz setInterval. 60 sn'de bir her tenant için (sırayla,
  // aynı anda değil — bu döngü de tek worker'dır) en fazla
  // DESPATCH_TRANSMISSION_SWEEP_BATCH_SIZE kadar QUEUED satırı sırayla
  // entegratöre gönderir.
  const DESPATCH_TRANSMISSION_SWEEP_MS = 60 * 1000;
  const despatchTransmissionSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [COMP-602.1] Tenant listesi alınamadı, bu iletim süpürme turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runDespatchAdviceTransmissionSweepForCurrentTenant());
        if (r.processed > 0) {
          logger.info({ tenantId, ...r }, `📨 [COMP-602.1] e-İrsaliye iletim süpürmesi: ${r.sent} gönderildi, ${r.failed} kalıcı hata, ${r.requeued} yeniden kuyrukta.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [COMP-602.1] e-İrsaliye iletim süpürmesi başarısız.');
      }
    }
  }, DESPATCH_TRANSMISSION_SWEEP_MS);

  // COMP-602.2 AC: "Gönderilmiş belgelerin durum yoklaması." Aynı desen —
  // düz setInterval, iletim süpürmesiyle AYNI periyot (bağımsız bir dış çağrı
  // türü — send() değil checkStatus() — devre kesiciyi etkilemez/okumaz).
  const DESPATCH_STATUS_POLL_MS = 60 * 1000;
  const despatchStatusPollInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [COMP-602.2] Tenant listesi alınamadı, bu GİB durum yoklama turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runDespatchAdviceStatusPollForCurrentTenant());
        if (r.checked > 0) {
          logger.info({ tenantId, ...r }, `📋 [COMP-602.2] GİB durum yoklaması: ${r.checked} sorgulandı, ${r.finalized} nihai karara ulaştı.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [COMP-602.2] GİB durum yoklaması başarısız.');
      }
    }
  }, DESPATCH_STATUS_POLL_MS);

  // COMP-604 AC: "Takılı kalan belgeler için uyarı (örn. 24 saattir yanıt
  // yok)." Eşik zaten 24 saat olduğundan günlük bir tur yeterli — diğer
  // günlük süpürücülerle (FLEET-1407 vb.) AYNI desen.
  const DESPATCH_STUCK_DETECTION_MS = 24 * 60 * 60 * 1000;
  const despatchStuckDetectionInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [COMP-604] Tenant listesi alınamadı, bu takılı-belge taraması atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runDespatchAdviceStuckDetectionForCurrentTenant());
        if (r.stuckCount > 0) {
          logger.warn({ tenantId, ...r }, `🚨 [COMP-604] ${r.stuckCount} e-İrsaliye 24 saatten uzun süredir yanıt bekliyor.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [COMP-604] Takılı-belge taraması başarısız.');
      }
    }
  }, DESPATCH_STUCK_DETECTION_MS);

  // FLEET-1407 AC: "yaklaşan bakımlar için hatırlatma sistemi." Ticket
  // NOTIF-1601 öneriyor — yok; yukarıdaki süpürücülerle AYNI setInterval.
  // Günlük bir tur, tarih/sayaç eşiğine yaklaşan/geçen araçlar için AI-507
  // birleşik alarm sistemine (MAINTENANCE_DUE) düşer.
  const MAINTENANCE_REMINDER_SWEEP_MS = 24 * 60 * 60 * 1000;
  const maintenanceReminderSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [FLEET-1407] Tenant listesi alınamadı, bu bakım hatırlatma turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runMaintenanceReminderSweepForCurrentTenant());
        if (r.alarmsRaised > 0) {
          logger.info({ tenantId, ...r }, `🔧 [FLEET-1407] Bakım hatırlatma taraması: ${r.alarmsRaised} yeni/tekrarlanan alarm.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [FLEET-1407] Bakım hatırlatma taraması başarısız.');
      }
    }
  }, MAINTENANCE_REMINDER_SWEEP_MS);

  // FLEET-1408 AC: "30/15/7 gün kala uyarı, geciken KRİTİK gösterilmeli."
  // Ticket NestJS + @nestjs/schedule + NOTIF-1601 öneriyor — yukarıdaki
  // süpürücülerle AYNI desen: günlük tur, muayene/egzoz/sigorta + lastik
  // durumunu tarar, AI-507'ye (COMPLIANCE_DEADLINE/TIRE_REPLACEMENT_DUE) akıtır.
  const FLEET_COMPLIANCE_SWEEP_MS = 24 * 60 * 60 * 1000;
  const fleetComplianceSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [FLEET-1408] Tenant listesi alınamadı, bu uygunluk turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runFleetComplianceSweepForCurrentTenant());
        if (r.alarmsRaised > 0) {
          logger.info({ tenantId, ...r }, `📋 [FLEET-1408] Uygunluk taraması: ${r.alarmsRaised} yeni/tekrarlanan alarm.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [FLEET-1408] Uygunluk taraması başarısız.');
      }
    }
  }, FLEET_COMPLIANCE_SWEEP_MS);

  // INV-1506 AC: "kritik stok uyarıları üretilmeli." Ticket NestJS +
  // NOTIF-1601 öneriyor — yukarıdakilerle AYNI setInterval. Kritik eşik bir
  // hareket OLMADAN da (yalnızca eşik düşürülerek) aşılabileceği için
  // hareket-anındaki anlık kontrolün YANINDA günlük bir yeniden-tarama.
  const INVENTORY_CRITICAL_STOCK_SWEEP_MS = 24 * 60 * 60 * 1000;
  const inventoryCriticalStockSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [INV-1506] Tenant listesi alınamadı, bu kritik stok turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runInventoryCriticalStockSweepForCurrentTenant());
        if (r.alarmsRaised > 0) {
          logger.info({ tenantId, ...r }, `📦 [INV-1506] Kritik stok taraması: ${r.alarmsRaised} yeni/tekrarlanan alarm.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [INV-1506] Kritik stok taraması başarısız.');
      }
    }
  }, INVENTORY_CRITICAL_STOCK_SWEEP_MS);

  // INV-1504 AC: "eşik altına düşen VEYA tahmini bitişe X gün kala tanklar
  // için sipariş uyarısı üretilmelidir." Ticket NestJS + BullMQ repeatable
  // job + NOTIF-1601 öneriyor — INV-1506'daki AYNI desen: düz setInterval,
  // AI-507 alarm sistemi tek bildirim kanalı (alarm_key dedupe zaten "günde
  // birden fazla uyarı" AC'sini doğal olarak sağlıyor).
  const TANK_STOCK_ALERT_SWEEP_MS = 24 * 60 * 60 * 1000;
  const tankStockAlertSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [INV-1504] Tenant listesi alınamadı, bu stok tahmini turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runTankStockAlertSweepForCurrentTenant());
        if (r.alarmsRaised > 0) {
          logger.info({ tenantId, ...r }, `⛽ [INV-1504] Tank stok tahmini taraması: ${r.alarmsRaised} yeni/tekrarlanan alarm.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [INV-1504] Tank stok tahmini taraması başarısız.');
      }
    }
  }, TANK_STOCK_ALERT_SWEEP_MS);

  // AI-506 AC: "skor geçmişi tutulmalı." Bu süpürücü fonksiyonu
  // (runDriverBehaviorScoreSweepForCurrentTenant) tenantDb.ts'te önceden
  // yazılmıştı ama BURADA hiç kayıt edilmemişti (yalnızca manuel POST
  // /drivers/behavior-scores/compute ile tetiklenebiliyordu) — IOT-308
  // taraması eklenirken fark edilip düzeltildi. Diğer günlük süpürücülerle
  // AYNI desen.
  const DRIVER_SCORE_SWEEP_MS = 24 * 60 * 60 * 1000;
  const driverScoreSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [AI-506] Tenant listesi alınamadı, bu şoför skoru turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runDriverBehaviorScoreSweepForCurrentTenant());
        if (r.alarmsRaised > 0) {
          logger.info({ tenantId, ...r }, `🚗 [AI-506] Şoför davranış skoru taraması: ${r.alarmsRaised} yeni/tekrarlanan alarm.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [AI-506] Şoför davranış skoru taraması başarısız.');
      }
    }
  }, DRIVER_SCORE_SWEEP_MS);

  // IOT-308 AC: "aylık online SLA... eşik altına düşünce bildirim." Ticket
  // NestJS + @nestjs/schedule öneriyor — yukarıdaki süpürücülerle AYNI düz
  // setInterval. Günlük bir tur: her AKTİF cihaz için sağlık skoru hesaplar,
  // kritik eşiğin altındakiler için AI-507'ye (DEVICE_HEALTH_SCORE_LOW) alarm.
  const DEVICE_HEALTH_SWEEP_MS = 24 * 60 * 60 * 1000;
  const deviceHealthSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [IOT-308] Tenant listesi alınamadı, bu cihaz sağlığı turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runDeviceHealthScoreSweepForCurrentTenant());
        if (r.alarmsRaised > 0) {
          logger.info({ tenantId, ...r }, `🛰️ [IOT-308] Cihaz sağlığı taraması: ${r.alarmsRaised} yeni/tekrarlanan alarm.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [IOT-308] Cihaz sağlığı taraması başarısız.');
      }
    }
  }, DEVICE_HEALTH_SWEEP_MS);

  // NOTIF-1601 AC: "Teslim durumu takibi, yeniden deneme..." Ticket BullMQ
  // öneriyor — yukarıdaki süpürücülerle AYNI düz setInterval. BAŞARISIZ
  // bildirimlerin teslimini yeniden dener; MAX_DELIVERY_ATTEMPTS (3) sonrası
  // KALICI_BAŞARISIZ'a düşürür (bkz. notificationService.ts).
  const NOTIFICATION_RETRY_SWEEP_MS = 5 * 60 * 1000;
  const notificationRetrySweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [NOTIF-1601] Tenant listesi alınamadı, bu bildirim yeniden deneme turu atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runNotificationRetrySweepForCurrentTenant());
        if (r.retried > 0 || r.permanentlyFailed > 0) {
          logger.info({ tenantId, ...r }, `📬 [NOTIF-1601] Bildirim yeniden deneme turu: ${r.retried} teslim edildi, ${r.permanentlyFailed} kalıcı başarısız.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [NOTIF-1601] Bildirim yeniden deneme turu başarısız.');
      }
    }
  }, NOTIFICATION_RETRY_SWEEP_MS);

  // REP-702 AC: "Periyot seçimi (7/15/30/90 gün)... tetikleyicisi." Ticket
  // BullMQ + @nestjs/schedule öneriyor — yok; yukarıdaki süpürücülerle AYNI
  // düz setInterval. Günlük bir tur: `companies.archive_period_days` ayarlı
  // VE süresi gelmiş (hiç üretilmemiş ya da son üretimden `period_days` gün
  // geçmiş) her firma için şifreli arşivi üretir. Tek bir firmanın hatası
  // (örn. o anki bir DB/Redis sıçraması) diğerlerini durdurmaz — sırayla,
  // her biri kendi try/catch'i içinde.
  const ARCHIVE_GENERATION_SWEEP_MS = 24 * 60 * 60 * 1000;
  const archiveGenerationSweepInterval = setInterval(async () => {
    let due: Array<{ tenantId: string; periodDays: number }> = [];
    try {
      due = await listCompaniesDueForPeriodicArchive();
    } catch (err) {
      logger.error({ err }, '🚨 [REP-702] Süresi gelen arşiv firmaları listelenemedi, bu tur atlandı.');
      return;
    }
    for (const { tenantId, periodDays } of due) {
      try {
        await runWithTenant({ tenantId }, () => generateArchiveForTenant(tenantId, periodDays as 7 | 15 | 30 | 90, null, 'PERIYODIK'));
        await touchArchiveLastGenerated(tenantId);
        logger.info({ tenantId, periodDays }, '📦 [REP-702] Periyodik arşiv turu: firma için yeni arşiv üretildi.');
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [REP-702] Periyodik arşiv üretimi başarısız.');
      }
    }
  }, ARCHIVE_GENERATION_SWEEP_MS);

  // AC ile dolaylı ilgili (ARŞİV depolamasının süresiz büyümemesi) — süresi
  // dolmuş arşivlerin BYTEA içeriğini temizler (bkz. adminDb.ts'teki
  // sweepExpiredArchives yorumu: satırın kendisi/denetim geçmişi kalır,
  // sadece dosya verisi silinir). Günlük yeterli — `expires_at` gün
  // granülaritesinde bir SLA değil, saatlik bir hassasiyet gerektirmiyor.
  const ARCHIVE_CLEANUP_SWEEP_MS = 24 * 60 * 60 * 1000;
  const archiveCleanupSweepInterval = setInterval(async () => {
    try {
      const cleaned = await sweepExpiredArchives();
      if (cleaned > 0) {
        logger.info({ cleaned }, `🧹 [REP-702] Süresi dolmuş arşiv temizliği: ${cleaned} arşivin dosyası temizlendi.`);
      }
    } catch (err) {
      logger.error({ err }, '🚨 [REP-702] Süresi dolmuş arşiv temizliği başarısız.');
    }
  }, ARCHIVE_CLEANUP_SWEEP_MS);

  // ARCH-107 AC: "Her veri sınıfı için saklama süresi yapılandırılabilir" + "Purge öncesi arşiv zorunlu" + "Mali kayıtlar
  // asla silinmez". Ticket BullMQ repeatable job/@nestjs/schedule öneriyor — yok; yukarıdakilerle AYNI düz setInterval.
  // Günlük tur (saklama süreleri gün granülaritesinde); asıl iş retentionService.runRetentionPurge (arşiv+silme aynı
  // transaction'da, parti parti, advisory lock ile tek replikada). Bir sınıfın hatası diğerlerini durdurmaz.
  const RETENTION_PURGE_SWEEP_MS = 24 * 60 * 60 * 1000;
  const retentionPurgeSweepInterval = setInterval(async () => {
    try {
      const run = await runRetentionPurge();
      if (run.skippedLocked) return;
      for (const r of run.results) {
        if (r.cancelled) logger.error({ ...r }, '🚨 [ARCH-107] Retention purge iptal edildi.');
        else logger.info({ ...r }, `🗄️ [ARCH-107] Retention purge: ${r.dataClass} — ${r.rows} satır arşivlenip silindi.`);
      }
    } catch (err) {
      logger.error({ err }, '🚨 [ARCH-107] Retention purge turu başarısız.');
    }
    // COMP-606: aynı günlük tur — süresi dolan kişisel verilerin anonimleştirilmesi + soğuk arşiv ömrü. Birbirinden ve
    // yukarıdaki purge'ten bağımsız (biri hata verirse diğerleri sürer).
    try {
      for (const r of await anonymizeExpiredSubjects()) {
        logger.info({ ...r }, `🔒 [COMP-606] Süresi dolan kişisel veri: ${r.dataClass} — ${r.anonymized}/${r.candidates} anonimleştirildi${r.failed ? `, ${r.failed} BAŞARISIZ` : ''}.`);
      }
    } catch (err) {
      logger.error({ err }, '🚨 [COMP-606] Kişisel veri anonimleştirme turu başarısız.');
    }
    try {
      for (const r of await purgeColdArchives()) {
        logger.info({ ...r }, `🗄️ [COMP-606] Soğuk arşiv ömrü doldu: ${r.archives} arşiv silindi.`);
      }
    } catch (err) {
      logger.error({ err }, '🚨 [COMP-606] Soğuk arşiv temizliği turu başarısız.');
    }
  }, RETENTION_PURGE_SWEEP_MS);

  // REP-705 AC: "Zamanlanan rapor belirlenen periyotta üretilip
  // gönderilmelidir." Ticket BullMQ repeatable job öneriyor — yukarıdaki
  // süpürücülerle AYNI düz setInterval. Saatlik tur yeterli: zamanlamalar
  // Europe/Istanbul (sabit UTC+3) saat granülaritesinde tanımlı (bkz.
  // reportScheduleService.ts), bu yüzden en fazla ~1 saat gecikmeyle yakalanır.
  const REPORT_SCHEDULE_SWEEP_MS = 60 * 60 * 1000;
  const reportScheduleSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [REP-705] Tenant listesi alınamadı, bu tur atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runReportScheduleSweepForCurrentTenant());
        if (r.processed > 0) {
          logger.info({ tenantId, ...r }, `📊 [REP-705] Zamanlanmış rapor turu: ${r.sent} gönderildi, ${r.failed} başarısız, ${r.skippedEmpty} boş rapor atlandı.`);
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [REP-705] Zamanlanmış rapor süpürmesi başarısız.');
      }
    }
  }, REPORT_SCHEDULE_SWEEP_MS);

  // REP-724 AC: "Aylık özet otomatik üretilip gönderilmelidir." Yukarıdakilerle AYNI düz saatlik setInterval (BullMQ yok). Her ayın 1'inde
  // 08:00'dan (Europe/Istanbul sabit UTC+3) itibaren bir önceki ayın raporu üretilir + e-postalanır; UNIQUE(tenant, ay) ve teslim izi
  // sayesinde sonraki turlar yeni rapor/çift e-posta üretmez, yalnızca başarısız/eksik alıcılara yeniden dener (bkz. monthlyManagementReportService.ts).
  const MONTHLY_REPORT_SWEEP_MS = 60 * 60 * 1000;
  const monthlyManagementReportSweepInterval = setInterval(async () => {
    let tenantIds: string[] = [];
    try {
      tenantIds = await getAllTenantIds();
    } catch (err) {
      logger.error({ err }, '🚨 [REP-724] Tenant listesi alınamadı, bu tur atlandı.');
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const r = await runWithTenant({ tenantId }, () => runMonthlyManagementReportSweepForCurrentTenant());
        if (r.generated || r.delivery) {
          logger.info({ tenantId, month: r.month, generated: r.generated, delivery: r.delivery }, '📈 [REP-724] Aylık yönetim raporu turu.');
        }
      } catch (err) {
        logger.error({ err, tenantId }, '🚨 [REP-724] Aylık yönetim raporu süpürmesi başarısız.');
      }
    }
  }, MONTHLY_REPORT_SWEEP_MS);

  // OPS-1107: iş metrikleri (cihaz/alarm/ikmal/e-İrsaliye kuyruğu) arka planda 30 sn'de bir yenilenir.
  const stopBusinessMetricsRefresher = startBusinessMetricsRefresher();

  // Setup Graceful Shutdown listeners (SIGTERM, SIGINT)
  const SOCKET_DRAIN_WINDOW_MS = 8000;
  setupGracefulShutdown(server, {
    timeoutMs: 30000,
    // OPS-1110: WebSocket istemcilerini 8 sn'ye yayarak kopar (bkz. drainSocketClients);
    // aksi halde server.close() tamamlanmaz ve 30 sn zorla-çıkışa takılır.
    onShutdownStart: async () => { await drainSocketClients(SOCKET_DRAIN_WINDOW_MS); },
    onShutdown: async () => {
      logger.info(`🔌 [Shutdown] Eknak kaynak temizliği çalıştırılıyor...`);

      clearInterval(dispenseTimeoutSweepInterval);
      clearInterval(calibrationTimeoutSweepInterval);
      if (weeklyAnomalySweepInterval) clearInterval(weeklyAnomalySweepInterval);
      clearInterval(quotaResetSweepInterval);
      clearInterval(dailyReconSweepInterval);
      clearInterval(licenseWarningSweepInterval);
      clearInterval(usageMeteringSweepInterval);
      clearInterval(anomalySweepInterval);
      clearInterval(alarmEscalationSweepInterval);
      clearInterval(despatchTransmissionSweepInterval);
      clearInterval(despatchStatusPollInterval);
      clearInterval(despatchStuckDetectionInterval);
      clearInterval(maintenanceReminderSweepInterval);
      clearInterval(fleetComplianceSweepInterval);
      clearInterval(inventoryCriticalStockSweepInterval);
      clearInterval(tankStockAlertSweepInterval);
      clearInterval(driverScoreSweepInterval);
      clearInterval(deviceHealthSweepInterval);
      clearInterval(notificationRetrySweepInterval);
      clearInterval(archiveGenerationSweepInterval);
      clearInterval(archiveCleanupSweepInterval);
      clearInterval(retentionPurgeSweepInterval);
      clearInterval(reportScheduleSweepInterval);
      clearInterval(monthlyManagementReportSweepInterval);
      stopBusinessMetricsRefresher();
      await flushSentry(2000); // RES-907: kapanırken bekleyen hata olaylarını gönder

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
