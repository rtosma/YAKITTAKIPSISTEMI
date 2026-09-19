import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import client from 'prom-client';
import { config } from '../config/env';
import { pool } from '../db/postgresPool';
import { logger } from '../utils/logger';

/**
 * OPS-1107 (#184) — Prometheus metrikleri (prom-client).
 *
 * KARDİNALİTE POLİTİKASI (AC: "Metrik kardinalitesi kontrol altında olmalıdır"; Teknik Not: device_id gibi
 * yüksek kardinaliteli etiketler Prometheus'u şişirir): HİÇBİR metrikte sınırsız değerli etiket YOKTUR —
 * device_id, tenant_id, user_id, araç plakası, IP, ham URL/yol etiket OLARAK KULLANILMAZ (bunlar log'a ve
 * iz kimliğine aittir: Loki + trace_id). Etiket değerleri kodda SABİT kümelerden (enum) türetilir:
 *   - `route`: Express'in EŞLEŞEN yol kalıbı (`/api/v1/transactions/:id`), asla ham URL; eşleşmeyen (404, tarayıcı
 *     taraması, rastgele yol) hepsi tek değer `unmatched`. Seri sayısı kod tabanındaki route sayısıyla sınırlıdır.
 *   - `method`: bilinen 7 fiil, diğerleri `OTHER`. `status_class`: 1xx..5xx. `status`: HTTP kodu (≈ ondan az farklı değer).
 * Cihaz/tenant bazlı ayrıntı GEREKİYORSA metrik değil log/sorgu yoludur (rep-717, Loki). docs/OBSERVABILITY.md
 * her metriğin etiketlerini ve seri üst sınırını listeler; test bunu koddaki kayıtla eşler (drift koruması).
 *
 * Prometheus tarafında ayrıca `sample_limit` (deploy/monitoring/prometheus.yml) — kod hatası yüzünden bir hedef
 * patlarsa scrape reddedilir, sunucu şişmez.
 *
 * İŞ METRİKLERİ scrape anında DEĞİL, arka planda (30 sn) hesaplanır (`refreshBusinessMetrics`): scrape sıklığı
 * DB yükünü belirlemesin; tek bir tenant-arası sorgu (adminDb.getBusinessMetricsSnapshot) tüm gauge'ları besler.
 */

export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'yakittakip-backend' });
// Süreç CPU/bellek/heap/GC/dosya tanıtıcı + nodejs_eventloop_lag_* (event loop gecikmesi p50/p90/p99).
client.collectDefaultMetrics({ register: registry });

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export const normalizeMethod = (m: string): string => (KNOWN_METHODS.has(m) ? m : 'OTHER');
export const statusClass = (code: number): string => `${Math.floor(code / 100)}xx`;

// ── HTTP ────────────────────────────────────────────────────────────────────
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP istek süresi (saniye). route = eşleşen Express yol kalıbı ("unmatched" = eşleşmeyen).',
  labelNames: ['method', 'route', 'status_class'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry]
});
const httpTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Toplam HTTP isteği.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry]
});
const httpInFlight = new client.Gauge({ name: 'http_requests_in_flight', help: 'Şu anda işlenen HTTP isteği sayısı.', registers: [registry] });

/**
 * İstek bittiğinde (finish) eşleşen route kalıbını etikete çevirir. Ham URL ASLA etiket olmaz.
 * DİKKAT: Express, hata yolunda (`next(err)`) `req.baseUrl`'ü geri sarar (''); bu yüzden 404/hata yanıtlarında
 * `/api/v1/reports/:reportId` yerine `/reports/:reportId` gibi TUTARSIZ bir değer üretirdi (aynı route iki seri). Bağlama
 * öneki boşsa, eşleşmiş route'un segment sayısına göre `originalUrl`'ün başındaki (route'un kendisine ait olmayan) segmentlerden
 * türetilir — route eşleştiği için bu segmentler gerçek mount yoludur (kullanıcı girdisi değil, sabit `/api/v1`).
 */
export function routeLabel(req: Request): string {
  const routePath = (req.route && typeof req.route.path === 'string') ? req.route.path : undefined;
  if (!routePath) return 'unmatched';
  let prefix = req.baseUrl || '';
  if (!prefix) {
    const routeSegs = routePath.split('/').filter(Boolean).length;
    const urlSegs = (req.originalUrl || '').split('?')[0].split('/').filter(Boolean);
    if (urlSegs.length > routeSegs) prefix = `/${urlSegs.slice(0, urlSegs.length - routeSegs).join('/')}`;
  }
  return `${prefix}${routePath}`;
}

export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer();
  httpInFlight.inc();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    httpInFlight.dec();
    const route = routeLabel(req);
    const method = normalizeMethod(req.method);
    end({ method, route, status_class: statusClass(res.statusCode) });
    httpTotal.inc({ method, route, status: String(res.statusCode) });
  };
  res.on('finish', finish);
  res.on('close', finish); // istemci bağlantıyı yarıda keserse de in-flight sızmasın
  next();
}

// ── DB havuzu (scrape anında canlı okunur; havuz nesnesi bellekte, DB'ye sorgu YOK) ──
new client.Gauge({
  name: 'yakit_db_pool_connections',
  help: 'Uygulamanın pg havuzu: state=total (açık) | idle (boşta) | waiting (bağlantı bekleyen istek).',
  labelNames: ['state'] as const,
  registers: [registry],
  collect() {
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount);
    this.set({ state: 'waiting' }, pool.waitingCount);
  }
});

// ── MQTT ────────────────────────────────────────────────────────────────────
export const MQTT_KINDS = ['telemetry_data', 'telemetry_status', 'command_ack', 'other'] as const;
export const MQTT_REJECT_REASONS = ['unregistered_device', 'blocked_device', 'tenant_mismatch'] as const;
const mqttMessages = new client.Counter({
  name: 'yakit_mqtt_messages_total',
  help: 'Alınan MQTT mesajı (kind: telemetry_data | telemetry_status | command_ack | other).',
  labelNames: ['kind'] as const,
  registers: [registry]
});
const mqttRejected = new client.Counter({
  name: 'yakit_mqtt_rejected_total',
  help: 'Uygulama seviyesinde reddedilen MQTT mesajı (IOT-304): unregistered_device | blocked_device | tenant_mismatch.',
  labelNames: ['reason'] as const,
  registers: [registry]
});
const mqttErrors = new client.Counter({ name: 'yakit_mqtt_processing_errors_total', help: 'MQTT mesaj işleme hatası.', registers: [registry] });
// Sınırlı (enum) etiketli sayaçlar 0 ile ÖNCEDEN oluşturulur: aksi halde ilk olay gelene kadar seri hiç görünmez, dashboard "No data" gösterir
// ve rate() ilk artışı kaçırır. (HTTP route/status kombinasyonları enum değildir — istekle oluşur.)
for (const kind of MQTT_KINDS) mqttMessages.inc({ kind }, 0);
for (const reason of MQTT_REJECT_REASONS) mqttRejected.inc({ reason }, 0);
export const recordMqttMessage = (kind: (typeof MQTT_KINDS)[number]): void => mqttMessages.inc({ kind });
export const recordMqttRejected = (reason: (typeof MQTT_REJECT_REASONS)[number]): void => mqttRejected.inc({ reason });
export const recordMqttError = (): void => mqttErrors.inc();

// ── İkmal sayacı ────────────────────────────────────────────────────────────
const dispenseCompleted = new client.Counter({
  name: 'yakit_dispense_completed_total',
  help: 'Tamamlanan ikmal sayısı (source: api = /dispense | device = cihaz finalize | offline_sync = çevrimdışı toplu senkron).',
  labelNames: ['source'] as const,
  registers: [registry]
});
export const DISPENSE_SOURCES = ['api', 'device', 'offline_sync'] as const;
for (const source of DISPENSE_SOURCES) dispenseCompleted.inc({ source }, 0);
export const recordDispenseCompleted = (source: (typeof DISPENSE_SOURCES)[number], count = 1): void => {
  if (count > 0) dispenseCompleted.inc({ source }, count);
};

// ── İş metrikleri (arka planda yenilenen gauge'lar) ─────────────────────────
const devices = new client.Gauge({ name: 'yakit_devices', help: 'Cihaz sayısı: registered (AKTİF kayıtlı) | active (son 10 dk içinde görülen) | offline (son presence olayı OFFLINE) | blocked.', labelNames: ['state'] as const, registers: [registry] });
const alarmsOpen = new client.Gauge({ name: 'yakit_alarms_open', help: 'Açık (RESOLVED/FALSE_POSITIVE olmayan) alarm sayısı, şiddete göre.', labelNames: ['severity'] as const, registers: [registry] });
const dispensesToday = new client.Gauge({ name: 'yakit_dispenses_today', help: 'Bugünkü (sunucu oturum saat dilimi) ikmal sayısı — tüm tenant\'lar.', registers: [registry] });
const dispensedLitersToday = new client.Gauge({ name: 'yakit_dispensed_liters_today', help: 'Bugünkü toplam ikmal (litre) — tüm tenant\'lar.', registers: [registry] });
const despatchQueue = new client.Gauge({ name: 'yakit_despatch_queue', help: 'e-İrsaliye iletim kuyruğu derinliği: status = QUEUED | SENDING | FAILED.', labelNames: ['status'] as const, registers: [registry] });
const despatchOldest = new client.Gauge({ name: 'yakit_despatch_oldest_queued_age_seconds', help: 'Kuyrukta (QUEUED) bekleyen en eski e-İrsaliyenin yaşı (sn); kuyruk boşsa 0.', registers: [registry] });
const notificationRetry = new client.Gauge({ name: 'yakit_notifications_retry_queue', help: 'Yeniden deneme bekleyen (BAŞARISIZ) bildirim sayısı.', registers: [registry] });
const notificationCircuitOpen = new client.Gauge({ name: 'yakit_notification_circuit_open', help: 'Devre kesicisi AÇIK (ardışık başarısızlık nedeniyle otomatik devre dışı) bildirim webhook kanalı sayısı — tenant sayısı, tenant etiketi YOK.', registers: [registry] });
const businessLastRefresh = new client.Gauge({ name: 'yakit_business_metrics_last_refresh_timestamp_seconds', help: 'İş metriklerinin son BAŞARILI yenilenme zamanı (unix sn) — bayat veriyi yakalamak için.', registers: [registry] });
const businessRefreshErrors = new client.Counter({ name: 'yakit_business_metrics_refresh_errors_total', help: 'İş metriği yenileme hatası sayısı.', registers: [registry] });

export async function refreshBusinessMetrics(): Promise<void> {
  try {
    // Tembel içe aktarma: adminDb ağır/yerel bağımlılıklar (argon2 vb.) çeker; metrik kayıt defterini yalnızca tanım/dokümantasyon araçları
    // (scripts/test-ops1107.mjs) yüklüyorsa bunları yüklemek gerekmez.
    const { getBusinessMetricsSnapshot } = await import('../db/adminDb');
    const s = await getBusinessMetricsSnapshot();
    for (const state of ['registered', 'active', 'offline', 'blocked'] as const) devices.set({ state }, s.devices[state]);
    for (const severity of ['INFO', 'WARNING', 'CRITICAL'] as const) alarmsOpen.set({ severity }, s.alarmsOpen[severity] ?? 0);
    dispensesToday.set(s.dispensesToday);
    dispensedLitersToday.set(s.dispensedLitersToday);
    for (const status of ['QUEUED', 'SENDING', 'FAILED'] as const) despatchQueue.set({ status }, s.despatchQueue[status] ?? 0);
    despatchOldest.set(s.despatchOldestQueuedAgeSeconds);
    notificationRetry.set(s.notificationRetryQueue);
    notificationCircuitOpen.set(s.notificationCircuitOpen);
    businessLastRefresh.set(Date.now() / 1000);
  } catch (err) {
    businessRefreshErrors.inc();
    logger.warn({ err }, '⚠️ [OPS-1107] İş metrikleri yenilenemedi (önceki değerler korunuyor).');
  }
}

export const BUSINESS_REFRESH_MS = 30_000;
/** Arka plan yenileyici; ilk tur kısa gecikmeyle, sonra 30 sn'de bir. Dönen fonksiyon durdurur (graceful shutdown). */
export function startBusinessMetricsRefresher(intervalMs = BUSINESS_REFRESH_MS): () => void {
  const first = setTimeout(() => void refreshBusinessMetrics(), 3_000);
  const timer = setInterval(() => void refreshBusinessMetrics(), intervalMs);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

// ── /metrics uç noktası ─────────────────────────────────────────────────────
function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header || '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `/metrics` API dışıdır (`/api/v1` altında DEĞİL) → nginx bunu dışarı proxy'lemez; Prometheus compose ağı içinden
 * `backend:5000/metrics`'i kazır. METRICS_TOKEN tanımlıysa ek olarak `Authorization: Bearer <token>` ZORUNLUDUR
 * (üretim önerisi: rota adları/hacimleri operasyonel bilgidir).
 */
export function metricsHandler(token: string | undefined = config.METRICS_TOKEN) {
  return async (req: Request, res: Response): Promise<void> => {
    if (token && !tokenMatches(req.headers.authorization, token)) {
      res.status(401).set('WWW-Authenticate', 'Bearer').type('text/plain').send('unauthorized\n');
      return;
    }
    res.set('Content-Type', registry.contentType);
    res.set('Cache-Control', 'no-store');
    res.send(await registry.metrics());
  };
}
