import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * NOTIF-1604 — Telegram bot kanalı. Telegram Bot API'nin kendisi HTTPS/JSON
 * üzerinden çalışır — axios (ticket'ın Teknik Yığın'ı) gibi bir istemci
 * kütüphanesi GEREKMEZ, düz `fetch` yeterli (bu kod tabanının SMTP/SMS
 * kanallarındaki AYNI tercih).
 */

export class TelegramPermanentFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramPermanentFailureError';
  }
}

export interface SendTelegramInput {
  botToken: string;
  chatId: string;
  text: string;
}

export async function sendTelegramMessage(input: SendTelegramInput): Promise<void> {
  const res = await fetch(`${config.TELEGRAM_API_BASE_URL}/bot${input.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: input.chatId, text: input.text })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body, chatId: input.chatId }, `🚨 [NOTIF-1604] Telegram API hatası: ${res.status}`);
    // Telegram 400/401/403 (geçersiz token, botun gruptan çıkarılmış olması,
    // yanlış chat_id) hep KALICIDIR — yeniden denemek anlamsız, tekrar aynı
    // hatayı alır. 429 (rate limit) tek istisna: GEÇİCİ, retry mantıklı.
    if (res.status !== 429) {
      throw new TelegramPermanentFailureError(`Telegram API hatası: ${res.status} ${body}`);
    }
    throw new Error(`Telegram API geçici hata (rate limit): ${res.status} ${body}`);
  }
}
