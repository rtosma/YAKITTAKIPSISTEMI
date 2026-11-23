/**
 * TEST-1002 — k6 Yük ve Stres Testi (HTTP telemetri ingest).
 *
 * AC: "100 eşzamanlı pompadan saniyede 1.000 telemetri paketi gönderildiğinde
 *      P95 yanıt süresi < 200ms ve event loop lag < 50ms."
 *
 * Hedef uç: POST /api/v1/telemetry/hardware-data — AUTH-202 HMAC-SHA256 ile
 * korunur, gövde/DB mutasyonu YOK (nonce SET NX + cihaz lookup + echo). Bu
 * yüzden tekrarlanabilir: satır büyümesi ya da seed veri bozulması olmaz.
 * Gerçek MQTT yükü k6'nın doğal kapsamı değildir; telemetri paketinin HTTP
 * eşdeğeri budur.
 *
 * Event loop lag AYRI ölçülür: scripts/load-test/serve-with-lag-monitor.mjs
 * backend'i in-process monitorEventLoopDelay ile ayağa kaldırır (bkz. README).
 *
 * Ortam değişkenleri (k6 `-e`):
 *   BASE_URL     (vars.) http://localhost:5000/api/v1
 *   DEVICES      JSON: [{ "id": "ESP32-PUMP-01", "secret": "..." }, ...]  (ZORUNLU)
 *   TARGET_RPS   (vars.) 12    — toplam istek/sn (AC koşusu: 1000)
 *   DURATION     (vars.) 60s
 *   VUS          (vars.) 100   — preAllocated/max VU
 *   P95_MS       (vars.) 200   — http_req_duration p(95) eşiği
 */
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000/api/v1';
const TARGET_RPS = Number(__ENV.TARGET_RPS || 12);
const DURATION = __ENV.DURATION || '60s';
const VUS = Number(__ENV.VUS || 100);
const P95_MS = Number(__ENV.P95_MS || 200);

const DEVICES = JSON.parse(__ENV.DEVICES || '[]');
if (!Array.isArray(DEVICES) || DEVICES.length === 0) {
  throw new Error('DEVICES ortam değişkeni zorunlu: [{"id":"...","secret":"..."}] — bkz. scripts/load-test/run.sh');
}

// AUTH-202: hardwareRateLimiter cihaz (X-Device-ID) başına 300 istek/dakika
// (= 5/sn). Cihaz sayısı, hedef RPS'i bu sınırın altında tutacak kadar
// olmalı (~4/sn/cihaz güvenli). Aksi halde testin çoğu 429 alır ve P95
// ölçümü anlamsızlaşır.
const perDeviceRps = TARGET_RPS / DEVICES.length;
if (perDeviceRps > 4.5) {
  throw new Error(
    `Cihaz başına ${perDeviceRps.toFixed(1)} istek/sn — 300/dk (5/sn) rate limitini aşar. ` +
    `Daha fazla cihaz sağlayın (DEVICE_COUNT) ya da TARGET_RPS'i düşürün. ` +
    `Gerekli: DEVICE_COUNT >= ${Math.ceil(TARGET_RPS / 4)}.`
  );
}

export const options = {
  scenarios: {
    telemetry_ingest: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: VUS,
      maxVUs: VUS,
    },
  },
  thresholds: {
    http_req_duration: [`p(95)<${P95_MS}`],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

function signedHeaders(device, bodyString) {
  const ts = Date.now().toString();
  // İstek başına benzersiz nonce (AUTH-202: cihaz başına 120sn tek kullanımlık).
  const nonce = `${__VU}-${__ITER}-${ts}-${Math.random().toString(16).slice(2)}`;
  const rawBody = bodyString && bodyString.length > 0 ? bodyString : '{}';
  const signature = crypto.hmac('sha256', device.secret, `${ts}.${nonce}.${rawBody}`, 'hex');
  return {
    'Content-Type': 'application/json',
    'X-Device-ID': device.id,
    'X-Timestamp': ts,
    'X-Nonce': nonce,
    'X-Hardware-Signature': signature,
  };
}

// run.sh bu tek satırı (marker'lı) ayıklar — deprecated --summary-export yerine.
export function handleSummary(data) {
  const m = data.metrics || {};
  const val = (metric, key) => (m[metric] && m[metric].values ? m[metric].values[key] : undefined);
  const summary = {
    __k6_summary__: true,
    metrics: {
      http_req_duration: { 'p(95)': val('http_req_duration', 'p(95)'), 'p(99)': val('http_req_duration', 'p(99)'), avg: val('http_req_duration', 'avg') },
      http_req_failed: { rate: val('http_req_failed', 'rate') },
      http_reqs: { count: val('http_reqs', 'count'), rate: val('http_reqs', 'rate') },
      checks: { rate: val('checks', 'rate') },
      vus_max: { value: val('vus_max', 'value') },
    },
  };
  return { stdout: '\n' + JSON.stringify(summary) + '\n' };
}

export default function () {
  // VU'yu bir cihaza sabitle — trafiği cihazlara eşit dağıtır.
  const device = DEVICES[(__VU - 1) % DEVICES.length];
  const body = JSON.stringify({
    flowRate: Math.round((Math.random() * 60 + 20) * 10) / 10,
    totalizerLiters: Math.round(Math.random() * 100000),
    rssi: -1 * (60 + Math.floor(Math.random() * 40)),
    sentAt: new Date().toISOString(),
  });

  const res = http.post(`${BASE_URL}/telemetry/hardware-data`, body, {
    headers: signedHeaders(device, body),
    tags: { name: 'telemetry-hardware-data' },
  });

  check(res, {
    'status 200': (r) => r.status === 200,
    'success:true': (r) => {
      try {
        return r.json('success') === true;
      } catch {
        return false;
      }
    },
  });
}
