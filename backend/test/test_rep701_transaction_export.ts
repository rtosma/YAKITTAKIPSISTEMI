// bkz. transactionExportService.ts'teki yorum: Node ESM'de exceljs (CJS)
// yalnızca default import ile tam module.exports'u verir.
import ExcelJS from 'exceljs';
import Redis from 'ioredis';

/**
 * REP-701 — Bellek dostu stream Excel dışa aktarımı + dinamik GENEL TOPLAM
 * satırı.
 *
 * Not: bu test büyük hacimli (örn. 100.000 satır) bir dışa aktarımı GERÇEKTEN
 * çalıştırıp bellek ölçmüyor — bu, HTTP round-trip'leriyle her testte dakikalar
 * sürecek bir yük testi olurdu (TEST-1002'nin kapsamı). Bunun yerine
 * doğruluğu (filtreleme, şantiye kısıtlaması, GENEL TOPLAM hesabı, header'lar)
 * doğrular; keyset sayfalamanın O(1) sayfa maliyeti ve WorkbookWriter'ın
 * stream doğası kod incelemesiyle garanti edilen tasarım özellikleridir.
 */

const API_URL = 'http://localhost:5000/api/v1';
// Bu test dosyasına özel, önceki test çalışmalarının transactions
// kayıtlarıyla ASLA çakışmayacak bir şantiye adı — filtreli sorguların
// sadece bu testin ürettiği satırları görmesini garanti eder.
const RUN_TAG = Date.now();
const TEST_SITE = `REP701-Test-Sahasi-${RUN_TAG}`;

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });

async function resetIpLoginRateLimit(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetIpLoginRateLimit();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function login(username: string): Promise<string> {
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

async function dispense(token: string, siteName: string, vehiclePlate: string, amountLiters: number): Promise<void> {
  const res = await call('POST', '/dispense', {
    token,
    body: { siteName, vehiclePlate, amountLiters, type: 'Manuel' }
  });
  if (res.status !== 200) throw new Error(`Ön koşul: dispense başarısız (${siteName}/${vehiclePlate}): ${JSON.stringify(res.body)}`);
}

interface ExportResult {
  status: number;
  contentType: string | null;
  contentDisposition: string | null;
  workbook?: ExcelJS.Workbook;
}

async function exportTransactions(token: string | undefined, query: Record<string, string>): Promise<ExportResult> {
  const qs = new URLSearchParams(query).toString();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/transactions/export?${qs}`, { headers });
  const contentType = res.headers.get('content-type');
  const contentDisposition = res.headers.get('content-disposition');
  if (res.status !== 200) {
    return { status: res.status, contentType, contentDisposition };
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return { status: res.status, contentType, contentDisposition, workbook };
}

/** Header satırı (1) ve GENEL TOPLAM satırı (son) hariç tüm veri satırlarının
 *  "Alınan Miktar (Litre)" (6. sütun) değerlerini döndürür. */
function dataRowAmounts(sheet: ExcelJS.Worksheet): number[] {
  const amounts: number[] = [];
  const lastRowNumber = sheet.rowCount;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || rowNumber === lastRowNumber) return;
    amounts.push(Number(row.getCell(6).value));
  });
  return amounts;
}

function totalRow(sheet: ExcelJS.Worksheet): { label: unknown; amount: unknown } {
  const row = sheet.getRow(sheet.rowCount);
  return { label: row.getCell(1).value, amount: row.getCell(6).value };
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [REP-701] STREAM EXCEL DIŞA AKTARIMI + GENEL TOPLAM TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  function check(name: string, condition: boolean, detail: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      console.log(`   ${detail}\n`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${name}`);
      console.log(`   ${detail}\n`);
    }
  }

  const camsaToken = await login('camsa'); // COMPANY_OWNER, comp-camsa — tüm şantiyeleri görür
  const gebzeToken = await login('gebze-santiye'); // SITE_MANAGER, 'Gebze Ana Şantiye'

  // --- Ön koşul verisi ---------------------------------------------------
  const OTHER_SITE = `REP701-Diger-Saha-${RUN_TAG}`;
  await dispense(camsaToken, TEST_SITE, '34 REP 701', 10.5);
  await dispense(camsaToken, TEST_SITE, '34 REP 702', 20.25);
  await dispense(camsaToken, TEST_SITE, '34 REP 703', 30.75);
  await dispense(camsaToken, OTHER_SITE, '34 REP 999', 999);
  // Gebze Ana Şantiye SITE_MANAGER'ının KENDİ şantiyesine yaptığı bir ikmal —
  // Test 4/5'te "SITE_MANAGER kendi şantiyesini görür" kontrolü için.
  await dispense(gebzeToken, 'Gebze Ana Şantiye', '41 GBZ 001', 55.5);

  // Test 1: kimlik doğrulaması olmadan erişim reddedilmeli.
  const r1 = await exportTransactions(undefined, { siteName: TEST_SITE });
  check(
    'Test 1: Yetkisiz (token yok) erişim reddi',
    r1.status === 401,
    `Beklenen: 401, Alınan: ${r1.status}`
  );

  // Test 2: doğru Content-Type ve Content-Disposition header'ları.
  const r2 = await exportTransactions(camsaToken, { siteName: TEST_SITE });
  check(
    'Test 2: Content-Type xlsx MIME tipinde',
    r2.contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    `Alınan Content-Type: ${r2.contentType}`
  );
  check(
    'Test 3: Content-Disposition ".xlsx" ekli indirme olarak işaretli',
    !!r2.contentDisposition && r2.contentDisposition.includes('attachment') && r2.contentDisposition.endsWith('.xlsx"'),
    `Alınan Content-Disposition: ${r2.contentDisposition}`
  );

  // Test 4: siteName filtresi yalnızca o şantiyenin kayıtlarını döndürmeli
  // (OTHER_SITE'ın 999 L'lik kaydı SIZMAMALI).
  const sheet2 = r2.workbook!.worksheets[0];
  const amounts2 = dataRowAmounts(sheet2).sort((a, b) => a - b);
  check(
    'Test 4: siteName filtresi doğru satırları döndürüyor',
    JSON.stringify(amounts2) === JSON.stringify([10.5, 20.25, 30.75]),
    `Beklenen: [10.5, 20.25, 30.75], Alınan: ${JSON.stringify(amounts2)}`
  );

  // Test 5: GENEL TOPLAM satırı, filtrelenen kayıtların litre toplamına eşit.
  const total2 = totalRow(sheet2);
  check(
    'Test 5: GENEL TOPLAM satırı doğru toplamı gösteriyor',
    total2.label === 'GENEL TOPLAM' && Math.abs(Number(total2.amount) - 61.5) < 0.001,
    `Beklenen etiket 'GENEL TOPLAM' / toplam 61.5, Alınan: ${JSON.stringify(total2)}`
  );

  // Test 6: header sütun isimleri ticket'ın AC'siyle uyumlu.
  const headerRow = sheet2.getRow(1).values as unknown[];
  const headerTexts = (headerRow as any[]).filter((v) => v !== undefined && v !== null);
  check(
    'Test 6: Excel başlık satırı beklenen sütunları içeriyor',
    headerTexts.includes('Alınan Miktar (Litre)') && headerTexts.includes('Tarih') && headerTexts.includes('Araç Plakası'),
    `Alınan başlıklar: ${JSON.stringify(headerTexts)}`
  );

  // Test 7: SITE_MANAGER (Gebze) export'unda sunucu tarafı şantiye kısıtlaması
  // uygulanır — istemci OTHER_SITE'ı sorgulasa BİLE yalnızca kendi
  // şantiyesinin kayıtlarını görür (AUTH-201.4 ile aynı desen). Bu container
  // uzun süredir ayakta olduğu için Gebze'nin GEÇMİŞTEN başka kayıtları da
  // olabilir — bu yüzden tam liste eşitliği yerine (a) bu testin kendi
  // kaydının (55.5) mevcut olduğu, (b) OTHER_SITE'a özgü, oldukça belirgin
  // 999 L'lik kaydın SIZMADIĞI doğrulanıyor.
  const r7 = await exportTransactions(gebzeToken, { siteName: OTHER_SITE });
  const amounts7 = dataRowAmounts(r7.workbook!.worksheets[0]);
  check(
    'Test 7: SITE_MANAGER, istemci siteName\'i geçersiz kılınarak kendi şantiyesine kısıtlanıyor',
    amounts7.includes(55.5) && !amounts7.includes(999),
    `Gebze'nin kendi kaydı (55.5) içermeli, OTHER_SITE'ın 999 L'lik kaydını İÇERMEMELİ. Alınan: ${JSON.stringify(amounts7)}`
  );

  // Test 8: eşleşen kayıt yoksa hata değil, yalnızca header + GENEL
  // TOPLAM=0 satırından oluşan boş bir dosya dönmeli.
  const r8 = await exportTransactions(camsaToken, { siteName: `REP701-Bos-Saha-${RUN_TAG}` });
  const sheet8 = r8.workbook!.worksheets[0];
  const amounts8 = dataRowAmounts(sheet8);
  const total8 = totalRow(sheet8);
  check(
    'Test 8: eşleşen kayıt yokken boş sonuç + GENEL TOPLAM=0 (hata değil)',
    r8.status === 200 && amounts8.length === 0 && Number(total8.amount) === 0,
    `status=${r8.status}, veri satırı=${amounts8.length}, toplam=${total8.amount}`
  );

  // Test 9: vehicle plakasına göre arama (search) filtresi export'ta da çalışıyor.
  const r9 = await exportTransactions(camsaToken, { siteName: TEST_SITE, search: '34 REP 702' });
  const amounts9 = dataRowAmounts(r9.workbook!.worksheets[0]);
  check(
    'Test 9: search filtresi export\'ta da uygulanıyor',
    amounts9.length === 1 && amounts9[0] === 20.25,
    `Beklenen: [20.25], Alınan: ${JSON.stringify(amounts9)}`
  );

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');

  await redis.quit();
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('💥 Test çalıştırma hatası:', err);
  process.exit(1);
});
