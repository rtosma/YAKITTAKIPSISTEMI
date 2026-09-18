import { NOTIFICATION_TEMPLATES } from '../notifications/templateRegistry';
import {
  createNotificationForCurrentTenant,
  markNotificationDelivered,
  markNotificationFailed,
  getFailedNotificationsForCurrentTenant,
  getNotifications,
  markNotificationRead,
  type NotificationRecord
} from '../db/tenantDb';
import { runWithTenant, getTenantId } from '../context/tenantContext';
import { broadcastToTenant } from '../socket/socketServer';
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

function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const val = variables[key];
    return val === undefined || val === null ? `{{${key}}}` : String(val);
  });
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
  opts?: { userId?: string; idempotencyKey?: string }
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
        variables
      })
    );
    if (!created) {
      return { notificationId: null, skippedDuplicate: true };
    }

    try {
      await deliverInApp(tenantId, created);
      await runWithTenant({ tenantId }, () => markNotificationDelivered(created.id));
    } catch (deliveryErr) {
      await runWithTenant({ tenantId }, () => markNotificationFailed(created.id, MAX_DELIVERY_ATTEMPTS));
      logger.error({ err: deliveryErr, notificationId: created.id }, '🚨 [NOTIF-1601] Bildirim teslimi başarısız, yeniden denenecek.');
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
 * Her BAŞARISIZ bildirim için teslim YENİDEN denenir; MAX_DELIVERY_ATTEMPTS
 * dolarsa KALICI_BAŞARISIZ'a düşer (bkz. markNotificationFailed).
 */
export async function runNotificationRetrySweepForCurrentTenant(): Promise<{ retried: number; permanentlyFailed: number }> {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('runNotificationRetrySweepForCurrentTenant: ambient tenant context yok.');

  const failed = await getFailedNotificationsForCurrentTenant();
  let retried = 0;
  let permanentlyFailed = 0;
  for (const notification of failed) {
    try {
      await deliverInApp(tenantId, notification);
      await markNotificationDelivered(notification.id);
      retried++;
    } catch (err) {
      await markNotificationFailed(notification.id, MAX_DELIVERY_ATTEMPTS);
      if (notification.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) permanentlyFailed++;
      logger.warn({ err, notificationId: notification.id }, '⏱️ [NOTIF-1601] Yeniden deneme başarısız.');
    }
  }
  return { retried, permanentlyFailed };
}

export { getNotifications, markNotificationRead };
