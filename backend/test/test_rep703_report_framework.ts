import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { getReportDefinition } from '../src/reports/index';
import { registerReport } from '../src/reports/reportRegistry';

/**
 * TEST_PLAN.md / GitHub #166 [REP-703] — ortak rapor çatısı.
 *
 * NEDEN: 13 rapor (REP-711..REP-723) bu çatıya bağımlı; çatının kendisi
 * yanlışsa hepsi yanlış olur. Bu test iki KAYITLI rapor üzerinden (rep-711
 * transactions, rep-722 audit_logs — bilerek farklı tablo + farklı rol
 * kümesi) motoru sınıyor: rol bazlı katalog görünürlüğü, filtre whitelist'i
 * (SQL injection + whitelist DIŞI gerçek sütun adı testi dahil), sayfalama,
 * tenant izolasyonu (RLS'in yeni jenerik motor üzerinden de devrede olduğu),
 * CSV/PDF export ve PDF satır sınırı.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const MARKER_PLATE = `34 REP703 ${String(RUN).slice(-4)}`;

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
async function getJson(path: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function getRaw(path: string, token: string): Promise<Response> {
  return fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN / GitHub #166] REP-703 ORTAK RAPOR ÇATISI');
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

  try {
    const admin = await login('admin');
    const owner = await login('camsa');
    const kusak = await login('kusak');
    const pumpOp = await login('pompa-op-01');
    const gebzeManager = await login('gebze-santiye');

    // ── Fixture: camsa'ya (Gebze Ana Şantiye) benzersiz plakalı 3 satır ──
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, type, created_at)
         VALUES ($1, 'comp-camsa', 'Gebze Ana Şantiye', $2, 'REP703 Test Şoförü', $3, 'Manuel', NOW() - ($4 || ' minutes')::interval)`,
        [`tx-rep703-${RUN}-${i}`, MARKER_PLATE, 25 + i, i]
      );
    }

    // ── Test 1-2: Katalog rol görünürlüğü (AC: "yalnızca yetkili olduğu raporları listeleyebilmeli") ──
    const catalogPump = await getJson('/reports', pumpOp);
    const catalogOwner = await getJson('/reports', owner);
    const pumpIds = catalogPump.body.data.map((r: any) => r.id);
    const ownerIds = catalogOwner.body.data.map((r: any) => r.id);
    check('Test 1: PUMP_OPERATOR kataloğunda rep-711 var ama rep-722 (audit) YOK',
      pumpIds.includes('rep-711') && !pumpIds.includes('rep-722'), `pumpIds=${JSON.stringify(pumpIds)}`);
    check('Test 2: COMPANY_OWNER kataloğunda HER İKİSİ de var', ownerIds.includes('rep-711') && ownerIds.includes('rep-722'), `ownerIds=${JSON.stringify(ownerIds)}`);

    // ── Test 3-4: RBAC — direkt erişim + bilinmeyen id ──
    const pumpDirectAudit = await getRaw('/reports/rep-722', pumpOp);
    check('Test 3: PUMP_OPERATOR /reports/rep-722\'ye DİREKT erişimde 403 alır (yalnızca kataloğu gizlemek yetmez)', pumpDirectAudit.status === 403, `status=${pumpDirectAudit.status}`);
    const unknownReport = await getRaw('/reports/boyle-bir-rapor-yok', owner);
    check('Test 4: bilinmeyen rapor id\'si 404 döner', unknownReport.status === 404, `status=${unknownReport.status}`);

    // ── Test 5: filtreleme + aggregate doğruluğu (fixture'ın kendi satırları üzerinden) ──
    const filtered = await getJson(`/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE)}`, owner);
    const expectedTotal = 25 + 26 + 27;
    check('Test 5: plaka filtresi TAM 3 satır döner ve total_liters aggregate\'i doğru toplar',
      filtered.body.data?.length === 3 && Number(filtered.body.aggregates?.total_liters) === expectedTotal,
      `satır=${filtered.body.data?.length}, total_liters=${filtered.body.aggregates?.total_liters} (beklenen ${expectedTotal})`);

    // ── Test 6: SQL injection — filtre DEĞERİ olarak metakarakterler ──
    const beforeCount = Number((await db.query('SELECT count(*) FROM transactions')).rows[0].count);
    const injection = await getJson(`/reports/rep-711?driverName=${encodeURIComponent("x'; DROP TABLE transactions; --")}`, owner);
    const afterCount = Number((await db.query('SELECT count(*) FROM transactions')).rows[0].count);
    check('Test 6: SQL metakarakterli filtre değeri düz metin olarak ele alınır (hata yok, 0 satır, tablo SAĞLAM)',
      injection.status === 200 && injection.body.data.length === 0 && beforeCount === afterCount,
      `status=${injection.status}, satır=${injection.body.data?.length}, öncesi=${beforeCount}, sonrası=${afterCount}`);

    // ── Test 7: whitelist DIŞI gerçek sütun adı hiçbir etki YAPMAZ ──
    const withoutParam = await getJson(`/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE)}`, owner);
    const withBogusRealColumn = await getJson(`/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE)}&hash_signature=her-hangi-bir-deger`, owner);
    check('Test 7: rapor tanımında olmayan (ama tabloda GERÇEKTEN var olan) bir sütun adı query param\'ı olarak gönderilirse yok sayılır',
      withBogusRealColumn.status === 200 && withBogusRealColumn.body.data.length === withoutParam.body.data.length,
      `parametresiz=${withoutParam.body.data.length}, sahte-sütun-ile=${withBogusRealColumn.body.data.length}`);

    // ── Test 8: sayfalama sınırı — transactionQuerySchema (REP-701) İLE AYNI
    // sözleşme: pageSize>100 KIRPILMAZ, 400 ile REDDEDİLİR (sessizce farklı
    // bir sayfa boyutuyla devam etmek yerine istemciye açıkça bildirilir).
    const bigPageSize = await getRaw(`/reports/rep-711?pageSize=500`, owner);
    const normalPageSize = await getJson(`/reports/rep-711?pageSize=100`, owner);
    check('Test 8: pageSize=500 → 400 VALIDATION_ERROR (REP-701 ile aynı sözleşme); pageSize=100 kabul edilir',
      bigPageSize.status === 400 && normalPageSize.status === 200 && normalPageSize.body.pagination?.pageSize === 100,
      `pageSize=500 → ${bigPageSize.status}; pageSize=100 → ${normalPageSize.status}/${normalPageSize.body.pagination?.pageSize}`);

    // ── Test 9: tenant izolasyonu — kusak, camsa'nın fixture satırlarını GÖRMEZ ──
    const kusakView = await getJson(`/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE)}`, kusak);
    check('Test 9: rep-711 üzerinden BAŞKA tenant\'ın (kusak) fixture satırlarını görmesi mümkün DEĞİL (RLS yeni motorda da devrede)',
      kusakView.body.data.length === 0, `kusak gördüğü satır=${kusakView.body.data.length}`);

    // ── Test 10: SITE_MANAGER site kapsamı istemci girdisini EZER ──
    const gebzeOverride = await getJson(`/reports/rep-711?siteName=${encodeURIComponent('Orman Şantiyesi')}&vehiclePlate=${encodeURIComponent(MARKER_PLATE)}`, gebzeManager);
    check('Test 10: SITE_MANAGER \'siteName=Orman\' filtresi göndersin, kendi şantiyesinin (Gebze) fixture satırlarını GÖRMEYE devam eder',
      gebzeOverride.body.data.length === 3, `satır=${gebzeOverride.body.data.length}`);

    // ── Test 11-12: CSV export ──
    const csvRes = await getRaw(`/reports/rep-711/export?format=csv&vehiclePlate=${encodeURIComponent(MARKER_PLATE)}`, owner);
    const csvText = await csvRes.text();
    const csvLines = csvText.trim().split('\r\n');
    check('Test 11: CSV export doğru content-type ile döner ve başlık satırı Türkçe sütun adlarını içerir',
      csvRes.headers.get('content-type')?.includes('text/csv') === true && csvLines[0].includes('Şantiye'),
      `content-type=${csvRes.headers.get('content-type')}, başlık=${csvLines[0]?.slice(0, 60)}`);
    check('Test 12: CSV veri satırı sayısı fixture ile TAM eşleşir (3 başlık dışı satır)', csvLines.length - 1 === 3, `satır=${csvLines.length - 1}`);

    // ── Test 13: PDF export — geçerli PDF + Türkçe başlık ──
    const pdfRes = await getRaw(`/reports/rep-711/export?format=pdf&vehiclePlate=${encodeURIComponent(MARKER_PLATE)}`, owner);
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
    check('Test 13: PDF export geçerli bir PDF üretir (%PDF imzası + application/pdf)',
      pdfRes.headers.get('content-type') === 'application/pdf' && pdfBuffer.subarray(0, 5).toString('latin1') === '%PDF-',
      `content-type=${pdfRes.headers.get('content-type')}, ilk-bytes=${pdfBuffer.subarray(0, 8).toString('latin1')}`);

    // ── Test 14: PDF satır sınırı — kuyruksuz bir süreçte sınırsız PDF üretimini
    // engeller. NOT: bu test HTTP üzerinden ayrı bir SÜRECE (canlı backend
    // konteynerine) istek atıyor — reportEngine.ts'in DEFAULT_MAX_PDF_ROWS'unu
    // (2000) bu test SÜRECİNDE mutasyonla düşürmek sunucu sürecini ETKİLEMEZ
    // (iki ayrı Node process/module registry). Bu yüzden gerçek varsayılan
    // sınırı GERÇEKTEN aşan bir fixture (2001 satır) kullanılıyor.
    const pdfCapPlate = `34 PDFCAP ${String(RUN).slice(-4)}`;
    await db.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, type, created_at)
       SELECT 'tx-rep703-pdfcap-' || $1 || '-' || g, 'comp-camsa', 'Gebze Ana Şantiye', $2, 'PDF Sınır Testi', 1, 'Manuel', NOW()
       FROM generate_series(1, 2001) g`,
      [RUN, pdfCapPlate]
    );
    const pdfTooLarge = await getRaw(`/reports/rep-711/export?format=pdf&vehiclePlate=${encodeURIComponent(pdfCapPlate)}`, owner);
    const pdfTooLargeBody = await pdfTooLarge.json().catch(() => ({}));
    await db.query('DELETE FROM transactions WHERE id LIKE $1', [`tx-rep703-pdfcap-${RUN}-%`]);
    check('Test 14: satır sayısı varsayılan maxPdfRows (2000) sınırını aşan bir PDF isteği (2001 satır) 400 PDF_EXPORT_TOO_LARGE ile reddedilir (kuyruksuz süreç koruması)',
      pdfTooLarge.status === 400 && pdfTooLargeBody.details?.error === 'PDF_EXPORT_TOO_LARGE' && pdfTooLargeBody.details?.totalCount === 2001,
      `status=${pdfTooLarge.status}, body=${JSON.stringify(pdfTooLargeBody).slice(0, 160)}`);

    // ── Test 15: aynı rapor id'sinin iki kez kaydı reddedilir (programlama hatası koruması) ──
    let doubleRegisterThrew = false;
    try {
      registerReport(getReportDefinition('rep-711')!);
    } catch {
      doubleRegisterThrew = true;
    }
    check('Test 15: aynı rapor id\'siyle çift kayıt denemesi hata fırlatır', doubleRegisterThrew, `fırlattı mı=${doubleRegisterThrew}`);

    // ── Test 16: admin (SUPER_ADMIN) her iki raporu da kullanabilir ──
    const adminRun = await getJson('/reports/rep-722?pageSize=1', admin);
    check('Test 16: SUPER_ADMIN rep-722\'yi çalıştırabilir (200)', adminRun.status === 200, `status=${adminRun.status}`);

    // ── Test 17-18: sıralama — whitelist'li sortBy/sortDir + geçersiz sortBy fallback ──
    const sortedAsc = await getJson(`/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE)}&sortBy=amount_liters&sortDir=asc`, owner);
    const amounts = sortedAsc.body.data.map((r: any) => Number(r.amount_liters));
    check('Test 17: sortBy=amount_liters&sortDir=asc GERÇEKTEN artan sırada döner (varsayılan created_at DESC değil)',
      sortedAsc.body.sort?.column === 'amount_liters' && sortedAsc.body.sort?.direction === 'ASC' &&
        amounts.every((v: number, i: number) => i === 0 || amounts[i - 1] <= v),
      `sort=${JSON.stringify(sortedAsc.body.sort)}, amounts=${JSON.stringify(amounts)}`);

    const invalidSort = await getJson(`/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE)}&sortBy=hash_signature`, owner);
    check('Test 18: rapor tanımında olmayan bir sortBy (hash_signature, tabloda gerçekten var) sessizce defaultSort\'a düşer',
      invalidSort.status === 200 && invalidSort.body.sort?.column === 'created_at' && invalidSort.body.sort?.direction === 'DESC',
      `sort=${JSON.stringify(invalidSort.body.sort)}`);

    // PDF-özgü regresyon testleri (Türkçe font gömme, aynı süreçte ardışık
    // istekler, sayfa sayısı doğruluğu) BİLEREK bu dosyada DEĞİL —
    // test_rep703_pdf_regression.ts'te, KENDİ başına. Sebep: bu üç kontrol
    // BURAYA (17 test SONRASINA, aynı süreç/dosyada) eklendiğinde, altta
    // yatan gerçek bug'lar (mutasyonla kanıtlandı: font kaydı ENOENT'i,
    // sayfa ikiye katlanması) sunucuda hâlâ AKTİF olsa da testler yeşil
    // kalıyordu — 3 bağımsız yöntemle (curl, docker exec wget, ayrı bir
    // node script'i) sunucunun GERÇEKTEN bozuk davrandığı doğrulanmasına
    // KARŞIN. Kök neden tespit edilemedi (muhtemelen Node/undici fetch
    // bağlantı havuzunun bu dosyada BİRİKEN ~20+ önceki isteğiyle bir
    // etkileşimi) — ama AYNI kontroller KENDİ dosyalarında (sıfır önceki
    // istek) HER SEFERİNDE güvenilir biçimde doğru/yanlışı yakalıyor. Testin
    // KENDİSİNİN sessizce yanlış geçmesi, hiç test olmamasından DAHA
    // KÖTÜdür — bu yüzden buradan çıkarıldı.
  } finally {
    await db.query('DELETE FROM transactions WHERE id LIKE $1', [`tx-rep703-${RUN}-%`]);
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
