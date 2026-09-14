import { Client } from 'pg';
import crypto from 'crypto';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md / GitHub #165 [REP-702] — Şifreli ZIP arşivleme + presigned
 * indirme bağlantısı, ÇEKİRDEK çatı testleri.
 *
 * BİLEREK bu dosyada YOK (bkz. test_rep702_archive_encryption.ts): gerçek
 * AES-256 şifreleme/parola doğrulaması ve manifest SHA-256 bütünlük kontrolü.
 * Bunlar `docker` CLI ile bir p7zip konteyneri gerektirir — test_res905/
 * test_iot305/test_fuel406 ile AYNI gerekçeyle CI'a EKLENMEZ, host'ta ayrı
 * çalıştırılır. Bu dosya CI'a eklenen kısımdır: RBAC, ayar CRUD'u, tenant
 * izolasyonu, presigned bağlantının şekli + süre kontrolü (gerçek şifre
 * doğrulaması OLMADAN — ZIP konteynerinin `PK` sihirli byte'larıyla).
 *
 * Kapsanan AC'ler:
 *  - "Periyot seçimi (7/15/30/90 gün)" — geçerli/geçersiz değerler.
 *  - "Kullanıcı yalnızca yetkili olduğu işlemleri yapabilmeli" (SUPER_ADMIN/
 *    COMPANY_OWNER; SITE_MANAGER/PUMP_OPERATOR reddedilir).
 *  - "İndirme bağlantısı süreli olmalı" — yanlış/bilinmeyen token ve
 *    (DB'de expires_at'i geçmişe çekerek simüle edilen) süresi dolmuş
 *    bağlantı reddi; süresi dolmamış bir bağlantının BİRDEN FAZLA kez
 *    indirilebildiği (tek kullanımlık DEĞİL, ticket'ın "süreli" ifadesiyle
 *    tutarlı).
 *  - Tenant izolasyonu: bir firmanın arşiv listesi/indirmesi diğerine sızmaz.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

async function api(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN / GitHub #165] REP-702 ARŞİV ÇATISI TESTLERİ');
  console.log('===========================================================\n');
  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };

  const db = pg();
  await db.connect();
  const createdArchiveIds: string[] = [];

  try {
    const owner = await login('camsa'); // COMPANY_OWNER, comp-camsa
    const otherOwner = await login('kusak'); // COMPANY_OWNER, comp-kusak — tenant izolasyonu
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR, comp-camsa
    const siteManager = await login('gebze-santiye'); // SITE_MANAGER, comp-camsa

    // --- Ayar CRUD'u -------------------------------------------------------
    const settingsBefore = await api('GET', '/companies/me/archive-settings', owner);
    check('Test 1: GET archive-settings 200 döner', settingsBefore.status === 200, `status=${settingsBefore.status}`);

    const setInvalid = await api('PATCH', '/companies/me/archive-settings', owner, { periodDays: 45 });
    check('Test 2: Geçersiz periyot (45 gün) 400 ile reddedilir', setInvalid.status === 400, `status=${setInvalid.status}, body=${JSON.stringify(setInvalid.body)}`);

    const setValid = await api('PATCH', '/companies/me/archive-settings', owner, { periodDays: 30 });
    check(
      'Test 3: Geçerli periyot (30 gün) kabul edilir ve yansır',
      setValid.status === 200 && setValid.body.data.periodDays === 30,
      `status=${setValid.status}, body=${JSON.stringify(setValid.body)}`
    );

    const clearSetting = await api('PATCH', '/companies/me/archive-settings', owner, { periodDays: null });
    check(
      'Test 4: periodDays:null periyodik üretimi kapatır (NULL\'a döner)',
      clearSetting.status === 200 && clearSetting.body.data.periodDays === null,
      `status=${clearSetting.status}, body=${JSON.stringify(clearSetting.body)}`
    );

    // --- RBAC ----------------------------------------------------------
    const rbacSettingsGet = await api('GET', '/companies/me/archive-settings', pumpOp);
    check('Test 5: PUMP_OPERATOR ayarları GÖREMEZ (403)', rbacSettingsGet.status === 403, `status=${rbacSettingsGet.status}`);

    const rbacSettingsPatch = await api('PATCH', '/companies/me/archive-settings', siteManager, { periodDays: 7 });
    check('Test 6: SITE_MANAGER ayarları DEĞİŞTİREMEZ (403)', rbacSettingsPatch.status === 403, `status=${rbacSettingsPatch.status}`);

    const rbacCreate = await api('POST', '/archives', pumpOp, { periodDays: 7 });
    check('Test 7: PUMP_OPERATOR manuel arşiv OLUŞTURAMAZ (403)', rbacCreate.status === 403, `status=${rbacCreate.status}`);

    const rbacList = await api('GET', '/archives', siteManager);
    check('Test 8: SITE_MANAGER arşiv listesini GÖREMEZ (403)', rbacList.status === 403, `status=${rbacList.status}`);

    // --- Manuel üretim + şekil doğrulaması ------------------------------
    const invalidPeriod = await api('POST', '/archives', owner, { periodDays: 13 });
    check('Test 9: Manuel tetikleyicide geçersiz periyot (13 gün) 400 ile reddedilir', invalidPeriod.status === 400, `status=${invalidPeriod.status}`);

    const created = await api('POST', '/archives', owner, { periodDays: 7 });
    check(
      'Test 10: Manuel arşiv üretimi 201 + archiveId/password/downloadUrl/expiresAt döner',
      created.status === 201 &&
        typeof created.body?.data?.archiveId === 'string' &&
        typeof created.body?.data?.password === 'string' &&
        created.body.data.password.length >= 8 &&
        typeof created.body?.data?.downloadUrl === 'string' &&
        typeof created.body?.data?.expiresAt === 'string',
      `status=${created.status}, body=${JSON.stringify(created.body)}`
    );
    const archiveId: string = created.body.data.archiveId;
    const token: string = created.body.data.downloadUrl.split('/').pop();
    createdArchiveIds.push(archiveId);

    // --- Listeleme + tenant izolasyonu ----------------------------------
    const listOwn = await api('GET', '/archives', owner);
    check(
      'Test 11: Firma kendi arşiv listesinde YENİ arşivi görür',
      listOwn.status === 200 && Array.isArray(listOwn.body.data) && listOwn.body.data.some((a: any) => a.id === archiveId),
      `status=${listOwn.status}, ids=${JSON.stringify((listOwn.body.data || []).map((a: any) => a.id))}`
    );

    const listOther = await api('GET', '/archives', otherOwner);
    check(
      'Test 12: BAŞKA bir firma (kusak) bu arşivi listesinde GÖRMEZ (tenant izolasyonu)',
      listOther.status === 200 && Array.isArray(listOther.body.data) && !listOther.body.data.some((a: any) => a.id === archiveId),
      `status=${listOther.status}, ids=${JSON.stringify((listOther.body.data || []).map((a: any) => a.id))}`
    );

    // --- Presigned indirme (JWT'siz) ------------------------------------
    const dl1 = await fetch(`${API_URL}/archives/${archiveId}/download/${token}`);
    const dl1Buf = Buffer.from(await dl1.arrayBuffer());
    check(
      'Test 13: Doğru token ile JWT OLMADAN indirme 200 + geçerli ZIP (PK sihirli byte\'ları)',
      dl1.status === 200 && dl1Buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      `status=${dl1.status}, content-type=${dl1.headers.get('content-type')}, ilk-bytes=${dl1Buf.subarray(0, 4).toString('hex')}`
    );

    const dl2 = await fetch(`${API_URL}/archives/${archiveId}/download/${token}`);
    check('Test 14: AYNI bağlantı İKİNCİ kez de çalışır (tek kullanımlık DEĞİL, "süreli")', dl2.status === 200, `status=${dl2.status}`);

    const wrongToken = crypto.randomBytes(32).toString('hex');
    const dlWrongToken = await fetch(`${API_URL}/archives/${archiveId}/download/${wrongToken}`);
    check('Test 15: YANLIŞ token 404 ile reddedilir', dlWrongToken.status === 404, `status=${dlWrongToken.status}`);

    const dlUnknownArchive = await fetch(`${API_URL}/archives/archive-does-not-exist/download/${token}`);
    check('Test 16: Bilinmeyen archiveId 404 ile reddedilir', dlUnknownArchive.status === 404, `status=${dlUnknownArchive.status}`);

    // --- Süresi dolmuş bağlantı reddi (DB'de expires_at geçmişe çekilerek simüle edilir) ---
    await db.query(`UPDATE tenant_archives SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [archiveId]);
    const dlExpired = await fetch(`${API_URL}/archives/${archiveId}/download/${token}`);
    check('Test 17: Süresi dolmuş bağlantı 404 ile reddedilir', dlExpired.status === 404, `status=${dlExpired.status}`);

    // --- Audit ---------------------------------------------------------
    const auditRows = await db.query(
      `SELECT action FROM audit_logs WHERE tenant_id = 'comp-camsa' AND target_id = $1 ORDER BY created_at ASC`,
      [archiveId]
    );
    const actions = auditRows.rows.map((r) => r.action);
    check(
      'Test 18: Üretim VE (süresi dolmadan önceki) indirmeler audit\'lenir',
      actions.includes('TENANT_ARCHIVE_GENERATED') && actions.filter((a) => a === 'TENANT_ARCHIVE_DOWNLOADED').length >= 2,
      `actions=${JSON.stringify(actions)}`
    );
  } finally {
    for (const id of createdArchiveIds) {
      await db.query('DELETE FROM tenant_archives WHERE id = $1', [id]);
      await db.query(`DELETE FROM audit_logs WHERE target_id = $1`, [id]);
    }
    await db.query(`UPDATE companies SET archive_period_days = NULL, archive_last_generated_at = NULL WHERE id IN ('comp-camsa', 'comp-kusak')`);
    await db.end();
    await resetLoginRateLimit();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
