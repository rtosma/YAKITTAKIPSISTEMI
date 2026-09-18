import { NOTIFICATION_TEMPLATES } from '../notifications/templateRegistry';
import { sendEmail, deriveHtmlFromText, EmailPermanentFailureError } from '../notifications/emailChannel';
import {
  createNotificationForCurrentTenant,
  markNotificationDelivered,
  markNotificationFailed,
  getFailedNotificationsForCurrentTenant,
  getNotifications,
  markNotificationRead,
  getUserEmailTarget,
  markUserEmailBounced,
  type NotificationRecord
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

async function deliver(tenantId: string, notification: NotificationRecord, priority: 'NORMAL' | 'CRITICAL' = 'NORMAL'): Promise<void> {
  if (notification.channel === 'EMAIL') {
    await deliverEmail(tenantId, notification, priority);
  } else {
    await deliverInApp(tenantId, notification);
  }
}

export interface NotifyEventResult {
  notificationId: string | null;
  skippedDuplicate: boolean;
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
  opts?: { userId?: string; idempotencyKey?: string; channel?: 'IN_APP' | 'EMAIL'; priority?: 'NORMAL' | 'CRITICAL' }
): Promise<NotifyEventResult> {
  try {
    const template = NOTIFICATION_TEMPLATES[eventType];
    if (!template) {
      logger.error({ eventType }, `🚨 [NOTIF-1601] Bilinmeyen bildirim tipi (templateRegistry.ts'te kayıtlı değil): ${eventType}`);
      return { notificationId: null, skippedDuplicate: false };
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
        channel: opts?.channel ?? 'IN_APP'
      })
    );
    if (!created) {
      return { notificationId: null, skippedDuplicate: true };
    }

    try {
      await deliver(tenantId, created, opts?.priority);
      await runWithTenant({ tenantId }, () => markNotificationDelivered(created.id));
    } catch (deliveryErr) {
      if (deliveryErr instanceof EmailPermanentFailureError) {
        await runWithTenant({ tenantId }, async () => {
          if (created.user_id) await markUserEmailBounced(created.user_id);
          // maxAttempts=0 → attempts+1 her zaman >= 0 → ANINDA KALICI_BAŞARISIZ (retry döngüsüne HİÇ girmez).
          await markNotificationFailed(created.id, 0);
        });
        logger.error({ err: deliveryErr, notificationId: created.id }, '🚨 [NOTIF-1602] E-posta kalıcı olarak başarısız — adres işaretlendi, yeniden denenmeyecek.');
      } else {
        await runWithTenant({ tenantId }, () => markNotificationFailed(created.id, MAX_DELIVERY_ATTEMPTS));
        logger.error({ err: deliveryErr, notificationId: created.id }, '🚨 [NOTIF-1601] Bildirim teslimi başarısız, yeniden denenecek.');
      }
    }
    return { notificationId: created.id, skippedDuplicate: false };
  } catch (err) {
    logger.error({ err, tenantId, eventType }, '🚨 [NOTIF-1601] notifyEvent beklenmeyen hata (ana işlemi etkilemeden yutuldu).');
    return { notificationId: null, skippedDuplicate: false };
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
      if (err instanceof EmailPermanentFailureError) {
        if (notification.user_id) await markUserEmailBounced(notification.user_id);
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

export { getNotifications, markNotificationRead };
