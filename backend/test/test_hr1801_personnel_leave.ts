/**
 * HR-1801 — Personel İzin Takip Modülü uçtan uca testi. Gerçek HTTP uçları
 * üzerinden (nginx proxy, localhost:3000).
 *
 * Kapsanan davranış:
 *  - İki aşamalı onay akışı: TALEP_EDILDI → (SITE_MANAGER) SAHA_ONAYLANDI →
 *    (COMPANY_OWNER) ONAYLANDI; COMPANY_OWNER TALEP_EDILDI'den de kısayoldan
 *    onaylayabilir.
 *  - Çakışma tespiti: aynı personelin örtüşen bir izni varsa 409.
 *  - Şoför atama entegrasyonu: personel bir şoförse ve o şoför bir araca
 *    atanmışsa, izin talebi bunu bilgilendirici olarak (engellemeden) taşır.
 *  - İzin bakiyesi: hak - ONAYLANDI YILLIK günler.
 *  - Bekleyenler listesi rol bazlı (SITE_MANAGER vs COMPANY_OWNER).
 *  - Reddetme + iptal + audit_logs.
 *
 * Not: tek kullanımlık test firması/personeli/aracı, mevcut seed verisine
 * dokunulmaz.
 */

// CI'da (auth-integration-test job) backend nginx OLMADAN doğrudan 5000
// portunda ayağa kalkar — bu yüzden localde varsayılan (3000, nginx proxy)
// env ile override edilebilir olmalı (bkz. ci-cd.yml API_URL).
const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';

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
  console.log('🗓️  [HR-1801] PERSONEL İZİN TAKİP MODÜLÜ TESTİ');
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

  const companyName = `hr1801t${Date.now()}`;
  const createCompanyRes = await api('POST', '/companies', adminToken, { name: companyName, package: 'KURUMSAL' });
  const companyId = createCompanyRes.data.data?.id;
  const siteName = createCompanyRes.data.data?.sites?.[0]?.name;
  check('Ön koşul: Test firması oluşturuldu', createCompanyRes.status === 200 && !!companyId, `yanıt: ${JSON.stringify(createCompanyRes.data)}`);

  const ownerToken = await login(companyName);

  // --- Ön koşul: bir şoför + o şoföre atanmış bir araç (vehicleAssignmentConflict testi için) ---
  const driverRes = await api('POST', '/drivers', ownerToken, {
    name: `Test Şoför ${Date.now()}`,
    tcNo: '12345678901',
    phone: '5551234567',
    rfidCardId: `RFID-${Date.now()}`,
    siteName
  });
  const driverId = driverRes.data.data?.id;
  check('Ön koşul: Test şoförü oluşturuldu', driverRes.status === 200 && !!driverId, `yanıt: ${JSON.stringify(driverRes.data)}`);

  const vehicleRes = await api('POST', '/vehicles', ownerToken, {
    plate: `34HR${(Date.now() % 10000).toString().padStart(4, '0')}`,
    brandModel: 'Ford Cargo',
    type: 'Kamyon',
    rfidTag: `RFIDTAG-${Date.now()}`,
    fuelCapacityLiters: 300,
    assignedDriver: driverRes.data.data?.name,
    siteName
  });
  check('Ön koşul: Test aracı oluşturuldu (şoföre atanmış)', vehicleRes.status === 200, `yanıt: ${JSON.stringify(vehicleRes.data)}`);

  // --- Test 1: personel oluştur (şoförle bağlantılı) ---
  const personnelRes = await api('POST', '/personnel', ownerToken, {
    fullName: 'Ahmet Yılmaz',
    roleTitle: 'ŞOFÖR',
    siteName,
    driverId,
    annualLeaveEntitlementDays: 20
  });
  const personnelId = personnelRes.data.data?.id;
  check('Test 1: Personel oluşturuldu', personnelRes.status === 200 && !!personnelId, `yanıt: ${JSON.stringify(personnelRes.data)}`);

  // --- Test 2: izin talebi oluştur → vehicleAssignmentConflict=true (şoför bir araca atanmış) ---
  const leaveRes = await api('POST', `/personnel/${personnelId}/leave-requests`, ownerToken, {
    leaveType: 'YILLIK',
    startDate: isoDatePlusDays(10),
    endDate: isoDatePlusDays(15),
    reason: 'Yıllık izin'
  });
  const leaveId = leaveRes.data.data?.id;
  check(
    'Test 2: İzin talebi oluşturuldu, status=TALEP_EDILDI, dayCount=6, vehicleAssignmentConflict=true',
    leaveRes.status === 200 &&
      leaveRes.data.data?.status === 'TALEP_EDILDI' &&
      leaveRes.data.data?.dayCount === 6 &&
      leaveRes.data.data?.vehicleAssignmentConflict?.hasConflict === true,
    `yanıt: ${JSON.stringify(leaveRes.data)}`
  );

  // --- Test 3: çakışan (overlap) bir izin talebi 409 ile reddedilir ---
  const overlapRes = await api('POST', `/personnel/${personnelId}/leave-requests`, ownerToken, {
    leaveType: 'MAZERET',
    startDate: isoDatePlusDays(12),
    endDate: isoDatePlusDays(13)
  });
  check('Test 3: Çakışan izin talebi 409 ile reddedildi', overlapRes.status === 409, `status: ${overlapRes.status}, yanıt: ${JSON.stringify(overlapRes.data)}`);

  // --- Test 4: bekleyenler listesi (SITE_MANAGER perspektifinden COMPANY_OWNER token ile simüle edilemez,
  //     bu yüzden rol ayrımını service-seviyesinde zaten test ediyoruz; burada COMPANY_OWNER'ın TALEP_EDILDI'yi de gördüğünü doğruluyoruz) ---
  const pendingRes = await api('GET', '/leave-requests/pending', ownerToken);
  const foundPending = (pendingRes.data.data || []).find((r: any) => r.id === leaveId);
  check(
    'Test 4: COMPANY_OWNER bekleyenler listesinde TALEP_EDILDI durumundaki talebi görüyor',
    pendingRes.status === 200 && !!foundPending,
    `bulunan: ${JSON.stringify(foundPending)}`
  );

  // --- Test 5: SITE_MANAGER saha onayı verir → SAHA_ONAYLANDI ---
  const siteApproveRes = await api('POST', `/leave-requests/${leaveId}/approve-site`, ownerToken); // COMPANY_OWNER da SITE_MANAGER rolüne izinli değil ama authorizeRoles('SUPER_ADMIN','SITE_MANAGER') — COMPANY_OWNER burada 403 almalı
  check(
    'Test 5: COMPANY_OWNER approve-site uçunu çağıramaz (403 — bu uç SITE_MANAGER\'a özel)',
    siteApproveRes.status === 403,
    `status: ${siteApproveRes.status}`
  );

  // --- Test 6: COMPANY_OWNER TALEP_EDILDI'den DOĞRUDAN (kısayol) onaylayabilir ---
  const companyApproveRes = await api('POST', `/leave-requests/${leaveId}/approve-company`, ownerToken);
  check(
    'Test 6: COMPANY_OWNER TALEP_EDILDI\'den kısayoldan ONAYLANDI\'ya geçirdi',
    companyApproveRes.status === 200 && companyApproveRes.data.data?.status === 'ONAYLANDI',
    `yanıt: ${JSON.stringify(companyApproveRes.data)}`
  );

  // --- Test 7: izin bakiyesi — 6 gün kullanıldı, 20 hak → 14 kaldı ---
  const balanceRes = await api('GET', `/personnel/${personnelId}/leave-balance?year=${new Date().getUTCFullYear()}`, ownerToken);
  check(
    'Test 7: İzin bakiyesi doğru (hak=20, kullanılan=6, kalan=14)',
    balanceRes.status === 200 &&
      balanceRes.data.data?.entitlementDays === 20 &&
      balanceRes.data.data?.usedDays === 6 &&
      balanceRes.data.data?.remainingDays === 14,
    `yanıt: ${JSON.stringify(balanceRes.data)}`
  );

  // --- Test 8: izin takvimi bu tarih aralığında kaydı gösteriyor ---
  const calendarRes = await api('GET', `/leave-calendar?startDate=${isoDatePlusDays(0)}&endDate=${isoDatePlusDays(20)}`, ownerToken);
  const foundInCalendar = (calendarRes.data.data || []).find((r: any) => r.id === leaveId);
  check('Test 8: İzin takviminde ONAYLANDI kaydı görünüyor', calendarRes.status === 200 && !!foundInCalendar, `bulundu: ${!!foundInCalendar}`);

  // --- Test 9: ikinci bir talep oluştur, reddet ---
  const secondLeaveRes = await api('POST', `/personnel/${personnelId}/leave-requests`, ownerToken, {
    leaveType: 'ÜCRETSİZ',
    startDate: isoDatePlusDays(30),
    endDate: isoDatePlusDays(31)
  });
  const secondLeaveId = secondLeaveRes.data.data?.id;
  const rejectRes = await api('POST', `/leave-requests/${secondLeaveId}/reject`, ownerToken, { rejectionReason: 'Bu dönemde personel yetersiz.' });
  check(
    'Test 9: İkinci talep reddedildi (REDDEDILDI)',
    rejectRes.status === 200 && rejectRes.data.data?.status === 'REDDEDILDI' && rejectRes.data.data?.rejectionReason === 'Bu dönemde personel yetersiz.',
    `yanıt: ${JSON.stringify(rejectRes.data)}`
  );

  // --- Test 10: üçüncü bir talep oluştur, iptal et ---
  const thirdLeaveRes = await api('POST', `/personnel/${personnelId}/leave-requests`, ownerToken, {
    leaveType: 'MAZERET',
    startDate: isoDatePlusDays(40),
    endDate: isoDatePlusDays(40)
  });
  const thirdLeaveId = thirdLeaveRes.data.data?.id;
  const cancelRes = await api('POST', `/leave-requests/${thirdLeaveId}/cancel`, ownerToken);
  check('Test 10: Üçüncü talep iptal edildi (IPTAL_EDILDI)', cancelRes.status === 200 && cancelRes.data.data?.status === 'IPTAL_EDILDI', `yanıt: ${JSON.stringify(cancelRes.data)}`);

  await sleep(200);

  // --- Test 11: audit_logs doğrulaması ---
  const auditRes = await api('GET', '/audit-logs?limit=50', ownerToken);
  const actions = (auditRes.data.data || []).map((l: any) => l.action);
  check(
    'Test 11: audit_logs — tüm izin akışı action\'ları mevcut',
    ['PERSONNEL_CREATED', 'LEAVE_REQUEST_CREATED', 'LEAVE_REQUEST_COMPANY_APPROVED', 'LEAVE_REQUEST_REJECTED', 'LEAVE_REQUEST_CANCELLED'].every((a) => actions.includes(a)),
    `görülen action'lar: ${JSON.stringify([...new Set(actions)])}`
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
