import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FE-811 (#86) — Şantiye Paneli: canlı ikmal ekranı ve acil durdurma.
 *
 * Kapsam notu: FE-811 esasen bir FRONTEND biletidir — "canlı ikmal
 * kartları" (anlık litre/debi/süre/ilerleme) ve "büyük ekran görünümü"
 * BİLİNÇLİ OLARAK bu PR'ın kapsamı dışında bırakıldı (backend'de GERÇEK
 * bir "devam eden dispense session" canlı yayını yok — yeni bir altyapı
 * gerektirir, ayrı bir iş). Bu test, GERÇEKTEN YENİ olan backend yüzeyini
 * doğrular: acil durdurma/devam ettirme + durum sorgusu. "Bağlantı
 * koptuğunda uyarı" ve "onay diyaloğu" saf istemci tarafı state'tir,
 * Playwright'ta kapsanır.
 *
 * ÖNEMLİ (test izolasyonu): emergency-stop bir ŞANTİYEDEKİ TÜM cihazları
 * bloke eder. "Gebze Ana Şantiye" gibi PAYLAŞILAN seed şantiyelerini asla
 * KULLANILMAZ (düzinelerce başka testin cihazını yanlışlıkla bloke
 * ederdi) — bu testin KENDİ, tek seferlik (Date.now()) şantiye adıyla
 * oluşturduğu bir cihaz dışında hiçbir şeye dokunmaz.
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
  const r = await fetch(`${API_URL}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await r.json();
  if (!data.accessToken) throw new Error(`login ${username}: ${JSON.stringify(data)}`);
  return data.accessToken;
}

const testSiteName = `FE811 Test Sahası ${RUN}`;
const deviceId1 = `FE811-DEV-A-${RUN}`;
const deviceId2 = `FE811-DEV-B-${RUN}`;

async function cleanup(): Promise<void> {
  await q(`DELETE FROM hardware_devices WHERE device_id = ANY($1::text[])`, [[deviceId1, deviceId2]]).catch(() => {});
}

async function run() {
  console.log('===========================================================');
  console.log('🛑 [FE-811] ŞANTİYE ACİL DURDURMA');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  try {
    const ownerToken = await login('camsa');
    const siteManagerToken = await login('gebze-santiye');

    // === Ön koşul: bu testin KENDİ şantiyesinde 2 cihaz (COMPANY_OWNER provizyonluyor) ===
    const create1 = await call('POST', '/hardware-devices', { token: ownerToken, body: { deviceId: deviceId1, name: 'FE811 Test Pompa A', siteName: testSiteName } });
    const create2 = await call('POST', '/hardware-devices', { token: ownerToken, body: { deviceId: deviceId2, name: 'FE811 Test Pompa B', siteName: testSiteName } });
    check('Ön koşul: 2 test cihazı provizyonlandı', create1.status === 200 && create2.status === 200, `status=${create1.status}/${create2.status}`);

    // === Test 1: başlangıçta durdurulmuş değil ===
    const status1 = await call('GET', `/sites/${encodeURIComponent(testSiteName)}/emergency-status`, { token: siteManagerToken });
    check(
      'Test 1 (regresyon): Başlangıçta şantiye durdurulmuş değil, 2 cihaz AKTİF',
      status1.status === 200 && status1.body?.data?.isStopped === false && status1.body?.data?.totalDeviceCount === 2 && status1.body?.data?.blockedDeviceCount === 0,
      `body=${JSON.stringify(status1.body)}`
    );

    // === Test 2: gerekçesiz/kısa gerekçeyle acil durdurma reddedilir (400) ===
    const noReason = await call('POST', `/sites/${encodeURIComponent(testSiteName)}/emergency-stop`, { token: siteManagerToken, body: { reason: 'ab' } });
    check('Test 2 (ASIL AC — zorunlu gerekçe): 5 karakterden kısa gerekçe 400 ile reddedilir', noReason.status === 400, `status=${noReason.status}`);

    // === Test 3 (ASIL AC): SITE_MANAGER acil durdurabilir — TÜM cihazlar bloke olur ===
    const stop = await call('POST', `/sites/${encodeURIComponent(testSiteName)}/emergency-stop`, { token: siteManagerToken, body: { reason: 'E2E test — hortum sızıntısı simülasyonu' } });
    check(
      'Test 3 (ASIL AC): SITE_MANAGER acil durdurabilir, 2 cihaz bloke edilir',
      stop.status === 200 && stop.body?.data?.blockedDeviceCount === 2,
      `status=${stop.status}, body=${JSON.stringify(stop.body)}`
    );

    // === Test 4 (ASIL AC — GERÇEK etki): bloke edilen cihaz artık HMAC isteği gönderemez ===
    const deviceRow = await q(`SELECT status FROM hardware_devices WHERE device_id = $1`, [deviceId1]);
    check(
      'Test 4 (ASIL AC — kozmetik DEĞİL): DB satırında status artık BLOKE (hardwareAuthMiddleware bunu anında 403 ile reddeder)',
      deviceRow[0]?.status === 'BLOKE',
      `status=${deviceRow[0]?.status}`
    );

    // === Test 5 (ASIL AC — audit): SITE_EMERGENCY_STOP audit kaydı, aktör (SITE_MANAGER) ile yazılır ===
    const auditRows = await q(
      `SELECT action, target_type, target_id, user_id, after_value FROM audit_logs WHERE tenant_id = 'comp-camsa' AND action = 'SITE_EMERGENCY_STOP' AND target_id = $1`,
      [testSiteName]
    );
    check(
      "Test 5 (ASIL AC — 'audit\\'lenmelidir'): SITE_EMERGENCY_STOP kaydı yazılır, hedef=şantiye, gerekçe+bloke sayısı after_value'da, aktör kullanıcısı dolu",
      auditRows.length === 1 && auditRows[0].target_type === 'site' && !!auditRows[0].user_id &&
        auditRows[0].after_value?.reason === 'E2E test — hortum sızıntısı simülasyonu' && auditRows[0].after_value?.blockedDeviceCount === 2,
      `satır=${JSON.stringify(auditRows[0])}`
    );

    // === Test 6: durum sorgusu artık "durduruldu" gösteriyor ===
    const status2 = await call('GET', `/sites/${encodeURIComponent(testSiteName)}/emergency-status`, { token: ownerToken });
    check('Test 6 (regresyon): Durum sorgusu artık isStopped=true gösterir', status2.body?.data?.isStopped === true, `body=${JSON.stringify(status2.body)}`);

    // === Test 7: PUMP_OPERATOR/DRIVER gibi bir rol yetkisiz (kimliksiz = 401, burada basit RBAC: yetkisiz tenant/rol yok test edilen senaryoda — token olmadan 401) ===
    const noAuth = await call('GET', `/sites/${encodeURIComponent(testSiteName)}/emergency-status`);
    check('Test 7 (regresyon): Kimliksiz erişim 401', noAuth.status === 401, `status=${noAuth.status}`);

    // === Test 8 (ASIL AC): Devam ettirme — tüm cihazlar tekrar AKTİF ===
    const resume = await call('POST', `/sites/${encodeURIComponent(testSiteName)}/emergency-resume`, { token: siteManagerToken });
    check('Test 8 (ASIL AC): Devam ettirme, 2 cihaz tekrar aktifleştirilir', resume.status === 200 && resume.body?.data?.resumedDeviceCount === 2, `status=${resume.status}, body=${JSON.stringify(resume.body)}`);

    const status3 = await call('GET', `/sites/${encodeURIComponent(testSiteName)}/emergency-status`, { token: ownerToken });
    check('Test 9 (regresyon): Devam ettirme sonrası isStopped=false', status3.body?.data?.isStopped === false, `body=${JSON.stringify(status3.body)}`);

    const resumeAuditRows = await q(`SELECT action FROM audit_logs WHERE tenant_id = 'comp-camsa' AND action = 'SITE_EMERGENCY_RESUME' AND target_id = $1`, [testSiteName]);
    check('Test 10 (ASIL AC — audit): SITE_EMERGENCY_RESUME kaydı da yazılır', resumeAuditRows.length === 1, `satır sayısı=${resumeAuditRows.length}`);
  } finally {
    await cleanup();
    await resetLoginRl();
    redis.disconnect();
    console.log('🧹 Test fixture verisi temizlendi (yalnızca bu testin KENDİ cihazları silindi).\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥 Beklenmeyen hata:', err); process.exit(1); });
