import crypto from 'crypto';
import { logger } from '../utils/logger';

/**
 * NOTIF-1604 — genel webhook kanalı. AC: "Webhook çağrıları imzalı ve
 * zaman aşımı korumalı olmalıdır."
 *
 * Devre kesici (AC: "Sürekli hata veren webhook otomatik devre dışı
 * bırakılmalıdır") burada DEĞİL — Opossum (COMP-602.2'nin kendi ticket'ı,
 * bu kod tabanında henüz yok) gibi bir kütüphane YERİNE basit bir ardışık-
 * başarısızlık SAYACI (tenantDb.ts: checkWebhookHealthAndRecordFailure) —
 * kararı VEREN o taraf, burası sadece TEK bir denemenin mekaniğini bilir.
 */

export class WebhookDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookDisabledError';
  }
}

const WEBHOOK_TIMEOUT_MS = 5000;

/** AC: "Webhook gövdesi imzalanmalı ki alıcı doğrulayabilsin." HMAC-SHA256, hex. */
export function signWebhookPayload(secret: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

export interface SendWebhookInput {
  url: string;
  secret: string;
  payload: Record<string, unknown>;
}

export async function sendWebhook(input: SendWebhookInput): Promise<void> {
  const body = JSON.stringify(input.payload);
  const signature = signWebhookPayload(input.secret, body);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(input.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature },
      body,
      signal: controller.signal
    });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '');
      logger.error({ status: res.status, url: input.url }, `🚨 [NOTIF-1604] Webhook hedefi hata döndürdü: ${res.status}`);
      throw new Error(`Webhook hedefi hata döndürdü: ${res.status} ${responseBody}`);
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Webhook hedefi ${WEBHOOK_TIMEOUT_MS}ms içinde yanıt vermedi (timeout) — müşteri kontrolündeki bir hedef yavaş/erişilemez olabilir.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
