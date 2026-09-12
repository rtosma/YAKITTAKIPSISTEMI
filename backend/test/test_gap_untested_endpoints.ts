import { Client } from 'pg';

/**
 * TEST_PLAN.md §0.1 — "Hiç test edilmemiş uçlar" (GAP-1 / GAP-2).
 *
 * routes.ts'teki 207 uç, 59 test dosyasının içeriğiyle programatik olarak
 * karşılaştırıldığında (statik path prefix eşleştirmesi) 205'inin en az bir
 * testte geçtiği, ikisinin ise HİÇ test edilmediği bulundu:
 *
 *   GAP-1  GET /policies/fail-open/offline-ratio-alerts
 *          RBAC'lı bir okuma ucu (HARDWARE_DEVICE_MANAGER_ROLES). Hiç test
 *          edilmediği için ne rol kontrolü, ne tenant izolasyonu, ne de
 *          eşik/zaman-penceresi mantığı doğrulanmıştı.
 *
 *   GAP-2  GET /tenant-info
 *          Tanılama ucu. Tarama sırasında KİMLİK DOĞRULAMASIZ olduğu
 *          görüldü (bkz. routes.ts'teki not) — authenticateJWT arkasına
 *          alındı; bu dosya yeni davranışı kilitliyor.
 *
 * ÇALIŞTIRMA BAĞLAMI (TEST_PLAN.md §2.3, kategori 1):
 *   Bu test hem HTTP (backend:5000) hem doğrudan Postgres erişimi ister.
 *   Yerelde backend konteynerinin ağ ad alanından çalıştırılmalıdır:
 *     docker run --rm --network "container:$(docker compose ps -q backend)" \
 *       -e POSTGRES_HOST=postgres -v "$PWD/backend/test:/app/test:ro" \
 *       yakittakipsistemi-backend:test-runner npx tsx test/test_gap_untested_endpoints.ts
 *   CI'daki auth-integration-test işinde backend zaten 5000'de çıplak
 *   çalıştığı için varsayılan API_URL doğrudur (nginx YOK — port 3000 DEĞİL).
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';

// tenantDb.ts: const OFFLINE_DISPENSE_RATIO_ALERT_THRESHOLD = 0.15;
// Testler bu sabiti VARSAYMIYOR, sınır davranışını (dahil mi, hariç mi)
// açıkça doğruluyor — eşik değişirse Test 10 bunu yakalar.
const THRESHOLD = 0.15;

const RUN_ID = Date.now();
const SITE_HIGH = `GAP1-Yuksek-${RUN_ID}`;
const SITE_LOW = `GAP1-Dusuk-${RUN_ID}`;
const SITE_BOUNDARY = `GAP1-Sinir-${RUN_ID}`;
const SITE_OLD = `GAP1-Eski-${RUN_ID}`;
const SITE_OTHER_TENANT = `GAP1-Kusak-${RUN_ID}`;

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
    const r = await c.query(sql, params);
    return r.rows;
  } finally {
    await c.end();
  }
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; rawAuthHeader?: string } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.rawAuthHeader !== undefined) headers['Authorization'] = opts.rawAuthHeader;
  const res = await fetch(`${API_URL}${path}`, { method, headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function login(username: string): Promise<string> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const body = await res.json().catch(() => ({}));
  if (!body.accessToken) {
    throw new Error(`'${username}' ile giriş yapılamadı (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  return body.accessToken;
}

/**
 * Belirli bir orana sahip ikmal kaydı kümesi üretir.
 * `type = 'Çevrimdışı Senkron'` olanlar "offline" sayılır (bkz. tenantDb.ts
 * getOfflineDispenseRatioAlerts sorgusundaki FILTER koşulu).
 */
async function seedDispenses(opts: {
  tenantId: string;
  siteName: string;
  total: number;
  offline: number;
  daysAgo?: number;
}): Promise<void> {
  const { tenantId, siteName, total, offline, daysAgo = 1 } = opts;
  for (let i = 0; i < total; i++) {
    const isOffline = i < offline;
    await q(
      `INSERT INTO transactions
         (id, tenant_id, site_name, vehicle_plate, amount_liters, type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() - ($7 || ' days')::interval)`,
      [
        `gap1-${RUN_ID}-${siteName}-${i}`,
        tenantId,
        siteName,
        '34 GAP 001',
        10,
        isOffline ? 'Çevrimdışı Senkron' : 'Manuel',
        daysAgo
      ]
    );
  }
}

async function cleanup(): Promise<void> {
  await q('DELETE FROM transactions WHERE id LIKE $1', [`gap1-${RUN_ID}-%`]);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §0.1] HİÇ TEST EDİLMEMİŞ UÇLAR (GAP-1 / GAP-2)');
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

  const ALERTS = '/policies/fail-open/offline-ratio-alerts';

  try {
    await cleanup(); // önceki yarım kalmış koşulardan artık kalmasın

    // ── Fixture ────────────────────────────────────────────────────────
    // %30 offline (eşik ÜSTÜ)           → alarm ÜRETMELİ
    await seedDispenses({ tenantId: 'comp-camsa', siteName: SITE_HIGH, total: 10, offline: 3 });
    // %10 offline (eşik ALTI)           → alarm ÜRETMEMELİ
    await seedDispenses({ tenantId: 'comp-camsa', siteName: SITE_LOW, total: 10, offline: 1 });
    // TAM %15 (eşiğin kendisi)          → kod `> threshold` kullanıyor, ÜRETMEMELİ
    await seedDispenses({ tenantId: 'comp-camsa', siteName: SITE_BOUNDARY, total: 20, offline: 3 });
    // %100 offline ama 40 gün önce      → 30 günlük pencere dışı, ÜRETMEMELİ
    await seedDispenses({ tenantId: 'comp-camsa', siteName: SITE_OLD, total: 5, offline: 5, daysAgo: 40 });
    // Başka tenant, %50 offline         → comp-camsa'nın yanıtında GÖRÜNMEMELİ
    await seedDispenses({ tenantId: 'comp-kusak', siteName: SITE_OTHER_TENANT, total: 10, offline: 5 });

    const ownerToken = await login('camsa');        // COMPANY_OWNER  (comp-camsa)
    const adminToken = await login('admin');        // SUPER_ADMIN    (comp-camsa)
    const operatorToken = await login('pompa-op-01'); // PUMP_OPERATOR (yetkisiz)
    const siteManagerToken = await login('gebze-santiye'); // SITE_MANAGER (yetkisiz)
    const otherTenantToken = await login('kusak');  // COMPANY_OWNER  (comp-kusak)

    // ═══ GAP-1: /policies/fail-open/offline-ratio-alerts ═══════════════

    // ── Kimlik doğrulama katmanı ───────────────────────────────────────
    const noAuth = await call('GET', ALERTS);
    check('Test 1: Token olmadan erişim reddedilir', noAuth.status === 401, `status=${noAuth.status}, error=${noAuth.body?.error}`);

    const badToken = await call('GET', ALERTS, { token: 'gecersiz.jwt.token' });
    check('Test 2: Bozuk/geçersiz token reddedilir', badToken.status === 401, `status=${badToken.status}, error=${badToken.body?.error}`);

    const malformedHeader = await call('GET', ALERTS, { rawAuthHeader: 'Token abc123' });
    check(
      'Test 3: "Bearer" öneki olmayan Authorization başlığı reddedilir',
      malformedHeader.status === 401,
      `status=${malformedHeader.status}, error=${malformedHeader.body?.error}`
    );

    // ── Yetkilendirme (RBAC) katmanı ───────────────────────────────────
    const asOperator = await call('GET', ALERTS, { token: operatorToken });
    check('Test 4: PUMP_OPERATOR erişemez (403)', asOperator.status === 403, `status=${asOperator.status}, error=${asOperator.body?.error}`);

    const asSiteManager = await call('GET', ALERTS, { token: siteManagerToken });
    check('Test 5: SITE_MANAGER erişemez (403)', asSiteManager.status === 403, `status=${asSiteManager.status}, error=${asSiteManager.body?.error}`);

    const asOwner = await call('GET', ALERTS, { token: ownerToken });
    check('Test 6: COMPANY_OWNER erişebilir (200)', asOwner.status === 200, `status=${asOwner.status}`);

    const asAdmin = await call('GET', ALERTS, { token: adminToken });
    check('Test 7: SUPER_ADMIN erişebilir (200)', asAdmin.status === 200, `status=${asAdmin.status}`);

    // ── Yanıt sözleşmesi ───────────────────────────────────────────────
    const shapeOk =
      asOwner.body?.success === true &&
      typeof asOwner.body?.totalCount === 'number' &&
      Array.isArray(asOwner.body?.data) &&
      asOwner.body.totalCount === asOwner.body.data.length;
    check(
      'Test 8: Yanıt sözleşmesi { success, totalCount, data[] } ve totalCount === data.length',
      shapeOk,
      `success=${asOwner.body?.success}, totalCount=${asOwner.body?.totalCount}, data.length=${asOwner.body?.data?.length}`
    );

    const rows: Array<{ siteName: string; totalDispenses: number; offlineDispenses: number; offlineRatio: number }> =
      asOwner.body.data || [];
    const bySite = (name: string) => rows.find((r) => r.siteName === name);

    // ── İş mantığı: eşik ───────────────────────────────────────────────
    const high = bySite(SITE_HIGH);
    check(
      'Test 9: Eşik ÜSTÜ şantiye (%30) alarm listesinde ve oran doğru hesaplanmış',
      !!high && high.totalDispenses === 10 && high.offlineDispenses === 3 && Math.abs(high.offlineRatio - 0.3) < 1e-9,
      high ? `total=${high.totalDispenses}, offline=${high.offlineDispenses}, ratio=${high.offlineRatio}` : 'şantiye listede YOK'
    );

    check(
      `Test 10: TAM eşikteki şantiye (%15 = ${THRESHOLD}) listede YOK (sınır dahil değil, kod "> eşik" kullanıyor)`,
      bySite(SITE_BOUNDARY) === undefined,
      `SITE_BOUNDARY listede mi: ${bySite(SITE_BOUNDARY) !== undefined}`
    );

    check(
      'Test 11: Eşik ALTI şantiye (%10) listede YOK',
      bySite(SITE_LOW) === undefined,
      `SITE_LOW listede mi: ${bySite(SITE_LOW) !== undefined}`
    );

    // ── İş mantığı: zaman penceresi ────────────────────────────────────
    check(
      'Test 12: 30 günlük pencere DIŞINDAKİ kayıtlar (40 gün önce, %100 offline) sayılmaz',
      bySite(SITE_OLD) === undefined,
      `SITE_OLD listede mi: ${bySite(SITE_OLD) !== undefined}`
    );

    // ── Tenant izolasyonu (RLS) — en kritik kontrol ────────────────────
    check(
      'Test 13: BAŞKA tenant\'ın şantiyesi (comp-kusak, %50 offline) comp-camsa yanıtında GÖRÜNMEZ',
      bySite(SITE_OTHER_TENANT) === undefined,
      `Sızıntı var mı: ${bySite(SITE_OTHER_TENANT) !== undefined}`
    );

    const otherTenantRes = await call('GET', ALERTS, { token: otherTenantToken });
    const otherRows: Array<{ siteName: string }> = otherTenantRes.body?.data || [];
    const seesOwn = otherRows.some((r) => r.siteName === SITE_OTHER_TENANT);
    const seesForeign = otherRows.some((r) => [SITE_HIGH, SITE_LOW, SITE_BOUNDARY, SITE_OLD].includes(r.siteName));
    check(
      'Test 14: comp-kusak KENDİ şantiyesini görür, comp-camsa\'nınkileri GÖRMEZ (çift yönlü izolasyon)',
      seesOwn && !seesForeign,
      `kendi verisi görünüyor=${seesOwn}, yabancı veri sızıyor=${seesForeign}`
    );

    // ═══ GAP-2: /tenant-info ═══════════════════════════════════════════

    const infoNoAuth = await call('GET', '/tenant-info');
    check(
      'Test 15: /tenant-info artık kimlik doğrulaması ister (401) — önceden herkese AÇIKTI',
      infoNoAuth.status === 401,
      `status=${infoNoAuth.status}, error=${infoNoAuth.body?.error}`
    );

    const infoOwner = await call('GET', '/tenant-info', { token: ownerToken });
    check(
      'Test 16: Kimlik doğrulamalı çağrıda context DOLU döner (uç artık gerçekten işlevsel)',
      infoOwner.status === 200 && !!infoOwner.body?.context && typeof infoOwner.body.context.tenantId === 'string',
      `status=${infoOwner.status}, context=${JSON.stringify(infoOwner.body?.context)}`
    );

    const infoOther = await call('GET', '/tenant-info', { token: otherTenantToken });
    check(
      'Test 17: Her kullanıcı KENDİ tenant context\'ini görür (çapraz sızıntı yok)',
      infoOwner.body?.context?.tenantId === 'comp-camsa' && infoOther.body?.context?.tenantId === 'comp-kusak',
      `camsa→${infoOwner.body?.context?.tenantId}, kusak→${infoOther.body?.context?.tenantId}`
    );
  } finally {
    await cleanup();
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');

  if (passed !== total) process.exit(1);
}

run().catch(async (err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  try {
    await cleanup();
  } catch {
    // temizlik de başarısızsa süreç zaten hata koduyla çıkıyor
  }
  process.exit(1);
});
