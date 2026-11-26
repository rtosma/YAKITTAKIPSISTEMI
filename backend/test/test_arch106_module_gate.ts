/**
 * ARCH-106 — tenant bazlı modül kapısı (entegrasyon, canlı backend).
 *
 *  1-6. TEMEL paketli yeni firma (eInvoice/aiAnomaly/smartWarehouse/maintenanceTrack/crossSiteAuth KAPALI,
 *       driverScore AÇIK): her kapalı modülün temsilci ucu 403 MODULE_DISABLED (+ hangi modül olduğu);
 *       açık modül ve çekirdek uçlar (araç/tank/ikmal geçmişi) 200.
 *  7.   AC: modül panelden açılınca BİR SONRAKİ istekte etkili (önbellek yok → 60 sn şartını fazlasıyla karşılar).
 *  8.   AC: modül değişikliği audit_logs'ta kim/ne zaman/ne ile görünür.
 *  9.   Çapraz şantiye: yetki tanımı API'si kapalıyken manuel ikmal yolu da (POST /dispense) MODULE_DISABLED
 *       ile reddeder — mevcut izinlerle cihaz/manuel yoldan sızma olmasın.
 *  10.  Tekrarlı işler: getAllTenantIdsWithModuleEnabled kapalı firmayı listelemez (süpürücüler atlar).
 *  11.  SUPER_ADMIN (platform operatörü) kapıya takılmaz.
 *
 * Test firmaları sonda SİLİNİR.
 */
import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { getAllTenantIdsWithModuleEnabled } from '../src/db/adminDb';
import { pool } from '../src/db/postgresPool';

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const NEW_PASSWORD = 'Arch106Kalici!2026';

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function q(sql: string, params: unknown[] = []): Promise<any[]> {
  const c = pg(); await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRateLimit();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const body = (res.headers.get('content-type') || '').includes('application/json') ? await res.json().catch(() => ({})) : {};
  return { status: res.status, body };
}
async function login(username: string, password = '123456'): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username, password } });
  if (!r.body.accessToken) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}
function uniqueVkn(): string {
  const s = String(100_000_000 + Math.floor(Math.random() * 900_000_000));
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const c1 = (Number(s[i]) + (9 - i)) % 10;
    let c2 = (c1 * 2 ** (9 - i)) % 9;
    if (c1 !== 0 && c2 === 0) c2 = 9;
    sum += c2;
  }
  return s + String((10 - (sum % 10)) % 10);
}
/** Firma + kalıcı parolalı sahip (ARCH-105: ilk parola rastgele ve tek seferlik). */
async function createTenant(admin: string, label: string, pkg: 'TEMEL' | 'KURUMSAL'): Promise<{ id: string; owner: string }> {
  const r = await call('POST', '/companies', { token: admin, body: { name: `arch106${label}${RUN}`, city: 'Kocaeli', taxNumber: uniqueVkn(), package: pkg } });
  if (r.status !== 200) throw new Error(`firma oluşturulamadı: ${r.status} ${JSON.stringify(r.body)}`);
  const { id, ownerUsername, temporaryPassword } = r.body.data;
  const temp = await login(ownerUsername, temporaryPassword);
  const ch = await call('POST', '/auth/change-password', { token: temp, body: { currentPassword: temporaryPassword, newPassword: NEW_PASSWORD } });
  if (ch.status !== 200) throw new Error(`parola değişmedi: ${ch.status} ${JSON.stringify(ch.body)}`);
  return { id, owner: await login(ownerUsername, NEW_PASSWORD) };
}

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total++;
  if (ok) { passed++; console.log(`✅ [PASS] ${name}\n   ${detail}\n`); } else console.error(`❌ [FAIL] ${name}\n   ${detail}\n`);
}

async function run(): Promise<void> {
  console.log('===========================================================');
  console.log('🧩 [ARCH-106] TENANT BAZLI MODÜL KAPISI');
  console.log('===========================================================\n');
  const tenants: string[] = [];
  try {
    const admin = await login('admin');
    const temel = await createTenant(admin, 't', 'TEMEL');
    tenants.push(temel.id);

    // ── 1-5: kapalı modüllerin temsilci uçları ──────────────────────────────
    const gated: Array<[string, string]> = [
      ['eInvoice', '/despatch-advice-transmissions'],
      ['aiAnomaly', '/anomaly-flags'],
      ['smartWarehouse', '/inventory-items'],
      ['maintenanceTrack', '/fleet/maintenance/upcoming'],
      ['crossSiteAuth', '/cross-site-permissions']
    ];
    for (const [module, path] of gated) {
      const r = await call('GET', path, { token: temel.owner });
      check(`${module} kapalı (TEMEL): GET ${path} → 403 MODULE_DISABLED`,
        r.status === 403 && r.body.error === 'MODULE_DISABLED' && r.body.module === module && /modülü firmanız için etkin değil/.test(r.body.message),
        `status=${r.status} error=${r.body.error} module=${r.body.module}`);
    }

    // ── 6: açık modül + çekirdek uçlar ─────────────────────────────────────
    const open = await Promise.all(['/drivers/behavior-scores', '/vehicles', '/tanks', '/transactions'].map((p) => call('GET', p, { token: temel.owner })));
    check('driverScore AÇIK (TEMEL) ve çekirdek uçlar (araç/tank/ikmal) kapıya takılmaz → 200',
      open.every((r) => r.status === 200), `durumlar=${open.map((r) => r.status).join(',')}`);

    // ── 7: modülü aç → bir sonraki istekte etkili ──────────────────────────
    const enable = await call('PATCH', `/companies/${temel.id}`, { token: admin, body: { modules: { eInvoice: true } } });
    const afterEnable = await call('GET', '/despatch-advice-transmissions', { token: temel.owner });
    check('AC: eInvoice panelden açılınca BİR SONRAKİ istekte erişim gelir (önbellek gecikmesi yok)',
      enable.status === 200 && afterEnable.status === 200, `açma=${enable.status}, sonraki istek=${afterEnable.status}`);
    const disable = await call('PATCH', `/companies/${temel.id}`, { token: admin, body: { modules: { eInvoice: false } } });
    const afterDisable = await call('GET', '/despatch-advice-transmissions', { token: temel.owner });
    check('Kapatma da anında: eInvoice tekrar kapatılınca 403 MODULE_DISABLED',
      disable.status === 200 && afterDisable.status === 403 && afterDisable.body.error === 'MODULE_DISABLED', `kapama=${disable.status}, sonraki=${afterDisable.status}`);

    // ── 8: audit ────────────────────────────────────────────────────────────
    const audit = await q(
      `SELECT user_id, action, after_value->'modules'->>'eInvoice' AS e, created_at FROM audit_logs
        WHERE tenant_id = $1 AND action = 'COMPANY_ADMIN_UPDATE' ORDER BY created_at`, [temel.id]);
    check('AC: modül değişiklikleri audit_logs\'ta kim/ne zaman/ne ile görünür (aç + kapa = 2 kayıt)',
      audit.length >= 2 && audit.every((a) => !!a.user_id && !!a.created_at) && audit[audit.length - 2].e === 'true' && audit[audit.length - 1].e === 'false',
      `kayıt=${audit.length}, son ikisi eInvoice=${audit.slice(-2).map((a) => a.e).join('→')}, aktör=${audit[0]?.user_id}`);

    // ── 9: çapraz şantiye — ikmal yolu da kapalı ───────────────────────────
    const kur = await createTenant(admin, 'k', 'KURUMSAL');
    tenants.push(kur.id);
    const siteA = `A6 Ana ${RUN}`;
    const siteB = `A6 Ortak ${RUN}`;
    for (const s of [siteA, siteB]) {
      const r = await call('POST', '/sites', { token: kur.owner, body: { siteName: s, location: 'Test' } });
      if (r.status !== 200) throw new Error(`şantiye: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const plate = '34 ARC 106';
    const veh = await call('POST', '/vehicles', { token: kur.owner, body: { plate, brandModel: 'Test Kamyon', type: 'Kamyon', rfidTag: `TAG-A106-${RUN}`, fuelCapacityLiters: 300, siteName: siteA } });
    if (veh.status !== 200) throw new Error(`araç: ${veh.status} ${JSON.stringify(veh.body)}`);
    await call('PATCH', `/companies/${kur.id}`, { token: admin, body: { modules: { crossSiteAuth: false } } });
    const cross = await call('POST', '/dispense', { token: kur.owner, body: { siteName: siteB, vehiclePlate: plate, amountLiters: 20 } });
    check('crossSiteAuth kapalıyken başka şantiyeden manuel ikmal (POST /dispense) → 403 MODULE_DISABLED (NO_SITE_PERMISSION değil)',
      cross.status === 403 && (cross.body.error === 'MODULE_DISABLED' || cross.body.details?.error === 'MODULE_DISABLED') && /Çapraz Şantiye İkmal Yetkisi/.test(cross.body.message || ''),
      `status=${cross.status} body=${JSON.stringify(cross.body).slice(0, 220)}`);

    // ── 10: tekrarlı işler ─────────────────────────────────────────────────
    const [withE, withD] = await Promise.all([getAllTenantIdsWithModuleEnabled('eInvoice'), getAllTenantIdsWithModuleEnabled('driverScore')]);
    check('Tekrarlı işler: eInvoice süpürücüsünün tenant listesinde TEMEL firma YOK, driverScore listesinde VAR',
      !withE.includes(temel.id) && withD.includes(temel.id) && withE.includes(kur.id), `eInvoice'ta=${withE.includes(temel.id)}, driverScore'da=${withD.includes(temel.id)}`);

    // ── 11: SUPER_ADMIN ────────────────────────────────────────────────────
    const asAdmin = await call('GET', '/despatch-advice-transmissions', { token: admin });
    check('SUPER_ADMIN platform operatörü kapıya takılmaz', asAdmin.status !== 403 || asAdmin.body.error !== 'MODULE_DISABLED', `status=${asAdmin.status} error=${asAdmin.body.error ?? '-'}`);
  } finally {
    for (const id of tenants) {
      await q('DELETE FROM companies WHERE id = $1', [id]).catch((e) => console.error('temizlik:', e.message));
    }
    await pool.end().catch(() => undefined);
  }
  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥 Beklenmeyen hata:', err); process.exit(1); });
