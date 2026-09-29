import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * ARCH-105 (#24) — Tenant onboarding / provisioning akışı.
 *
 * Kapsam notu: "tek API çağrısıyla firma + ilk yönetici + varsayılan
 * ayarlar" ve "hata durumunda hiçbir kısmi kayıt kalmaması" (tek
 * transaction) zaten BILL-1701'in test ettiği createCompanyWithOwner'da
 * mevcuttu. Bu testin odağı, o zamana kadar EKSİK olan üç somut parça:
 *  - VKN benzersizliği (409, supplier bazlı DEĞİL — global, ama '0000000000'
 *    yer tutucusu HARİÇ).
 *  - GERÇEK, tek kullanımlık, rastgele üretilen ilk parola (sabit '123456'
 *    DEĞİL) — BILL-1701 testi bunu zaten Test 3b/3c'de doğruluyor, burada
 *    tekrarlanmaz.
 *  - Denetlenebilirlik: TENANT_PROVISIONED audit log kaydı.
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

/** GİB VKN checksum algoritmasını GERİYE doğru çalıştırıp GEÇERLİ, benzersiz bir VKN üretir (INV-1502 testiyle AYNI teknik). */
function computeValidVkn(seedDigits: string): string {
  const nine = (seedDigits + '000000000').slice(0, 9).split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const c1 = (nine[i] + (9 - i)) % 10;
    let c2 = (c1 * 2 ** (9 - i)) % 9;
    if (c1 !== 0 && c2 === 0) c2 = 9;
    sum += c2;
  }
  const check = (10 - (sum % 10)) % 10;
  return nine.join('') + check;
}

const createdCompanyIds: string[] = [];

async function cleanup(): Promise<void> {
  if (createdCompanyIds.length === 0) return;
  // ON DELETE CASCADE zaten sites/users/audit_logs'u temizler.
  await q('DELETE FROM companies WHERE id = ANY($1::text[])', [createdCompanyIds]).catch(() => {});
}

async function run() {
  console.log('===========================================================');
  console.log('🏢 [ARCH-105] TENANT ONBOARDING / PROVISIONING AKIŞI');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  try {
    const adminToken = await login('admin');
    const vkn1 = computeValidVkn(String(RUN).slice(-9));
    const vkn2 = computeValidVkn(String(RUN + 1).slice(-9));

    // === Test 1: geçerli, benzersiz VKN ile firma oluşturulur ===
    const create1 = await call('POST', '/companies', { token: adminToken, body: { name: `Arch105-A-${RUN}`, taxNumber: vkn1 } });
    if (create1.body?.data?.id) createdCompanyIds.push(create1.body.data.id);
    check(
      'Test 1: Geçerli VKN ile firma oluşturulur, VKN aynen saklanır',
      create1.status === 200 && create1.body?.data?.taxNumber === vkn1,
      `status=${create1.status}, taxNumber=${create1.body?.data?.taxNumber}`
    );

    // === Test 2 (ASIL AC — VKN benzersizliği): AYNI VKN ile ikinci firma → 409 ===
    const create2 = await call('POST', '/companies', { token: adminToken, body: { name: `Arch105-B-${RUN}`, taxNumber: vkn1 } });
    check(
      'Test 2 (ASIL AC): Aynı VKN ile ikinci firma reddedilir (409 TAX_NUMBER_TAKEN)',
      create2.status === 409 && create2.body?.details?.error === 'TAX_NUMBER_TAKEN',
      `status=${create2.status}, body=${JSON.stringify(create2.body)}`
    );

    // === Test 3: farklı VKN ile üçüncü firma serbestçe oluşturulur (yanlış pozitif yok) ===
    const create3 = await call('POST', '/companies', { token: adminToken, body: { name: `Arch105-C-${RUN}`, taxNumber: vkn2 } });
    if (create3.body?.data?.id) createdCompanyIds.push(create3.body.data.id);
    check('Test 3: Farklı VKN ile firma serbestçe oluşturulur', create3.status === 200, `status=${create3.status}`);

    // === Test 4 (regresyon — geriye uyumluluk): VKN verilmeden İKİ firma → ikisi de başarılı (yer tutucu '0000000000' çakışmaz) ===
    const create4a = await call('POST', '/companies', { token: adminToken, body: { name: `Arch105-D1-${RUN}` } });
    const create4b = await call('POST', '/companies', { token: adminToken, body: { name: `Arch105-D2-${RUN}` } });
    if (create4a.body?.data?.id) createdCompanyIds.push(create4a.body.data.id);
    if (create4b.body?.data?.id) createdCompanyIds.push(create4b.body.data.id);
    check(
      "Test 4 (regresyon): VKN verilmeden oluşturulan İKİ firma da başarılı — '0000000000' yer tutucusu benzersizlik denetiminden MUAF",
      create4a.status === 200 && create4b.status === 200 && create4a.body?.data?.taxNumber === '0000000000' && create4b.body?.data?.taxNumber === '0000000000',
      `a=${create4a.status}, b=${create4b.status}`
    );

    // === Test 5 (ASIL AC — denetlenebilirlik): TENANT_PROVISIONED audit log yazılır ===
    const auditRows = await q(
      `SELECT action, target_type, target_id, user_id, after_value FROM audit_logs WHERE tenant_id = $1 AND action = 'TENANT_PROVISIONED'`,
      [create1.body.data.id]
    );
    check(
      "Test 5 (ASIL AC — 'denetlenebilir'): TENANT_PROVISIONED audit log kaydı yazılır — hedef=yeni firma, aktör=SUPER_ADMIN, detayda firma adı/kullanıcı adı var",
      auditRows.length === 1 && auditRows[0].target_type === 'company' && auditRows[0].target_id === create1.body.data.id &&
        !!auditRows[0].user_id && auditRows[0].after_value?.name === `Arch105-A-${RUN}` && !!auditRows[0].after_value?.ownerUsername,
      `satır=${JSON.stringify(auditRows[0])}`
    );

    // === Test 6: reddedilen (409) denemeler İÇİN audit log YOK (hiçbir kısmi/gölge kayıt) ===
    const rejectedAuditRows = await q(
      `SELECT COUNT(*)::int AS c FROM audit_logs a JOIN companies c ON c.id = a.tenant_id WHERE c.name = $1`,
      [`Arch105-B-${RUN}`]
    );
    check('Test 6 (ASIL AC — hiçbir kısmi kayıt kalmamalı): 409 ile reddedilen deneme için HİÇBİR audit log/firma kaydı yok', rejectedAuditRows[0].c === 0, `audit satır=${rejectedAuditRows[0].c}`);

    // === Test 7: yeni sahibin parolası zorunlu değişiklik bayrağıyla kurulur ===
    const ownerRows = await q(`SELECT must_change_password, temp_password_expires_at FROM users WHERE tenant_id = $1 AND role = 'COMPANY_OWNER'`, [create1.body.data.id]);
    check(
      'Test 7: Yeni COMPANY_OWNER, must_change_password=TRUE ve gelecekteki bir sona erme zamanıyla oluşturulur',
        ownerRows.length === 1 && ownerRows[0].must_change_password === true && new Date(ownerRows[0].temp_password_expires_at).getTime() > Date.now(),
      `satır=${JSON.stringify(ownerRows[0])}`
    );

    // === Test 8: geçersiz VKN biçimi (9 hane) → 400 (şema doğrulaması, mevcut davranış — regresyon) ===
    const badFormat = await call('POST', '/companies', { token: adminToken, body: { name: `Arch105-E-${RUN}`, taxNumber: '123456789' } });
    check('Test 8 (regresyon): 9 haneli (geçersiz biçim) VKN → 400', badFormat.status === 400, `status=${badFormat.status}`);

    // === Test 9: RBAC — SUPER_ADMIN olmayan biri firma oluşturamaz ===
    const ownerToken = await login('camsa');
    const rbac = await call('POST', '/companies', { token: ownerToken, body: { name: `Arch105-F-${RUN}`, taxNumber: computeValidVkn(String(RUN + 2).slice(-9)) } });
    check('Test 9: RBAC — COMPANY_OWNER firma oluşturamaz (403)', rbac.status === 403, `status=${rbac.status}`);
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
