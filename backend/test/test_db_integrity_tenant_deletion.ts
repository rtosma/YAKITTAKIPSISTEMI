import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md §4 — Veritabanı bütünlüğü (canlı DB) + kalıcı tenant silme sonrası
 * geride hiçbir şey kalmaması.
 *
 * NEDEN CANLI DB: statik guard'lar (check-rls-coverage.mjs) schema.sql METNİNE
 * bakıyor. Bu oturumda schema.sql'deki düzeltmelerin çalışan veritabanına
 * ULAŞMADIĞI gerçekten yaşandı (migration boşluğu). Bu test politika/FK/kısıt
 * durumunu doğrudan pg_catalog'dan okur ve RLS'i DAVRANIŞ olarak dener.
 *
 * Kapsam:
 *   1-2. Her tenant_id tablosu: companies'e ON DELETE CASCADE FK; RLS ENABLE +
 *        FORCE; USING ve WITH CHECK ifadeleri app.current_tenant_id'ye bağlı.
 *   3.   Dinamik okuma izolasyonu — TÜM tenant tablolarında, app_user olarak.
 *   4.   Dinamik yazma kaçışı — bir satırı başka tenant'a TAŞIMA denemesi.
 *   5.   Kalıcı silme sonrası o tenant'ın verisi TÜM tablolarda sıfır.
 *   6-7. Silinen tenant kullanıcısının token'ları reddedilir.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const OTHER_TENANT = 'comp-kusak';

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
  const c = pg();
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}
async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function loginFull(username: string): Promise<{ accessToken: string; refreshToken: string }> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const body = await res.json().catch(() => ({}));
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

async function tenantTables(): Promise<string[]> {
  return (await q(
    `SELECT DISTINCT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
      ORDER BY 1`
  )).map((r) => r.table_name);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §4] DB BÜTÜNLÜĞÜ (CANLI) + KALICI TENANT SİLME SONRASI');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}\n   ${detail}\n`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${name}\n   ${detail}\n`);
    }
  };

  const tables = await tenantTables();
  const OWNER = `integ-owner-${RUN}`;
  const ADMIN2 = `integ-admin2-${RUN}`;
  let doomedTenant: string | null = null;

  try {
    // ═══ 1) FK CASCADE — canlı şema ═════════════════════════════════════
    const fkRows = await q(
      `SELECT kcu.table_name FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.constraint_name
        WHERE kcu.column_name = 'tenant_id' AND ccu.table_name = 'companies' AND rc.delete_rule = 'CASCADE'`
    );
    const withCascade = new Set(fkRows.map((r) => r.table_name));
    const missingCascade = tables.filter((t) => !withCascade.has(t));
    check(`Test 1: ${tables.length} tenant tablosunun HEPSİNDE companies'e ON DELETE CASCADE FK var (silinen tenant'ın verisi kalamaz)`,
      missingCascade.length === 0, missingCascade.length ? `eksik: ${missingCascade.join(', ')}` : `${tables.length}/${tables.length}`);

    // ═══ 2) RLS politikası — canlı şema ═════════════════════════════════
    const rlsRows = await q(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              bool_and(p.qual LIKE '%app.current_tenant_id%') AS qual_ok,
              bool_and(coalesce(p.with_check, p.qual) LIKE '%app.current_tenant_id%') AS check_ok,
              count(p.policyname) AS policies
         FROM pg_class c LEFT JOIN pg_policies p ON p.tablename = c.relname AND p.schemaname = 'public'
        WHERE c.relname = ANY($1) AND c.relkind = 'r'
        GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity`,
      [tables]
    );
    const badRls = rlsRows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || Number(r.policies) === 0 || !r.qual_ok || !r.check_ok);
    check(`Test 2: ${tables.length} tablonun hepsinde RLS ENABLE+FORCE ve USING/WITH CHECK app.current_tenant_id'ye bağlı (canlı DB)`,
      badRls.length === 0 && rlsRows.length === tables.length,
      badRls.length ? `sorunlu: ${badRls.map((r) => r.relname).join(', ')}` : `${rlsRows.length}/${tables.length}`);

    // ═══ 3) Dinamik okuma izolasyonu ════════════════════════════════════
    const client = pg();
    await client.connect();
    const leaks: string[] = [];
    let tablesWithForeignData = 0;
    const escapeFailures: string[] = [];
    let escapeTested = 0;
    try {
      for (const t of tables) {
        const foreignRows = Number((await client.query(`SELECT count(*) FROM "${t}" WHERE tenant_id <> $1`, [OTHER_TENANT])).rows[0].count);
        if (foreignRows > 0) tablesWithForeignData++;
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_user');
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [OTHER_TENANT]);
        const visibleForeign = Number((await client.query(`SELECT count(*) FROM "${t}" WHERE tenant_id <> $1`, [OTHER_TENANT])).rows[0].count);
        await client.query('ROLLBACK');
        if (visibleForeign > 0) leaks.push(`${t} (${visibleForeign} yabancı satır görünür)`);
      }

      // ═══ 4) Dinamik yazma kaçışı: satırı başka tenant'a taşıma ═══════
      for (const t of tables) {
        const hasOwn = Number((await client.query(`SELECT count(*) FROM "${t}" WHERE tenant_id = 'comp-camsa'`)).rows[0].count) > 0;
        if (!hasOwn) continue;
        escapeTested++;
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_user');
        await client.query("SELECT set_config('app.current_tenant_id', 'comp-camsa', true)");
        let blocked = false;
        let reason = '';
        try {
          const r = await client.query(
            `UPDATE "${t}" SET tenant_id = $1 WHERE ctid = (SELECT ctid FROM "${t}" WHERE tenant_id = 'comp-camsa' LIMIT 1)`,
            [OTHER_TENANT]
          );
          reason = `${r.rowCount} satır taşındı`;
        } catch (err: any) {
          blocked = true; // RLS WITH CHECK ihlali ya da append-only REVOKE — ikisi de doğru
          reason = err.message.split('\n')[0];
        }
        await client.query('ROLLBACK');
        if (!blocked) escapeFailures.push(`${t}: ${reason}`);
      }
    } finally {
      await client.end();
    }
    check(`Test 3: app_user olarak ${tables.length} tablonun HİÇBİRİNDE başka tenant'ın satırı görünmüyor`,
      leaks.length === 0, leaks.length ? leaks.join('; ') : `sızıntı yok — ${tablesWithForeignData} tabloda gerçekten yabancı veri vardı (kapsama)`);
    check('Test 4: Bir satırın tenant_id\'si başka tenant\'a TAŞINAMIYOR (WITH CHECK / REVOKE)',
      escapeFailures.length === 0 && escapeTested > 0,
      escapeFailures.length ? escapeFailures.join('; ') : `${escapeTested} tabloda denendi, hepsi engellendi`);

    // ═══ 5) Kalıcı silme: tenant verisi TÜM tablolarda sıfır ═════════════
    const adminHash = (await q("SELECT password_hash FROM users WHERE username = 'admin'"))[0].password_hash;
    const admin = await loginFull('admin');
    const created = await call('POST', '/companies', admin.accessToken, { name: `integ${RUN}` });
    doomedTenant = created.body?.data?.id;
    if (!doomedTenant) throw new Error(`firma oluşturulamadı: ${JSON.stringify(created.body)}`);

    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) VALUES ($1, $2, $3, $4, 'COMPANY_OWNER')`, [`usr-${OWNER}`, doomedTenant, OWNER, adminHash]);
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) VALUES ($1, 'comp-camsa', $2, $3, 'SUPER_ADMIN')`, [`usr-${ADMIN2}`, ADMIN2, adminHash]);
    await q(`INSERT INTO sites (id, tenant_id, name, location) VALUES ($1, $2, 'Integ Şantiye', 'Test')`, [`site-integ-${RUN}`, doomedTenant]).catch(() => {});
    await q(`INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type) VALUES ($1, $2, 'Integ Tank', 'Integ Şantiye', 1000, 500, 'Motorin')`, [`tank-integ-${RUN}`, doomedTenant]);
    await q(`INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name) VALUES ($1, $2, '34 IN 001', 'T', 'Kamyon', $3, 'Integ Şantiye')`, [`veh-integ-${RUN}`, doomedTenant, `RFID-INTEG-${RUN}`]);
    await q(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters) VALUES ($1, $2, 'Integ Şantiye', '34 IN 001', 10)`, [`tx-integ-${RUN}`, doomedTenant]);

    const owner = await loginFull(OWNER);
    const ownerBefore = await call('GET', '/vehicles', owner.accessToken);

    const beforeCounts: Record<string, number> = {};
    for (const t of tables) {
      const n = Number((await q(`SELECT count(*) FROM "${t}" WHERE tenant_id = $1`, [doomedTenant]))[0].count);
      if (n > 0) beforeCounts[t] = n;
    }

    await call('POST', `/admin/companies/${doomedTenant}/schedule-deletion`, admin.accessToken, { reason: 'Bütünlük testi: kalıcı silme sonrası artık veri kontrolü.' });
    await q("UPDATE companies SET deletion_scheduled_at = NOW() - INTERVAL '31 days' WHERE id = $1", [doomedTenant]);
    const admin2 = await loginFull(ADMIN2);
    await call('POST', `/admin/companies/${doomedTenant}/approve-deletion`, admin.accessToken);
    const final = await call('POST', `/admin/companies/${doomedTenant}/approve-deletion`, admin2.accessToken);

    const leftovers: string[] = [];
    for (const t of tables) {
      const n = Number((await q(`SELECT count(*) FROM "${t}" WHERE tenant_id = $1`, [doomedTenant]))[0].count);
      if (n > 0) leftovers.push(`${t}=${n}`);
    }
    check('Test 5: Kalıcı silme sonrası tenant verisi TÜM tablolarda SIFIR (hiçbir tabloda artık veri yok)',
      final.body?.data?.executed === true && leftovers.length === 0 && Object.keys(beforeCounts).length >= 4,
      `silme öncesi dolu tablolar=${JSON.stringify(beforeCounts)}; sonrası artık=${leftovers.join(', ') || 'yok'}`);

    // ═══ 6-7) Silinen tenant kullanıcısının oturumu ═════════════════════
    const accessAfter = await call('GET', '/vehicles', owner.accessToken);
    const meAfter = await call('GET', '/auth/me', owner.accessToken);
    check('Test 6: SİLİNEN tenant kullanıcısının (henüz süresi dolmamış) access token\'ı REDDEDİLİR — lisans istisna listesindeki /auth/me dahil',
      ownerBefore.status === 200 && accessAfter.status === 401 && accessAfter.body?.error === 'TENANT_DELETED' && meAfter.status === 401,
      `silme öncesi GET /vehicles=${ownerBefore.status}; sonrası /vehicles=${accessAfter.status} (${accessAfter.body?.error}), /auth/me=${meAfter.status}`);

    const refreshRes = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: owner.refreshToken })
    });
    const refreshBody = await refreshRes.json().catch(() => ({}));
    check('Test 7: SİLİNEN tenant kullanıcısının refresh token\'ı ile YENİ token ALINAMAZ',
      refreshRes.status === 401 || refreshRes.status === 403,
      `POST /auth/refresh=${refreshRes.status} accessToken döndü mü=${!!refreshBody.accessToken}`);
  } finally {
    if (doomedTenant) {
      await q('DELETE FROM companies WHERE id = $1', [doomedTenant]);
      await q('DELETE FROM platform_audit_log WHERE deleted_tenant_id = $1', [doomedTenant]);
    }
    await q('DELETE FROM users WHERE username = ANY($1)', [[OWNER, ADMIN2]]);
    await resetLoginRateLimit();
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
