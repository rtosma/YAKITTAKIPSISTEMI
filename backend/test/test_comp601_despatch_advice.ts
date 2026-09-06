import Redis from 'ioredis';
import { buildDespatchAdviceXml, validateDespatchAdviceXml } from '../src/compliance/despatchAdviceXmlService';

/**
 * COMP-601 — UBL 2.1 DespatchAdvice (e-İrsaliye taslağı) XML üretimi + XSD
 * doğrulaması.
 *
 * "XSD şema doğrulamasından %100 hatasız geçmelidir" AC'si SAHTE bir şemaya
 * karşı değil — gerçek, kamuya açık OASIS UBL 2.1 DespatchAdvice şema
 * zincirine (bkz. src/compliance/ubl-xsd/, docs.oasis-open.org'dan vendored)
 * karşı, gerçek bir native libxml2 binding'i (libxmljs2) ile doğrulanıyor.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN_TAG = Date.now();

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

async function getXml(path: string, token?: string): Promise<{ status: number; contentType: string | null; text: string }> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { headers });
  return { status: res.status, contentType: res.headers.get('content-type'), text: await res.text() };
}

async function login(username: string): Promise<string> {
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

async function dispense(token: string, siteName: string, vehiclePlate: string, driverName: string | undefined, amountLiters: number): Promise<string> {
  const res = await call('POST', '/dispense', { token, body: { siteName, vehiclePlate, driverName, amountLiters, type: 'Manuel' } });
  if (res.status !== 200) throw new Error(`Ön koşul: dispense başarısız: ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [COMP-601] UBL 2.1 DESPATCHADVICE (E-İRSALİYE) TESTİ');
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

  // --- Test 1 (saf fonksiyon, ağ/DB yok): geçerli girdi → gerçek OASIS UBL
  // 2.1 XSD şemasına karşı %100 doğrulanıyor.
  const sample = buildDespatchAdviceXml({
    transactionId: 'TX-TEST-001',
    issueDate: '2026-09-06',
    supplierVkn: '2381092831',
    vehiclePlate: '34 ABC 123',
    driverTcNo: '10928374821',
    amountLiters: 450.5
  });
  const v1 = validateDespatchAdviceXml(sample);
  check(
    'Test 1: geçerli girdi gerçek UBL 2.1 DespatchAdvice XSD şemasına karşı doğrulanıyor',
    v1.valid && v1.errors.length === 0,
    `valid=${v1.valid}, errors=${JSON.stringify(v1.errors)}`
  );

  // --- Test 2: AC'nin istediği 4 alan (+ GTIP) doğru UBL elemanlarına basılmış
  check(
    'Test 2: VKN/Plaka/Şoför TC/Sevk Tarihi/GTIP çıktıda doğru yerlerde',
    sample.includes('<cbc:CompanyID>2381092831</cbc:CompanyID>') &&
    sample.includes('<cbc:LicensePlateID>34 ABC 123</cbc:LicensePlateID>') &&
    sample.includes('<cbc:ID>10928374821</cbc:ID>') &&
    sample.includes('<cbc:IssueDate>2026-09-06</cbc:IssueDate>') &&
    sample.includes('listID="GTIP"') && sample.includes('2710194300'),
    'Tüm 5 alan bulundu'
  );

  // --- Test 3: XML özel karakterleri kaçırılıyor (enjeksiyon değil, kazara
  // bozuk XML üretimi riski) ---------------------------------------------
  const withSpecialChars = buildDespatchAdviceXml({
    transactionId: 'TX & <TEST>',
    issueDate: '2026-09-06',
    supplierVkn: '2381092831',
    vehiclePlate: '34 ABC 123',
    driverTcNo: '10928374821',
    amountLiters: 10
  });
  const v3 = validateDespatchAdviceXml(withSpecialChars);
  check(
    'Test 3: özel karakterler (& <) kaçırılıp yine de şemaya uygun XML üretiliyor',
    withSpecialChars.includes('TX &amp; &lt;TEST&gt;') && v3.valid,
    `valid=${v3.valid}, içerik: ${withSpecialChars.includes('TX &amp;')}`
  );

  // --- Test 4: eksik zorunlu alan (cbc:IssueDate yok) → XSD reddediyor ----
  // Doğrudan XML string manipülasyonu ile builder'ı BYPASS edip eksik bir
  // belge simüle ediliyor — validateDespatchAdviceXml'in GERÇEKTEN
  // doğrulama yaptığını (her zaman true dönmediğini) kanıtlamak için.
  const broken = sample.replace(/<cbc:IssueDate>.*?<\/cbc:IssueDate>/, '');
  const v4 = validateDespatchAdviceXml(broken);
  check(
    'Test 4: zorunlu bir alan eksikken (IssueDate) XSD doğrulaması BAŞARISIZ dönüyor',
    !v4.valid && v4.errors.length > 0,
    `valid=${v4.valid}, errors=${JSON.stringify(v4.errors)}`
  );

  // --- HTTP testleri -------------------------------------------------------
  const camsaToken = await login('camsa'); // COMPANY_OWNER, comp-camsa, VKN 2381092831
  const gebzeToken = await login('gebze-santiye'); // SITE_MANAGER, 'Gebze Ana Şantiye'

  // Test 5: kimlik doğrulaması olmadan erişim reddi.
  const r5 = await getXml('/transactions/nonexistent/e-irsaliye');
  check('Test 5: token olmadan 401', r5.status === 401, `Alınan: ${r5.status}`);

  // Test 6: sicilde KAYITLI bir sürücüyle (Ahmet Yılmaz, TC 10928374821)
  // yapılan gerçek bir ikmal için e-İrsaliye başarıyla üretilip GERÇEK XSD'ye
  // karşı doğrulanıyor.
  const txId = await dispense(camsaToken, 'Gebze Ana Şantiye', `34 CMP ${RUN_TAG % 10000}`, 'Ahmet Yılmaz', 275.25);
  const r6 = await getXml(`/transactions/${txId}/e-irsaliye`, camsaToken);
  const v6 = r6.status === 200 ? validateDespatchAdviceXml(r6.text) : { valid: false, errors: ['HTTP ' + r6.status] };
  check(
    'Test 6: kayıtlı sürücülü ikmal için e-İrsaliye üretiliyor ve XSD\'den geçiyor',
    r6.status === 200 &&
      r6.contentType?.includes('application/xml') === true &&
      r6.text.includes('<cbc:CompanyID>2381092831</cbc:CompanyID>') &&
      r6.text.includes('<cbc:ID>10928374821</cbc:ID>') &&
      v6.valid,
    `status=${r6.status}, contentType=${r6.contentType}, xsd-valid=${v6.valid}`
  );

  // Test 7: sicilde KAYITLI OLMAYAN bir sürücü için 400 (TC no bulunamaz).
  const txIdUnregistered = await dispense(camsaToken, 'Gebze Ana Şantiye', `34 CMP ${RUN_TAG % 10000 + 1}`, `Bilinmeyen Şoför ${RUN_TAG}`, 50);
  const r7 = await call('GET', `/transactions/${txIdUnregistered}/e-irsaliye`, { token: camsaToken });
  check(
    'Test 7: sicilde kayıtlı olmayan sürücü için 400 (TC no bulunamadı)',
    r7.status === 400,
    `Alınan: ${r7.status}, body: ${JSON.stringify(r7.body)}`
  );

  // Test 8: SITE_MANAGER, KENDİ şantiyesi DIŞINDAKİ bir ikmalin e-İrsaliyesini
  // göremez (AUTH-201.4 ile aynı desen) — ID'yi tahmin etse bile 404.
  const txIdOtherSite = await dispense(camsaToken, 'Orman Şantiyesi', `34 CMP ${RUN_TAG % 10000 + 2}`, 'Hasan Kaya', 60);
  const r8 = await call('GET', `/transactions/${txIdOtherSite}/e-irsaliye`, { token: gebzeToken });
  check(
    'Test 8: SITE_MANAGER başka şantiyenin ikmali için 404 alıyor',
    r8.status === 404,
    `Alınan: ${r8.status}`
  );

  // Test 9: var olmayan bir ikmal ID'si için 404.
  const r9 = await call('GET', '/transactions/tx-does-not-exist-12345/e-irsaliye', { token: camsaToken });
  check('Test 9: var olmayan ikmal ID\'si → 404', r9.status === 404, `Alınan: ${r9.status}`);

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
