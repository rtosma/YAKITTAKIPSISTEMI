/**
 * BILL-1701 — Firma Paketleri ve Lisans Modeli uçtan uca testi. Gerçek
 * Docker Compose (backend + Postgres) üzerinden, gerçek HTTP istekleriyle
 * (nginx proxy, localhost:3000) — DB'ye doğrudan bağlanmaya gerek yok, her
 * şey `/api/v1` uçları üzerinden gözlemleniyor.
 *
 * Kapsanan davranış:
 *  - Yeni firma oluştururken paket verilmezse TEMEL'e düşer, modules o
 *    paketin varsayılan demediyle kurulur.
 *  - SUPER_ADMIN paketi değiştirdiğinde (PATCH /companies/:id) modules o
 *    paketin varsayılanına SIFIRLANIR; aynı istekte açık `modules` de
 *    gönderilirse üzerine biner (kısmi override).
 *  - Lisans kapısı (authMiddleware.ts): ASKIDA/süresi-dolmuş bir firmanın
 *    kullanıcısı normal uçlarda (ör. GET /vehicles) 402 alır; ama kendi
 *    durumunu görmek (GET /companies/me) ve çıkış yapmak (allowlist) HER
 *    ZAMAN erişilebilir kalır. Lisans düzelince erişim geri gelir.
 *
 * Not: Bu test yeni, tek kullanımlık bir firma OLUŞTURUR (mevcut seed
 * firmalarının — comp-camsa vb. — lisansına ASLA dokunulmaz, paylaşılan
 * demo verisini/eşzamanlı diğer testleri bozmamak için). Test firması
 * silinmiyor (DELETE /companies ucu yok) — kalıcı ama zararsız bir artık.
 */

const API_URL = 'http://localhost:3000/api/v1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(username: string): Promise<string> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const data = await res.json();
  if (!data.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız — ${JSON.stringify(data)}`);
  return data.accessToken;
}

async function api(method: string, path: string, token: string, body?: object): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function run() {
  console.log('===========================================================');
  console.log('💳 [BILL-1701] FİRMA PAKETLERİ VE LİSANS MODELİ TESTİ');
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
      console.error(`❌ [FAIL] ${name}`);
      console.error(`   ${detail}\n`);
    }
  }

  const adminToken = await login('admin');

  // Slugify (adminDb.ts createCompanyWithOwner'daki mantıkla AYNI, ama
  // isim zaten yalnızca [a-z0-9] olduğundan burada hiçbir dönüşüm gerekmez
  // — bu yüzden username, gönderdiğimiz name'in TA KENDİSİ olacak.
  const companyName = `billtest${Date.now()}`;

  // --- Test 1: paket verilmeden oluştur → TEMEL + TEMEL'in modül demeti ---
  const createRes = await api('POST', '/companies', adminToken, { name: companyName });
  check('Test 1: Firma oluşturuldu (200)', createRes.status === 200 && createRes.data.success, `yanıt: ${JSON.stringify(createRes.data)}`);
  const companyId = createRes.data.data?.id;
  check(
    'Test 1b: Paket verilmeden oluşturulunca varsayılan TEMEL atandı',
    createRes.data.data?.package === 'TEMEL',
    `package: ${createRes.data.data?.package}`
  );
  check(
    'Test 1c: modules, TEMEL paketinin varsayılan demediyle kuruldu (aiAnomaly/eInvoice/smartWarehouse/crossSiteAuth kapalı, driverScore açık)',
    createRes.data.data?.modules?.aiAnomaly === false &&
      createRes.data.data?.modules?.eInvoice === false &&
      createRes.data.data?.modules?.smartWarehouse === false &&
      createRes.data.data?.modules?.crossSiteAuth === false &&
      createRes.data.data?.modules?.driverScore === true,
    `modules: ${JSON.stringify(createRes.data.data?.modules)}`
  );

  // --- Test 2: paket PROFESYONEL'e yükseltilince modules o pakete sıfırlanır ---
  const upgradeRes = await api('PATCH', `/companies/${companyId}`, adminToken, { package: 'PROFESYONEL' });
  check(
    'Test 2: PROFESYONEL\'e yükseltme → modules PROFESYONEL varsayılanına sıfırlandı',
    upgradeRes.data.data?.package === 'PROFESYONEL' &&
      upgradeRes.data.data?.modules?.aiAnomaly === true &&
      upgradeRes.data.data?.modules?.eInvoice === true &&
      upgradeRes.data.data?.modules?.smartWarehouse === false &&
      upgradeRes.data.data?.modules?.crossSiteAuth === true,
    `yanıt: ${JSON.stringify(upgradeRes.data.data)}`
  );

  // --- Test 3: paket KURUMSAL + tek modülü manuel kapat → override paket varsayılanının üzerine biner ---
  const overrideRes = await api('PATCH', `/companies/${companyId}`, adminToken, {
    package: 'KURUMSAL',
    modules: { smartWarehouse: false }
  });
  check(
    'Test 3: KURUMSAL + açık modül override\'ı → paket varsayılanı UYGULANIR, override ÜZERİNE biner',
    overrideRes.data.data?.package === 'KURUMSAL' &&
      overrideRes.data.data?.modules?.smartWarehouse === false &&
      overrideRes.data.data?.modules?.aiAnomaly === true &&
      overrideRes.data.data?.modules?.maintenanceTrack === true,
    `yanıt: ${JSON.stringify(overrideRes.data.data)}`
  );

  // --- Lisans kapısı testleri: tenant'ın kendi kullanıcısıyla giriş ---
  const ownerToken = await login(companyName);

  const vehiclesOkRes = await api('GET', '/vehicles', ownerToken);
  check('Test 4: Lisans AKTİF iken GET /vehicles erişilebilir (200)', vehiclesOkRes.status === 200, `status: ${vehiclesOkRes.status}`);

  // --- Test 5: lisans ASKIDA → normal uçlar 402, ama companies/me ve auth/me erişilebilir kalır ---
  await api('PATCH', `/companies/${companyId}`, adminToken, { licenseStatus: 'ASKIDA' });
  await sleep(200);

  const vehiclesSuspendedRes = await api('GET', '/vehicles', ownerToken);
  check(
    'Test 5: Lisans ASKIDA iken GET /vehicles 402 LICENSE_SUSPENDED döner',
    vehiclesSuspendedRes.status === 402 && vehiclesSuspendedRes.data.error === 'LICENSE_SUSPENDED',
    `status: ${vehiclesSuspendedRes.status}, yanıt: ${JSON.stringify(vehiclesSuspendedRes.data)}`
  );
  const meSuspendedRes = await api('GET', '/companies/me', ownerToken);
  check(
    'Test 5b: ASKIDA iken GET /companies/me hâlâ erişilebilir (allowlist) ve durumu doğru gösteriyor',
    meSuspendedRes.status === 200 && meSuspendedRes.data.data?.licenseStatus === 'ASKIDA',
    `status: ${meSuspendedRes.status}, licenseStatus: ${meSuspendedRes.data.data?.licenseStatus}`
  );
  const authMeSuspendedRes = await api('GET', '/auth/me', ownerToken);
  check('Test 5c: ASKIDA iken GET /auth/me hâlâ erişilebilir (allowlist)', authMeSuspendedRes.status === 200, `status: ${authMeSuspendedRes.status}`);

  // --- Test 6: lisans AKTİF ama süresi geçmiş tarih → SALT-OKUNUR (BILL-1702) ---
  // GET hâlâ çalışır ("ani kesinti YOK"), yazma (POST/PUT/PATCH/DELETE) 402 alır.
  // (Not: BILL-1701'de bu senaryo tam blok'tu; BILL-1702 "kademeli kısıtlama"
  // AC'siyle salt-okunur'a evrildi — bkz. authMiddleware.ts LICENSE_EXPIRED_READONLY.)
  await api('PATCH', `/companies/${companyId}`, adminToken, { licenseStatus: 'AKTİF', licenseExpiry: '2020-01-01' });
  await sleep(200);

  const vehiclesExpiredGetRes = await api('GET', '/vehicles', ownerToken);
  check(
    'Test 6: Lisans süresi geçmiş iken GET /vehicles hâlâ 200 döner (salt-okunur, ani kesinti yok)',
    vehiclesExpiredGetRes.status === 200,
    `status: ${vehiclesExpiredGetRes.status}`
  );
  const vehiclesExpiredPostRes = await api('POST', '/vehicles', ownerToken, {});
  check(
    'Test 6b: Lisans süresi geçmiş iken POST /vehicles 402 LICENSE_EXPIRED_READONLY döner',
    vehiclesExpiredPostRes.status === 402 && vehiclesExpiredPostRes.data.error === 'LICENSE_EXPIRED_READONLY',
    `status: ${vehiclesExpiredPostRes.status}, yanıt: ${JSON.stringify(vehiclesExpiredPostRes.data)}`
  );

  // --- Test 7: lisans yenilenince (gelecek tarih) yazma erişimi de geri gelir ---
  await api('PATCH', `/companies/${companyId}`, adminToken, { licenseStatus: 'AKTİF', licenseExpiry: '2099-12-31' });
  await sleep(200);

  const vehiclesRestoredRes = await api('GET', '/vehicles', ownerToken);
  check('Test 7: Lisans yenilenince GET /vehicles tekrar 200 döner', vehiclesRestoredRes.status === 200, `status: ${vehiclesRestoredRes.status}`);
  const vehiclesRestoredPostRes = await api('POST', '/vehicles', ownerToken, {});
  check(
    'Test 7b: Lisans yenilenince salt-okunur kısıtlaması kalktı (POST artık 402 değil — 400/422 doğrulama hatası dönebilir, ama LICENSE_EXPIRED_READONLY DEĞİL)',
    vehiclesRestoredPostRes.status !== 402 || vehiclesRestoredPostRes.data.error !== 'LICENSE_EXPIRED_READONLY',
    `status: ${vehiclesRestoredPostRes.status}, yanıt: ${JSON.stringify(vehiclesRestoredPostRes.data)}`
  );

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('❌ Test çalıştırma hatası:', err);
  process.exit(1);
});
