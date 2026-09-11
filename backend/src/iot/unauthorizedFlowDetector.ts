import { redisPool } from '../db/redisPool';
import { logger } from '../utils/logger';
import { ioTEventBus, mqttService } from './mqttClient';
import { runWithTenant } from '../context/tenantContext';
import { raiseAlarmForCurrentTenant } from '../db/tenantDb';
import { broadcastToTenant } from '../socket/socketServer';

/**
 * FUEL-406 — Kartsız/Yetkisiz Akış Alarmı ve Acil Kesme (#98)
 *
 * Kabul kriteri: bir pompa cihazı, sunucuda karşılığı olan aktif bir RFID
 * dispense oturumu (dispenseSessionService.ts, `dispense:session:{deviceId}`,
 * durum AUTHORIZED/PUMPING) OLMADAN akış bildirirse: (1) CRITICAL bir alarm
 * üretilmeli, (2) cihaza `FORCE_CUTOFF` komutu yayınlanmalıdır.
 *
 * Tasarım notu: theftDetectionService.ts (AI-501) ile aynı desen — ioTEventBus
 * 'telemetryData' olayına abone, durumu Redis'te tutan olay-güdümlü servis.
 * dispenseSessionService.ts'e bağımlılık kurmamak için oturum anahtarı
 * doğrudan (salt okunur) Redis'ten okunur — o modül import edilmez/değiştirilmez.
 */

// Aynı cihaz için art arda her telemetri paketinde yeni alarm/kesme
// komutu üretmemek için kapaklı bekleme süresi.
const ALERT_COOLDOWN_SECONDS = 60;

const ACTIVE_STATES = new Set(['AUTHORIZED', 'PUMPING']);

interface TelemetryEvent {
  tenantId: string;
  siteId: string;
  deviceType: string;
  deviceId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface StoredDispenseSession {
  state?: string;
  [key: string]: unknown;
}

function sessionKey(deviceId: string): string {
  return `dispense:session:${deviceId}`;
}

function cooldownKey(deviceId: string): string {
  return `unauthorized-flow:cooldown:${deviceId}`;
}

/** İlk tanımlı, sonlu sayıyı döndürür (telemetri alan adı sürümden sürüme değişebilir). */
function firstFiniteNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const raw = source[key];
    const n = typeof raw === 'string' ? Number(raw) : (raw as number);
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

/** dispenseSessionService.ts'in yazdığı oturumu salt okunur okur — import etmeden. */
async function hasActiveDispenseSession(deviceId: string): Promise<boolean> {
  const raw = await redisPool.client.get(sessionKey(deviceId));
  if (!raw) return false;
  try {
    const session = JSON.parse(raw) as StoredDispenseSession;
    return typeof session.state === 'string' && ACTIVE_STATES.has(session.state);
  } catch {
    return false; // bozuk/eski kayıt — güvenli taraf: yetkisiz say
  }
}

async function handleUnauthorizedFlow(evt: TelemetryEvent, flowDetail: Record<string, unknown>): Promise<void> {
  // Debounce: aynı cihaz için cooldown penceresinde tek alarm/kesme.
  const setResult = await redisPool.client.set(cooldownKey(evt.deviceId), '1', 'EX', ALERT_COOLDOWN_SECONDS, 'NX');
  if (setResult !== 'OK') return;

  logger.error(
    { deviceId: evt.deviceId, tenantId: evt.tenantId, siteId: evt.siteId, ...flowDetail },
    `🚨 [FUEL-406] YETKİSİZ AKIŞ — aktif RFID oturumu olmadan pompa=${evt.deviceId} akış bildirdi. Acil kesme gönderiliyor.`
  );

  try {
    await runWithTenant({ tenantId: evt.tenantId }, () =>
      raiseAlarmForCurrentTenant({
        alarmKey: `UNAUTHORIZED_FLOW:${evt.deviceId}`,
        category: 'UNAUTHORIZED_FLOW',
        severity: 'CRITICAL',
        title: `Kartsız/yetkisiz akış: ${evt.deviceId} — aktif RFID oturumu yok`,
        siteName: evt.siteId,
        subjectType: 'DEVICE',
        subjectId: evt.deviceId,
        detail: { ...flowDetail, deviceId: evt.deviceId, siteId: evt.siteId }
      })
    );
  } catch (err) {
    logger.warn({ err, deviceId: evt.deviceId }, '⚠️ [FUEL-406] Alarm kaydı oluşturulamadı.');
  }

  mqttService.publishCommand(evt.deviceId, 'FORCE_CUTOFF', { reason: 'UNAUTHORIZED_FLOW' });

  try {
    broadcastToTenant(evt.tenantId, 'flow:unauthorized', {
      deviceId: evt.deviceId,
      siteId: evt.siteId,
      detectedAt: new Date().toISOString(),
      ...flowDetail
    });
  } catch (err) {
    logger.warn({ err }, '⚠️ [FUEL-406] flow:unauthorized Socket.io yayını başarısız.');
  }
}

async function handleTelemetry(evt: TelemetryEvent): Promise<void> {
  try {
    if (!evt || evt.deviceType !== 'pump' || !evt.data || !evt.tenantId || !evt.deviceId) return;

    const liters = firstFiniteNumber(evt.data, ['litersDispensed', 'liters', 'amountLiters']);
    const flowRate = firstFiniteNumber(evt.data, ['flowRate', 'flowRateLpm', 'flow_rate_lpm']);
    const isFlowing = (liters !== null && liters > 0) || (flowRate !== null && flowRate > 0);
    if (!isFlowing) return;

    const authorized = await hasActiveDispenseSession(evt.deviceId);
    if (authorized) return;

    await handleUnauthorizedFlow(evt, {
      litersDispensed: liters,
      flowRate
    });
  } catch (err) {
    logger.error({ err, evt }, '🚨 [FUEL-406] Yetkisiz akış değerlendirme hatası.');
  }
}

let started = false;

/**
 * Motoru `ioTEventBus`'a bağlar. Birden fazla kez çağrılması güvenlidir
 * (idempotent) — çift dinleyici eklemez.
 */
export function startUnauthorizedFlowDetectionEngine(): void {
  if (started) return;
  started = true;
  ioTEventBus.on('telemetryData', (payload: TelemetryEvent) => {
    void handleTelemetry(payload);
  });
  logger.info('🚫 [FUEL-406] Kartsız/yetkisiz akış tespit motoru etkin.');
}
