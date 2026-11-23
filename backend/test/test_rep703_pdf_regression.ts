import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md / GitHub #166 [REP-703] — PDF export regresyon testleri.
 *
 * BİLEREK KENDİ dosyasında, test_rep703_report_framework.ts'in İÇİNDE DEĞİL:
 * bu üç kontrol o dosyada (17 test SONRASINA eklenince) altta yatan gerçek
 * bug'lar sunucuda hâlâ AKTİF olsa da yeşil kalıyordu — 3 bağımsız yöntemle
 * (curl, `docker exec ... wget`, ayrı bir standalone node script'i) sunucunun
 * GERÇEKTEN bozuk davrandığı doğrulanmasına KARŞIN aynı kontrol o dosyanın
 * İÇİNDE hep "doğru" görünüyordu. Kök neden netleştirilemedi (Node/undici
 * fetch bağlantı havuzunun o dosyada birikmiş ~20+ önceki HTTP isteğiyle bir
 * etkileşimi olduğu düşünülüyor) — ama AYNI kontroller KENDİ, izole
 * dosyalarında (bu dosyada, sıfır önceki istek) HER SEFERİNDE (mutasyonla
 * tekrar tekrar doğrulandı) güvenilir biçimde doğru/yanlışı yakalıyor.
 *
 * Bu dosyanın var olma sebebi TAM OLARAK budur: bir testin sessizce YANLIŞ
 * geçmesi, o testin hiç var olmamasından DAHA KÖTÜdür.
 *
 * Kapsam — üçü de canlı olarak yakalanıp düzeltilen gerçek bulgular:
 *  1. pdfkit'in standart-14 fontları (Helvetica) WinAnsiEncoding kullanır —
 *     Türkçe'ye özgü ş/Ş/ğ/Ğ/ı/İ bu kodlamada YOK; başlık "İkmal Hareket
 *     Raporu" PDF'te "Aà ¶ÖÂ†&V°et Raporu" olarak render ediliyordu.
 *     Düzeltme: vendored Roboto .woff (bkz. src/reports/assets/fonts/)
 *     gömülüyor. Otomatik doğrulama sınırı: gömülü METİN glif indeksi
 *     olarak kodlanır (literal byte DEĞİL), "Şantiye" ham byte'larda
 *     aranamaz — ama /BaseFont adı ("Roboto") PDF dictionary'sinde LİTERAL
 *     kalır, o kontrol edilebiliyor. Doğru Türkçe render PDF açılıp GÖRSEL
 *     olarak da doğrulandı (bu dosyanın kapsamı dışında, elle yapıldı).
 *  2. `doc.registerFont()` PDFDocument ÖRNEĞİNE kayıtlıdır, SÜREÇ genelinde
 *     DEĞİL — ilk sürüm "kaydedildi mi" bayrağını yanlışlıkla SÜREÇ
 *     genelinde tutuyordu: aynı çalışan sunucuda İKİNCİ PDF isteği "ENOENT
 *     ReportRoboto-Bold" ile 500 patlıyordu (İLK istek her zaman çalıştığı
 *     için TEK istekli bir test bunu hiç YAKALAYAMAZDI — bu yüzden burada
 *     bilerek 3 ARDIŞIK istek atılıyor).
 *  3. Sayfa numarası altbilgisi `margins.bottom`'un İÇİNE (boş alana)
 *     yazılınca pdfkit bunu "sayfa dolu" sayıp SONUNA yeni, neredeyse boş
 *     bir sayfa ekliyordu (5 içerik + 5 altbilgi-only sayfa = 10 toplam).
 *     Düzeltme: damgalama sırasında `margins.bottom` geçici olarak 0.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const PLATE = `34 PDFREG ${String(RUN).slice(-4)}`;
const ROW_COUNT = 100;

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
async function getPdf(token: string): Promise<{ status: number; buffer: Buffer }> {
  const res = await fetch(`${API_URL}/reports/rep-711/export?format=pdf&vehiclePlate=${encodeURIComponent(PLATE)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
}
/** `/Type /Pages` (kök ağaç düğümü) HARİÇ, gerçek sayfa nesnelerini sayar. */
function countPdfPages(buffer: Buffer): number {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN / GitHub #166] REP-703 PDF EXPORT REGRESYONU');
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
    await db.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, type, created_at)
       SELECT 'tx-pdfreg-' || $1 || '-' || g, 'comp-camsa', 'Gebze Ana Şantiye', $2, 'PDF Regresyon Testi', 1, 'Manuel', NOW() - (g || ' seconds')::interval
       FROM generate_series(1, ${ROW_COUNT}) g`,
      [RUN, PLATE]
    );

    const owner = await login('camsa');

    // Test 1-3: AYNI süreçte ART ARDA 3 istek — 2. bulgunun (per-doc font
    // kaydı) tam kanıtı. Sıralı (Promise.all DEĞİL) — undoing'in kendisi
    // her isteğin BAĞIMSIZ bir 'doc' örneği kullandığını, süreç genelinde
    // paylaşılan bir durumun sızmadığını kanıtlar.
    const results: { status: number; buffer: Buffer }[] = [];
    for (let i = 0; i < 3; i++) results.push(await getPdf(owner));

    results.forEach((r, i) => {
      check(`Test ${i + 1}: aynı süreçteki ${i + 1}. PDF isteği 200 döner ve geçerli bir PDF'tir`,
        r.status === 200 && r.buffer.subarray(0, 5).toString('latin1') === '%PDF-',
        `status=${r.status}, ilk-bytes=${r.buffer.subarray(0, 8).toString('latin1')}`);
    });

    // Test 4: Roboto GERÇEKTEN gömülü (1. bulgunun otomatikleştirilebilir kanıtı).
    const robotoCounts = results.map((r) => r.buffer.toString('latin1').split('Roboto').length - 1);
    check('Test 4: HER 3 PDF\'te de Roboto fontu gömülü (/BaseFont, standart Helvetica DEĞİL)',
      robotoCounts.every((c) => c > 0), `Roboto geçiş sayıları=${JSON.stringify(robotoCounts)}`);

    // Test 5: sayfa sayısı TUTARLI ve DOĞRU — 3. bulgunun (sayfa ikiye
    // katlanması) otomatikleştirilebilir kanıtı. Bu satır sayısı (100),
    // sabit satır yüksekliği ve A4 yatay sayfa boyutuyla GERÇEK/doğru
    // değer ampirik olarak tekrar tekrar 3 (bkz. bu dosyanın üstündeki not)
    // — aralık [2,4] küçük bir font-metrik toleransı bırakır ama bug'ın
    // ürettiği "6" (ikiye katlanmış) değeri KESİN olarak dışarıda tutar.
    // İlk sürüm burada [2,6] gibi gevşek bir aralık kullanıyordu ve bu,
    // 6'yı da (yanlışlıkla) KABUL ediyordu — mutasyonla yakalanıp düzeltildi.
    const pageCounts = results.map((r) => countPdfPages(r.buffer));
    check(`Test 5: ${ROW_COUNT} satırlık fixture için sayfa sayısı 3 istekte de TUTARLI ve TAM DOĞRU (2-4 arası) — ikiye katlanma (6) yok`,
      pageCounts.every((c) => c === pageCounts[0]) && pageCounts[0] >= 2 && pageCounts[0] <= 4,
      `sayfa sayıları=${JSON.stringify(pageCounts)}`);
  } finally {
    await db.query('DELETE FROM transactions WHERE id LIKE $1', [`tx-pdfreg-${RUN}-%`]);
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
