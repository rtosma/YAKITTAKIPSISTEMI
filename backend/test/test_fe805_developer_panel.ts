import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FE-805 (#81) — Geliştirici Paneli: firma listesi, tenant detayı ve modül aç/kapa.
 *
 * Kapsam notu: FE-805 esas olarak bir FRONTEND biletidir (TenantsPage.tsx /
 * TenantDetailModal.tsx zaten büyük ölçüde mevcuttu — modül aç/kapa ARCH-106,
 * tenant dondurma/aktifleştirme, şantiye listesi). Araştırmada 3 somut GERÇEK
 * eksik bulundu:
 *  1. "Firma listesi ... son aktivite" (AC) — backend hiç bu alanı döndürmüyordu.
 *     Bu test SADECE bu backend eklentisini (GET /companies'teki lastActivityAt)
 *     doğrular — geri kalanı (tek seferlik parola gösterimi, onay diyalogları,
 *     hızlı arama) saf frontend state/UI değişiklikleri, Playwright'ta kapsanır.
 *  2. Tek seferlik parola gösterimi zaten ARCH-105 testinde (Test 7,
 *     BILL-1701 Test 3b/3c) API sözleşmesi düzeyinde doğrulanıyor — burada
 *     TEKRARLANMAZ.
 *  3. Modül kapatma / tenant dondurma onay diyalogları ve hızlı arama: saf
 *     istemci tarafı state — backend sözleşmesi değişmedi, bu dosyada test
 *     edilecek bir API yok.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
async function resetLoginRl(): Promise<void> {
  const k = await redis.keys('rl:auth-login:*'); if (k.length) await redis.del(...k);
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json().catch(() => ({})) : {};
  return { status: res.status, body };
}
async function login(username: string, password = '123456'): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username, password } });
  if (!r.body.accessToken) throw new Error(`login ${username}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

const createdCompanyIds: string[] = [];
async function cleanup(): Promise<void> {
  if (createdCompanyIds.length === 0) return;
  await q('DELETE FROM companies WHERE id = ANY($1::text[])', [createdCompanyIds]).catch(() => {});
}

async function run() {
  console.log('===========================================================');
  console.log('🖥️  [FE-805] GELİŞTİRİCİ PANELİ — FİRMA LİSTESİ SON AKTİVİTE');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  try {
    const adminToken = await login('admin');

    // === Ön koşul: taze bir firma oluştur (henüz hiç ikmali yok) ===
    const create = await call('POST', '/companies', { token: adminToken, body: { name: `Fe805-${RUN}` } });
    const companyId = create.body?.data?.id;
    if (companyId) createdCompanyIds.push(companyId);
    check('Ön koşul: Test firması oluşturuldu', create.status === 200 && !!companyId, `status=${create.status}`);
    const siteName = create.body.data.sites?.[0]?.name;

    // === Test 1: taze firmada lastActivityAt null (hiç ikmal yok) ===
    const list1 = await call('GET', '/companies', { token: adminToken });
    const row1 = (list1.body?.data || []).find((c: any) => c.id === companyId);
    check(
      'Test 1 (ASIL AC): Hiç ikmali olmayan firma için lastActivityAt null döner',
      list1.status === 200 && !!row1 && row1.lastActivityAt === null,
      `lastActivityAt=${JSON.stringify(row1?.lastActivityAt)}`
    );

    // === Test 2 (ASIL AC): bir ikmal kaydından SONRA lastActivityAt o ikmalin zamanını yansıtır ===
    const txTime = new Date(Date.now() - 60_000); // 1 dk önce — "şimdi" ile karışmasın
    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [`fe805-tx-${RUN}`, companyId, siteName, '34FE805X', 42.5, txTime.toISOString()]
    );
    const list2 = await call('GET', '/companies', { token: adminToken });
    const row2 = (list2.body?.data || []).find((c: any) => c.id === companyId);
    const gotTime = row2?.lastActivityAt ? new Date(row2.lastActivityAt).getTime() : null;
    check(
      'Test 2 (ASIL AC): İkmal sonrası lastActivityAt, transactions.created_at (en son) ile eşleşir',
      gotTime !== null && Math.abs(gotTime - txTime.getTime()) < 2000,
      `beklenen=${txTime.toISOString()}, gelen=${row2?.lastActivityAt}`
    );

    // === Test 3: DAHA YENİ bir ikinci ikmal → lastActivityAt İLERİ günceller (MAX, ilk kayıt değil) ===
    const txTime2 = new Date();
    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [`fe805-tx2-${RUN}`, companyId, siteName, '34FE805Y', 10, txTime2.toISOString()]
    );
    const list3 = await call('GET', '/companies', { token: adminToken });
    const row3 = (list3.body?.data || []).find((c: any) => c.id === companyId);
    const gotTime3 = row3?.lastActivityAt ? new Date(row3.lastActivityAt).getTime() : null;
    check(
      'Test 3 (regresyon — MAX doğru): İki ikmalden EN YENİSİ yansır, en eskisi değil',
      gotTime3 !== null && Math.abs(gotTime3 - txTime2.getTime()) < 2000 && gotTime3 > (gotTime || 0),
      `beklenen=${txTime2.toISOString()}, gelen=${row3?.lastActivityAt}`
    );

    // === Test 4 (regresyon — RBAC): SUPER_ADMIN olmayan biri firma listesini çekemez ===
    const ownerToken = await login('camsa');
    const rbac = await call('GET', '/companies', { token: ownerToken });
    check('Test 4 (regresyon): RBAC — COMPANY_OWNER GET /companies çağıramaz (403)', rbac.status === 403, `status=${rbac.status}`);
  } finally {
    await cleanup();
    await resetLoginRl();
    redis.disconnect();
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥 Beklenmeyen hata:', err); process.exit(1); });
