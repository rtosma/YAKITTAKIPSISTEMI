import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';

/**
 * TEST-1004 — 3 panelin kritik akış testleri için ortak destek.
 *
 * İLKELER (ticket "Teknik Notlar"):
 *  - SEÇİCİ = yalnızca `data-testid` (metin/rol-adı/CSS seçici YOK; scripts/test-test1004.mjs bunu her CI koşusunda denetler).
 *  - DETERMİNİSTİK: sabit süreli uyku YOK. Her bekleme bir KOŞULA bağlı (yanıt, öznitelik, poll). Mutasyonlar
 *    `Promise.all([waitForResponse, click])` ile beklenir. Canlı olaylar RASTGELE zamanlanmaz: sentetik olay ENJEKSİYONU
 *    (cihaz olarak HMAC imzalı ikmal döngüsü + MQTT presence) yapılır ve tarayıcının WebSocket'i bağlanana dek beklenir (`html[data-socket=connected]`).
 *  - İZOLE: her test kendi taze firmasını API ile kurar (rastgele son ek); tohum firmalarına dokunulmaz.
 *  - Kurulum (firma/tank/sürücü…) API ile; ASIL akış UI ile — testin konusu kurulum değil, kullanıcının yapacağı iş.
 */
export const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
export const API = `${BASE}/api/v1`;
export const PASSWORD = '123456';
export const NEW_PASSWORD = 'E2eYeni#2026';

let counter = 0;
/** Koşuya özgü kısa benzersiz son ek (yalnızca ad üretiminde; iddia değerlerinde kullanılmaz). */
export const uniq = (): string => `${Date.now().toString(36)}${(++counter).toString(36)}${crypto.randomBytes(2).toString('hex')}`;

// ── Altyapı erişimi (orkestratör/CI: E2E_* ortam değişkenleri; yerelde compose kapları) ─────────────
const REDIS_CONTAINER = process.env.E2E_REDIS_CONTAINER || 'yakittakip_redis';
const BACKEND_CONTAINER = process.env.E2E_BACKEND_CONTAINER || '';

/** Login rate limit (IP başına 10/15 dk) tüm testler aynı IP'den geldiği için sıfırlanır (TEST_PLAN §0.3). */
export function resetLoginRateLimit(): void {
  try {
    execFileSync('docker', ['exec', REDIS_CONTAINER, 'sh', '-c', "redis-cli --scan --pattern 'rl:auth-login:*' | xargs -r redis-cli DEL"], { stdio: 'ignore' });
  } catch {
    /* docker/redis erişilemiyorsa test yine de dener */
  }
}

/** MQTT'ye cihaz gibi yayın: backend konteynerinin kendi mqtt paketi + kimliği (deterministik presence/telemetri enjeksiyonu). */
export function publishMqtt(topic: string, payload: string): void {
  if (!BACKEND_CONTAINER) throw new Error('E2E_BACKEND_CONTAINER tanımlı değil (orkestratör verir: node scripts/e2e/run-e2e.mjs --browser).');
  execFileSync('docker', ['exec', '-e', `E2E_TOPIC=${topic}`, '-e', `E2E_PAYLOAD=${payload}`, BACKEND_CONTAINER, 'node', '-e',
    "const m=require('mqtt');const c=m.connect(process.env.MQTT_URL,{username:process.env.MQTT_USERNAME,password:process.env.MQTT_PASSWORD,protocolVersion:5});" +
    "c.on('connect',()=>c.publish(process.env.E2E_TOPIC,process.env.E2E_PAYLOAD,{qos:1},()=>c.end(false,()=>process.exit(0))));c.on('error',()=>process.exit(2));"],
  { stdio: 'pipe', timeout: 20_000 });
}

// ── API yardımcıları ────────────────────────────────────────────────────────────────────────────────
export async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function login(username: string, password = PASSWORD): Promise<string> {
  resetLoginRateLimit();
  const r = await api('POST', '/auth/login', { body: { username, password } });
  if (!r.body.accessToken) throw new Error(`'${username}' girişi başarısız: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

const slugify = (name: string): string => name.toLowerCase().replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u').replace(/[^a-z0-9]+/g, '').slice(0, 32) || 'firma';

export interface Tenant { id: string; name: string; ownerUsername: string; ownerToken: string }
/** Taze firma (KURUMSAL paket: tüm modüller açık) + sahibi; parola varsayılan 123456. */
export async function createTenant(label: string): Promise<Tenant> {
  const name = `E2E ${label} ${uniq()}`;
  const admin = await login('admin');
  const r = await api('POST', '/companies', { token: admin, body: { name, city: 'Kocaeli', taxNumber: '1234567890', package: 'KURUMSAL' } });
  if (r.status !== 200) throw new Error(`firma oluşturulamadı: ${r.status} ${JSON.stringify(r.body)}`);
  const ownerUsername = slugify(name);
  return { id: r.body.data.id, name, ownerUsername, ownerToken: await login(ownerUsername) };
}

export async function provisionSite(t: Tenant, siteName: string): Promise<{ managerUsername: string; temporaryPassword: string }> {
  const r = await api('POST', '/sites', { token: t.ownerToken, body: { siteName } });
  if (r.status !== 200) throw new Error(`şantiye oluşturulamadı: ${r.status} ${JSON.stringify(r.body)}`);
  return { managerUsername: r.body.data.manager.username, temporaryPassword: r.body.data.manager.temporaryPassword };
}

/** Geçici parolayı API ile değiştirir (kimlik akışı testi dışındaki testler doğrudan panele girebilsin). */
export async function activateManager(username: string, temporaryPassword: string, newPassword = NEW_PASSWORD): Promise<void> {
  const token = await login(username, temporaryPassword);
  const r = await api('POST', '/auth/change-password', { token, body: { currentPassword: temporaryPassword, newPassword } });
  if (r.status !== 200) throw new Error(`parola değişmedi: ${r.status} ${JSON.stringify(r.body)}`);
}

// TCKN sağlama algoritmasından geçen sabit değer (backend driverSchema doğrular).
export const VALID_TCKN = '10000000146';

export interface FuelFixture { site: string; tank: string; plate: string; driver: string; card: string; deviceId: string; deviceSecret: string }
/** Şantiyede 10000 L'lik tank + sürücü (RFID kartlı) + ona atanmış araç + pompa cihazı — hepsi API ile. */
export async function seedFuel(t: Tenant, site: string): Promise<FuelFixture> {
  const tag = uniq();
  const f = { site, tank: `E2E Tank ${tag}`, plate: '34 KHS 07', driver: `E2E Sürücü ${tag}`, card: `CARD-${tag}`, deviceId: `E2E-PUMP-${tag}`.toUpperCase() };
  const must = (r: { status: number; body: any }, what: string) => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };
  must(await api('POST', '/tanks', { token: t.ownerToken, body: { name: f.tank, capacityLiters: 20000, currentLevelLiters: 10000, fuelType: 'Motorin (Euro Diesel)', siteName: site } }), 'tank');
  must(await api('POST', '/drivers', { token: t.ownerToken, body: { name: f.driver, tcNo: VALID_TCKN, phone: '0532 000 00 00', licenseType: 'CE', rfidCardId: f.card, siteName: site, status: 'SAHADA' } }), 'sürücü');
  must(await api('POST', '/vehicles', { token: t.ownerToken, body: { plate: f.plate, brandModel: 'E2E Kamyon', type: 'Kamyon', rfidTag: `TAG-${tag}`, fuelCapacityLiters: 400, siteName: site, assignedDriver: f.driver } }), 'araç');
  const dev = must(await api('POST', '/hardware-devices', { token: t.ownerToken, body: { deviceId: f.deviceId, name: 'E2E Pompa', siteName: site } }), 'cihaz');
  return { ...f, deviceSecret: dev.body.data.secret };
}

/** Cihaz gibi HMAC imzalı istek (docs/HARDWARE_INTEGRATION_GUIDE.md §2). */
async function deviceCall(f: FuelFixture, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(body);
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', f.deviceSecret).update(`${ts}.${nonce}.${raw}`).digest('hex');
  const res = await fetch(`${API}${path}`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Device-ID': f.deviceId, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Hardware-Signature': sig } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** SENTETİK OLAY ENJEKSİYONU: kart okut → pompalama → bitir. Sunucu `dispense:completed` yayınlar (açık paneller canlı güncellenir). */
export async function injectDispense(f: FuelFixture, liters: number): Promise<{ transactionId: string }> {
  const auth = await deviceCall(f, '/dispense/request-auth', { rfidCardId: f.card, tankName: f.tank });
  if (auth.status !== 200) throw new Error(`request-auth: ${auth.status} ${JSON.stringify(auth.body)}`);
  const sessionId = auth.body.data.sessionId;
  await deviceCall(f, '/dispense/heartbeat', { sessionId, totalizerLiters: 5000, flowRateLpm: 24 });
  await deviceCall(f, '/dispense/heartbeat', { sessionId, totalizerLiters: 5000 + liters, flowRateLpm: 24 });
  const fin = await deviceCall(f, '/dispense/finalize', { sessionId, endTotalizerLiters: 5000 + liters, reportedLiters: liters, idempotencyKey: `e2e-${uniq()}` });
  if (fin.status !== 200) throw new Error(`finalize: ${fin.status} ${JSON.stringify(fin.body)}`);
  return { transactionId: fin.body.data.id };
}

// ── UI yardımcıları (yalnızca data-testid) ────────────────────────────────────────────────────────
export async function uiLogin(page: Page, kind: 'company' | 'site', username: string, password = PASSWORD, expectUrl: RegExp | null = /\/(panel|admin|santiye-panel)/): Promise<void> {
  resetLoginRateLimit();
  await page.goto(kind === 'company' ? '/' : '/santiye-login');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  if (expectUrl) await page.waitForURL(expectUrl);
}

/** Tarayıcının canlı bağlantısı (WebSocket) gerçekten kurulana dek bekler — enjekte edilen olay kaçmasın. */
export async function waitForLiveConnection(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-socket', 'connected');
}
