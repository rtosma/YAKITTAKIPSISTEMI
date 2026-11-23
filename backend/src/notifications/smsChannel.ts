import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * NOTIF-1603 — SMS kanalı. SMTP_HOST/SMS_PROVIDER_URL ile AYNI gerekçe: bu
 * ortamda gerçek bir SMS sağlayıcısı YOK, tanımlı değilse açıkça hata
 * fırlatır (notifyEvent bunu yutar, ana işlemi etkilemez).
 *
 * AC: "Türkçe karakter kaynaklı uzunluk sorunları yönetilmelidir." GSM-7
 * kodlaması Türkçe karakterleri (ç,ğ,ı,ö,ş,ü + büyükleri) DESTEKLEMEZ — bir
 * mesajda TEK bir Türkçe karakter bile olsa sağlayıcı UCS-2'ye geçer ve
 * segment sınırı 160→70, çok-segmentli 153→67'ye düşer (maliyet katlanır).
 * Ticket'ın notu "şablonlar kısa yazılmalı VEYA karakter dönüşümü" —
 * burası İKİNCİSİNİ seçiyor: her Türkçe karakteri ASCII karşılığına
 * çevirip GSM-7'de KALINIR. "Şablon değişmeden yeni bir tip eklenebilir"
 * ruhunu bozmaz (templateRegistry.ts hâlâ Türkçe yazılır, dönüşüm burada,
 * gönderim ANINDA olur).
 */

export class SmsPermanentFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsPermanentFailureError';
  }
}

const TURKISH_TO_ASCII: Record<string, string> = {
  ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U'
};

export function transliterateTurkish(text: string): string {
  return text.replace(/[çÇğĞıİöÖşŞüÜ]/g, (ch) => TURKISH_TO_ASCII[ch] ?? ch);
}

const GSM7_SINGLE_SEGMENT_MAX = 160;
const GSM7_MULTI_SEGMENT_MAX = 153;

/** Metin GSM-7 karakter kümesine (transliterateTurkish uygulandıktan sonra) uyduğu varsayımıyla kaç SMS segmentine böleceğini hesaplar. */
export function computeSmsSegmentCount(text: string): number {
  if (text.length <= GSM7_SINGLE_SEGMENT_MAX) return 1;
  return Math.ceil(text.length / GSM7_MULTI_SEGMENT_MAX);
}

export interface SendSmsInput {
  to: string;
  text: string;
}

export async function sendSms(input: SendSmsInput): Promise<void> {
  if (!config.SMS_PROVIDER_URL) {
    throw new Error('SMS_PROVIDER_URL yapılandırılmamış — SMS kanalı şu anda kullanılamıyor.');
  }
  const transliterated = transliterateTurkish(input.text);
  const segments = computeSmsSegmentCount(transliterated);

  const res = await fetch(config.SMS_PROVIDER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.SMS_PROVIDER_API_KEY ? { Authorization: `Bearer ${config.SMS_PROVIDER_API_KEY}` } : {})
    },
    body: JSON.stringify({ to: input.to, text: transliterated, segments })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error({ status: res.status, body, to: input.to }, `🚨 [NOTIF-1603] SMS sağlayıcı hatası: ${res.status}`);
    throw new Error(`SMS sağlayıcı hatası: ${res.status} ${body}`);
  }
}
