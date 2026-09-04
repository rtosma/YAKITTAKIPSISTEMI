import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config/env';
import { redisPool } from '../db/redisPool';
import { logger } from '../utils/logger';

// OPS-1105: cihaz sırları önceden burada düz metin olarak duruyordu — repo
// geneli bir gitleaks taraması bunu gerçek bir sızıntı olarak işaretledi.
// Artık config/env.ts (Zod ile doğrulanmış ortam değişkenleri) üzerinden
// okunuyor; yalnızca cihaz ADI/ŞANTİYESİ gibi sır OLMAYAN metadata burada.
// AUTH-202.3 (cihaz secret üretimi/saklanması/rotasyonu) henüz
// yapılmadığından bunlar hâlâ statik/sabit sırlar — bu değişiklik yalnızca
// "kaynak kodunda düz metin secret" sorununu çözüyor, tam yaşam döngüsü
// yönetimini değil.
// FUEL-401: withTenant()/tenantDb.ts fonksiyonları RLS'in devreye girmesi
// için AsyncLocalStorage'da bir tenantId bekler (bkz. context/tenantContext.ts)
// — ama donanım kimlik doğrulaması JWT değil HMAC olduğundan bu context'i
// dolduracak bir token yok. AUTH-202.3 (gerçek çoklu-kiracı cihaz
// provisioning'i) henüz yapılmadığından, hangi cihazın hangi kiracıya ait
// olduğu burada REGISTERED_HARDWARE_DEVICES'a statik olarak eklendi — bu,
// mqttClient.ts'in tenantId'yi MQTT topic'inden ayrıştırmasının HTTP
// kanalındaki karşılığı (orada topic'ten geliyor, burada cihaz kaydından).
export const REGISTERED_HARDWARE_DEVICES: Record<string, { secret: string; name: string; siteName: string; tenantId: string }> = {
  'ESP32-PUMP-01': {
    secret: config.HW_SECRET_ESP32_PUMP_01,
    name: 'Gebze Pompa Otomasyonu #1',
    siteName: 'Gebze Ana Şantiye',
    tenantId: 'comp-camsa'
  },
  'ESP32-TANK-01': {
    secret: config.HW_SECRET_ESP32_TANK_01,
    name: 'Gebze Ultrasonik Tank Probu #1',
    siteName: 'Gebze Ana Şantiye',
    tenantId: 'comp-camsa'
  },
  'ESP32-FLOW-ISR': {
    secret: config.HW_SECRET_ESP32_FLOW_ISR,
    name: 'Debimetre Kesme Sensörü',
    siteName: 'Sistem Kalibrasyonu',
    tenantId: 'comp-camsa'
  }
};

// AUTH-202.2 — 30sn'lik timestamp penceresinden BÜYÜK olmalı (ticket notu):
// bir nonce, kabul edilebilir en eski paketten bile daha uzun süre Redis'te
// tutulmalı ki pencerenin sınırındaki bir paket tekrar gönderildiğinde de
// reddedilsin.
const NONCE_TTL_MS = 120_000;
const MAX_ALLOWED_TIME_WINDOW_MS = 30_000;

// Reddedilen paket sayacı: cihaz başına, kayan bir pencerede tutulur; eşik
// aşılırsa alarm seviyesinde loglanır (Prometheus bu projede hiçbir yerde
// kurulu değil — ticket'ın "Prometheus sayaçları" önerisi yerine kod
// tabanının zaten kullandığı Redis + yapısal Pino logu deseni tercih edildi).
const REJECTION_WINDOW_SECONDS = 5 * 60;
const REJECTION_ALERT_THRESHOLD = 5;

/**
 * Bir donanım isteği reddedildiğinde çağrılır: Redis'te cihaz başına kayan
 * pencereli bir sayaç tutar, eşik aşılınca alarm seviyesinde loglar. Redis
 * erişilemez olsa bile isteğin reddi engellenmemeli — bu yüzden hata
 * yutuluyor, yalnızca loglanıyor.
 */
async function recordRejection(deviceId: string, reason: string): Promise<void> {
  try {
    const key = `hw-reject-count:${deviceId}`;
    const count = await redisPool.client.incr(key);
    if (count === 1) {
      await redisPool.client.expire(key, REJECTION_WINDOW_SECONDS);
    }

    if (count >= REJECTION_ALERT_THRESHOLD) {
      logger.error(
        { deviceId, reason, count, windowSeconds: REJECTION_WINDOW_SECONDS },
        `🚨 [AUTH-202.2] ALARM: '${deviceId}' cihazından son ${REJECTION_WINDOW_SECONDS}sn içinde ${count} reddedilen paket (son sebep: ${reason}).`
      );
    } else {
      logger.warn({ deviceId, reason, count }, `⚠️ [AUTH-202.2] Donanım paketi reddedildi: ${reason}`);
    }
  } catch (err) {
    logger.error({ err, deviceId }, '🚨 [AUTH-202.2] Reddedilen paket sayaçlanamadı (Redis hatası).');
  }
}

function reject(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ success: false, error, message });
}

/**
 * AUTH-202 Hardware Authentication Middleware
 * Validates HMAC-SHA256 signatures from ESP32 & IoT hardware devices.
 * Protects against Data Tampering, Timing Attacks, and Replay Attacks
 * (AUTH-202.2: 30sn timestamp penceresi + Redis'te TTL'li tek-kullanımlık
 * nonce — bkz. issue #32).
 */
export const hardwareAuthMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const deviceId = req.headers['x-device-id'] as string;
    const timestampHeader = req.headers['x-timestamp'] as string;
    const nonceHeader = req.headers['x-nonce'] as string;
    const receivedSignature = req.headers['x-hardware-signature'] as string;

    // 1. Mandatory Headers Check
    if (!deviceId || !timestampHeader || !nonceHeader || !receivedSignature) {
      if (deviceId) await recordRejection(deviceId, 'MISSING_HARDWARE_HEADERS');
      return reject(
        res, 401, 'MISSING_HARDWARE_HEADERS',
        'Donanım doğrulaması başarısız. X-Device-ID, X-Timestamp, X-Nonce ve X-Hardware-Signature başlıkları zorunludur.'
      );
    }

    // 2. Device Secret Retrieval (nonce/timestamp reddi de bu cihaza karşı
    // sayaçlanacağı için önce cihazın gerçekten kayıtlı olduğunu doğrula)
    const deviceConfig = REGISTERED_HARDWARE_DEVICES[deviceId];
    if (!deviceConfig) {
      await recordRejection(deviceId, 'UNAUTHORIZED_DEVICE');
      return reject(res, 401, 'UNAUTHORIZED_DEVICE', `Cihaz ('${deviceId}') yetkilendirilmemiş veya sisteme kayıtlı değil.`);
    }

    // 3. Replay Attack Protection (30-second sliding time window, ileri/geri sapma)
    const timestampMs = isNaN(Number(timestampHeader))
      ? new Date(timestampHeader).getTime()
      : Number(timestampHeader);

    if (isNaN(timestampMs)) {
      await recordRejection(deviceId, 'INVALID_TIMESTAMP_FORMAT');
      return reject(res, 400, 'INVALID_TIMESTAMP_FORMAT', 'X-Timestamp geçerli bir milisaniye zaman damgası veya ISO tarihi olmalıdır.');
    }

    const timeDifferenceMs = Math.abs(Date.now() - timestampMs);

    if (timeDifferenceMs > MAX_ALLOWED_TIME_WINDOW_MS) {
      // Cihaz saati kaymışsa (RTC drift) TÜM paketleri reddedilir ve saha
      // durur — bu yüzden sessizce 401 dönmek yerine ayrıca CLOCK_DRIFT
      // olarak loglanır (asıl saat senkronu komutu IOT-307'nin işi). Cihaz
      // BURADA kara listeye alınmaz, yalnızca bu paket reddedilir.
      logger.warn(
        { deviceId, driftMs: timeDifferenceMs },
        `⏱️ [AUTH-202.2] CLOCK_DRIFT: '${deviceId}' cihazının saati ${Math.round(timeDifferenceMs / 1000)}sn sapmış.`
      );
      await recordRejection(deviceId, 'CLOCK_DRIFT');
      return reject(
        res, 401, 'REPLAY_ATTACK_DETECTED',
        `İstek zaman aşımına uğradı veya paket 30 saniyeden eski (${Math.round(timeDifferenceMs / 1000)}sn fark). Replay Saldırısı Engellendi.`
      );
    }

    // 4. Raw Body Extraction & HMAC-SHA256 Calculation — nonce da imzaya
    // dahil edilir, aksi halde bir saldırgan yakaladığı geçerli bir paketin
    // nonce'unu değiştirip imzayı bozmadan tekrar gönderebilirdi.
    const rawBodyBuf: Buffer = (req as any).rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const payloadToSign = `${timestampHeader}.${nonceHeader}.${rawBodyBuf.toString('utf8')}`;

    const computedHmacHex = crypto
      .createHmac('sha256', deviceConfig.secret)
      .update(payloadToSign)
      .digest('hex');

    // 5. Timing Attack Prevention (crypto.timingSafeEqual)
    const expectedBuf = Buffer.from(computedHmacHex, 'hex');
    let receivedBuf: Buffer;

    try {
      receivedBuf = Buffer.from(receivedSignature, 'hex');
    } catch {
      await recordRejection(deviceId, 'INVALID_SIGNATURE_FORMAT');
      return reject(res, 401, 'INVALID_SIGNATURE_FORMAT', 'X-Hardware-Signature geçerli bir hex dizisi olmalıdır.');
    }

    if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
      await recordRejection(deviceId, 'INVALID_HARDWARE_SIGNATURE');
      return reject(res, 401, 'INVALID_HARDWARE_SIGNATURE', 'Kriptografik imza doğrulaması başarısız. Veri manipüle edilmiş veya anahtar hatalı.');
    }

    // 6. Nonce Reuse Check — yalnızca imza doğrulandıktan SONRA Redis'e
    // yazılır: sahte/imzasız isteklerin bir cihazın nonce alanını
    // tüketmesini (ve gerçek cihazın sıradaki paketini "zaten kullanılmış"
    // gibi göstermesini) önler. SET ... NX atomik olduğundan iki eşzamanlı
    // istek aynı nonce'u asla ikisi de "yeni" olarak kazanamaz.
    const nonceKey = `hw-nonce:${deviceId}:${nonceHeader}`;
    const nonceSetResult = await redisPool.client.set(nonceKey, '1', 'PX', NONCE_TTL_MS, 'NX');
    if (nonceSetResult !== 'OK') {
      await recordRejection(deviceId, 'NONCE_REUSED');
      return reject(res, 401, 'NONCE_REUSED', 'Bu nonce bu cihaz için daha önce kullanılmış. Replay Saldırısı Engellendi.');
    }

    // 7. Attach Authenticated Hardware Info to Request Context
    (req as any).authenticatedHardware = {
      deviceId,
      name: deviceConfig.name,
      siteName: deviceConfig.siteName,
      tenantId: deviceConfig.tenantId,
      timestampMs
    };

    next();
  } catch (err) {
    next(err);
  }
};
