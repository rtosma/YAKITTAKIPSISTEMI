import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * IOT-302.1 — POST /api/v1/lorawan/uplink kimlik doğrulaması.
 *
 * Ticket notu: "Bu uç internete açık; token doğrulaması olmadan sahte
 * seviye verisi enjeksiyonu mümkün." Bu yüzden:
 *  - LORAWAN_WEBHOOK_TOKEN yapılandırılmamışsa → 503 (FAIL-CLOSED; doğrulama
 *    yapamadan istek KABUL ETMEKTENSE hiç kabul etme).
 *  - `Authorization: Bearer <token>` (veya `X-Webhook-Token: <token>`) başlığı
 *    beklenen token ile SABİT ZAMANLI (`crypto.timingSafeEqual`)
 *    karşılaştırılır — eşleşmezse/eksikse 401.
 *
 * ChirpStack ve TTN'in HTTP integration'ı statik bir `Authorization` başlığı
 * göndermeyi destekler; bu yüzden HMAC yerine (ki ağ sunucusu native
 * göndermiyor) sabit token seçildi. Token değeri hiçbir zaman loglanmaz.
 */

function extractToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const custom = req.headers['x-webhook-token'];
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  return null;
}

function safeEquals(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  // Uzunluk farkı timingSafeEqual'ı patlatır — önce eşit uzunlukmuş gibi
  // dolgu yapıp yine de sabit zamanlı karşılaştır, sonra uzunluğu da denetle.
  const max = Math.max(a.length, b.length);
  const pa = Buffer.alloc(max);
  const pb = Buffer.alloc(max);
  a.copy(pa);
  b.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && a.length === b.length;
}

export function lorawanWebhookAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = config.LORAWAN_WEBHOOK_TOKEN;
  if (!expected) {
    logger.error('🚨 [IOT-302.1] LORAWAN_WEBHOOK_TOKEN tanımlı değil — /lorawan/uplink fail-closed olarak reddediyor.');
    res.status(503).json({
      success: false,
      error: 'WEBHOOK_NOT_CONFIGURED',
      message: 'LoRaWAN uplink webhook\'u yapılandırılmamış.'
    });
    return;
  }

  const token = extractToken(req);
  if (!token || !safeEquals(expected, token)) {
    logger.warn(
      { ip: req.ip, hasToken: !!token, path: req.path },
      '🚫 [IOT-302.1] Doğrulanmamış LoRaWAN webhook çağrısı reddedildi (401).'
    );
    res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Geçersiz veya eksik webhook token\'ı.'
    });
    return;
  }

  next();
}
