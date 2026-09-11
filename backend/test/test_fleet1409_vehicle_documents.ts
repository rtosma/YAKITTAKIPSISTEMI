/**
 * FLEET-1409 — Araç Doküman/Ruhsat Arşivi ve Son Kullanma Uyarıları uçtan
 * uca testi. Gerçek HTTP uçları üzerinden (nginx proxy, localhost:3000).
 *
 * Kapsanan davranış:
 *  - Belge yükleme (base64) → doğru fileSizeBytes, isCurrent=true.
 *  - Aynı türde ikinci yükleme (yenileme) → eskisi isCurrent=false'a düşer,
 *    APPEND-ONLY (eski satır silinmez, listede kalır).
 *  - documentType MUAYENE_RAPORU + expiryDate → FLEET-1408'in
 *    vehicle_compliance_deadlines'ına OTOMATİK işleniyor (ayrı bir alarm
 *    mekanizması kurulmadı, mevcut sistem besleniyor).
 *  - İndirilen bayt içeriği YÜKLENEN ile BİREBİR aynı + doğru Content-Type.
 *  - 10MB üstü dosya ve geçersiz mimeType reddediliyor.
 *  - İndirme audit_logs'a yazılıyor.
 *
 * Not: tek kullanımlık test firması + aracı, mevcut seed verisine dokunulmaz.
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

async function fetchRaw(path: string, token: string): Promise<{ status: number; contentType: string | null; buffer: Buffer }> {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type'), buffer };
}

function isoDatePlusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function run() {
  console.log('===========================================================');
  console.log('📁 [FLEET-1409] ARAÇ DOKÜMAN/RUHSAT ARŞİVİ TESTİ');
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

  const companyName = `fleet1409t${Date.now()}`;
  const createCompanyRes = await api('POST', '/companies', adminToken, { name: companyName, package: 'KURUMSAL' });
  const companyId = createCompanyRes.data.data?.id;
  check('Ön koşul: Test firması oluşturuldu', createCompanyRes.status === 200 && !!companyId, `yanıt: ${JSON.stringify(createCompanyRes.data)}`);

  const ownerToken = await login(companyName);

  const plate = `34FL${(Date.now() % 10000).toString().padStart(4, '0')}`;
  const createVehicleRes = await api('POST', '/vehicles', ownerToken, {
    plate,
    brandModel: 'Ford Cargo',
    type: 'Kamyon',
    rfidTag: `RFID-${Date.now()}`,
    fuelCapacityLiters: 300
  });
  const vehicleId = createVehicleRes.data.data?.id;
  check('Ön koşul: Test aracı oluşturuldu', createVehicleRes.status === 200 && !!vehicleId, `yanıt: ${JSON.stringify(createVehicleRes.data)}`);

  // --- Test 1: RUHSAT belgesi yükle (compliance linki YOK) ---
  const ruhsatContent = Buffer.from('%PDF-1.4 test ruhsat içeriği').toString('base64');
  const ruhsatRes = await api('POST', `/vehicles/${vehicleId}/documents`, ownerToken, {
    documentType: 'RUHSAT',
    fileName: 'ruhsat-v1.pdf',
    mimeType: 'application/pdf',
    fileContentBase64: ruhsatContent
  });
  check(
    'Test 1: RUHSAT belgesi yüklendi, isCurrent=true ve fileSizeBytes doğru',
    ruhsatRes.status === 200 &&
      ruhsatRes.data.data?.isCurrent === true &&
      ruhsatRes.data.data?.fileSizeBytes === Buffer.from(ruhsatContent, 'base64').length,
    `yanıt: ${JSON.stringify(ruhsatRes.data)}`
  );
  const ruhsatV1Id = ruhsatRes.data.data?.id;

  // --- Test 2: MUAYENE_RAPORU + expiryDate=15 gün sonra → FLEET-1408 entegrasyonu ---
  const muayeneContent = Buffer.from('%PDF-1.4 test muayene raporu').toString('base64');
  const muayeneRes = await api('POST', `/vehicles/${vehicleId}/documents`, ownerToken, {
    documentType: 'MUAYENE_RAPORU',
    fileName: 'muayene-2026.pdf',
    mimeType: 'application/pdf',
    fileContentBase64: muayeneContent,
    expiryDate: isoDatePlusDays(15)
  });
  check('Test 2: MUAYENE_RAPORU belgesi yüklendi', muayeneRes.status === 200, `yanıt: ${JSON.stringify(muayeneRes.data)}`);
  await sleep(200);

  const deadlinesRes = await api('GET', `/vehicles/${vehicleId}/compliance-deadlines`, ownerToken);
  const linkedDeadline = (deadlinesRes.data.data || []).find((d: any) => d.deadlineType === 'MUAYENE');
  check(
    'Test 2b: FLEET-1408 uyum takvimine (vehicle_compliance_deadlines) OTOMATİK işlendi',
    deadlinesRes.status === 200 && !!linkedDeadline && linkedDeadline.dueDate === isoDatePlusDays(15),
    `bulunan MUAYENE kaydı: ${JSON.stringify(linkedDeadline)}`
  );

  // --- Test 3: GET /vehicles/:id/documents listesi doğru (2 belge, ikisi de isCurrent, MUAYENE isExpiringSoon) ---
  const listRes = await api('GET', `/vehicles/${vehicleId}/documents`, ownerToken);
  const ruhsatEntry = (listRes.data.data || []).find((d: any) => d.documentType === 'RUHSAT');
  const muayeneEntry = (listRes.data.data || []).find((d: any) => d.documentType === 'MUAYENE_RAPORU');
  check(
    'Test 3: Belge listesi doğru (RUHSAT+MUAYENE_RAPORU, ikisi de güncel, MUAYENE isExpiringSoon=true)',
    listRes.status === 200 &&
      ruhsatEntry?.isCurrent === true &&
      muayeneEntry?.isCurrent === true &&
      muayeneEntry?.isExpiringSoon === true &&
      muayeneEntry?.daysUntilExpiry === 15,
    `liste: ${JSON.stringify(listRes.data.data)}`
  );

  // --- Test 4: indirilen bayt içeriği yüklenenle BİREBİR aynı + doğru Content-Type ---
  const downloadRes = await fetchRaw(`/vehicle-documents/${ruhsatV1Id}/content`, ownerToken);
  const originalBytes = Buffer.from(ruhsatContent, 'base64');
  check(
    'Test 4: İndirilen dosya içeriği (bayt bazında) yüklenenle birebir aynı, Content-Type doğru',
    downloadRes.status === 200 && downloadRes.buffer.equals(originalBytes) && downloadRes.contentType?.includes('application/pdf'),
    `status: ${downloadRes.status}, contentType: ${downloadRes.contentType}, eşleşiyor mu: ${downloadRes.buffer.equals(originalBytes)}`
  );

  // --- Test 5: aynı tür (RUHSAT) ikinci kez yüklenince (yenileme) — APPEND-ONLY ---
  const ruhsatV2Content = Buffer.from('%PDF-1.4 YENİ ruhsat içeriği (yenilenmiş)').toString('base64');
  const ruhsatV2Res = await api('POST', `/vehicles/${vehicleId}/documents`, ownerToken, {
    documentType: 'RUHSAT',
    fileName: 'ruhsat-v2.pdf',
    mimeType: 'application/pdf',
    fileContentBase64: ruhsatV2Content
  });
  check('Test 5: RUHSAT yenileme (2. yükleme) başarılı', ruhsatV2Res.status === 200, `yanıt: ${JSON.stringify(ruhsatV2Res.data)}`);
  await sleep(200);

  const listAfterRenewalRes = await api('GET', `/vehicles/${vehicleId}/documents`, ownerToken);
  const ruhsatEntries = (listAfterRenewalRes.data.data || []).filter((d: any) => d.documentType === 'RUHSAT');
  const oldRuhsat = ruhsatEntries.find((d: any) => d.id === ruhsatV1Id);
  const newRuhsat = ruhsatEntries.find((d: any) => d.id === ruhsatV2Res.data.data?.id);
  check(
    'Test 5b: Yenileme sonrası — ESKİ belge listede KALDI (append-only) ama isCurrent=false, YENİ isCurrent=true',
    ruhsatEntries.length === 2 && oldRuhsat?.isCurrent === false && newRuhsat?.isCurrent === true,
    `RUHSAT kayıtları: ${JSON.stringify(ruhsatEntries)}`
  );

  // --- Test 6: 10MB üstü dosya reddedilir ---
  // Not: 10.5MB seçildi (11MB DEĞİL) — base64'e çevrilince ~14MB olur, bu da
  // index.ts'teki 15mb'lık Express JSON gövde sınırının GÜVENLE altında kalır
  // (aksi halde Express kendi 413'ünü döner, bu testin amacı olan servis
  // katmanındaki 400 BadRequestError kontrolüne hiç ulaşılmaz).
  const oversizedContent = Buffer.alloc(10.5 * 1024 * 1024, 'a').toString('base64');
  const oversizedRes = await api('POST', `/vehicles/${vehicleId}/documents`, ownerToken, {
    documentType: 'DIGER',
    fileName: 'buyuk-dosya.pdf',
    mimeType: 'application/pdf',
    fileContentBase64: oversizedContent
  });
  check('Test 6: 10MB üstü dosya reddedildi (400)', oversizedRes.status === 400, `status: ${oversizedRes.status}, yanıt: ${JSON.stringify(oversizedRes.data)}`);

  // --- Test 7: geçersiz mimeType reddedilir (şema doğrulaması) ---
  const invalidMimeRes = await api('POST', `/vehicles/${vehicleId}/documents`, ownerToken, {
    documentType: 'DIGER',
    fileName: 'zararli.exe',
    mimeType: 'application/x-msdownload',
    fileContentBase64: Buffer.from('test').toString('base64')
  });
  check('Test 7: Geçersiz mimeType (application/x-msdownload) reddedildi (400)', invalidMimeRes.status === 400, `status: ${invalidMimeRes.status}`);

  // --- Test 8: indirme audit_logs'a yazılıyor ---
  const auditRes = await api('GET', '/audit-logs?limit=50', ownerToken);
  const actions = (auditRes.data.data || []).map((l: any) => l.action);
  check(
    'Test 8: audit_logs — VEHICLE_DOCUMENT_UPLOADED ve VEHICLE_DOCUMENT_DOWNLOADED kayıtları mevcut',
    actions.includes('VEHICLE_DOCUMENT_UPLOADED') && actions.includes('VEHICLE_DOCUMENT_DOWNLOADED'),
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
