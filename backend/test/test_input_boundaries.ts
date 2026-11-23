import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md §2.2 — Sayfalama/filtre sınır durumları ve girdi güvenliği.
 *
 * NEDEN: Mevcut 59 testin neredeyse tamamı "mutlu yol"u doğruluyor — geçerli
 * girdiyle doğru sonucun döndüğünü. Sınır ve kötü niyetli girdiler (devasa
 * sayfa boyutu, negatif sayfa, tip uyuşmazlığı, SQL injection denemeleri)
 * sistematik olarak taranmamıştı.
 *
 * İki risk sınıfı test ediliyor:
 *   1. KAYNAK TÜKETİMİ: `pageSize=100000` gibi bir istek tek başına sunucu
 *      belleğini ve DB'yi zorlayabilir (DoS yüzeyi). Zod şemasında max(100)
 *      var — bu testler o sınırın GERÇEKTEN uygulandığını doğruluyor.
 *   2. ENJEKSİYON: filtre/arama alanları SQL'e gidiyor. Kod parametreli
 *      sorgu kullanıyor (check-no-raw-pool-query.mjs bunu ayrıca denetliyor)
 *      ama bu, davranışın uçtan uca doğrulanması.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';

async function call(
  method: string,
  path: string,
  opts: { token?: string } = {}
): Promise<{ status: number; body: any; ms: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const t0 = Date.now();
  const res = await fetch(`${API_URL}${path}`, { method, headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ms: Date.now() - t0 };
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const body = await res.json().catch(() => ({}));
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §2.2] SAYFALAMA SINIRLARI + GİRDİ GÜVENLİĞİ');
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

  const token = await login('camsa');

  // ═══ 1) Kaynak tüketimi: sayfa boyutu sınırı ═══════════════════════════

  const tooBig = await call('GET', '/transactions?pageSize=100000', { token });
  check(
    'Test 1: Devasa pageSize (100000) REDDEDİLİR — bellek/DB tüketimi yüzeyi kapalı',
    tooBig.status === 400,
    `status=${tooBig.status}, error=${tooBig.body?.error}`
  );

  const justOverLimit = await call('GET', '/transactions?pageSize=101', { token });
  check(
    'Test 2: Sınırın 1 üstü (101) de reddedilir — off-by-one yok',
    justOverLimit.status === 400,
    `status=${justOverLimit.status}`
  );

  const atLimit = await call('GET', '/transactions?pageSize=100', { token });
  check(
    'Test 3: Sınırın TAM kendisi (100) kabul edilir — gereksiz katı değil',
    atLimit.status === 200,
    `status=${atLimit.status}`
  );

  // ═══ 2) Geçersiz sayısal girdiler ══════════════════════════════════════

  const cases: Array<{ q: string; label: string }> = [
    { q: 'pageSize=0', label: 'pageSize=0 (pozitif olmalı)' },
    { q: 'pageSize=-5', label: 'pageSize negatif' },
    { q: 'page=0', label: 'page=0 (1\'den başlar)' },
    { q: 'page=-1', label: 'page negatif' },
    { q: 'pageSize=abc', label: 'pageSize sayı değil' },
    { q: 'pageSize=1.5', label: 'pageSize tam sayı değil' }
  ];
  for (const c of cases) {
    const r = await call('GET', `/transactions?${c.q}`, { token });
    check(`Test: ${c.label} → 400`, r.status === 400, `status=${r.status}, error=${r.body?.error}`);
  }

  // ═══ 3) Geçersiz filtre değerleri ══════════════════════════════════════

  // Bu test İLK KOŞUDA 500 DÖNDÜ ve gerçek bir hata ortaya çıkardı: şemalar
  // tarihleri yalnızca BİÇİM regex'iyle doğruluyordu, takvim geçerliliğini
  // değil — 2026-13-45 doğrulamayı geçip Postgres'e gidiyor ve "date/time
  // field value out of range" ile 500 üretiyordu. 16 şema dosyasındaki 28
  // tarih alanının TAMAMI aynı durumdaydı; hepsi ortak doğrulayıcıya
  // (schemas/common/dateString.ts) taşındı.
  const badDate = await call('GET', '/transactions?startDate=2026-13-45', { token });
  check(
    'Test: Geçersiz tarih (2026-13-45) → 400 (500 DEĞİL — kullanıcı girdisi sunucu hatası üretmemeli)',
    badDate.status === 400,
    `status=${badDate.status}`
  );

  const impossibleDay = await call('GET', '/transactions?startDate=2026-02-30', { token });
  check(
    'Test: Takvimde OLMAYAN gün (2026-02-30) → 400 (biçim doğru ama tarih geçersiz)',
    impossibleDay.status === 400,
    `status=${impossibleDay.status}`
  );

  const nonLeapFeb29 = await call('GET', '/transactions?startDate=2026-02-29', { token });
  check(
    'Test: Artık yıl OLMAYAN yılda 29 Şubat → 400',
    nonLeapFeb29.status === 400,
    `status=${nonLeapFeb29.status}`
  );

  const leapFeb29 = await call('GET', '/transactions?startDate=2024-02-29', { token });
  check(
    'Test: ARTIK yılda 29 Şubat KABUL edilir (doğrulama fazla katı değil)',
    leapFeb29.status === 200,
    `status=${leapFeb29.status}`
  );

  const badEnum = await call('GET', '/transactions?pumpStatus=HACKED', { token });
  check(
    'Test: Bilinmeyen enum değeri → 400 (allowlist, blocklist değil)',
    badEnum.status === 400,
    `status=${badEnum.status}`
  );

  const longSearch = await call('GET', `/transactions?search=${'a'.repeat(500)}`, { token });
  check(
    'Test: Aşırı uzun arama metni (500 karakter) → 400 (max 128)',
    longSearch.status === 400,
    `status=${longSearch.status}`
  );

  // ═══ 4) SQL enjeksiyon denemeleri ══════════════════════════════════════
  //
  // Parametreli sorgu kullanıldığı için bunların hiçbiri SQL olarak
  // yorumlanmamalı: ya 200 (sonuç bulunamadı/filtre uygulandı) ya da 400
  // (şema reddetti) dönmeli — ama ASLA 500 (SQL sözdizimi hatası) olmamalı.
  // 500, girdinin sorguya ham olarak gömüldüğünün işaretidir.

  const injections = [
    "'; DROP TABLE transactions; --",
    "' OR '1'='1",
    "1' UNION SELECT NULL,NULL,NULL--",
    "'; UPDATE companies SET license_status='AKTİF'; --"
  ];
  for (const payload of injections) {
    const r = await call('GET', `/transactions?search=${encodeURIComponent(payload)}`, { token });
    check(
      `Test: SQL enjeksiyon denemesi güvenle işleniyor — ${payload.slice(0, 28)}...`,
      r.status !== 500,
      `status=${r.status} (500 OLMAMALI — 500, girdinin sorguya ham gömüldüğünü gösterir)`
    );
  }

  // Enjeksiyon gerçekten ETKİSİZ mi? Tablo hâlâ sorgulanabiliyor olmalı.
  const afterInjection = await call('GET', '/transactions?pageSize=1', { token });
  check(
    'Test: Enjeksiyon denemelerinden SONRA transactions tablosu sağlam',
    afterInjection.status === 200 && Array.isArray(afterInjection.body?.data),
    `status=${afterInjection.status}`
  );

  // ═══ 5) Varsayılan davranış ve uç sayfa ════════════════════════════════

  const defaults = await call('GET', '/transactions', { token });
  check(
    'Test: Parametresiz istek varsayılanlarla çalışır (page=1, pageSize=10)',
    defaults.status === 200 &&
      defaults.body?.pagination?.page === 1 &&
      defaults.body?.pagination?.pageSize === 10,
    `status=${defaults.status}, pagination=${JSON.stringify(defaults.body?.pagination)}`
  );

  const farPage = await call('GET', '/transactions?page=999999&pageSize=10', { token });
  check(
    'Test: Çok uzak sayfa boş sonuç döner, makul sürede (hata/askıda kalma yok)',
    farPage.status === 200 && Array.isArray(farPage.body?.data) && farPage.body.data.length === 0 && farPage.ms < 5000,
    `status=${farPage.status}, kayıt=${farPage.body?.data?.length}, süre=${farPage.ms}ms`
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
