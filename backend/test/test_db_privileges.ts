import { Client } from 'pg';

/**
 * TEST_PLAN.md §4 — RLS'siz tabloların veritabanı seviyesindeki korumaları.
 *
 * NEDEN BU TEST VAR:
 *   Şemadaki 48 tablonun 46'sı RLS ile korunuyor ve bu, check-rls-coverage.mjs
 *   ile mekanik olarak garanti altında. Geriye RLS'i BİLİNÇLİ olarak olmayan
 *   2 tablo kalıyor:
 *     - companies           (platform seviyesi: tüm firmaların listesi)
 *     - platform_audit_log  (tenant dondurma/kalıcı silme kayıtları)
 *   Bu ikisinde RLS olmadığı için tek savunma app_user'ın YETKİLERİ. Yetkiler
 *   sessizce geniş bırakılırsa, withTenant() içinde çalışan HERHANGİ bir
 *   sorgu (bugün yazılmış ya da yarın eklenecek) bu tabloları değiştirebilir —
 *   ve RLS devrede olmadığı için hiçbir şey onu durdurmaz.
 *
 * TARAMADA BULUNAN (ve bu commit'te düzeltilen) DURUM:
 *   app_user her iki tabloda da DELETE/TRUNCATE/UPDATE yetkisine sahipti.
 *   platform_audit_log, audit_logs ile aynı append-only korumasını hak
 *   ediyordu ama ARCH-108'de eklenirken REVOKE yazılmamıştı.
 *
 * Bu test, korumanın GERÇEKTEN veritabanı seviyesinde uygulandığını
 * doğruluyor — şemadaki REVOKE satırının varlığına bakmakla yetinmiyor,
 * app_user rolüne geçip yazmayı DENİYOR ve reddedildiğini görüyor.
 */

const APPEND_ONLY_AUDIT_TABLES = ['audit_logs', 'platform_audit_log'];

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}

/**
 * Verilen ifadeyi app_user rolüyle, gerçek uygulama akışıyla AYNI şekilde
 * (BEGIN + SET LOCAL ROLE + tenant context) çalıştırır ve reddedilip
 * reddedilmediğini döndürür. withTenant.ts ile aynı kurulum.
 */
async function runAsAppUser(sql: string): Promise<{ rejected: boolean; error?: string; rows?: any[] }> {
  const c = pg();
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user;');
    await c.query("SELECT set_config('app.current_tenant_id', 'comp-camsa', true)");
    const res = await c.query(sql);
    await c.query('ROLLBACK'); // yan etki bırakma
    return { rejected: false, rows: res.rows };
  } catch (err: any) {
    await c.query('ROLLBACK').catch(() => {});
    return { rejected: true, error: err.message };
  } finally {
    await c.end();
  }
}

async function grantsOf(table: string): Promise<string[]> {
  const c = pg();
  await c.connect();
  try {
    const r = await c.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'app_user' AND table_name = $1`,
      [table]
    );
    return r.rows.map((x) => x.privilege_type).sort();
  } finally {
    await c.end();
  }
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §4] RLS\'SİZ TABLOLARIN DB SEVİYESİ KORUMALARI');
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

  // ── 1) Denetim günlükleri gerçekten append-only mi? ────────────────────
  for (const table of APPEND_ONLY_AUDIT_TABLES) {
    const del = await runAsAppUser(`DELETE FROM ${table}`);
    check(
      `${table}: app_user SİLEMEZ (denetim izi yok edilemez)`,
      del.rejected,
      del.rejected ? `reddedildi: ${del.error?.split('\n')[0]}` : '⚠️ SİLME BAŞARILI OLDU — denetim günlüğü korumasız!'
    );

    const trunc = await runAsAppUser(`TRUNCATE ${table}`);
    check(
      `${table}: app_user TRUNCATE edemez (DELETE'ten ayrı komut, aynı sonuç)`,
      trunc.rejected,
      trunc.rejected ? `reddedildi: ${trunc.error?.split('\n')[0]}` : '⚠️ TRUNCATE BAŞARILI OLDU!'
    );

    const upd = await runAsAppUser(`UPDATE ${table} SET action = 'TAMPERED'`);
    check(
      `${table}: app_user DEĞİŞTİREMEZ (geçmişe dönük tahrifat engelli)`,
      upd.rejected,
      upd.rejected ? `reddedildi: ${upd.error?.split('\n')[0]}` : '⚠️ GÜNCELLEME BAŞARILI OLDU!'
    );
  }

  // ── 2) companies: okunabilir ama app_user tarafından YAZILAMAZ ─────────
  const readCompanies = await runAsAppUser("SELECT id FROM companies WHERE id = 'comp-camsa'");
  check(
    'companies: app_user OKUYABİLİR (lisans/modül kontrolü buna bağlı)',
    !readCompanies.rejected && (readCompanies.rows?.length ?? 0) === 1,
    readCompanies.rejected ? `⚠️ okuma reddedildi: ${readCompanies.error}` : `satır=${readCompanies.rows?.length}`
  );

  const insertCompany = await runAsAppUser(
    "INSERT INTO companies (id, name) VALUES ('sahte-firma-test', 'Sahte')"
  );
  check(
    'companies: app_user YENİ FİRMA OLUŞTURAMAZ (tenant üretimi yalnızca SUPER_ADMIN)',
    insertCompany.rejected,
    insertCompany.rejected ? `reddedildi: ${insertCompany.error?.split('\n')[0]}` : '⚠️ EKLEME BAŞARILI OLDU!'
  );

  const updateCompany = await runAsAppUser(
    "UPDATE companies SET license_status = 'AKTİF' WHERE id = 'comp-camsa'"
  );
  check(
    'companies: app_user LİSANS DURUMUNU DEĞİŞTİREMEZ (kendi kendine lisans yükseltme engelli)',
    updateCompany.rejected,
    updateCompany.rejected ? `reddedildi: ${updateCompany.error?.split('\n')[0]}` : '⚠️ GÜNCELLEME BAŞARILI OLDU!'
  );

  const deleteCompany = await runAsAppUser("DELETE FROM companies WHERE id = 'comp-kusak'");
  check(
    'companies: app_user FİRMA SİLEMEZ (CASCADE ile tüm tenant verisi gidebilirdi)',
    deleteCompany.rejected,
    deleteCompany.rejected ? `reddedildi: ${deleteCompany.error?.split('\n')[0]}` : '⚠️ SİLME BAŞARILI OLDU!'
  );

  // ── 3) Yetki listesi beklenen şekilde mi? (regresyon kilidi) ───────────
  const companiesGrants = await grantsOf('companies');
  const forbiddenOnCompanies = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].filter((p) =>
    companiesGrants.includes(p)
  );
  check(
    'companies yetki listesi: yazma yetkisi YOK, SELECT var',
    forbiddenOnCompanies.length === 0 && companiesGrants.includes('SELECT'),
    `yetkiler=[${companiesGrants.join(', ')}]${forbiddenOnCompanies.length ? ` — fazlalık: ${forbiddenOnCompanies.join(',')}` : ''}`
  );

  const auditGrants = await grantsOf('platform_audit_log');
  const forbiddenOnAudit = ['UPDATE', 'DELETE', 'TRUNCATE'].filter((p) => auditGrants.includes(p));
  check(
    'platform_audit_log yetki listesi: UPDATE/DELETE/TRUNCATE YOK (append-only)',
    forbiddenOnAudit.length === 0,
    `yetkiler=[${auditGrants.join(', ')}]${forbiddenOnAudit.length ? ` — fazlalık: ${forbiddenOnAudit.join(',')}` : ''}`
  );

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');

  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
