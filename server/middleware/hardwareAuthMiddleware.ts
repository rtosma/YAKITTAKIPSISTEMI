import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// Registered Hardware Secrets (In production, stored encrypted in database)
export const REGISTERED_HARDWARE_DEVICES: Record<string, { secret: string; name: string; siteName: string }> = {
  'ESP32-PUMP-01': {
    secret: 'secret_gebze_pump_8849',
    name: 'Gebze Pompa Otomasyonu #1',
    siteName: 'Gebze Ana Şantiye'
  },
  'ESP32-TANK-01': {
    secret: 'secret_gebze_tank_3910',
    name: 'Gebze Ultrasonik Tank Probu #1',
    siteName: 'Gebze Ana Şantiye'
  },
  'ESP32-FLOW-ISR': {
    secret: 'secret_flow_isr_7721',
    name: 'Debimetre Kesme Sensörü',
    siteName: 'Sistem Kalibrasyonu'
  }
};

/**
 * AUTH-202 Hardware Authentication Middleware
 * Validates HMAC-SHA256 signatures from ESP32 & IoT hardware devices.
 * Protects against Data Tampering, Timing Attacks, and Replay Attacks (30s window).
 */
export const hardwareAuthMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const deviceId = req.headers['x-device-id'] as string;
  const timestampHeader = req.headers['x-timestamp'] as string;
  const receivedSignature = req.headers['x-hardware-signature'] as string;

  // 1. Mandatory Headers Check
  if (!deviceId || !timestampHeader || !receivedSignature) {
    res.status(401).json({
      success: false,
      error: 'MISSING_HARDWARE_HEADERS',
      message: 'Donanım doğrulaması başarısız. X-Device-ID, X-Timestamp ve X-Hardware-Signature başlıkları zorunludur.'
    });
    return;
  }

  // 2. Replay Attack Protection (30-second sliding time window)
  const timestampMs = isNaN(Number(timestampHeader))
    ? new Date(timestampHeader).getTime()
    : Number(timestampHeader);

  if (isNaN(timestampMs)) {
    res.status(400).json({
      success: false,
      error: 'INVALID_TIMESTAMP_FORMAT',
      message: 'X-Timestamp geçerli bir milisaniye zaman damgası veya ISO tarihi olmalıdır.'
    });
    return;
  }

  const timeDifferenceMs = Math.abs(Date.now() - timestampMs);
  const MAX_ALLOWED_TIME_WINDOW_MS = 30000; // 30 seconds

  if (timeDifferenceMs > MAX_ALLOWED_TIME_WINDOW_MS) {
    res.status(401).json({
      success: false,
      error: 'REPLAY_ATTACK_DETECTED',
      message: `İstek zaman aşımına uğradı veya paket 30 saniyeden eski (${Math.round(timeDifferenceMs / 1000)}sn fark). Replay Saldırısı Engellendi.`
    });
    return;
  }

  // 3. Device Secret Retrieval
  const deviceConfig = REGISTERED_HARDWARE_DEVICES[deviceId];
  if (!deviceConfig) {
    res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED_DEVICE',
      message: `Cihaz ('${deviceId}') yetkilendirilmemiş veya sisteme kayıtlı değil.`
    });
    return;
  }

  // 4. Raw Body Extraction & HMAC-SHA256 Calculation
  const rawBodyBuf: Buffer = (req as any).rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const payloadToSign = `${timestampHeader}.${rawBodyBuf.toString('utf8')}`;

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
    res.status(401).json({
      success: false,
      error: 'INVALID_SIGNATURE_FORMAT',
      message: 'X-Hardware-Signature geçerli bir hex dizisi olmalıdır.'
    });
    return;
  }

  if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
    res.status(401).json({
      success: false,
      error: 'INVALID_HARDWARE_SIGNATURE',
      message: 'Kriptografik imza doğrulaması başarısız. Veri manipüle edilmiş veya anahtar hatalı.'
    });
    return;
  }

  // 6. Attach Authenticated Hardware Info to Request Context
  (req as any).authenticatedHardware = {
    deviceId,
    name: deviceConfig.name,
    siteName: deviceConfig.siteName,
    timestampMs
  };

  next();
};
