/**
 * TEST-1002 — Event Loop Lag ölçümlü backend sidecar (container içi).
 *
 * `yakittakipsistemi-backend` imajının İÇİNDE çalıştırılır: derlenmiş
 * `/app/dist/server.cjs`'i AYNI process'te require ederek backend'i ayağa
 * kaldırır ve `perf_hooks.monitorEventLoopDelay` ile GERÇEK event loop
 * gecikmesini ölçer. Backend kaynak koduna hiç dokunulmaz.
 *
 * Neden container içi: bu makinede host firewall'ı docker bridge → host portu
 * bağlantılarını düşürüyor; k6 konteynerinin host'taki bir sidecar'a erişmesi
 * güvenilir değil. Sidecar'ı da compose ağında bir konteyner olarak koşturunca
 * tüm trafik container↔container kalır.
 *
 * run.sh şu şekilde başlatır (özet):
 *   docker run --network <compose-net> --name loadtest-sidecar \
 *     --env-file .env -e MQTT_URL=__CI_SKIP__ -e LOG_LEVEL=warn \
 *     -v .../lag-sidecar.cjs:/lag-sidecar.cjs:ro \
 *     yakittakipsistemi-backend node /lag-sidecar.cjs
 *
 * Çıktı: her ~2 sn'de bir stdout'a `[eventloop-lag] {json}` satırı
 * (`docker logs loadtest-sidecar` ile toplanır).
 */
'use strict';
const { monitorEventLoopDelay } = require('node:perf_hooks');

const RESOLUTION_MS = 10;
const SAMPLE_MS = Number(process.env.LAG_SAMPLE_MS || 2000);

const h = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
h.enable();

// resolution çıkarılır → boştaki loop ≈ 0 ms ("nominal üstü gerçek gecikme").
const toMs = (ns) => Math.max(0, Math.round((ns / 1e6 - RESOLUTION_MS) * 100) / 100);

setInterval(() => {
  const line = {
    t: new Date().toISOString(),
    p50_ms: toMs(h.percentile(50)),
    p90_ms: toMs(h.percentile(90)),
    p99_ms: toMs(h.percentile(99)),
    max_ms: toMs(h.max),
    mean_ms: toMs(h.mean),
  };
  // eslint-disable-next-line no-console
  console.log('[eventloop-lag] ' + JSON.stringify(line));
  h.reset();
}, SAMPLE_MS).unref();

// eslint-disable-next-line no-console
console.log('[eventloop-lag] sidecar: backend bundle yükleniyor (dist/server.cjs)...');
require('/app/dist/server.cjs');
