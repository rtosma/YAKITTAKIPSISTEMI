import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/**
 * NOTIF-1602 — e-posta kanalı. GEMINI_API_KEY/AI-502 ile AYNI gerekçe: bu
 * ortamda gerçek bir SMTP sunucusu YOK, SMTP_HOST tanımlı değilse bu modül
 * açıkça (ServiceUnavailableError DEĞİL — notifyEvent'in "gönderim hataları
 * ana işlemi etkilememeli" AC'sini karşılaması için bu bir DÜZ Error, çağıran
 * tarafından yutulur) fırlatır.
 *
 * "Bounce alan adresler işaretlenip tekrar denenmemelidir" AC'si: SMTP
 * sunucusu kalıcı reddetme (5xx response code) döndürürse bu modül
 * `EmailPermanentFailureError` fırlatır — notifyEvent bunu yakalayıp
 * users.email_bounced_at'i işaretler VE bildirimi doğrudan KALICI_
 * BAŞARISIZ'a düşürür (BAŞARISIZ→retry döngüsüne HİÇ girmez — bir kez
 * bounce eden adrese TEKRAR denemek AC'yi ihlal eder).
 */

export class EmailPermanentFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailPermanentFailureError';
  }
}

let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!config.SMTP_HOST) {
    throw new Error('SMTP_HOST yapılandırılmamış — e-posta kanalı şu anda kullanılamıyor.');
  }
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      auth: config.SMTP_USER && config.SMTP_PASSWORD ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined
    });
  }
  return cachedTransporter;
}

/** SMTP yanıt kodu 5xx = kalıcı reddetme (bounce); 4xx = geçici (retry mantıklı). RFC 5321. */
function isPermanentSmtpFailure(err: any): boolean {
  const code = err?.responseCode ?? (typeof err?.response === 'string' ? parseInt(err.response.slice(0, 3), 10) : undefined);
  return typeof code === 'number' && code >= 500 && code < 600;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** REP-705 — zamanlanmış rapor eki (CSV). Diğer çağıranlar bunu hiç göndermez. */
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const transporter = getTransporter();
  try {
    await transporter.sendMail({
      from: config.SMTP_FROM ?? config.SMTP_USER,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType }))
    });
  } catch (err: any) {
    if (isPermanentSmtpFailure(err)) {
      logger.error({ err, to: input.to }, `🚨 [NOTIF-1602] E-posta kalıcı olarak reddedildi (bounce): ${input.to}`);
      throw new EmailPermanentFailureError(`'${input.to}' adresi kalıcı olarak reddetti: ${err.message}`);
    }
    throw err;
  }
}

/** AC: "HTML ve düz metin olarak gönderilmelidir." Şablon kaydı yalnızca düz metin üretir — HTML burada TÜRETİLİR (ayrı bir HTML şablonu YAZILMAZ, AC'nin "yeni tip = yalnızca şablon ekleme" ruhu korunur). */
export function deriveHtmlFromText(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
}
