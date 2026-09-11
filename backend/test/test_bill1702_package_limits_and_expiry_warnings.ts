/**
 * BILL-1702 — Şantiye/Cihaz/Kullanıcı Paket Limitleri ve Lisans Süresi
 * Uyarıları uçtan uca testi. BILL-1701'in devamı, gerçek HTTP uçları
 * üzerinden (nginx proxy, localhost:3000).
 *
 * Kapsanan davranış:
 *  - TEMEL paketin şantiye/cihaz limiti aşılınca yeni kayıt 409 ile
 *    reddedilir (paket firma oluşturulurken zaten 1 şantiye + 1 kullanıcı
 *    ile başladığı için TEMEL'in maxSites=1 limitine anında ulaşılmış olur).
 *  - Paket yükseltilince (PROFESYONEL) limit gevşer, aynı işlem artık geçer.
 *  - `POST /admin/license-expiry-sweep` (SUPER_ADMIN, manuel tetik) süresi
 *    yakında dolacak firmaları tarayıp uyarı üretir.
 *
 * Not: BILL-1701 testiyle AYNI ilke — tek kullanımlık test firması, mevcut
 * seed firmalarına dokunulmaz.
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

function isoDatePlusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function run() {
  console.log('===========================================================');
  console.log('📦 [BILL-1702] PAKET LİMİTLERİ VE LİSANS SÜRESİ UYARILARI TESTİ');
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

  const companyName = `bill1702t${Date.now()}`;
  const createRes = await api('POST', '/companies', adminToken, { name: companyName, package: 'TEMEL' });
  const companyId = createRes.data.data?.id;
  const defaultSiteName = createRes.data.data?.sites?.[0]?.name;
  check(
    'Ön koşul: TEMEL paketli test firması oluşturuldu (1 şantiye + 1 kullanıcı ile başlıyor)',
    createRes.status === 200 && !!companyId && !!defaultSiteName,
    `yanıt: ${JSON.stringify(createRes.data)}`
  );

  const ownerToken = await login(companyName);

  // --- Test 1: TEMEL'in maxSites=1 limiti — firma zaten 1 şantiyeyle başladı, 2. şantiye 409 almalı ---
  const site2Res = await api('POST', '/sites', ownerToken, { siteName: `${companyName} 2. Şantiye`, location: 'İstanbul' });
  check(
    'Test 1: TEMEL paket şantiye limitine (1/1) ulaşılmışken yeni şantiye 409 ile reddedildi',
    site2Res.status === 409,
    `status: ${site2Res.status}, yanıt: ${JSON.stringify(site2Res.data)}`
  );

  // --- Test 2: TEMEL'in maxDevices=5 limiti — 5 cihaz oluştur, 6.'sı 409 almalı ---
  let lastDeviceRes: { status: number; data: any } | null = null;
  for (let i = 1; i <= 5; i++) {
    lastDeviceRes = await api('POST', '/hardware-devices', ownerToken, {
      deviceId: `BILL1702-DEV-${Date.now()}-${i}`,
      name: `Test Cihaz ${i}`,
      siteName: defaultSiteName
    });
  }
  check(
    'Test 2: TEMEL paket cihaz limiti (5) dahilindeki 5 cihaz da başarıyla oluşturuldu',
    lastDeviceRes?.status === 200,
    `son cihaz yanıtı: status=${lastDeviceRes?.status}`
  );
  const device6Res = await api('POST', '/hardware-devices', ownerToken, {
    deviceId: `BILL1702-DEV-${Date.now()}-6`,
    name: 'Test Cihaz 6',
    siteName: defaultSiteName
  });
  check(
    'Test 2b: 6. cihaz (limit 5/5 dolu) 409 ile reddedildi',
    device6Res.status === 409,
    `status: ${device6Res.status}, yanıt: ${JSON.stringify(device6Res.data)}`
  );

  // --- Test 3: paket PROFESYONEL'e yükseltilince (maxSites=5) aynı şantiye isteği artık geçer ---
  await api('PATCH', `/companies/${companyId}`, adminToken, { package: 'PROFESYONEL' });
  await sleep(200);

  const site2AfterUpgradeRes = await api('POST', '/sites', ownerToken, { siteName: `${companyName} 2. Şantiye`, location: 'İstanbul' });
  check(
    'Test 3: PROFESYONEL\'e yükseltme sonrası (maxSites=5) 2. şantiye artık başarıyla oluşturuluyor',
    site2AfterUpgradeRes.status === 200,
    `status: ${site2AfterUpgradeRes.status}, yanıt: ${JSON.stringify(site2AfterUpgradeRes.data)}`
  );

  // --- Test 4: lisans süresi uyarı süpürücüsü (manuel tetik) ---
  // Firmayı 5 gün içinde dolacak şekilde ayarla (CRITICAL eşiği: ≤7 gün).
  await api('PATCH', `/companies/${companyId}`, adminToken, { licenseStatus: 'AKTİF', licenseExpiry: isoDatePlusDays(5) });
  await sleep(200);

  const sweepRes = await api('POST', '/admin/license-expiry-sweep', adminToken);
  check(
    'Test 4: POST /admin/license-expiry-sweep başarıyla çalıştı ve süresi 5 gün içinde dolan test firmasını yakaladı',
    sweepRes.status === 200 && sweepRes.data.data?.warned >= 1,
    `status: ${sweepRes.status}, yanıt: ${JSON.stringify(sweepRes.data)}`
  );

  // --- Test 5: normal (SUPER_ADMIN olmayan) bir kullanıcı sweep ucunu tetikleyemez ---
  const sweepForbiddenRes = await api('POST', '/admin/license-expiry-sweep', ownerToken);
  check(
    'Test 5: COMPANY_OWNER /admin/license-expiry-sweep\'i tetikleyemez (403)',
    sweepForbiddenRes.status === 403,
    `status: ${sweepForbiddenRes.status}`
  );

  // Temizlik: test firmasını güvenli bir duruma döndür (lisans süresi uzak gelecekte).
  await api('PATCH', `/companies/${companyId}`, adminToken, { licenseStatus: 'AKTİF', licenseExpiry: '2099-12-31' });

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('❌ Test çalıştırma hatası:', err);
  process.exit(1);
});
