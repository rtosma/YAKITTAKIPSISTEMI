import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { redisPool } from '../db/redisPool';
import { getHardwareDeviceByDeviceId } from '../db/adminDb';
import { decryptDeviceSecret } from '../utils/hardwareSecretCrypto';
import { logger } from '../utils/logger';

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
 * Bir secret'ın, alınan imzayla eşleşip eşleşmediğini timing-attack'e
 * dayanıklı şekilde kontrol eder. AUTH-202.3'ün "rotasyon sırasında iki
 * secret de geçerli" AC'si için hem güncel hem önceki secret'a karşı
 * (varsa) çağrılır.
 */
function signatureMatches(secret: string, payloadToSign: string, receivedBuf: Buffer): boolean {
  const expectedBuf = Buffer.from(
    crypto.createHmac('sha256', secret).update(payloadToSign).digest('hex'),
    'hex'
  );
  return expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * AUTH-202 Hardware Authentication Middleware
 * Validates HMAC-SHA256 signatures from ESP32 & IoT hardware devices.
 * Protects against Data Tampering, Timing Attacks, and Replay Attacks
 * (AUTH-202.2: 30sn timestamp penceresi + Redis'te TTL'li tek-kullanımlık
 * nonce — bkz. issue #32).
 *
 * AUTH-202.3: cihaz kaydı artık statik bir sabit (REGISTERED_HARDWARE_DEVICES)
 * değil, hardware_devices tablosunda — secret'lar AES-256-GCM ile şifreli
 * saklanır, uzaktan rotasyon ve bloke etme desteklenir (bkz. adminDb.ts
 * getHardwareDeviceByDeviceId, tenantDb.ts createHardwareDevice/
 * rotateHardwareDeviceSecret/blockHardwareDevice).
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

    // 2. Device Lookup (nonce/timestamp reddi de bu cihaza karşı
    // sayaçlanacağı için önce cihazın gerçekten kayıtlı olduğunu doğrula)
    const device = await getHardwareDeviceByDeviceId(deviceId);
    if (!device) {
      await recordRejection(deviceId, 'UNAUTHORIZED_DEVICE');
      return reject(res, 401, 'UNAUTHORIZED_DEVICE', `Cihaz ('${deviceId}') yetkilendirilmemiş veya sisteme kayıtlı değil.`);
    }

    // AC: "Sızıntı şüphesinde cihazın anında bloke edilmesi" — bloke edilen
    // cihazın paketleri, imza doğru olsa bile, HİÇBİR kontrole geçmeden
    // reddedilir.
    if (device.status === 'BLOKE') {
      await recordRejection(deviceId, 'DEVICE_BLOCKED');
      return reject(res, 403, 'DEVICE_BLOCKED', `Cihaz ('${deviceId}') bloke edilmiş.`);
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

    // 5. Timing Attack Prevention (crypto.timingSafeEqual) — önce güncel
    // secret, eşleşmezse (ve rotasyon geçiş penceresi hâlâ açıksa) önceki
    // secret denenir (AUTH-202.3 AC: "rotasyon sırasında iki secret de
    // geçerli olmalı").
    let receivedBuf: Buffer;
    try {
      receivedBuf = Buffer.from(receivedSignature, 'hex');
    } catch {
      await recordRejection(deviceId, 'INVALID_SIGNATURE_FORMAT');
      return reject(res, 401, 'INVALID_SIGNATURE_FORMAT', 'X-Hardware-Signature geçerli bir hex dizisi olmalıdır.');
    }

    let matched = signatureMatches(decryptDeviceSecret(device.encrypted_secret), payloadToSign, receivedBuf);
    let usedPreviousSecret = false;

    if (!matched && device.encrypted_secret_previous && device.previous_secret_expires_at &&
      new Date(device.previous_secret_expires_at).getTime() > Date.now()) {
      matched = signatureMatches(decryptDeviceSecret(device.encrypted_secret_previous), payloadToSign, receivedBuf);
      usedPreviousSecret = true;
    }

    if (!matched) {
      await recordRejection(deviceId, 'INVALID_HARDWARE_SIGNATURE');
      return reject(res, 401, 'INVALID_HARDWARE_SIGNATURE', 'Kriptografik imza doğrulaması başarısız. Veri manipüle edilmiş veya anahtar hatalı.');
    }

    if (usedPreviousSecret) {
      // Cihaz rotasyon komutunu henüz almamış — sahada kesinti yaşanmadı
      // (istek kabul edildi) ama operasyon ekibinin bunu görmesi gerekiyor.
      logger.warn({ deviceId }, `⚠️ [AUTH-202.3] '${deviceId}' hâlâ ROTASYONDAN ÖNCEKİ secret'ı kullanıyor (geçiş penceresi içinde kabul edildi).`);
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
      name: device.name,
      siteName: device.site_name,
      tenantId: device.tenant_id,
      timestampMs
    };

    next();
  } catch (err) {
    next(err);
  }
};
