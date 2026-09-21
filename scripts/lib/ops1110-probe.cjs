'use strict';
// ==============================================================================
// OPS-1110 canlı tatbikat sondası — `test-ops1110.mjs --live` tarafından, backend
// test-runner imajında (socket.io-client mevcut), nginx (frontend) konteynerinin AĞ İSİM
// ALANINDA çalıştırılır: trafik gerçek istemcilerle aynı yoldan (nginx :80 → backend) geçer.
// Dağıtım sürerken kesintisiz ölçer; SIGUSR1 alınca durup sonucu `RESULT {json}` satırı
// olarak yazar. Ölçülenler:
//   1. /health'e her 100 ms bir GET (hata sayısı + hangi sürümün ne zaman göründüğü)
//   2. kimlik doğrulamalı API çağrısı (JWT'nin iki örnekte de geçerli olması)
//   3. AKTİF İKMAL OTURUMU: cihaz-HMAC ile request-auth → 1 sn'de bir heartbeat → sonda finalize
//      (oturum ESKİ örnekte başlar, YENİ örnekte biter — Redis'te yaşadığı için kopmamalı)
//   4. N adet WebSocket istemcisi: kopuş zamanları (kademeli mi?) ve yeniden bağlanma
// ==============================================================================
const crypto = require('crypto');
const { io } = require('socket.io-client');

const BASE = process.env.PROBE_BASE || 'http://localhost';
const API = `${BASE}/api/v1`;
const N_SOCKETS = parseInt(process.env.PROBE_SOCKETS || '20', 10);
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01;
const t0 = Date.now();
const now = () => Date.now() - t0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = true;
const result = {
  health: { total: 0, failures: [], versions: {} },
  api: { total: 0, failures: [] },
  dispense: { started: false, heartbeats: 0, failures: [], finalize: null, sessionStartVersion: null, finalizeVersion: null },
  sockets: { n: N_SOCKETS, initialConnected: 0, disconnects: [], reconnects: [], stuck: 0 }
};
let currentVersion = null;

async function timedFetch(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(timer); }
}

async function hwPost(pathname, body) {
  const raw = JSON.stringify(body);
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', DEVICE_SECRET).update(`${ts}.${nonce}.${raw}`).digest('hex');
  const res = await timedFetch(`${API}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': DEVICE_ID, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Hardware-Signature': sig },
    body: raw
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function healthLoop() {
  while (running) {
    const started = now();
    try {
      const res = await timedFetch(`${API}/health`);
      const body = await res.json().catch(() => ({}));
      result.health.total++;
      if (res.status !== 200) result.health.failures.push({ t: started, status: res.status });
      else {
        currentVersion = body.version || 'unknown';
        if (!(currentVersion in result.health.versions)) result.health.versions[currentVersion] = { firstSeenMs: started, count: 0 };
        result.health.versions[currentVersion].count++;
      }
    } catch (e) {
      result.health.total++;
      result.health.failures.push({ t: started, error: String(e && e.message) });
    }
    await sleep(100);
  }
}

async function apiLoop(token) {
  while (running) {
    const started = now();
    try {
      const res = await timedFetch(`${API}/tenant-info`, { headers: { Authorization: `Bearer ${token}` } });
      result.api.total++;
      if (res.status !== 200) result.api.failures.push({ t: started, status: res.status });
    } catch (e) {
      result.api.total++;
      result.api.failures.push({ t: started, error: String(e && e.message) });
    }
    await sleep(250);
  }
}

let lastTotalizer = 1000;
let sessionId = null;
async function dispenseLoop() {
  try {
    const auth = await hwPost('/dispense/request-auth', { rfidCardId: 'CARD-881201', tankName: 'Gebze Ana Tank (T-1)' });
    sessionId = auth.data && auth.data.data && (auth.data.data.sessionId || auth.data.data.session_id);
    if (auth.status !== 200 && auth.status !== 201) { result.dispense.failures.push({ t: now(), step: 'request-auth', status: auth.status, body: auth.data }); return; }
    if (!sessionId) { result.dispense.failures.push({ t: now(), step: 'request-auth', note: 'sessionId yok', body: auth.data }); return; }
  } catch (e) { result.dispense.failures.push({ t: now(), step: 'request-auth', error: String(e && e.message) }); return; }
  result.dispense.started = true;
  result.dispense.sessionStartVersion = currentVersion;
  while (running) {
    try {
      const hb = await hwPost('/dispense/heartbeat', { sessionId, totalizerLiters: lastTotalizer, flowRateLpm: 25 });
      if (hb.status === 200) { result.dispense.heartbeats++; lastTotalizer += 1; }
      else result.dispense.failures.push({ t: now(), step: 'heartbeat', status: hb.status, body: hb.data });
    } catch (e) { result.dispense.failures.push({ t: now(), step: 'heartbeat', error: String(e && e.message) }); }
    await sleep(1000);
  }
}

async function login(username) {
  const res = await timedFetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: '123456' }) });
  const body = await res.json().catch(() => ({}));
  if (!body.accessToken) throw new Error(`login ${username}: ${res.status} ${JSON.stringify(body)}`);
  return body.accessToken;
}

function startSockets(token) {
  const clients = [];
  for (let i = 0; i < N_SOCKETS; i++) {
    // İstemci, frontend/src/utils/socket.ts ile AYNI yeniden bağlanma ayarlarıyla (sonsuz deneme, 1 sn → 10 sn, ±%50 jitter).
    const s = io(BASE, { path: '/socket.io', auth: { token }, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 10000, randomizationFactor: 0.5 });
    const c = { s, connected: false };
    s.on('connect', () => { if (!c.connected) { c.connected = true; } if (c.everDisconnected) result.sockets.reconnects.push({ i, t: now() }); else result.sockets.initialConnected++; });
    s.on('disconnect', (reason) => { c.connected = false; c.everDisconnected = true; result.sockets.disconnects.push({ i, t: now(), reason }); });
    clients.push(c);
  }
  return clients;
}

(async () => {
  const token = await login('admin');
  const ownerToken = token;
  const clients = startSockets(token);
  await sleep(2500); // soketlerin ilk bağlantısı
  console.log(`READY sockets=${result.sockets.initialConnected}/${N_SOCKETS}`);
  const loops = [healthLoop(), apiLoop(ownerToken), dispenseLoop()];
  await new Promise((resolve) => process.once('SIGUSR1', resolve));
  running = false;
  await Promise.all(loops);
  // Aktif ikmal oturumunu SONDA finalize et (dağıtımın ortasında başlayıp bitti).
  if (result.dispense.started && sessionId) {
    const delta = lastTotalizer - 1000;
    try {
      const fin = await hwPost('/dispense/finalize', { sessionId, endTotalizerLiters: lastTotalizer - 1 + 0, reportedLiters: Math.max(0, lastTotalizer - 1 - 1000), idempotencyKey: `ops1110-${Date.now()}` });
      result.dispense.finalize = { status: fin.status, amount: fin.data && fin.data.data && fin.data.data.amount_liters, verification: fin.data && fin.data.data && fin.data.data.verification_status, body: fin.status === 200 ? undefined : fin.data };
      result.dispense.expectedLiters = Math.max(0, lastTotalizer - 1 - 1000);
      result.dispense.deltaSeen = delta;
    } catch (e) { result.dispense.finalize = { error: String(e && e.message) }; }
    result.dispense.finalizeVersion = currentVersion;
  }
  await sleep(3000); // geç yeniden bağlanan soketler
  result.sockets.stuck = clients.filter((c) => !c.s.connected).length;
  result.sockets.finalConnected = clients.filter((c) => c.s.connected).length;
  // Sonuç, sondanın KENDİ kapatma olaylarından ("io client disconnect") ÖNCE dondurulur.
  console.log(`RESULT ${JSON.stringify(result)}`);
  clients.forEach((c) => c.s.close());
  process.exit(0);
})().catch((e) => { console.log(`RESULT ${JSON.stringify({ fatal: String(e && e.stack || e) })}`); process.exit(1); });
