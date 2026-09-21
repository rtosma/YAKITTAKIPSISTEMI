import crypto from 'crypto';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { execSync } from 'node:child_process';
import { Client } from 'pg';

/**
 * TEST-1007 (#198) — Kesinti/offline KAOS testi: 72 saatlik kesinti, kademeli bozulma (gecikme + paket kaybı + yavaş hat),
 * senkron sırasında ikinci kesinti, sunucu çökmesi ve bağımlılık (Redis / MQTT / PostgreSQL) çökmeleri.
 *
 * KAPSAM UYARLAMASI: ticket toxiproxy / tc netem + Testcontainers + TEST-1005 cihaz simülatörü öneriyor. Bu ortamda (rootless Docker,
 * dış imaj çekmeye bağımlılık istemiyoruz) hiçbiri yok: (a) ağ hatası enjeksiyonu için bu dosyada toxiproxy'nin ilgili özelliklerini
 * (kes, gecikme, bant genişliği, bağlantı sıfırlama, "istek işlendi ama yanıt kayboldu") uygulayan küçük bir TCP proxy var —
 * TOHUMLU (seeded) PRNG ile TEKRARLANABİLİR; (b) cihaz simülatörü: firmware'in çevrimdışı kuyruk + batch senkron + yeniden deneme
 * mantığını (yalnızca ACCEPTED/DUPLICATE_SKIPPED olanlar kuyruktan silinir) birebir uygulayan bir istemci; (c) gerçek bağımlılıklar:
 * çalışan docker compose yığını (Postgres, Redis, EMQX, backend, nginx) — bağımlılık çökmeleri gerçek `docker stop/kill` ile.
 * "72 saat" SİMÜLE edilir: kesinti boyunca 72 saatlik ikmal geçmişi (deviceTimestamp) kuyruğa girer; gerçek 72 saat beklenmez.
 *
 * DOCKER gerektirir → test_res905 / iot301 ile AYNI gerekçeyle CI'a EKLENMEDİ (CI GitHub `services:` kullanır); host'tan çalıştırılır:
 *   cd backend && set -a && . ../.env && set +a && npx tsx test/test_test1007_chaos.ts [--report]
 * Sonuçlar `docs/chaos-reports/<tarih>.json|.md` olarak yazılır (--report) ve bir önceki raporla KARŞILAŞTIRILIR (sürümler arası).
 */

const API = new URL(process.env.API_URL || 'http://localhost:3000/api/v1');
const DEVICE_ID = 'ESP32-PUMP-01';
const DEVICE_SECRET = process.env.HW_SECRET_ESP32_PUMP_01 || 'secret_gebze_pump_8849';
const TANK_ID = 'tank-gebze-1';
const REPORT = process.argv.includes('--report');
const ROOT = path.join(process.cwd(), '..');

// ── Tohumlu PRNG (mulberry32): kaos senaryoları her koşuda AYNI kararları verir ───────────────────────────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string): string => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT }).trim(); } catch (e: any) { return String(e.stdout ?? '') + String(e.stderr ?? ''); } };

// ── Kaos proxy ────────────────────────────────────────────────────────────────────────────────────────────────
type Fault = 'ok' | 'reset_before' | 'reset_after_forward' | 'slow_response';
interface ProxyStats { connections: number; forwarded: number; resetBefore: number; resetAfterForward: number; refused: number; }

class ChaosProxy {
  server!: net.Server;
  port = 0;
  cut = false;                 // ağ tamamen kesik: bağlantı kabul edilir ve HEMEN sıfırlanır (kablo çekildi)
  latencyMs = 0;               // her yönde her parçaya eklenen gecikme
  bytesPerSec = 0;             // 0 = sınırsız; aksi halde bant genişliği sınırı
  lossRate = 0;                // olasılıksal hata (tohumlu): yarısı istek işlenmeden, yarısı işlendikten SONRA (belirsiz durum)
  plan: Fault[] = [];          // önce bu senaryo kuyruğu (deterministik), boşsa lossRate
  slowMs = 0;                  // slow_response: yanıtı bu kadar geciktir
  stats: ProxyStats = { connections: 0, forwarded: 0, resetBefore: 0, resetAfterForward: 0, refused: 0 };
  constructor(private target: { host: string; port: number }, private rand: () => number) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = net.createServer((client) => this.onConnection(client));
      this.server.listen(0, '127.0.0.1', () => { this.port = (this.server.address() as net.AddressInfo).port; resolve(); });
    });
  }
  stop(): void { this.server.close(); }
  resetStats(): void { this.stats = { connections: 0, forwarded: 0, resetBefore: 0, resetAfterForward: 0, refused: 0 }; }

  private pick(): Fault {
    if (this.plan.length > 0) return this.plan.shift()!;
    if (this.lossRate > 0 && this.rand() < this.lossRate) return this.rand() < 0.5 ? 'reset_before' : 'reset_after_forward';
    return 'ok';
  }

  /** Yön başına SIRALI yazıcı: gecikme + bant genişliği uygulanırken bayt sırası korunur (aksi halde HTTP akışı bozulur). */
  private makePipe(dst: net.Socket, extraDelayMs = 0): { write: (buf: Buffer) => void; done: () => Promise<void> } {
    let chain: Promise<void> = Promise.resolve();
    const write = (buf: Buffer) => {
      chain = chain.then(async () => {
        if (dst.destroyed) return;
        const wait = this.latencyMs + extraDelayMs;
        if (wait > 0) await sleep(wait);
        if (!this.bytesPerSec) { if (!dst.destroyed) dst.write(buf); return; }
        const chunk = Math.max(64, Math.floor(this.bytesPerSec / 10));
        for (let off = 0; off < buf.length && !dst.destroyed; off += chunk) { dst.write(buf.subarray(off, off + chunk)); await sleep(100); }
      });
    };
    return { write, done: () => chain };
  }

  private onConnection(client: net.Socket): void {
    this.stats.connections++;
    client.on('error', () => undefined);
    if (this.cut) { this.stats.refused++; client.destroy(); return; }
    const fault = this.pick();
    if (fault === 'reset_before') { this.stats.resetBefore++; client.destroy(); return; }
    const upstream = net.connect(this.target.port, this.target.host);
    upstream.on('error', () => client.destroy());
    const toUpstream = this.makePipe(upstream);
    const toClient = this.makePipe(client, fault === 'slow_response' ? this.slowMs : 0);
    // Kapanışta önce kuyruktaki (gecikmeli/kısıtlı) baytların TAMAMI iletilir; sonra karşı taraf kapatılır.
    client.on('close', () => { void toUpstream.done().then(() => upstream.destroy()); });
    upstream.on('close', () => { void toClient.done().then(() => client.end()); });
    client.on('data', (d) => toUpstream.write(d));
    let responded = false;
    upstream.on('data', (d) => {
      if (fault === 'reset_after_forward') {
        // İstek sunucuya ulaştı VE sunucu yanıt üretti (işlendi) — ama istemciye HİÇBİR ŞEY iletmeden bağlantıyı koparıyoruz.
        if (!responded) { responded = true; this.stats.resetAfterForward++; setTimeout(() => client.destroy(), this.latencyMs); }
        return;
      }
      this.stats.forwarded++;
      toClient.write(d);
    });
  }
}

// ── Cihaz simülatörü (firmware çevrimdışı kuyruk + batch senkron + yeniden deneme) ───────────────────────────────
interface QueuedRecord { localSequenceId: number; deviceTimestamp: string; siteName: string; vehiclePlate: string; tankName: string; amountLiters: number; flowRateLpm: number; }
interface HttpResult { status: number; body: any; error?: string; }

function httpPost(port: number, pathname: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<HttpResult> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', agent: false, headers: { ...headers, 'Content-Length': Buffer.byteLength(body), Connection: 'close' }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let parsed: any = {}; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* boş/HTML gövde */ } resolve({ status: res.statusCode ?? 0, body: parsed }); });
      res.on('error', (e) => resolve({ status: 0, body: {}, error: e.message }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, body: {}, error: e.message }));
    req.write(body); req.end();
  });
}

function signedHeaders(rawBody: string): Record<string, string> {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', DEVICE_SECRET).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
  return { 'Content-Type': 'application/json', 'X-Device-ID': DEVICE_ID, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Hardware-Signature': signature };
}

class DeviceSim {
  queue: QueuedRecord[] = [];
  metrics = { attempts: 0, failures: 0, ambiguousObserved: 0, batchesAcked: 0, accepted: 0, dupSkipped: 0, recordErrors: 0, statuses: {} as Record<string, number> };
  constructor(private proxy: () => number) {}

  /** Bir ikmal, internet OLSA da OLMASA da yerel kuyruğa yazılır (firmware LittleFS ring buffer). */
  dispense(rec: QueuedRecord): void { this.queue.push(rec); }

  async syncOnce(batchSize: number, timeoutMs = 6000): Promise<HttpResult> {
    const batch = this.queue.slice(0, batchSize);
    const raw = JSON.stringify({ records: batch });
    this.metrics.attempts++;
    const r = await httpPost(this.proxy(), `${API.pathname}/telemetry/sync-batch`, raw, signedHeaders(raw), timeoutMs);
    const key = r.status === 0 ? `ağ:${r.error}` : String(r.status);
    this.metrics.statuses[key] = (this.metrics.statuses[key] ?? 0) + 1;
    if (r.status !== 200) { this.metrics.failures++; if (r.status === 0) this.metrics.ambiguousObserved++; return r; }
    // Cihaz YALNIZCA ACCEPTED + DUPLICATE_SKIPPED olanları kuyruktan siler (ERROR kalır).
    const done = new Set<number>();
    for (const x of r.body.results ?? []) {
      if (x.status === 'ACCEPTED') { done.add(x.localSequenceId); this.metrics.accepted++; }
      else if (x.status === 'DUPLICATE_SKIPPED') { done.add(x.localSequenceId); this.metrics.dupSkipped++; }
      else this.metrics.recordErrors++;
    }
    this.queue = this.queue.filter((q) => !done.has(q.localSequenceId));
    this.metrics.batchesAcked++;
    return r;
  }

  /** Kuyruk boşalana ya da deneme hakkı bitene kadar üstel geri çekilmeyle senkron. */
  async syncAll(batchSize: number, maxAttempts: number, timeoutMs = 6000): Promise<boolean> {
    let backoff = 40;
    for (let i = 0; i < maxAttempts && this.queue.length > 0; i++) {
      const r = await this.syncOnce(batchSize, timeoutMs);
      if (r.status === 200) backoff = 40; else { await sleep(backoff); backoff = Math.min(backoff * 2, 400); }
    }
    return this.queue.length === 0;
  }
}

function makeRecord(seq: number, tsMs: number, liters: number): QueuedRecord {
  return { localSequenceId: seq, deviceTimestamp: new Date(tsMs).toISOString(), siteName: 'Gebze Ana Şantiye', vehiclePlate: '34 KHS 07', tankName: 'Gebze Ana Tank (T-1)', amountLiters: liters, flowRateLpm: 20 };
}

// ── Bağımlılık kontrolü ───────────────────────────────────────────────────────────────────────────────────────────
const COMPOSE_BACKEND = () => sh("docker compose ps -q backend").split('\n')[0];
async function waitHealth(pathname: string, want: (status: number, body: any) => boolean, timeoutMs: number): Promise<{ ok: boolean; ms: number; last: string }> {
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${API.origin}${API.pathname}${pathname}`, { signal: AbortSignal.timeout(4000) });
      const body: any = await res.json().catch(() => ({}));
      last = `${res.status}`;
      if (want(res.status, body)) return { ok: true, ms: Date.now() - t0, last };
    } catch (e: any) { last = `hata:${e.message}`; }
    await sleep(500);
  }
  return { ok: false, ms: Date.now() - t0, last };
}
const readyBody = async (): Promise<{ status: number; body: any }> => {
  try { const r = await fetch(`${API.origin}${API.pathname}/health/ready`, { signal: AbortSignal.timeout(5000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; } catch { return { status: 0, body: {} }; }
};

// ── Ana akış ──────────────────────────────────────────────────────────────────────────────────────────────────────
interface ScenarioResult { name: string; records: number; durationMs: number; attempts: number; failures: number; ambiguousObserved: number; dupSkipped: number; exact: boolean; extra?: Record<string, unknown>; }
const results: ScenarioResult[] = [];
// Hata ayıklama: CHAOS_ONLY=AC  → yalnızca A ve C senaryoları (varsayılan: hepsi).
const want = (k: string): boolean => !process.env.CHAOS_ONLY || process.env.CHAOS_ONLY.includes(k);

async function run() {
  console.log('===========================================================');
  console.log('🌪️  [TEST-1007] KESİNTİ / OFFLINE KAOS TESTİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  // Bağımlılık çökmeleri sırasında kalıcı bir pg bağlantısı 'terminating connection' ile test sürecini düşürürdü → her sorgu KISA ömürlü bağlantıyla.
  const db = {
    async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
      for (let attempt = 0; ; attempt++) {
        const c = new Client({ host: process.env.POSTGRES_HOST || 'localhost', port: parseInt(process.env.POSTGRES_PORT || '5432', 10), user: process.env.POSTGRES_USER || 'postgres', password: process.env.POSTGRES_PASSWORD || 'postgres', database: process.env.POSTGRES_DB || 'yakittakip_db' });
        c.on('error', () => undefined);
        try { await c.connect(); const r = await c.query(sql, params); return { rows: r.rows }; } catch (e) { if (attempt >= 20) throw e; await sleep(1000); } finally { await c.end().catch(() => undefined); }
      }
    }
  };
  const tankLevel = async (): Promise<number> => Number((await db.query('SELECT current_level_liters FROM tanks WHERE id = $1', [TANK_ID])).rows[0].current_level_liters);
  const levelBefore = await tankLevel();
  const baseSeq = Date.now() * 100; // her koşuda benzersiz aralık
  let seqCursor = baseSeq;
  const rangeOf = (from: number, to: number) => db.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_liters), 0)::float8 AS liters, COUNT(DISTINCT local_sequence_id)::int AS distinct_n, MIN(created_at) AS first_at, MAX(created_at) AS last_at
     FROM transactions WHERE device_id = $1 AND local_sequence_id BETWEEN $2 AND $3`, [DEVICE_ID, from, to]);
  const nextRange = (n: number) => { const from = seqCursor + 1; seqCursor += n + 1000; return { from, to: from + n - 1 }; };

  const proxy = new ChaosProxy({ host: API.hostname, port: parseInt(API.port || '80', 10) }, rng(20260921));
  await proxy.start();
  const dev = () => new DeviceSim(() => proxy.port);

  try {
    // Ön koşul: yığın ayakta.
    const up = await waitHealth('/health/ready', (s) => s === 200, 30000);
    check('Ön koşul: yığın hazır (readiness 200)', up.ok, `${up.last}`);

    // ── A. Taban çizgisi ───────────────────────────────────────────────────────────────────────────────────────
    if (want('A')) {
      const t0 = Date.now(); const d = dev(); const { from, to } = nextRange(40);
      for (let i = 0; i < 40; i++) d.dispense(makeRecord(from + i, Date.now() - (40 - i) * 60_000, 5));
      const lvl0 = await tankLevel();
      const ok = await d.syncAll(20, 10);
      const db1 = (await rangeOf(from, to)).rows[0]; const lvl1 = await tankLevel();
      const exact = ok && db1.n === 40 && Math.abs(lvl0 - lvl1 - 200) < 0.01;
      results.push({ name: 'A-baseline', records: 40, durationMs: Date.now() - t0, attempts: d.metrics.attempts, failures: d.metrics.failures, ambiguousObserved: 0, dupSkipped: d.metrics.dupSkipped, exact });
      check('A. Taban: sağlam hatta 40 ikmal / 2 batch → 40 kayıt, tank −200 L, sıfır hata, sıfır tekrar', exact && d.metrics.failures === 0 && d.metrics.dupSkipped === 0, `db=${db1.n}, Δtank=${(lvl0 - lvl1).toFixed(2)}, deneme=${d.metrics.attempts}`);
    }

    // ── B. 72 saatlik kesinti ─────────────────────────────────────────────────────────────────────────────────────
    if (want('B')) {
      const t0 = Date.now(); const d = dev(); const N = 216; const { from, to } = nextRange(N);
      proxy.cut = true; proxy.resetStats();
      const now = Date.now(); let liters = 0;
      for (let h = 0; h < 72; h++) {                 // 72 saat × saatte 3 ikmal
        for (let k = 0; k < 3; k++) {
          const i = h * 3 + k; const amt = 5 + (i % 7);  // 5..11 L
          liters += amt;
          d.dispense(makeRecord(from + i, now - (72 - h) * 3600_000 + k * 20 * 60_000, amt));
        }
        if (h % 6 === 5) await d.syncOnce(50, 1500);  // cihaz her "6 saatte" bir bağlanmayı dener → kesik
      }
      const during = (await rangeOf(from, to)).rows[0];
      check('B1. 72 saatlik kesinti: kuyruk 216 ikmali biriktirir; kesinti boyunca 12 senkron denemesi hep başarısız; sunucuya TEK kayıt sızmaz',
        d.queue.length === N && d.metrics.failures === 12 && d.metrics.batchesAcked === 0 && during.n === 0 && proxy.stats.refused === 12, `kuyruk=${d.queue.length}, hata=${d.metrics.failures}, DB=${during.n}, reddedilen bağlantı=${proxy.stats.refused}`);
      const lvl0 = await tankLevel();
      proxy.cut = false;
      const ok = await d.syncAll(50, 20, 15000);
      const after = (await rangeOf(from, to)).rows[0]; const lvl1 = await tankLevel();
      const spanH = (new Date(after.last_at).getTime() - new Date(after.first_at).getTime()) / 3600_000;
      const exact = ok && after.n === N && after.distinct_n === N && Math.abs(after.liters - liters) < 0.01 && Math.abs(lvl0 - lvl1 - liters) < 0.01;
      results.push({ name: 'B-72h-outage', records: N, durationMs: Date.now() - t0, attempts: d.metrics.attempts, failures: d.metrics.failures, ambiguousObserved: 0, dupSkipped: d.metrics.dupSkipped, exact, extra: { totalLiters: liters, spanHours: Number(spanH.toFixed(1)) } });
      check(`B2. AC (72 saatte hiçbir ikmal kaybolmaz): bağlantı gelince 216 ikmal EKSİKSİZ senkronlanır — DB 216 benzersiz kayıt, toplam ${liters} L (elle hesap), tank Δ = ${liters} L, kuyruk boş`,
        exact && d.queue.length === 0 && d.metrics.dupSkipped === 0, `db=${after.n}/${after.distinct_n}, litre=${after.liters}, Δtank=${(lvl0 - lvl1).toFixed(2)}, kuyruk=${d.queue.length}`);
      check('B3. Kayıtlar CİHAZIN zamanıyla saklanır: oluşturulma zamanları 72 saatlik geçmişi kapsar (sunucu "şimdi" damgası basmaz)', spanH > 70 && spanH < 73, `aralık=${spanH.toFixed(1)} saat`);
    }

    // ── C. Kademeli bozulma: gecikme + paket kaybı + yavaş hat ──────────────────────────────────────────────────────
    if (want('C')) {
      const t0 = Date.now(); const d = dev(); const N = 150; const { from, to } = nextRange(N);
      let liters = 0;
      for (let i = 0; i < N; i++) { const amt = 4 + (i % 5); liters += amt; d.dispense(makeRecord(from + i, Date.now() - (N - i) * 120_000, amt)); }
      proxy.resetStats();
      proxy.latencyMs = 250; proxy.lossRate = 0.35; proxy.bytesPerSec = 12_000;
      // Belirsiz durumu GARANTİLE: ilk iki bağlantı "işlendi ama yanıt kayboldu", sonra tohumlu olasılıksal kayıp.
      proxy.plan = ['reset_after_forward', 'ok', 'reset_before', 'reset_after_forward'];
      const lvl0 = await tankLevel();
      const ok = await d.syncAll(25, 80, 10000);
      proxy.latencyMs = 0; proxy.lossRate = 0; proxy.bytesPerSec = 0; proxy.plan = [];
      const after = (await rangeOf(from, to)).rows[0]; const lvl1 = await tankLevel();
      const exact = ok && after.n === N && after.distinct_n === N && Math.abs(after.liters - liters) < 0.01 && Math.abs(lvl0 - lvl1 - liters) < 0.01;
      results.push({ name: 'C-degraded-link', records: N, durationMs: Date.now() - t0, attempts: d.metrics.attempts, failures: d.metrics.failures, ambiguousObserved: proxy.stats.resetAfterForward, dupSkipped: d.metrics.dupSkipped, exact, extra: { resetBefore: proxy.stats.resetBefore, latencyMs: 250, lossRate: 0.35, bytesPerSec: 12000 } });
      check('C1. Yavaş+kayıplı hat (gecikme 250 ms, bant 12 KB/s, %35 bağlantı kaybı, tohum 20260921): 150 ikmal EKSİKSİZ ve MÜKERRERSİZ senkronlanır — DB 150 benzersiz kayıt, litre ve tank Δ birebir',
        exact && d.queue.length === 0, `db=${after.n}/${after.distinct_n}, litre=${after.liters}/${liters}, Δtank=${(lvl0 - lvl1).toFixed(2)}, deneme=${d.metrics.attempts}, hata=${d.metrics.failures}, durumlar=${JSON.stringify(d.metrics.statuses)}`);
      check('C2. Belirsiz durum gerçekten yaşandı: sunucu batch\'i İŞLEDİ ama yanıt cihaza ulaşmadı (≥2 kez) ve cihaz aynı batch\'i tekrar gönderince kayıtlar DUPLICATE_SKIPPED döndü — çift işleme YOK',
        proxy.stats.resetAfterForward >= 2 && d.metrics.dupSkipped >= 25, `yanıtı kaybolan işlenmiş istek=${proxy.stats.resetAfterForward}, işlenmeden kopan=${proxy.stats.resetBefore}, DUPLICATE_SKIPPED=${d.metrics.dupSkipped}`);
    }

    // ── D. Senkron SIRASINDA ikinci kesinti (kısmi senkron) ─────────────────────────────────────────────────────────
    if (want('D')) {
      const t0 = Date.now(); const d = dev(); const N = 100; const { from, to } = nextRange(N);
      let liters = 0;
      for (let i = 0; i < N; i++) { const amt = 6 + (i % 3); liters += amt; d.dispense(makeRecord(from + i, Date.now() - (N - i) * 90_000, amt)); }
      proxy.resetStats(); proxy.plan = ['ok', 'reset_after_forward'];   // batch1 tamam; batch2 sunucuda İŞLENİR ama yanıt kaybolur
      const lvl0 = await tankLevel();
      await d.syncOnce(20); await d.syncOnce(20);
      proxy.cut = true;                                                    // ikinci kesinti (senkron ortasında)
      for (let i = 0; i < 3; i++) await d.syncOnce(20, 1500);
      const mid = (await rangeOf(from, to)).rows[0];
      check('D1. Kısmi senkron (en riskli durum): batch2 sunucuda işlendi ama yanıt kayboldu, ardından ikinci kesinti → DB 40 kayıt içerir, cihaz yalnızca 20\'sini onaylanmış sanır (kuyrukta 80)',
        mid.n === 40 && d.queue.length === 80 && d.metrics.batchesAcked === 1, `db=${mid.n}, kuyruk=${d.queue.length}, onaylı batch=${d.metrics.batchesAcked}`);
      proxy.cut = false;
      const ok = await d.syncAll(20, 30);
      const after = (await rangeOf(from, to)).rows[0]; const lvl1 = await tankLevel();
      const exact = ok && after.n === N && after.distinct_n === N && Math.abs(after.liters - liters) < 0.01 && Math.abs(lvl0 - lvl1 - liters) < 0.01;
      results.push({ name: 'D-second-outage-mid-sync', records: N, durationMs: Date.now() - t0, attempts: d.metrics.attempts, failures: d.metrics.failures, ambiguousObserved: proxy.stats.resetAfterForward, dupSkipped: d.metrics.dupSkipped, exact });
      check('D2. AC (senkron sırasındaki ikinci kesinti mükerrer üretmez): bağlantı gelince kalan 80 gönderilir; batch2\'nin 20 kaydı DUPLICATE_SKIPPED — DB tam 100 kayıt, litre ve tank Δ tam olarak BİR kez',
        exact && d.metrics.dupSkipped === 20, `db=${after.n}, litre=${after.liters}/${liters}, Δtank=${(lvl0 - lvl1).toFixed(2)}, dupSkipped=${d.metrics.dupSkipped}`);
    }

    // ── E. Sunucu çökmesi (SIGKILL) senkron ortasında ───────────────────────────────────────────────────────────────
    if (want('E')) {
      const t0 = Date.now(); const d = dev(); const N = 60; const { from, to } = nextRange(N);
      let liters = 0;
      for (let i = 0; i < N; i++) { const amt = 5 + (i % 4); liters += amt; d.dispense(makeRecord(from + i, Date.now() - (N - i) * 60_000, amt)); }
      const lvl0 = await tankLevel();
      proxy.resetStats();
      await d.syncOnce(30);                                                  // batch1 tamam
      proxy.plan = ['slow_response']; proxy.slowMs = 1200;
      const inflight = d.syncOnce(30, 5000);                                 // batch2 yolda…
      await sleep(250);
      const cid = COMPOSE_BACKEND();
      // Gerçek bir ÇÖKME: konteynerin içindeki node süreci SIGKILL ile öldürülür (docker kill "elle durdurma" sayılır ve restart policy'yi tetiklemeyebilir).
      sh(`docker exec ${cid} sh -c 'kill -9 $(pidof node)'`);
      await inflight;
      let restartedByPolicy = false; let manualStart = false; let nginxReloaded = false;
      const t1 = Date.now();
      while (Date.now() - t1 < 60000) { if (sh(`docker inspect -f '{{.State.Running}}' ${cid}`) === 'true' && sh(`docker inspect -f '{{.RestartCount}}' ${cid}`) !== '0') { restartedByPolicy = true; break; } await sleep(1000); }
      if (!restartedByPolicy) { manualStart = true; sh(`docker start ${cid}`); }
      let back = await waitHealth('/health/ready', (s) => s === 200, 60000);
      if (!back.ok) {                                                        // nginx upstream IP'si eskimiş olabilir: reload dene (bulgu olarak raporlanır)
        sh(`docker exec ${sh('docker compose ps -q frontend').split('\n')[0]} nginx -s reload`); nginxReloaded = true;
        back = await waitHealth('/health/ready', (s) => s === 200, 60000);
      }
      const recovered = back.ok;
      const ok = recovered && await d.syncAll(30, 30, 10000);
      const after = (await rangeOf(from, to)).rows[0]; const lvl1 = await tankLevel();
      const exact = ok && after.n === N && after.distinct_n === N && Math.abs(after.liters - liters) < 0.01 && Math.abs(lvl0 - lvl1 - liters) < 0.01;
      results.push({ name: 'E-backend-crash-mid-sync', records: N, durationMs: Date.now() - t0, attempts: d.metrics.attempts, failures: d.metrics.failures, ambiguousObserved: d.metrics.ambiguousObserved, dupSkipped: d.metrics.dupSkipped, exact, extra: { recoveryMs: Date.now() - t1, restartedByPolicy, manualStartNeeded: manualStart, nginxReloadNeeded: nginxReloaded } });
      check(`E. Backend SIGKILL ile çöktü (senkron ortasında), geri geldi (${restartedByPolicy ? 'restart policy ile' : 'restart policy TETİKLENMEDİ → elle başlatıldı'}${nginxReloaded ? ', nginx reload gerekti' : ''}, ${((Date.now() - t1) / 1000).toFixed(0)} sn); cihaz kuyruğu koruyup yeniden gönderdi → DB tam 60 kayıt, litre ve tank Δ birebir, mükerrer yok`,
        exact, `db=${after.n}/${after.distinct_n}, litre=${after.liters}/${liters}, Δtank=${(lvl0 - lvl1).toFixed(2)}, dupSkipped=${d.metrics.dupSkipped}`);
    }

    // ── F. Bağımlılık çökmeleri (RES-905 davranışı) ────────────────────────────────────────────────────────────────────
    const probeSync = async (label: string): Promise<{ status: number; ms: number; d: DeviceSim; from: number; to: number }> => {
      const d = dev(); const { from, to } = nextRange(3);
      for (let i = 0; i < 3; i++) d.dispense(makeRecord(from + i, Date.now() - 60_000 * (3 - i), 5));
      const t0 = Date.now(); const r = await d.syncOnce(3, 12000);
      void label; return { status: r.status, ms: Date.now() - t0, d, from, to };
    };
    // rate-limit hijyeni (TEST_PLAN §0.3): giriş denemesinden önce rl:auth-login:* temizlenir (Redis durmuşsa komut sessizce başarısız olur — beklenen).
    const resetLoginRl = () => sh("docker exec yakittakip_redis redis-cli --scan --pattern 'rl:auth-login:*' | xargs -r docker exec -i yakittakip_redis redis-cli DEL");
    const login = async (): Promise<number> => { resetLoginRl(); try { const r = await fetch(`${API.origin}${API.pathname}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nobody-chaos', password: '123456' }), signal: AbortSignal.timeout(12000) }); return r.status; } catch { return 0; } };
    const restoreAll = async () => {
      for (const c of ['yakittakip_postgres', 'yakittakip_redis', 'yakittakip_emqx']) sh(`docker start ${c}`);
      await waitHealth('/health/ready', (s) => s === 200, 90000);
    };

    // F1 Redis
    if (want('F')) {
      sh('docker stop yakittakip_redis'); await sleep(4000);
      const s = await probeSync('redis'); const live = await waitHealth('/health/live', (st) => st === 200, 5000); const rdy = await readyBody(); const lg = await login();
      const redisDep = rdy.body?.dependencies?.find((x: any) => /redis/i.test(x.name));
      check(`F1. Redis çöktü (RES-905): cihaz senkronu FAIL-CLOSED 503 (nonce/replay koruması atlanamaz — kayıt kaybı YOK, cihaz kuyruğu korur, ${s.ms} ms'de yanıt = asılı kalmaz); liveness 200; readiness 503 (redis ok=false); login FAIL-CLOSED 503 (AUTH-209: hesap kilit sayacı okunamazken brute-force korumasız giriş açılmaz)`,
        s.status === 503 && s.ms < 10000 && s.d.queue.length === 3 && live.ok && rdy.status === 503 && redisDep?.ok === false && lg === 503, `sync=${s.status}/${s.ms}ms, live=${live.last}, ready=${rdy.status}, login=${lg}, redis=${JSON.stringify(redisDep)}`);
      sh('docker start yakittakip_redis'); await waitHealth('/health/ready', (st) => st === 200, 60000);
      const ok = await s.d.syncAll(3, 20); const after = (await rangeOf(s.from, s.to)).rows[0];
      results.push({ name: 'F1-redis-down', records: 3, durationMs: s.ms, attempts: s.d.metrics.attempts, failures: s.d.metrics.failures, ambiguousObserved: 0, dupSkipped: 0, exact: ok && after.n === 3, extra: { syncStatusDuringOutage: s.status, readiness: rdy.status } });
      check('F1b. Redis geri gelince aynı kuyruk sorunsuz senkronlanır (3/3), kayıp/mükerrer yok', ok && after.n === 3, `db=${after.n}`);
    }

    // F2 MQTT (EMQX)
    if (want('F')) {
      sh('docker stop yakittakip_emqx');
      const flip = await waitHealth('/health/ready', (st) => st === 503, 45000);
      const s = await probeSync('mqtt'); const after = (await rangeOf(s.from, s.to)).rows[0];
      const rdy = await readyBody(); const mq = rdy.body?.dependencies?.find((x: any) => /mqtt/i.test(x.name));
      check(`F2. MQTT (EMQX) çöktü: HTTP senkron yolu ETKİLENMEZ (200, 3/3 kabul); readiness ${flip.ok ? '503' : '?'} (mqtt ok=false, ${(flip.ms / 1000).toFixed(1)} sn'de fark edildi — uygulama kendi yeniden bağlanma döngüsünde), liveness 200`,
        s.status === 200 && after.n === 3 && flip.ok && mq?.ok === false && (await waitHealth('/health/live', (st) => st === 200, 5000)).ok, `sync=${s.status}, db=${after.n}, ready=${flip.last}, mqtt=${JSON.stringify(mq)}`);
      sh('docker start yakittakip_emqx');
      const back = await waitHealth('/health/ready', (st) => st === 200, 120000);
      results.push({ name: 'F2-mqtt-down', records: 3, durationMs: s.ms, attempts: 1, failures: 0, ambiguousObserved: 0, dupSkipped: 0, exact: s.status === 200 && after.n === 3, extra: { readinessFlipMs: flip.ms, reconnectMs: back.ms } });
      check(`F2b. EMQX dönünce backend MQTT'ye kendiliğinden yeniden bağlanır (üstel backoff): readiness ${(back.ms / 1000).toFixed(1)} sn içinde 200`, back.ok, `${back.last}`);
    }

    // F3 PostgreSQL
    if (want('F')) {
      sh('docker stop yakittakip_postgres'); await sleep(4000);
      const s = await probeSync('pg'); const live = await waitHealth('/health/live', (st) => st === 200, 5000); const rt0 = Date.now(); const rdy = await readyBody(); const rdyMs = Date.now() - rt0; const lg = await login();
      const pgDep = rdy.body?.dependencies?.find((x: any) => /postgres/i.test(x.name));
      check(`F3. PostgreSQL çöktü: senkron 503 DB_UNAVAILABLE (${s.status}; opak 500 DEĞİL, kalıcı yazım YOK, cihaz kuyruğu korur, ${s.ms} ms'de yanıt = asılı kalmaz); liveness 200 (süreç canlı — DB kesintisi konteyneri öldürmez); readiness ${rdy.status} ${rdyMs} ms'de (probe'u asmaz, postgres ok=false); login ${lg}`,
        s.status === 503 && s.ms < 12000 && s.d.queue.length === 3 && live.ok && rdy.status === 503 && rdyMs < 4500 && pgDep?.ok === false && (lg === 503 || lg === 401 || lg === 400), `sync=${s.status}/${s.ms}ms, live=${live.last}, ready=${rdy.status}, login=${lg}, pg=${JSON.stringify(pgDep)}`);
      sh('docker start yakittakip_postgres');
      const back = await waitHealth('/health/ready', (st) => st === 200, 120000);
      const ok = back.ok && await s.d.syncAll(3, 30, 8000); const after = (await rangeOf(s.from, s.to)).rows[0];
      results.push({ name: 'F3-postgres-down', records: 3, durationMs: s.ms, attempts: s.d.metrics.attempts, failures: s.d.metrics.failures, ambiguousObserved: 0, dupSkipped: 0, exact: ok && after.n === 3, extra: { syncStatusDuringOutage: s.status, recoveryMs: back.ms } });
      check(`F3b. PostgreSQL dönünce backend bağlantı havuzunu toparlar (readiness ${(back.ms / 1000).toFixed(1)} sn) ve kuyruk eksiksiz senkronlanır (3/3), mükerrer yok`, ok && after.n === 3, `db=${after.n}`);
    }
    await restoreAll();

    // ── G. Bütünlük ve rapor ─────────────────────────────────────────────────────────────────────────────────────────
    const dupes = (await db.query(`SELECT COUNT(*)::int AS n FROM (SELECT local_sequence_id FROM transactions WHERE device_id = $1 AND local_sequence_id > $2 GROUP BY local_sequence_id HAVING COUNT(*) > 1) x`, [DEVICE_ID, baseSeq])).rows[0].n;
    check('G. Tüm kaos koşusu sonunda: mükerrer (device_id, localSequenceId) yok; tüm senaryolar "exact"', dupes === 0 && results.every((r) => r.exact), `mükerrer=${dupes}, senaryolar=${results.map((r) => `${r.name}:${r.exact}`).join(' ')}`);
  } finally {
    try { await restoreAllSafe(); } catch { /* en iyi çaba */ }
    proxy.stop();
    await db.query('DELETE FROM transactions WHERE device_id = $1 AND local_sequence_id > $2', [DEVICE_ID, baseSeq]);
    await db.query(`UPDATE tanks SET current_level_liters = $1, status = 'GÜVENLİ' WHERE id = $2`, [levelBefore, TANK_ID]);
  }

  if (REPORT) writeReport(results, passed === total);
  console.log('===========================================================');
  console.log(`📊 SONUÇ: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

async function restoreAllSafe(): Promise<void> {
  for (const c of ['yakittakip_postgres', 'yakittakip_redis', 'yakittakip_emqx', sh('docker compose ps -aq backend').split('\n')[0]]) if (c) sh(`docker start ${c}`);
}

function writeReport(rs: ScenarioResult[], ok: boolean): void {
  const dir = path.join(ROOT, 'docs', 'chaos-reports');
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const prevFile = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f < `${date}.json`).sort().pop();
  const prev: ScenarioResult[] | null = prevFile ? JSON.parse(fs.readFileSync(path.join(dir, prevFile), 'utf8')).scenarios : null;
  const version = sh('curl -s localhost:3000/api/v1/health').match(/"version":"([^"]*)"/)?.[1] ?? 'bilinmiyor';
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify({ date, version, ok, scenarios: rs }, null, 2));
  const cmp = (r: ScenarioResult) => { const p = prev?.find((x) => x.name === r.name); return p ? `${(r.durationMs / Math.max(p.durationMs, 1)).toFixed(2)}×` : 'ilk'; };
  const rows = rs.map((r) => `| ${r.name} | ${r.records} | ${(r.durationMs / 1000).toFixed(1)} sn | ${r.attempts} | ${r.failures} | ${r.ambiguousObserved} | ${r.dupSkipped} | ${r.exact ? 'EVET' : '**HAYIR**'} | ${cmp(r)} |`).join('\n');
  fs.writeFileSync(path.join(dir, `${date}.md`), `# Kaos Testi Raporu — ${date}\n\n**Sonuç: ${ok ? 'BAŞARILI' : 'BAŞARISIZ'}** · Backend sürümü: \`${version}\` · Betik: \`backend/test/test_test1007_chaos.ts\` (tohum 20260921)\n\n| Senaryo | Kayıt | Süre | Deneme | Hata | Belirsiz (işlendi/yanıt yok) | DUPLICATE_SKIPPED | Eksiksiz+mükerrersiz | Önceki koşuya süre oranı |\n|---|---|---|---|---|---|---|---|---|\n${rows}\n\nÖnceki rapor: ${prevFile ?? 'yok (ilk koşu)'}. "Eksiksiz+mükerrersiz" = DB kayıt sayısı, benzersiz (device_id, localSequenceId), toplam litre ve tank Δ beklenenle birebir.\n\nAyrıntılar ve kabul kriterleri: [../CHAOS_TESTING.md](../CHAOS_TESTING.md)\n`);
  console.log(`Rapor yazıldı: docs/chaos-reports/${date}.md (+ .json)`);
}

run().catch(async (e) => { console.error(e); await restoreAllSafe(); process.exit(1); });
