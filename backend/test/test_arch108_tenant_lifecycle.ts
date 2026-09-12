import { Client } from 'pg';
import { execSync } from 'node:child_process';

/**
 * ARCH-108 — tenant dondurma, kalıcı silme (30 gün + iki farklı SUPER_ADMIN
 * onayı) ve şifreli veri dışa aktarımı. BILL-1701/1702 testleriyle AYNI
 * desen: gerçek Docker Compose üzerinden, gerçek HTTP istekleriyle, YENİ
 * bir tek-kullanımlık firma oluşturarak (mevcut seed firmalarına — comp-camsa
 * vb. — ASLA dokunulmaz).
 *
 * DİKKAT: bu test, oluşturduğu test firmasını GERÇEKTEN KALICI OLARAK SİLER
 * (approve-deletion akışının sonunda) — bu KASITLI ve testin kendisinin
 * doğruladığı davranış, bir yan etki değil.
 */

// Bu test `docker run --network container:backend` İÇİNDEN DEĞİL, doğrudan
// host'tan çalıştırılmalıdır (docker exec ile Redis'e erişmesi + host'tan
// giriş denemesi yapması gerekiyor). Yerel geliştirme ortamında (OPS-1102
// backend'in host'a yayınlanan portunu kaldırdığından) yalnızca nginx (3000)
// doğrudan erişilebilir — ama .github/workflows/ci-cd.yml'deki
// auth-integration-test job'ı backend'i nginx'siz, DOĞRUDAN bootstrap.ts ile
// 5000 portunda başlatıyor (BILL-1701/1702/1703, FLEET-1409, HR-1801
// testlerinin de İSABETLİ OLARAK kullanması gereken, ama hâlâ hardcoded
// 3000 kullandığı port — bu ayrı, önceden var olan bir tutarsızlık, bkz.
// bu commit'in mesajındaki not). API_URL bu yüzden env'den override
// edilebilir; CI adımı 5000'i geçer, yerel varsayılan nginx'in 3000'idir.
const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';

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
  const c = pg(); await c.connect(); const r = await c.query(sql, params); await c.end(); return r.rows;
}
/**
 * Bu test host'tan doğrudan çalıştığından `new Redis({host:'localhost'})`
 * Docker Compose'un redis'iyle İLİŞKİSİZ, host'ta çalışan (varsa) BAŞKA bir
 * yerel Redis'e bağlanıp resetLoginRl'yi SESSİZCE no-op yapabilir (peer
 * session'ın FUEL-406/IOT-305 testlerinde keşfettiği tuzak — bkz. proje
 * hafızası). Bunun yerine `docker exec` ile GERÇEK compose container'ına
 * (container_name: yakittakip_redis, schema.sql ile AYNI şekilde sabit)
 * doğrudan komut çalıştırılıyor — ağ bağlantısı GEREKMİYOR.
 */
function resetLoginRl(): void {
  try {
    execSync("docker exec yakittakip_redis redis-cli --scan --pattern 'rl:auth-login:*' | xargs -r docker exec -i yakittakip_redis redis-cli DEL", { stdio: 'ignore' });
  } catch {
    // Devam ediyoruz — sıfırlama başarısız olsa bile bazı testler hâlâ
    // limitin altında kalabilir; bu bir fail-fast noktası değil.
  }
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return { status: res.status, body: await res.json().catch(() => ({})) };
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: { __binary: buf, __contentType: ct, __contentDisposition: res.headers.get('content-disposition') } };
}
async function login(username: string): Promise<{ status: number; token: string | null; body: any }> {
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  return { status: r.status, token: r.body.accessToken ?? null, body: r.body };
}

const SECOND_ADMIN_USERNAME = `arch108-admin2-${Date.now()}`;

async function cleanupSecondAdmin(): Promise<void> {
  await q('DELETE FROM users WHERE username = $1', [SECOND_ADMIN_USERNAME]);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [ARCH-108] TENANT DONDURMA + KALICI SİLME + ŞİFRELİ DIŞA AKTARIM');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanupSecondAdmin();

  try {
    const admin1 = (await login('admin')).token!;

    // ── Test 1: tek kullanımlık test firması oluştur ──────────────────
    const companyNameA = `arch108a${Date.now()}`;
    const createA = await call('POST', '/companies', { token: admin1, body: { name: companyNameA } });
    const tenantAId = createA.body.data?.id;
    check('Test 1: firma A oluşturuldu, başlangıç account_status AKTİF',
      createA.status === 200 && !!tenantAId,
      `status=${createA.status}, id=${tenantAId}`);
    const ownerA1 = (await login(companyNameA)).token!;

    // ── Test 2: dondurma öncesi normal erişim ──────────────────────────
    const r2 = await call('GET', '/vehicles', { token: ownerA1 });
    check('Test 2: dondurulmadan önce GET /vehicles → 200', r2.status === 200, `status=${r2.status}`);

    // ── Test 3: dondurma → mevcut token bile 403, YENİ giriş de engellenir ─
    const r3freeze = await call('POST', `/admin/companies/${tenantAId}/freeze`, { token: admin1, body: { reason: 'Fatura ödemesi 90 gün geçti, sözleşme feshi öncesi dondurma.' } });
    const r3vehicles = await call('GET', '/vehicles', { token: ownerA1 });
    const r3login = await login(companyNameA);
    check('Test 3: dondurulunca → mevcut token 403 TENANT_FROZEN, yeni giriş de 403 TENANT_FROZEN',
      r3freeze.status === 200 && r3freeze.body.data.accountStatus === 'DONDURULDU' &&
      r3vehicles.status === 403 && r3vehicles.body.error === 'TENANT_FROZEN' &&
      r3login.status === 403,
      `dondur=${r3freeze.status}/${r3freeze.body.data?.accountStatus}, mevcutToken=${r3vehicles.status}/${r3vehicles.body?.error}, yeniGiriş=${r3login.status}`);

    // ── Test 4: aynı firmayı tekrar dondurmak reddedilir ────────────────
    const r4 = await call('POST', `/admin/companies/${tenantAId}/freeze`, { token: admin1, body: { reason: 'İkinci dondurma denemesi.' } });
    check('Test 4: zaten DONDURULDU olan firma tekrar dondurulamaz → 409 ALREADY_FROZEN',
      r4.status === 409 && r4.body.details?.error === 'ALREADY_FROZEN', `status=${r4.status}, err=${r4.body.details?.error}`);

    // ── Test 5: dondurmayı kaldır → erişim + giriş normale döner ────────
    const r5unfreeze = await call('POST', `/admin/companies/${tenantAId}/unfreeze`, { token: admin1 });
    const ownerA2 = (await login(companyNameA)).token;
    const r5vehicles = ownerA2 ? await call('GET', '/vehicles', { token: ownerA2 }) : { status: 0, body: {} };
    check('Test 5: dondurma kaldırılınca → AKTİF, giriş + erişim tekrar çalışır',
      r5unfreeze.status === 200 && r5unfreeze.body.data.accountStatus === 'AKTİF' && !!ownerA2 && r5vehicles.status === 200,
      `kaldır=${r5unfreeze.status}/${r5unfreeze.body.data?.accountStatus}, girişOldu=${!!ownerA2}, erişim=${r5vehicles.status}`);

    // ── Test 6: silme planlama → DONDURULDU gibi davranır (giriş engellenir) ─
    const r6schedule = await call('POST', `/admin/companies/${tenantAId}/schedule-deletion`, { token: admin1, body: { reason: 'Müşteri sözleşmeyi feshetti, kalıcı silme talep etti.' } });
    const r6login = await login(companyNameA);
    check('Test 6: silme planlanınca → SILME_BEKLIYOR, giriş 403 TENANT_PENDING_DELETION',
      r6schedule.status === 200 && r6schedule.body.data.accountStatus === 'SILME_BEKLIYOR' &&
      r6login.status === 403 && r6login.body.error === 'TENANT_PENDING_DELETION',
      `planla=${r6schedule.status}/${r6schedule.body.data?.accountStatus}, giriş=${r6login.status}/${r6login.body?.error}`);

    // ── Test 7: 30 günlük bekleme dolmadan onay reddedilir ──────────────
    const r7 = await call('POST', `/admin/companies/${tenantAId}/approve-deletion`, { token: admin1 });
    check('Test 7: 30 gün dolmadan approve-deletion → 409 WAITING_PERIOD_NOT_ELAPSED',
      r7.status === 409 && r7.body.details?.error === 'WAITING_PERIOD_NOT_ELAPSED', `status=${r7.status}, err=${r7.body.details?.error}`);

    // ── Test 8: bekleme süresini simüle etmek için deletion_scheduled_at'i geriye al ─
    await q("UPDATE companies SET deletion_scheduled_at = NOW() - INTERVAL '31 days' WHERE id = $1", [tenantAId]);
    const r8a = await call('POST', `/admin/companies/${tenantAId}/approve-deletion`, { token: admin1 });
    const r8b = await call('POST', `/admin/companies/${tenantAId}/approve-deletion`, { token: admin1 }); // AYNI admin ikinci kez — sayaç ARTMAMALI
    check('Test 8: süre dolunca 1. onay kabul edilir; AYNI admin\'in tekrar onaylaması sayacı ARTIRMAZ (idempotent)',
      r8a.status === 200 && r8a.body.data.executed === false && r8a.body.data.approvalsCount === 1 &&
      r8b.status === 200 && r8b.body.data.executed === false && r8b.body.data.approvalsCount === 1,
      `1.onay=${r8a.body.data?.approvalsCount}/${r8a.body.data?.executed}, tekrar=${r8b.body.data?.approvalsCount}/${r8b.body.data?.executed}`);

    // ── Test 9: FARKLI bir SUPER_ADMIN onaylayınca → kalıcı silme GERÇEKLEŞİR ─
    const adminHash = (await q("SELECT password_hash FROM users WHERE username = 'admin'"))[0].password_hash;
    await q(
      `INSERT INTO users (id, tenant_id, username, password_hash, role, site_name)
       VALUES ($1, 'comp-camsa', $2, $3, 'SUPER_ADMIN', NULL)`,
      [`usr-${SECOND_ADMIN_USERNAME}`, SECOND_ADMIN_USERNAME, adminHash]
    );
    const admin2 = (await login(SECOND_ADMIN_USERNAME)).token!;
    const r9 = await call('POST', `/admin/companies/${tenantAId}/approve-deletion`, { token: admin2 });
    check('Test 9: 2. FARKLI SUPER_ADMIN onaylayınca → executed:true, approvalsCount=2',
      r9.status === 200 && r9.body.data.executed === true && r9.body.data.approvalsCount === 2,
      `status=${r9.status}, executed=${r9.body.data?.executed}, sayaç=${r9.body.data?.approvalsCount}`);

    // ── Test 10: firma GERÇEKTEN gitti (cascade) — eski sahip artık giriş yapamaz ─
    const r10lifecycle = await call('GET', `/admin/companies/${tenantAId}/lifecycle`, { token: admin1 });
    const r10login = await login(companyNameA);
    const r10users = await q('SELECT COUNT(*)::int AS c FROM users WHERE tenant_id = $1', [tenantAId]);
    check('Test 10: silinen firma → lifecycle 404, eski sahip giriş yapamaz, users tablosunda hiç kayıt yok (CASCADE)',
      r10lifecycle.status === 404 && r10login.status === 401 && r10users[0].c === 0,
      `lifecycle=${r10lifecycle.status}, giriş=${r10login.status}, kalanKullanıcı=${r10users[0].c}`);

    // ── Test 11: silme olayı platform_audit_log'da KALICI olarak duruyor ─
    const r11 = await q(
      "SELECT action, actor_user_id, detail->>'approvedBy' AS approved_by FROM platform_audit_log WHERE deleted_tenant_id = $1 AND action = 'TENANT_PERMANENTLY_DELETED'",
      [tenantAId]
    );
    check('Test 11: platform_audit_log — TENANT_PERMANENTLY_DELETED kaydı (companies silinmiş olsa da) kalıcı',
      r11.length === 1, `kayıt=${r11.length}, detay=${JSON.stringify(r11[0])}`);

    // ── Test 12: iptal — planlanmış bir silme AKTİF'e geri alınabilir ────
    const companyNameB = `arch108b${Date.now()}`;
    const createB = await call('POST', '/companies', { token: admin1, body: { name: companyNameB } });
    const tenantBId = createB.body.data.id;
    await call('POST', `/admin/companies/${tenantBId}/schedule-deletion`, { token: admin1, body: { reason: 'Test iptal senaryosu.' } });
    const r12cancel = await call('POST', `/admin/companies/${tenantBId}/cancel-deletion`, { token: admin1 });
    const r12loginAfter = await login(companyNameB);
    check('Test 12: planlanmış silme iptal edilince → AKTİF, giriş tekrar mümkün',
      r12cancel.status === 200 && r12cancel.body.data.accountStatus === 'AKTİF' && r12loginAfter.status === 200,
      `iptal=${r12cancel.status}/${r12cancel.body.data?.accountStatus}, girişSonra=${r12loginAfter.status}`);

    // ── Test 13: şifreli veri dışa aktarımı — ikili, rastgele (IV) her seferinde farklı ─
    const r13a = await call('GET', `/admin/companies/${tenantBId}/export`, { token: admin1 });
    const r13b = await call('GET', `/admin/companies/${tenantBId}/export`, { token: admin1 });
    const buf13a: Buffer = r13a.body.__binary;
    const buf13b: Buffer = r13b.body.__binary;
    check('Test 13: GET .../export → application/octet-stream, ikili gövde >100 bayt, iki çağrı FARKLI şifreli çıktı üretir (rastgele IV)',
      r13a.status === 200 && r13a.body.__contentType?.includes('application/octet-stream') &&
      buf13a.length > 100 && buf13a.length === buf13b.length && !buf13a.equals(buf13b),
      `status=${r13a.status}, contentType=${r13a.body.__contentType}, boyut=${buf13a?.length}, farklı=${!buf13a?.equals(buf13b)}`);

    // ── Test 14: Zod — gerekçe eksik/kısa → 400 ────────────────────────────
    const r14a = await call('POST', `/admin/companies/${tenantBId}/freeze`, { token: admin1, body: { reason: 'kısa' } });
    const r14b = await call('POST', `/admin/companies/${tenantBId}/freeze`, { token: admin1, body: {} });
    check('Test 14: Zod — 5 karakterden kısa/eksik reason → 400', r14a.status === 400 && r14b.status === 400, `kısa=${r14a.status}, eksik=${r14b.status}`);

    // ── Test 15: RBAC — COMPANY_OWNER lifecycle uçlarına erişemez ────────
    const ownerB = (await login(companyNameB)).token!;
    const r15a = await call('POST', `/admin/companies/${tenantBId}/freeze`, { token: ownerB, body: { reason: 'Yetkisiz deneme.' } });
    const r15b = await call('GET', `/admin/companies/${tenantBId}/lifecycle`, { token: ownerB });
    const r15c = await call('GET', `/admin/companies/${tenantBId}/lifecycle`, {});
    check('Test 15: RBAC — COMPANY_OWNER freeze/lifecycle görüntüleyemez → 403, tokensiz → 401',
      r15a.status === 403 && r15b.status === 403 && r15c.status === 401,
      `freeze=${r15a.status}, lifecycle=${r15b.status}, tokensiz=${r15c.status}`);

    // ── Test 16: olmayan firma → 404 ──────────────────────────────────────
    const r16 = await call('POST', `/admin/companies/nonexistent-company-id/freeze`, { token: admin1, body: { reason: 'Olmayan firma testi.' } });
    check('Test 16: olmayan firma → 404 COMPANY_NOT_FOUND', r16.status === 404 && r16.body.details?.error === 'COMPANY_NOT_FOUND', `status=${r16.status}, err=${r16.body.details?.error}`);

    // ── Test 17: audit_logs — dondurma/silme olayları kaydedildi (firma B üzerinden) ─
    const auditB = await q(
      "SELECT action FROM audit_logs WHERE tenant_id = $1 AND action IN ('TENANT_FROZEN','TENANT_DELETION_SCHEDULED','TENANT_DELETION_CANCELLED')",
      [tenantBId]
    );
    check('Test 17: audit_logs — firma B için TENANT_DELETION_SCHEDULED + TENANT_DELETION_CANCELLED yazıldı',
      auditB.some((r) => r.action === 'TENANT_DELETION_SCHEDULED') && auditB.some((r) => r.action === 'TENANT_DELETION_CANCELLED'),
      `kayıtlar=${JSON.stringify(auditB.map((r) => r.action))}`);

  } finally {
    await cleanupSecondAdmin();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥 Beklenmeyen hata:', err); process.exit(1); });
