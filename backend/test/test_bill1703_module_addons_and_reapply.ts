/**
 * BILL-1703 — Modül Bazlı Feature-Flag Satış Eşlemesi uçtan uca testi.
 * BILL-1701/1702'nin devamı, gerçek HTTP uçları üzerinden (nginx proxy,
 * localhost:3000).
 *
 * Kapsanan davranış:
 *  - Ek modül satın alımı (company_module_addons) paketten bağımsız olarak
 *    ANINDA etkin olur ve paket DEĞİŞSE BİLE (yukarı ya da aşağı) hayatta kalır.
 *  - Ek modül kaldırılınca köre körüne false yapılmaz, paketin o modül için
 *    varsayılanına döner.
 *  - Manuel modül/paket/lisans değişiklikleri artık audit_logs'a yazılıyor
 *    (PATCH /companies/:id daha önce hiç yazmıyordu).
 *  - POST /admin/package-defaults/:package/reapply — o paketteki TÜM
 *    firmalara paket varsayılanını yeniden uygular; addon'lar korunur, ad-hoc
 *    (addon olmayan) manuel override'lar temizlenir.
 *
 * Not: tek kullanımlık test firması, mevcut seed firmalarına dokunulmaz —
 * reapply testi de SADECE bu test firmasının paketini hedefleyecek şekilde
 * tasarlandı (bkz. Test 5 — firma PROFESYONEL'e taşınıp reapply orada
 * çalıştırılıyor, TEMEL'deki diğer gerçek firmaları etkilemiyor... aslında
 * TEMEL paketindeki TÜM firmaları etkiler, bu yüzden PROFESYONEL kullanılıyor
 * ve testten önce/sonra PROFESYONEL'de başka gerçek firma olmadığı varsayılıyor
 * (seed firmaları KURUMSAL, bkz. BILL-1701 backfill notu)).
 */

import { resetLoginRateLimit } from './helpers/loginRateLimit';

// CI'da (auth-integration-test job) backend nginx OLMADAN doğrudan 5000
// portunda ayağa kalkar — bu yüzden localde varsayılan (3000, nginx proxy)
// env ile override edilebilir olmalı (bkz. ci-cd.yml API_URL).
const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit(); // TEST_PLAN §0.3 — paket içi 429 kırılmalarını önler
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
  console.log('🧩 [BILL-1703] MODÜL BAZLI FEATURE-FLAG SATIŞ EŞLEMESİ TESTİ');
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

  const companyName = `bill1703t${Date.now()}`;
  const createRes = await api('POST', '/companies', adminToken, { name: companyName, package: 'TEMEL' });
  const companyId = createRes.data.data?.id;
  check(
    'Ön koşul: TEMEL paketli test firması oluşturuldu, eInvoice başlangıçta kapalı',
    createRes.status === 200 && !!companyId && createRes.data.data?.modules?.eInvoice === false,
    `yanıt: ${JSON.stringify(createRes.data)}`
  );

  const ownerToken = await login(companyName);

  // --- Test 1: eInvoice'u ek modül olarak ekle → ANINDA modules.eInvoice=true ---
  const addRes = await api('POST', `/companies/${companyId}/module-addons`, adminToken, { moduleName: 'eInvoice' });
  check(
    'Test 1: POST module-addons ile eInvoice eklendi (200), addon listesinde görünüyor',
    addRes.status === 200 && addRes.data.data?.some((a: any) => a.moduleName === 'eInvoice'),
    `status: ${addRes.status}, yanıt: ${JSON.stringify(addRes.data)}`
  );
  const meAfterAddRes = await api('GET', '/companies/me', ownerToken);
  check(
    'Test 1b: Addon eklendikten hemen sonra companies/me → modules.eInvoice=true (paket hâlâ TEMEL)',
    meAfterAddRes.data.data?.modules?.eInvoice === true && meAfterAddRes.data.data?.package === 'TEMEL',
    `modules: ${JSON.stringify(meAfterAddRes.data.data?.modules)}`
  );

  // --- Test 2: paket PROFESYONEL'e yükseltilince addon HAYATTA KALIR (normalde modules sıfırlanırdı) ---
  await api('PATCH', `/companies/${companyId}`, adminToken, { package: 'PROFESYONEL' });
  await sleep(150);
  const meAfterUpgradeRes = await api('GET', '/companies/me', ownerToken);
  check(
    'Test 2: PROFESYONEL\'e yükseltme sonrası eInvoice addon\'u hâlâ true (paket zaten true yapardı ama addon garanti eder)',
    meAfterUpgradeRes.data.data?.modules?.eInvoice === true && meAfterUpgradeRes.data.data?.package === 'PROFESYONEL',
    `modules: ${JSON.stringify(meAfterUpgradeRes.data.data?.modules)}`
  );

  // --- Test 3: paket TEMEL'e GERİ düşürülünce de addon hayatta kalır (TEMEL'in kendi varsayılanı false olsa bile) ---
  await api('PATCH', `/companies/${companyId}`, adminToken, { package: 'TEMEL' });
  await sleep(150);
  const meAfterDowngradeRes = await api('GET', '/companies/me', ownerToken);
  check(
    'Test 3: TEMEL\'e geri düşürme sonrası eInvoice addon\'u HÂLÂ true (TEMEL varsayılanı false olmasına rağmen)',
    meAfterDowngradeRes.data.data?.modules?.eInvoice === true &&
      meAfterDowngradeRes.data.data?.package === 'TEMEL' &&
      meAfterDowngradeRes.data.data?.modules?.aiAnomaly === false,
    `modules: ${JSON.stringify(meAfterDowngradeRes.data.data?.modules)}`
  );

  // --- Test 4: addon kaldırılınca paketin (TEMEL) varsayılanına döner (false), köre körüne false DEĞİL ---
  const removeRes = await api('DELETE', `/companies/${companyId}/module-addons/eInvoice`, adminToken);
  check('Test 4: DELETE module-addons başarılı (200)', removeRes.status === 200, `status: ${removeRes.status}`);
  const meAfterRemoveRes = await api('GET', '/companies/me', ownerToken);
  check(
    'Test 4b: Addon kaldırılınca modules.eInvoice TEMEL varsayılanına (false) döndü',
    meAfterRemoveRes.data.data?.modules?.eInvoice === false,
    `modules: ${JSON.stringify(meAfterRemoveRes.data.data?.modules)}`
  );

  // --- Test 4c: aynı senaryo ama paket zaten o modülü içeriyorsa addon kaldırma erişimi KESMEMELİ ---
  await api('POST', `/companies/${companyId}/module-addons`, adminToken, { moduleName: 'smartWarehouse' });
  await api('PATCH', `/companies/${companyId}`, adminToken, { package: 'KURUMSAL' }); // KURUMSAL zaten smartWarehouse:true
  await sleep(150);
  await api('DELETE', `/companies/${companyId}/module-addons/smartWarehouse`, adminToken);
  await sleep(150);
  const meAfterRemoveOnKurumsalRes = await api('GET', '/companies/me', ownerToken);
  check(
    'Test 4c: KURUMSAL\'deyken smartWarehouse addon\'u kaldırılınca erişim KESİLMEDİ (paket zaten true)',
    meAfterRemoveOnKurumsalRes.data.data?.modules?.smartWarehouse === true,
    `modules: ${JSON.stringify(meAfterRemoveOnKurumsalRes.data.data?.modules)}`
  );

  // --- Test 5: manuel değişikliklerin audit_logs'a yazılması (daha önce HİÇ yazılmıyordu) ---
  const auditRes = await api('GET', '/audit-logs?limit=50', ownerToken);
  const actions = (auditRes.data.data || []).map((l: any) => l.action);
  check(
    'Test 5: audit_logs — MODULE_ADDON_GRANTED, MODULE_ADDON_REVOKED, COMPANY_ADMIN_UPDATE kayıtları mevcut',
    actions.includes('MODULE_ADDON_GRANTED') && actions.includes('MODULE_ADDON_REVOKED') && actions.includes('COMPANY_ADMIN_UPDATE'),
    `görülen action'lar: ${JSON.stringify([...new Set(actions)])}`
  );

  // --- Test 6: paket varsayılanlarının kontrollü yeniden uygulanması (reapply) ---
  // Firmayı PROFESYONEL'e taşı, elle bir ad-hoc override yap (addon OLMAYAN),
  // sonra reapply'ın bu override'ı temizleyip addon'u koruduğunu doğrula.
  await api('PATCH', `/companies/${companyId}`, adminToken, { package: 'PROFESYONEL' });
  await api('POST', `/companies/${companyId}/module-addons`, adminToken, { moduleName: 'crossSiteAuth' }); // PROFESYONEL zaten true ama addon olarak da işaretleyelim
  await api('PATCH', `/companies/${companyId}`, adminToken, { modules: { smartWarehouse: true } }); // ad-hoc override — PROFESYONEL'in kendi varsayılanı false
  await sleep(150);
  const beforeReapplyRes = await api('GET', '/companies/me', ownerToken);
  check(
    'Ön koşul (Test 6): reapply öncesi ad-hoc override etkili (smartWarehouse=true, PROFESYONEL varsayılanı false olmasına rağmen)',
    beforeReapplyRes.data.data?.modules?.smartWarehouse === true,
    `modules: ${JSON.stringify(beforeReapplyRes.data.data?.modules)}`
  );

  const reapplyRes = await api('POST', '/admin/package-defaults/PROFESYONEL/reapply', adminToken);
  check(
    'Test 6: POST reapply başarıyla çalıştı ve test firmasını (değişen olarak) yakaladı',
    reapplyRes.status === 200 && reapplyRes.data.data?.results?.some((r: any) => r.companyId === companyId && r.changed === true),
    `status: ${reapplyRes.status}, companiesChecked: ${reapplyRes.data.data?.companiesChecked}, companiesChanged: ${reapplyRes.data.data?.companiesChanged}`
  );
  const afterReapplyRes = await api('GET', '/companies/me', ownerToken);
  check(
    'Test 6b: Reapply sonrası ad-hoc override (smartWarehouse) TEMİZLENDİ (PROFESYONEL varsayılanı false)',
    afterReapplyRes.data.data?.modules?.smartWarehouse === false,
    `modules: ${JSON.stringify(afterReapplyRes.data.data?.modules)}`
  );
  check(
    'Test 6c: Reapply sonrası addon (crossSiteAuth) KORUNDU (true)',
    afterReapplyRes.data.data?.modules?.crossSiteAuth === true,
    `modules: ${JSON.stringify(afterReapplyRes.data.data?.modules)}`
  );

  const auditAfterReapplyRes = await api('GET', '/audit-logs?limit=50', ownerToken);
  const actionsAfterReapply = (auditAfterReapplyRes.data.data || []).map((l: any) => l.action);
  check(
    'Test 6d: audit_logs — PACKAGE_DEFAULTS_REAPPLIED kaydı mevcut',
    actionsAfterReapply.includes('PACKAGE_DEFAULTS_REAPPLIED'),
    `görülen action'lar: ${JSON.stringify([...new Set(actionsAfterReapply)])}`
  );

  // --- Test 7: SUPER_ADMIN olmayan kullanıcı bu uçları çağıramaz ---
  const addForbiddenRes = await api('POST', `/companies/${companyId}/module-addons`, ownerToken, { moduleName: 'aiAnomaly' });
  check('Test 7: COMPANY_OWNER module-addons ekleyemez (403)', addForbiddenRes.status === 403, `status: ${addForbiddenRes.status}`);
  const reapplyForbiddenRes = await api('POST', '/admin/package-defaults/TEMEL/reapply', ownerToken);
  check('Test 7b: COMPANY_OWNER reapply tetikleyemez (403)', reapplyForbiddenRes.status === 403, `status: ${reapplyForbiddenRes.status}`);

  // Temizlik: firmayı zararsız bir duruma bırak (KURUMSAL, tüm modüller açık).
  await api('PATCH', `/companies/${companyId}`, adminToken, { package: 'KURUMSAL' });

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('❌ Test çalıştırma hatası:', err);
  process.exit(1);
});
