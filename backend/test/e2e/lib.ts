import crypto from 'crypto';
import mqtt, { MqttClient } from 'mqtt';
import { io as socketIoClient, Socket } from 'socket.io-client';
import { Client } from 'pg';
import Redis from 'ioredis';
import { resetLoginRateLimit } from '../helpers/loginRateLimit';

/**
 * TEST-1001 — uçtan uca (E2E) ikmal döngüsü testlerinin ortak kütüphanesi.
 *
 * İZOLASYON KURALI (ticket: "paylaşılan container'da tenant bazlı izolasyon"): her test KENDİ taze tenant'ını yaratır
 * (`createTenant`) ve YALNIZ ona dokunur — tohum firmalarına (comp-camsa vb.) hiç dokunulmaz, sıra numarası/plaka/kart/cihaz kimlikleri
 * koşuya özgü rastgele son ek taşır. Böylece dosyalar aynı backend/Postgres/Redis/EMQX üzerinde PARALEL çalışabilir
 * (bkz. scripts/e2e/run-e2e.mjs) ve birbirinin verisini görmez/bozmaz.
 *
 * Bağlantı adresleri ortamdan gelir (orkestratör verir); varsayılanlar CI'daki tek-host düzenidir.
 */
export const ENV = {
  api: process.env.E2E_API_URL || 'http://localhost:5000/api/v1',
  origin: (process.env.E2E_API_URL || 'http://localhost:5000/api/v1').replace(/\/api\/v1\/?$/, ''),
  mqtt: process.env.E2E_MQTT_URL || 'mqtt://localhost:1883',
  mqttUser: process.env.MQTT_USERNAME || '',
  mqttPass: process.env.MQTT_PASSWORD || ''
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const rnd = (n = 6): string => crypto.randomBytes(8).toString('hex').slice(0, n);

// ── Raporlama ───────────────────────────────────────────────────────────────
export class Reporter {
  passed = 0;
  total = 0;
  private t0 = Date.now();
  constructor(private title: string) {
    console.log('===========================================================');
    console.log(this.title);
    console.log('===========================================================\n');
  }
  check(name: string, ok: boolean, detail: string): void {
    this.total++;
    if (ok) this.passed++;
    console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
  }
  /** Çıkış kodu: hepsi geçtiyse 0. Süre orkestratörün zaman bütçesi raporu için yazılır. */
  finish(minChecks: number): never {
    const secs = ((Date.now() - this.t0) / 1000).toFixed(1);
    console.log(`\nSONUÇ: ${this.passed}/${this.total} test geçti. (${secs} sn)`);
    process.exit(this.passed === this.total && this.total >= minChecks ? 0 : 1);
  }
}

// ── DB / Redis ────────────────────────────────────────────────────────────────
export async function q(sql: string, params: unknown[] = []): Promise<any[]> {
  const c = new Client({
    host: process.env.POSTGRES_HOST || 'localhost', port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres', password: process.env.POSTGRES_PASSWORD || 'postgres', database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
export function redis(): Redis {
  return new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
export async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${ENV.api}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
export async function login(username: string): Promise<string> {
  await resetLoginRateLimit(); // TEST_PLAN §0.3: paralel dosyalar aynı IP'den giriş yapar → sayaç birikmesin
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`'${username}' girişi başarısız: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

/** Cihazın (firmware'in) HMAC imzalı isteği — docs/HARDWARE_INTEGRATION_GUIDE.md §2 ile aynı imza dizesi. */
export async function deviceCall(deviceId: string, secret: string, path: string, body: unknown, method = 'POST'): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(body);
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${nonce}.${raw}`).digest('hex');
  const res = await fetch(`${ENV.api}${path}`, {
    method, body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': deviceId, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Hardware-Signature': sig }
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ── Taze tenant ───────────────────────────────────────────────────────────────
/** Geçerli VKN üretir (GİB algoritması): ilk 9 hane + kontrol hanesi. */
export function makeVkn(first9: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const d = Number(first9[i]);
    const tmp = (d + (9 - i)) % 10;
    let v = (tmp * 2 ** (9 - i)) % 9;
    if (tmp !== 0 && v === 0) v = 9;
    sum += v;
  }
  return first9 + String((10 - (sum % 10)) % 10);
}

export interface E2ETenant {
  tag: string;
  tenantId: string;
  ownerUser: string;
  ownerToken: string;
  siteA: string; siteB: string;
  tankName: string; tankId: string; tankStart: number;
  plate: string; driverName: string; card: string;
  pump: { id: string; secret: string };
  tankSensorA: { id: string };
  tankSensorB: { id: string };
}

export async function createTenant(label: string, opts: { plate: string; tankStart?: number }): Promise<E2ETenant> {
  const tag = `${label}${rnd(6)}`;
  const tenantId = `e2e-${tag}`;
  const ownerUser = `e2e-owner-${tag}`;
  const siteA = `E2E Şantiye A ${tag}`;
  const siteB = `E2E Şantiye B ${tag}`;
  const tankName = `E2E Tank ${tag}`;
  const tankId = `tank-${tag}`;
  const tankStart = opts.tankStart ?? 10000;
  const driverName = `E2E Sürücü ${tag}`;
  const card = `CARD-${tag}`;
  const vkn = makeVkn(String(Math.floor(100000000 + Math.random() * 899999999)));

  await q(`INSERT INTO companies (id, name, tax_number, code, city, license_status, license_expiry, package) VALUES ($1,$2,$3,$4,'Kocaeli / Gebze','AKTİF','2099-12-31','KURUMSAL')`,
    [tenantId, `E2E Firma ${tag}`, vkn, `E2E-${tag}`.slice(0, 32)]);
  await q(`INSERT INTO users (id, tenant_id, username, password_hash, role, site_name) SELECT $1, $2, $3, password_hash, 'COMPANY_OWNER', NULL FROM users WHERE username = 'camsa'`, [`usr-${tag}`, tenantId, ownerUser]);
  for (const [i, s] of [siteA, siteB].entries()) await q(`INSERT INTO sites (id, tenant_id, name, location) VALUES ($1,$2,$3,'E2E')`, [`site-${tag}-${i}`, tenantId, s]);
  await q(`INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name, status) VALUES ($1,$2,$3,20000,$4,'Motorin (Euro Diesel)',$5,'GÜVENLİ')`, [tankId, tenantId, tankName, tankStart, siteA]);
  await q(`INSERT INTO drivers (id, tenant_id, name, tc_no, phone, license_type, rfid_card_id, site_name, status) VALUES ($1,$2,$3,'10000000146','0500 000 00 00','CE',$4,$5,'SAHADA')`, [`drv-${tag}`, tenantId, driverName, card, siteA]);
  await q(`INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status, assigned_driver_name) VALUES ($1,$2,$3,'E2E Kamyon','Kamyon',$4,$5,'AKTİF',$6)`, [`veh-${tag}`, tenantId, opts.plate, `TAG-${tag}`, siteA, driverName]);

  const ownerToken = await login(ownerUser);
  const reg = async (id: string, name: string, site: string) => {
    const r = await call('POST', '/hardware-devices', { token: ownerToken, body: { deviceId: id, name, siteName: site } });
    if (r.status !== 200 || !r.body.data?.secret) throw new Error(`cihaz kaydı başarısız (${id}): ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data.secret as string;
  };
  const pumpId = `E2E-PUMP-${tag}`;
  const pumpSecret = await reg(pumpId, 'E2E Pompa', siteA);
  const tankAId = `E2E-TANKSENSOR-A-${tag}`;
  const tankBId = `E2E-TANKSENSOR-B-${tag}`;
  await reg(tankAId, 'E2E Tank Sensörü A', siteA);
  await reg(tankBId, 'E2E Tank Sensörü B', siteB);

  return { tag, tenantId, ownerUser, ownerToken, siteA, siteB, tankName, tankId, tankStart, plate: opts.plate, driverName, card, pump: { id: pumpId, secret: pumpSecret }, tankSensorA: { id: tankAId }, tankSensorB: { id: tankBId } };
}

// ── Sentetik istemciler ─────────────────────────────────────────────────────────
export interface WsEvent { name: string; payload: any; at: number }
export class WsObserver {
  events: WsEvent[] = [];
  private socket!: Socket;
  static async open(token: string): Promise<WsObserver> {
    const o = new WsObserver();
    o.socket = socketIoClient(ENV.origin, { path: '/socket.io', auth: { token }, transports: ['websocket'] });
    await new Promise<void>((resolve, reject) => { o.socket.on('connect', () => resolve()); o.socket.on('connect_error', reject); });
    o.socket.onAny((name: string, payload: any) => o.events.push({ name, payload, at: Date.now() }));
    return o;
  }
  find(name: string, pred: (p: any) => boolean = () => true): WsEvent | undefined { return this.events.find((e) => e.name === name && pred(e.payload)); }
  all(name: string, pred: (p: any) => boolean = () => true): WsEvent[] { return this.events.filter((e) => e.name === name && pred(e.payload)); }
  async waitFor(name: string, pred: (p: any) => boolean, ms = 8000): Promise<WsEvent | undefined> {
    const end = Date.now() + ms;
    while (Date.now() < end) { const e = this.find(name, pred); if (e) return e; await sleep(100); }
    return undefined;
  }
  close(): void { this.socket.disconnect(); }
}

export async function openMqtt(): Promise<MqttClient> {
  const c = mqtt.connect(ENV.mqtt, { username: ENV.mqttUser, password: ENV.mqttPass, protocolVersion: 5 });
  await new Promise<void>((resolve, reject) => { c.on('connect', () => resolve()); c.on('error', reject); });
  return c;
}
export const topic = (t: E2ETenant, site: string, type: string, deviceId: string, leaf: 'data' | 'status'): string => `telemetry/v1/${t.tenantId}/${site}/${type}/${deviceId}/${leaf}`;
export const publish = (c: MqttClient, tp: string, payload: unknown): Promise<void> =>
  new Promise((resolve, reject) => c.publish(tp, typeof payload === 'string' ? payload : JSON.stringify(payload), { qos: 1 }, (e) => (e ? reject(e) : resolve())));

// ── İkmal döngüsü (yetki → akış → sonlandırma) ────────────────────────────────────
export interface CycleResult {
  auth: { status: number; body: any };
  hbStart: { status: number; body: any };
  hbEnd: { status: number; body: any };
  fin: { status: number; body: any };
  key: string;
}
export async function dispenseCycle(t: E2ETenant, liters: number, hooks: { duringPumping?: () => Promise<void> } = {}): Promise<CycleResult> {
  const start = 5000;
  const auth = await deviceCall(t.pump.id, t.pump.secret, '/dispense/request-auth', { rfidCardId: t.card, tankName: t.tankName });
  const sid = auth.body?.data?.sessionId;
  const hbStart = await deviceCall(t.pump.id, t.pump.secret, '/dispense/heartbeat', { sessionId: sid, totalizerLiters: start, flowRateLpm: 24 });
  if (hooks.duringPumping) await hooks.duringPumping();
  const hbEnd = await deviceCall(t.pump.id, t.pump.secret, '/dispense/heartbeat', { sessionId: sid, totalizerLiters: start + liters, flowRateLpm: 24 });
  const key = `e2e-${t.tag}-${Date.now()}`;
  const fin = await deviceCall(t.pump.id, t.pump.secret, '/dispense/finalize', { sessionId: sid, endTotalizerLiters: start + liters, reportedLiters: liters, idempotencyKey: key });
  return { auth, hbStart, hbEnd, fin, key };
}

/**
 * "Yayınladım → tüketici işledi" senkronu. Hırsızlık motoru örnekleri İŞLENME anında damgalar (cihaz saatini değil); ilk MQTT mesajı
 * (doğrulama worker'ı ısınması, DB cihaz araması) sonrakinden geç işlenebilir. E2E test, sırayı `sleep` ile ŞANSA bırakmak yerine tüketicinin
 * Redis'e yazdığını GÖZLEMLEYEREK ilerler (gerçek bağımlılıkla senkron — sahte zamanlama yok).
 */
export async function waitForSamples(rd: Redis, key: string, atLeast: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await rd.zcard(key)) >= atLeast) return true; await sleep(50); }
  return false;
}
export const tankKey = (t: E2ETenant, site: string, deviceId: string): string => `theft:tank:${t.tenantId}:${site}:${deviceId}`;
export const pumpKey = (t: E2ETenant, site: string): string => `theft:pumpflow:${t.tenantId}:${site}`;

export async function cleanupTenant(t: E2ETenant | undefined): Promise<void> {
  if (!t) return;
  // companies ON DELETE CASCADE tenant'a bağlı her tabloyu temizler (kalıcı/append-only tablolar dahil değil: audit_logs izlenebilirlik için
  // tenant satırıyla birlikte cascade ile gider) — tenant'a özgü veri başka teste ait olmadığından güvenlidir.
  await q(`DELETE FROM companies WHERE id = $1`, [t.tenantId]).catch(() => undefined);
}
