import { redisPool } from '../db/redisPool';
import { logger } from '../utils/logger';
import { ioTEventBus } from '../iot/mqttClient';
import { broadcastToTenant } from '../socket/socketServer';

/**
 * AI-501 — Pompa Debisi vs. Tank Ultrasonik Düşüş Korelasyonu (Hırsızlık Motoru)
 *
 * Kabul Kriterleri (ISSUES_ROADMAP.md #115 / #116):
 *  - Pompa çalışmıyorken 10 dakikada 5 litreden fazla düşüş olursa
 *    `STATIC_THEFT_DETECTED` alarmı üretilmelidir.
 *  - Pompa akışı ile tank seviye farkı ±%1.5 toleransı aşarsa
 *    `METER_CALIBRATION_TAMPER` uyarısı fırlatılmalıdır.
 *
 * Tasarım notları:
 *  - Ticket'ın "Teknik Yığın"ı BullMQ Repeatable Job öneriyor — bu kod
 *    tabanında BullMQ yok. Bunun yerine mevcut desen kullanıldı: `ioTEventBus`
 *    (mqttClient.ts) telemetri olaylarına abone olan, durumu Redis'te (TTL'li)
 *    tutan olay-güdümlü bir servis. Analiz "gerçek zamanlı" — her yeni tank
 *    örneği geldiğinde kayan 10 dakikalık pencere yeniden değerlendirilir,
 *    ayrı bir periyodik job'a gerek yok.
 *  - Bu ilk pass KASITLI olarak bir DB tablosu (theft_alerts) ve REST ucu
 *    (GET /theft-alerts) EKLEMİYOR — o parçalar schema.sql/routes.ts/
 *    tenantDb.ts'i değiştirir ve paralel yürüyen FUEL-404 işiyle çakışırdı.
 *    Alarmlar şimdilik: (1) yapısal Pino `error` logu, (2) `theft:alert`
 *    Socket.io yayını (kiracı odasına), (3) Redis'te kapaklı son-alarm
 *    tamponu (`theft:alerts:{tenantId}`) olarak dışa veriliyor — kalıcı
 *    tablo + uç, FUEL-404 push edildikten sonra temiz bir follow-up.
 *
 * Telemetri sözleşmesi (mqttClient.ts `ioTEventBus.emit('telemetryData', ...)`):
 *   { tenantId, siteId, deviceType, deviceId, data, timestamp }
 *  - Tank sensörü:  deviceType === 'tank',  data.levelLiters (litre cinsinden
 *    güncel seviye; currentLevelLiters / current_level_liters / level de kabul).
 *  - Pompa:         deviceType === 'pump',  data.litersDispensed (bu pakette
 *    akan litre; flowRate > 0 da "pompa aktif" sayılır).
 */

// #115: kayan pencere ve statik düşüş eşiği
const WINDOW_MS = 10 * 60 * 1000; // 10 dakika
const STATIC_DROP_THRESHOLD_L = 5; // "5 litreden fazla düşüş"

// #116: pompa toplamı ile tank düşüşü arasındaki kabul edilebilir sapma
const CALIBRATION_TOLERANCE_RATIO = 0.015; // ±%1.5

// Aynı alarm türü aynı şantiye için bu süre boyunca tekrar yayınlanmaz —
// tek bir olayın her yeni telemetri paketinde onlarca alarm üretmesini önler.
const ALERT_COOLDOWN_SECONDS = 10 * 60;

// Redis anahtarlarının TTL'i — pencereden rahatça uzun, ama sonsuza dek
// birikmesin (cihaz susarsa örnekler kendiliğinden düşer).
const SAMPLE_KEY_TTL_SECONDS = 60 * 60;

// Kiracı başına dışa verilen son-alarm tamponunun boyutu.
const ALERT_BUFFER_MAX = 100;
const ALERT_BUFFER_TTL_SECONDS = 7 * 24 * 60 * 60;

export type TheftAlertType = 'STATIC_THEFT_DETECTED' | 'METER_CALIBRATION_TAMPER';

interface TelemetryEvent {
  tenantId: string;
  siteId: string;
  deviceType: string;
  deviceId: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface TimedSample {
  ts: number;
  value: number;
}

function tankSamplesKey(tenantId: string, siteId: string, deviceId: string): string {
  return `theft:tank:${tenantId}:${siteId}:${deviceId}`;
}
function pumpFlowKey(tenantId: string, siteId: string): string {
  return `theft:pumpflow:${tenantId}:${siteId}`;
}
function cooldownKey(tenantId: string, siteId: string, type: TheftAlertType): string {
  return `theft:cooldown:${tenantId}:${siteId}:${type}`;
}
function alertBufferKey(tenantId: string): string {
  return `theft:alerts:${tenantId}`;
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

/** ZSET'e "ts|value" üyesi ekler, pencerenin 2 katından eskiyi budar, TTL tazeler. */
async function pushSample(key: string, ts: number, value: number): Promise<void> {
  const member = `${ts}|${value}`;
  const multi = redisPool.client.multi();
  multi.zadd(key, ts, member);
  multi.zremrangebyscore(key, '-inf', ts - WINDOW_MS * 2);
  multi.expire(key, SAMPLE_KEY_TTL_SECONDS);
  await multi.exec();
}

/** ZSET'ten [fromTs, toTs] aralığındaki örnekleri artan zaman sırasıyla okur. */
async function readSamples(key: string, fromTs: number, toTs: number): Promise<TimedSample[]> {
  const raw = await redisPool.client.zrangebyscore(key, fromTs, toTs);
  return raw
    .map((entry) => {
      const [tsStr, valStr] = entry.split('|');
      return { ts: Number(tsStr), value: Number(valStr) };
    })
    .filter((s) => Number.isFinite(s.ts) && Number.isFinite(s.value))
    .sort((a, b) => a.ts - b.ts);
}

async function raiseAlert(
  evt: TelemetryEvent,
  type: TheftAlertType,
  details: Record<string, unknown>
): Promise<void> {
  // Debounce: aynı şantiye + tür için cooldown penceresinde tek alarm.
  const setResult = await redisPool.client.set(
    cooldownKey(evt.tenantId, evt.siteId, type),
    '1',
    'EX',
    ALERT_COOLDOWN_SECONDS,
    'NX'
  );
  if (setResult !== 'OK') return;

  const alert = {
    type,
    tenantId: evt.tenantId,
    siteId: evt.siteId,
    tankDeviceId: evt.deviceId,
    detectedAt: new Date().toISOString(),
    windowMinutes: WINDOW_MS / 60000,
    ...details
  };

  logger.error(
    { alert },
    `🚨 [AI-501] HIRSIZLIK ALARMI (${type}) — tenant=${evt.tenantId} site=${evt.siteId} tank=${evt.deviceId}`
  );

  // Canlı yayın — kiracının açık panelleri anında görsün.
  try {
    broadcastToTenant(evt.tenantId, 'theft:alert', alert);
  } catch (err) {
    logger.warn({ err }, '⚠️ [AI-501] theft:alert Socket.io yayını başarısız.');
  }

  // Kiracı başına kapaklı son-alarm tamponu (ileride bir uç/panel okuyabilsin).
  try {
    const key = alertBufferKey(evt.tenantId);
    const multi = redisPool.client.multi();
    multi.lpush(key, JSON.stringify(alert));
    multi.ltrim(key, 0, ALERT_BUFFER_MAX - 1);
    multi.expire(key, ALERT_BUFFER_TTL_SECONDS);
    await multi.exec();
  } catch (err) {
    logger.warn({ err }, '⚠️ [AI-501] Alarm tamponuna yazılamadı.');
  }
}

/**
 * Bir tank seviye örneği kaydedildikten sonra çağrılır. Kayan 10 dakikalık
 * pencerede tank düşüşü ile aynı şantiyedeki pompa akış toplamını
 * karşılaştırıp iki AC'yi de değerlendirir.
 */
async function evaluateTank(evt: TelemetryEvent, now: number): Promise<void> {
  const windowStart = now - WINDOW_MS;

  const tankSamples = await readSamples(tankSamplesKey(evt.tenantId, evt.siteId, evt.deviceId), windowStart, now);
  if (tankSamples.length < 2) return; // pencere içinde kıyaslanacak iki nokta yok

  const first = tankSamples[0];
  const last = tankSamples[tankSamples.length - 1];
  const levelDropLiters = first.value - last.value; // pozitif = seviye düştü

  if (levelDropLiters <= 0) return; // dolum/gürültü — hırsızlık senaryosu değil

  // Pencere içinde (ilk tank örneğinden bu yana) bu şantiyede pompa akışı oldu mu?
  const pumpSamples = await readSamples(pumpFlowKey(evt.tenantId, evt.siteId), first.ts, now);
  const pumpTotalLiters = pumpSamples.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const pumpWasActive = pumpSamples.length > 0 && pumpTotalLiters > 0;

  if (!pumpWasActive) {
    // #115 — pompa kapalıyken kayda değer düşüş.
    if (levelDropLiters > STATIC_DROP_THRESHOLD_L) {
      await raiseAlert(evt, 'STATIC_THEFT_DETECTED', {
        levelDropLiters: Number(levelDropLiters.toFixed(2)),
        thresholdLiters: STATIC_DROP_THRESHOLD_L,
        sampleCount: tankSamples.length,
        firstLevelLiters: Number(first.value.toFixed(2)),
        lastLevelLiters: Number(last.value.toFixed(2))
      });
    }
    return;
  }

  // #116 — pompa aktifti: verilen litre ile tank düşüşü tutarlı mı?
  const discrepancyRatio = Math.abs(pumpTotalLiters - levelDropLiters) / pumpTotalLiters;
  if (discrepancyRatio > CALIBRATION_TOLERANCE_RATIO) {
    await raiseAlert(evt, 'METER_CALIBRATION_TAMPER', {
      pumpTotalLiters: Number(pumpTotalLiters.toFixed(2)),
      tankLevelDropLiters: Number(levelDropLiters.toFixed(2)),
      discrepancyPct: Number((discrepancyRatio * 100).toFixed(2)),
      tolerancePct: CALIBRATION_TOLERANCE_RATIO * 100
    });
  }
}

/**
 * mqttClient.ts'in `telemetryData` olayına bağlanan tek giriş noktası.
 * Hiçbir hatayı yukarı fırlatmaz — MQTT mesaj işleyicisini bloklamamalı.
 */
async function handleTelemetry(evt: TelemetryEvent): Promise<void> {
  try {
    if (!evt || !evt.tenantId || !evt.siteId || !evt.data) return;
    const now = Date.parse(evt.timestamp) || Date.now();

    if (evt.deviceType === 'tank') {
      const level = firstFiniteNumber(evt.data, ['levelLiters', 'currentLevelLiters', 'current_level_liters', 'level']);
      if (level === null || level < 0) return;
      await pushSample(tankSamplesKey(evt.tenantId, evt.siteId, evt.deviceId), now, level);
      await evaluateTank(evt, now);
      return;
    }

    if (evt.deviceType === 'pump') {
      const liters = firstFiniteNumber(evt.data, ['litersDispensed', 'liters', 'amountLiters']);
      const flowRate = firstFiniteNumber(evt.data, ['flowRate', 'flowRateLpm', 'flow_rate_lpm']);
      // Bu pakette akan litre bilinmiyorsa ama akış hızı > 0 ise "pompa aktif"
      // sinyali olarak 0 litrelik bir işaret bırak (pumpWasActive true olur,
      // ama METER_CALIBRATION_TAMPER hesabına litre eklemez).
      const value = liters !== null && liters > 0 ? liters : (flowRate !== null && flowRate > 0 ? 0 : null);
      if (value === null) return;
      await pushSample(pumpFlowKey(evt.tenantId, evt.siteId), now, value);
    }
  } catch (err) {
    logger.error({ err, evt }, '🚨 [AI-501] Telemetri değerlendirme hatası.');
  }
}

let started = false;

/**
 * Motoru `ioTEventBus`'a bağlar. Birden fazla kez çağrılması güvenlidir
 * (idempotent) — çift dinleyici eklemez.
 */
export function startTheftDetectionEngine(): void {
  if (started) return;
  started = true;
  ioTEventBus.on('telemetryData', (payload: TelemetryEvent) => {
    void handleTelemetry(payload);
  });
  logger.info('🕵️  [AI-501] Hırsızlık tespit motoru etkin (debi ↔ tank seviye korelasyonu).');
}
