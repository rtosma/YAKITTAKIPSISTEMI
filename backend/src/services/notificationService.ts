import { NOTIFICATION_TEMPLATES } from '../notifications/templateRegistry';
import { sendEmail, deriveHtmlFromText, EmailPermanentFailureError } from '../notifications/emailChannel';
import { sendSms, SmsPermanentFailureError } from '../notifications/smsChannel';
import { sendTelegramMessage, TelegramPermanentFailureError } from '../notifications/telegramChannel';
import { sendWebhook, WebhookDisabledError } from '../notifications/webhookChannel';
import {
  createNotificationForCurrentTenant,
  markNotificationDelivered,
  markNotificationFailed,
  getFailedNotificationsForCurrentTenant,
  getNotifications,
  markNotificationRead,
  getUserEmailTarget,
  markUserEmailBounced,
  getUserPhoneTarget,
  checkAndIncrementSmsUsage,
  getTelegramTargetForCurrentTenant,
  getWebhookTargetForCurrentTenant,
  recordWebhookFailure,
  recordWebhookSuccess,
  getUserNotificationPreference,
  isUserNotificationMuted,
  type NotificationRecord,
  type EscalatedAlarmResult
} from '../db/tenantDb';
import { runWithTenant, getTenantId } from '../context/tenantContext';
import { broadcastToTenant } from '../socket/socketServer';
import { redisPool } from '../db/redisPool';
import { logger } from '../utils/logger';

/**
 * NOTIF-1601 — bildirim çekirdeği. Ticket'ın NestJS + BullMQ + ARCH-102 event
 * bus + handlebars/eta yığını bu kod tabanında YOK. Bunun yerine:
 *  - "Olay yayımlanır" → `notifyEvent()` DÜZ bir fonksiyon çağrısıdır; çağıran
 *    `void notifyEvent(...)` ile fire-and-forget yapar (FUEL-406/BILL-1702
 *    ile AYNI "await edilmiyor" deseni).
 *  - Şablon motoru → `{{degisken}}` regex değiştiricisi (templateRegistry.ts).
 *  - Teslim kuyruğu/retry → BullMQ değil; başarısız teslimler `notifications.
 *    status='BAŞARISIZ'` olarak işaretlenir, index.ts'teki periyodik
 *    süpürücü (INV-1504/1505 ile AYNI desen) `runNotificationRetrySweepFor
 *    CurrentTenant()`'ı çağırır. `MAX_DELIVERY_ATTEMPTS` sonrası
 *    KALICI_BAŞARISIZ'a düşer (AC: "teslim edilemeyen bildirimlerin kaydı").
 *
 * AC: "Gönderim hataları ana işlemi etkilememelidir" — notifyEvent HİÇBİR
 * KOŞULDA fırlatmaz (dıştaki try/catch tüm hataları yutar, sadece loglar).
 */

const MAX_DELIVERY_ATTEMPTS = 3;
// NOTIF-1602 AC: "Gönderim hızı sınırı." Gerçek bir kuyruk (BullMQ) YOK —
// tenant başına dakikada sabit bir üst sınır, Redis INCR+EXPIRE ile
// (loginRateLimiter.ts'teki desenin AYNISI). Aşılırsa BAŞARISIZ'a düşer,
// süpürücü daha sonra (limit sıfırlandığında) yeniden dener.
const EMAIL_RATE_LIMIT_PER_MINUTE = 30;

function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const val = variables[key];
    return val === undefined || val === null ? `{{${key}}}` : String(val);
  });
}

async function checkEmailRateLimit(tenantId: string): Promise<boolean> {
  const key = `notif:email:ratelimit:${tenantId}`;
  const count = await redisPool.client.incr(key);
  if (count === 1) await redisPool.client.expire(key, 60);
  return count <= EMAIL_RATE_LIMIT_PER_MINUTE;
}

async function deliverInApp(tenantId: string, notification: NotificationRecord): Promise<void> {
  broadcastToTenant(tenantId, 'notification:new', {
    id: notification.id,
    eventType: notification.event_type,
    title: notification.title,
    body: notification.body,
    userId: notification.user_id
  });
}

/**
 * AC: "E-postalar HTML ve düz metin olarak gönderilmelidir." AC: "Kritik
 * e-postalar öncelikli kuyrukta işlenmelidir" — gerçek bir kuyruk yok;
 * `priority='CRITICAL'` gönderim hızı sınırını ATLAR (bekletilmez).
 * `userId` yoksa/kullanıcının e-postası yoksa/ADRES DAHA ÖNCE BOUNCE
 * ETMİŞSE hiç deneme yapılmaz — çağıran `EmailPermanentFailureError` alır.
 */
async function deliverEmail(tenantId: string, notification: NotificationRecord, priority: 'NORMAL' | 'CRITICAL'): Promise<void> {
  if (!notification.user_id) {
    throw new EmailPermanentFailureError('E-posta kanalı bir userId gerektirir (tenant geneli bildirim EMAIL kanalıyla gönderilemez).');
  }
  const target = await runWithTenant({ tenantId }, () => getUserEmailTarget(notification.user_id!));
  if (!target || !target.email) {
    throw new EmailPermanentFailureError(`Kullanıcının (${notification.user_id}) kayıtlı bir e-posta adresi yok.`);
  }
  if (target.bounced) {
    throw new EmailPermanentFailureError(`'${target.email}' daha önce bounce etti — AC: tekrar denenmez.`);
  }
  if (priority !== 'CRITICAL') {
    const withinLimit = await checkEmailRateLimit(tenantId);
    if (!withinLimit) {
      throw new Error(`Tenant e-posta gönderim hızı sınırı (dakikada ${EMAIL_RATE_LIMIT_PER_MINUTE}) aşıldı — daha sonra yeniden denenecek.`);
    }
  }
  await sendEmail({ to: target.email, subject: notification.title, text: notification.body, html: deriveHtmlFromText(notification.body) });
}

/**
 * AC: "Kritik alarmlar SMS ile iletilmelidir" + Teknik Not: "SMS maliyetlidir;
 * hangi olayların SMS ile gideceği... varsayılan olarak dar tutulmalıdır" —
 * bu, kanalın KENDİSİNE gömülü bir politika: `priority !== 'CRITICAL'` olan
 * HİÇBİR bildirim SMS ile gönderilMEZ (çağıranın bunu unutması/istismar
 * etmesi mümkün değil). "Gece saatlerinde kritik olmayan SMS gönderilmemeli"
 * notu bu yüzden zaten YAPISAL olarak sağlanıyor — kritik-olmayan SMS hiçbir
 * saatte gönderilmiyor, ayrı bir saat kontrolüne gerek yok.
 */
async function deliverSms(tenantId: string, notification: NotificationRecord): Promise<void> {
  if (notification.priority !== 'CRITICAL') {
    throw new SmsPermanentFailureError('SMS kanalı yalnızca CRITICAL öncelikli bildirimler için kullanılabilir (maliyet kontrolü).');
  }
  if (!notification.user_id) {
    throw new SmsPermanentFailureError('SMS kanalı bir userId gerektirir (tenant geneli bildirim SMS ile gönderilemez).');
  }
  const phone = await runWithTenant({ tenantId }, () => getUserPhoneTarget(notification.user_id!));
  if (!phone) {
    throw new SmsPermanentFailureError(`Kullanıcının (${notification.user_id}) kayıtlı bir telefon numarası yok.`);
  }
  const usage = await runWithTenant({ tenantId }, () => checkAndIncrementSmsUsage(tenantId));
  if (!usage.allowed) {
    throw new Error(`Aylık SMS limiti aşıldı (${usage.sentCount}/${usage.monthlyLimit}) — bir sonraki ay sıfırlanana kadar gönderim yapılamaz.`);
  }
  await sendSms({ to: phone, text: `${notification.title}: ${notification.body}` });
}

/** AC: "Telegram grubuna bildirim gönderilebilmelidir." Tenant bazlı yapılandırma (bkz. tenantDb.ts) yoksa deneme yapılmaz. */
async function deliverTelegram(tenantId: string, notification: NotificationRecord): Promise<void> {
  const target = await runWithTenant({ tenantId }, () => getTelegramTargetForCurrentTenant());
  if (!target) {
    throw new TelegramPermanentFailureError('Bu tenant için Telegram yapılandırması (bot token + chat_id) yok.');
  }
  await sendTelegramMessage({ botToken: target.botToken, chatId: target.chatId, text: `${notification.title}\n${notification.body}` });
}

/**
 * AC: "Webhook çağrıları imzalı ve zaman aşımı korumalı olmalıdır." + AC:
 * "Sürekli hata veren webhook otomatik devre dışı bırakılmalıdır." — devre
 * kesici durumu (webhook_disabled_at) BURADA kontrol edilir (tenantDb.ts
 * salt VERİYİ tutar, KARARI vermez); her BAŞARILI denemede sayaç sıfırlanır,
 * her BAŞARISIZ denemede recordWebhookFailure eşiği kontrol eder.
 */
async function deliverWebhook(tenantId: string, notification: NotificationRecord): Promise<void> {
  const target = await runWithTenant({ tenantId }, () => getWebhookTargetForCurrentTenant());
  if (!target) {
    throw new WebhookDisabledError('Bu tenant için webhook yapılandırması (URL + sır) yok.');
  }
  if (target.disabled) {
    throw new WebhookDisabledError('Webhook, ardışık başarısızlıklar sonrası otomatik devre dışı bırakıldı — yeniden yapılandırma gerekir.');
  }
  try {
    await sendWebhook({
      url: target.url,
      secret: target.secret,
      payload: { id: notification.id, eventType: notification.event_type, title: notification.title, body: notification.body, variables: notification.variables }
    });
    await runWithTenant({ tenantId }, () => recordWebhookSuccess());
  } catch (err) {
    const { disabled } = await runWithTenant({ tenantId }, () => recordWebhookFailure());
    if (disabled) {
      throw new WebhookDisabledError(`Webhook başarısızlığı eşiği aştı, otomatik devre dışı bırakıldı: ${(err as Error).message}`);
    }
    throw err;
  }
}

async function deliver(tenantId: string, notification: NotificationRecord): Promise<void> {
  if (notification.channel === 'EMAIL') {
    await deliverEmail(tenantId, notification, notification.priority);
  } else if (notification.channel === 'SMS') {
    await deliverSms(tenantId, notification);
  } else if (notification.channel === 'TELEGRAM') {
    await deliverTelegram(tenantId, notification);
  } else if (notification.channel === 'WEBHOOK') {
    await deliverWebhook(tenantId, notification);
  } else {
    await deliverInApp(tenantId, notification);
  }
}

export interface NotifyEventResult {
  notificationId: string | null;
  skippedDuplicate: boolean;
  skippedByPreference: boolean;
}

/**
 * NOTIF-1605 AC: "Kullanıcı, bildirim tiplerini kanal bazında açıp
 * kapatabilmelidir" + "Sessize alma zaman sınırlı olmalıdır" + "Güvenlik
 * bildirimleri tamamen kapatılamamalıdır, en az bir kanal zorunlu kalmalıdır".
 * Ticket'ın ayrı bir "subscription service" / event-bus filtresi önerisi bu
 * kod tabanında YOK — tercih/sessize-alma kontrolü notifyEvent() İÇİNE,
 * bildirim satırı YARATILMADAN ÖNCE gömülüdür (bkz. çağrı yeri): engellenen
 * bir bildirim için KAYIT DAHİ AÇILMAZ, retry süpürücüsünün tekrar kontrol
 * etmesine gerek kalmaz.
 *
 * Zorunlu kanal AC'si: `isSecurityCritical` şablonlarda IN_APP kanalı, tercih
 * VEYA sessize alma NE OLURSA OLSUN her zaman `true` döner — "tamamen
 * kapatılamamalı" bunu tek bir kanalın DAİMA açık kalmasıyla karşılar, diğer
 * kanallar (EMAIL/SMS/TELEGRAM/WEBHOOK) hâlâ normal şekilde tercihe tabidir.
 */
async function isDeliveryAllowedByPreference(
  tenantId: string,
  userId: string | null,
  eventType: string,
  channel: string,
  isSecurityCritical: boolean
): Promise<boolean> {
  // Tenant geneli bildirim (userId yok) — kullanıcı bazlı tercih/sessize alma kapsam dışı (Efor: S basitleştirmesi).
  if (!userId) return true;
  if (isSecurityCritical && channel === 'IN_APP') return true;

  const enabled = await runWithTenant({ tenantId }, () => getUserNotificationPreference(userId, eventType, channel));
  if (!enabled) return false;

  const muted = await runWithTenant({ tenantId }, () => isUserNotificationMuted(userId, eventType));
  return !muted;
}

/** Kanalların "asla tekrar deneme" sinyali — hepsi FARKLI sebeplerle (bounce/yalnızca-kritik/token-yok/devre-dışı) ama HEPSİ AYNI davranışı ister: ANINDA KALICI_BAŞARISIZ. */
function isPermanentChannelFailure(err: unknown): boolean {
  return err instanceof EmailPermanentFailureError || err instanceof SmsPermanentFailureError || err instanceof TelegramPermanentFailureError || err instanceof WebhookDisabledError;
}

/**
 * AC: "Yeni bir bildirim tipi yalnızca şablon ve eşleme eklenerek
 * tanımlanabilmelidir" — burası `eventType`'a göre templateRegistry.ts'ten
 * OKUR, kendisi hiçbir tip-özel mantık İÇERMEZ.
 */
export async function notifyEvent(
  tenantId: string,
  eventType: string,
  variables: Record<string, unknown>,
  opts?: { userId?: string; idempotencyKey?: string; channel?: 'IN_APP' | 'EMAIL' | 'SMS' | 'TELEGRAM' | 'WEBHOOK'; priority?: 'NORMAL' | 'CRITICAL' }
): Promise<NotifyEventResult> {
  try {
    const template = NOTIFICATION_TEMPLATES[eventType];
    if (!template) {
      logger.error({ eventType }, `🚨 [NOTIF-1601] Bilinmeyen bildirim tipi (templateRegistry.ts'te kayıtlı değil): ${eventType}`);
      return { notificationId: null, skippedDuplicate: false, skippedByPreference: false };
    }

    const channel = opts?.channel ?? 'IN_APP';
    const allowed = await isDeliveryAllowedByPreference(tenantId, opts?.userId ?? null, eventType, channel, template.isSecurityCritical === true);
    if (!allowed) {
      return { notificationId: null, skippedDuplicate: false, skippedByPreference: true };
    }

    const title = renderTemplate(template.titleTemplate, variables);
    const body = renderTemplate(template.bodyTemplate, variables);

    const created = await runWithTenant({ tenantId }, () =>
      createNotificationForCurrentTenant({
        eventType,
        idempotencyKey: opts?.idempotencyKey ?? null,
        userId: opts?.userId ?? null,
        title,
        body,
        variables,
        channel,
        priority: opts?.priority ?? 'NORMAL'
      })
    );
    if (!created) {
      return { notificationId: null, skippedDuplicate: true, skippedByPreference: false };
    }

    try {
      await deliver(tenantId, created);
      await runWithTenant({ tenantId }, () => markNotificationDelivered(created.id));
    } catch (deliveryErr) {
      if (isPermanentChannelFailure(deliveryErr)) {
        await runWithTenant({ tenantId }, async () => {
          if (created.user_id && deliveryErr instanceof EmailPermanentFailureError) await markUserEmailBounced(created.user_id);
          // maxAttempts=0 → attempts+1 her zaman >= 0 → ANINDA KALICI_BAŞARISIZ (retry döngüsüne HİÇ girmez).
          await markNotificationFailed(created.id, 0);
        });
        logger.error({ err: deliveryErr, notificationId: created.id }, '🚨 [NOTIF-1602/1603/1604] Kanal kalıcı olarak başarısız, yeniden denenmeyecek.');
      } else {
        await runWithTenant({ tenantId }, () => markNotificationFailed(created.id, MAX_DELIVERY_ATTEMPTS));
        logger.error({ err: deliveryErr, notificationId: created.id }, '🚨 [NOTIF-1601] Bildirim teslimi başarısız, yeniden denenecek.');
      }
    }
    return { notificationId: created.id, skippedDuplicate: false, skippedByPreference: false };
  } catch (err) {
    logger.error({ err, tenantId, eventType }, '🚨 [NOTIF-1601] notifyEvent beklenmeyen hata (ana işlemi etkilemeden yutuldu).');
    return { notificationId: null, skippedDuplicate: false, skippedByPreference: false };
  }
}

/**
 * index.ts'teki periyodik süpürücü çağırır — INV-1504/1505 ile AYNI desen
 * (runWithTenant içinden çağrılır, ambient context'ten tenantId okunur).
 * Her BAŞARISIZ bildirim için KENDİ kanalından teslim YENİDEN denenir;
 * MAX_DELIVERY_ATTEMPTS dolarsa KALICI_BAŞARISIZ'a düşer. Bir e-posta bu
 * arada bounce ederse (EmailPermanentFailureError) ANINDA KALICI_
 * BAŞARISIZ'a düşer, deneme sayısı beklenmez.
 */
export async function runNotificationRetrySweepForCurrentTenant(): Promise<{ retried: number; permanentlyFailed: number }> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('runNotificationRetrySweepForCurrentTenant: ambient tenant context yok.');

  const failed = await getFailedNotificationsForCurrentTenant();
  let retried = 0;
  let permanentlyFailed = 0;
  for (const notification of failed) {
    try {
      await deliver(tenantId, notification);
      await markNotificationDelivered(notification.id);
      retried++;
    } catch (err) {
      if (isPermanentChannelFailure(err)) {
        if (notification.user_id && err instanceof EmailPermanentFailureError) await markUserEmailBounced(notification.user_id);
        await markNotificationFailed(notification.id, 0);
        permanentlyFailed++;
      } else {
        await markNotificationFailed(notification.id, MAX_DELIVERY_ATTEMPTS);
        if (notification.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) permanentlyFailed++;
      }
      logger.warn({ err, notificationId: notification.id }, '⏱️ [NOTIF-1601] Yeniden deneme başarısız.');
    }
  }
  return { retried, permanentlyFailed };
}

/**
 * AC: "Kanal bazlı test gönderimi düğmesi." notifyEvent'in AKSİNE (fire-
 * and-forget, hataları yutar) burası çağıranın SONUCU HEMEN görmesi
 * gerektiği için senkron döner ve fırlatan hatayı SARMALAR — bir yönetici
 * "Telegram'ı test et" düğmesine bastığında "başarısız" mı "başarılı" mı
 * ANINDA bilmek ister, sessizce yutulmuş bir hata işe yaramaz. Kalıcı bir
 * `notifications` satırı YARATILMAZ (bu bir bağlantı testi, gerçek bir
 * bildirim değil).
 */
export async function sendTestNotification(tenantId: string, channel: 'EMAIL' | 'SMS' | 'TELEGRAM' | 'WEBHOOK', userId?: string): Promise<{ success: boolean; error?: string }> {
  const testNotification: NotificationRecord = {
    id: 'test',
    tenant_id: tenantId,
    event_type: 'TEST',
    idempotency_key: null,
    user_id: userId ?? null,
    title: 'Test Bildirimi',
    body: 'Bu, kanal yapılandırmanızı doğrulamak için gönderilen bir test bildirimidir.',
    channel,
    priority: 'CRITICAL',
    status: 'BEKLIYOR',
    attempts: 0,
    variables: null,
    read_at: null,
    delivered_at: null,
    created_at: new Date().toISOString()
  };
  try {
    await deliver(tenantId, testNotification);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

const ESCALATION_ROLE_LABELS: Record<'SITE_MANAGER' | 'COMPANY_OWNER' | 'SUPER_ADMIN', string> = {
  SITE_MANAGER: 'Şantiye Şefi',
  COMPANY_OWNER: 'Firma Yöneticisi',
  SUPER_ADMIN: 'Süper Admin'
};

/**
 * NOTIF-1606 — tenantDb.ts'in runAlarmEscalationForCurrentTenant()'ının
 * DÖNDÜRDÜĞÜ alıcı listesine gerçekten bildirim GÖNDEREN katman (tenantDb.ts
 * KENDİSİ notifyEvent'i çağıramaz — notificationService.ts ↔ tenantDb.ts
 * DAİRESEL import'a yol açar). Her (alarm, kademe, alıcı) üçlüsü için AYRI
 * bir idempotencyKey — AYNI kademe için süpürücü tekrar çalışsa da (ör. bir
 * önceki turda updateAlarm/deliver arası çökme) mükerrer bildirim gitmez.
 * Zincir alıcısız tükenmişse (chain_exhausted) hiç kimseye bildirim YOKTUR —
 * bu durumun kaydı zaten alarm_events'te (bkz. tenantDb.ts) tutulur.
 */
export async function notifyAlarmEscalationRecipients(tenantId: string, escalated: EscalatedAlarmResult[]): Promise<void> {
  for (const alarm of escalated) {
    if (alarm.chain_exhausted || !alarm.notify_role) continue;
    for (const userId of alarm.recipient_user_ids) {
      await notifyEvent(
        tenantId,
        'ALARM_ESCALATED',
        { alarmTitle: alarm.title, siteName: alarm.site_name ?? '-', level: alarm.escalation_level, roleLabel: ESCALATION_ROLE_LABELS[alarm.notify_role] },
        {
          userId,
          channel: 'IN_APP',
          priority: alarm.severity === 'CRITICAL' ? 'CRITICAL' : 'NORMAL',
          idempotencyKey: `alarm-escalation-${alarm.id}-${alarm.escalation_level}-${userId}`
        }
      );
    }
  }
}

export { getNotifications, markNotificationRead };
