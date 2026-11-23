import Redis from 'ioredis';
import { Client } from 'pg';
import { buildDespatchAdviceXml, validateDespatchAdviceXml, resolveGtip } from '../src/compliance/despatchAdviceXmlService';

/**
 * COMP-601.1 — UBL 2.1 DespatchAdvice (e-İrsaliye taslağı) XML üretimi +
 * boşluksuz sıralı belge no + ETTN + XSD doğrulaması.
 *
 * "XSD şema doğrulamasından %100 hatasız geçmelidir" AC'si SAHTE bir şemaya
 * karşı değil — gerçek, kamuya açık OASIS UBL 2.1 DespatchAdvice şema
 * zincirine (bkz. src/compliance/ubl-xsd/, docs.oasis-open.org'dan vendored)
 * karşı, gerçek bir native libxml2 binding'i (libxmljs2) ile doğrulanıyor.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN_TAG = Date.now();

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });

function pgClient(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}

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

async function getXml(path: string, token?: string): Promise<{ status: number; contentType: string | null; headers: Headers; text: string }> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { headers });
  return { status: res.status, contentType: res.headers.get('content-type'), headers: res.headers, text: await res.text() };
}

async function login(username: string): Promise<string> {
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`Ön koşul: ${username} ile giriş başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

async function dispense(token: string, siteName: string, vehiclePlate: string, driverName: string | undefined, amountLiters: number, tankName?: string): Promise<string> {
  const res = await call('POST', '/dispense', { token, body: { siteName, vehiclePlate, driverName, amountLiters, tankName, type: 'Manuel' } });
  if (res.status !== 200) throw new Error(`Ön koşul: dispense başarısız: ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

const BASE_INPUT = {
  documentNumber: 'IRS2026000000001',
  ettn: '00000000-0000-4000-8000-000000000001',
  transactionId: 'TX-TEST-001',
  issueDate: '2026-09-06',
  supplierVkn: '2381092831',
  supplierName: 'ÇamSA Pelet & Enerji A.Ş.',
  supplierCity: 'Kocaeli / Gebze',
  vehiclePlate: '34 ABC 123',
  driverTcNo: '10928374821',
  fuelType: 'Motorin (Euro Diesel)',
  amountLiters: 450.5
};

async function run() {
  console.log('===========================================================');
  console.log('🧪 [COMP-601.1] UBL 2.1 DESPATCHADVICE (E-İRSALİYE) TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  function check(name: string, condition: boolean, detail: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}\n   ${detail}\n`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${name}\n   ${detail}\n`);
    }
  }

  // --- Test 1 (saf fonksiyon): geçerli girdi → gerçek OASIS UBL 2.1 XSD ---
  const sample = buildDespatchAdviceXml(BASE_INPUT);
  const v1 = validateDespatchAdviceXml(sample);
  check(
    'Test 1: geçerli girdi gerçek UBL 2.1 DespatchAdvice XSD şemasına karşı %100 doğrulanıyor',
    v1.valid && v1.errors.length === 0,
    `valid=${v1.valid}, errors=${JSON.stringify(v1.errors)}`
  );

  // --- Test 2: tüm AC alanları doğru UBL elemanlarında ---
  check(
    'Test 2: Belge No / ETTN / VKN / Firma Adı / Adres / Plaka / Şoför TC / Sevk Tarihi / GTIP doğru yerlerde',
    sample.includes('<cbc:ID>IRS2026000000001</cbc:ID>') &&
    sample.includes('<cbc:UUID>00000000-0000-4000-8000-000000000001</cbc:UUID>') &&
    sample.includes('<cbc:CompanyID>2381092831</cbc:CompanyID>') &&
    sample.includes('<cbc:Name>ÇamSA Pelet &amp; Enerji A.Ş.</cbc:Name>') &&
    sample.includes('<cbc:CityName>Kocaeli / Gebze</cbc:CityName>') &&
    sample.includes('<cbc:LicensePlateID>34 ABC 123</cbc:LicensePlateID>') &&
    sample.includes('<cbc:ID>10928374821</cbc:ID>') &&
    sample.includes('<cbc:IssueDate>2026-09-06</cbc:IssueDate>') &&
    sample.includes('<cac:OrderReference>') && sample.includes('<cbc:ID>TX-TEST-001</cbc:ID>') &&
    sample.includes('listID="GTIP"'),
    'Tüm alanlar bulundu'
  );

  // --- Test 3: GTIP yakıt tipine göre çözülüyor, sabit DEĞİL (saf fonksiyon) ---
  check(
    'Test 3: resolveGtip yakıt tipine göre farklı GTIP döndürüyor (sabit kodlanmamış)',
    resolveGtip('Motorin (Euro Diesel)').gtip === '2710194300' &&
    resolveGtip('Kurşunsuz 95 Oktan').gtip === '2710124500' &&
    resolveGtip('Kurşunsuz 98').gtip === '2710124900' &&
    resolveGtip('LPG (Otogaz)').gtip === '2711129700' &&
    resolveGtip('bilinmeyen yakıt').gtip === '2710194300' &&
    resolveGtip(null).gtip === '2710194300',
    'Motorin/95/98/LPG/varsayılan doğru'
  );

  // --- Test 4: XML özel karakter kaçırma ---
  const withSpecial = buildDespatchAdviceXml({ ...BASE_INPUT, transactionId: 'TX & <TEST>', supplierName: 'A & B <Ltd>' });
  const v4 = validateDespatchAdviceXml(withSpecial);
  check(
    'Test 4: özel karakterler (& <) kaçırılıp yine de şemaya uygun XML üretiliyor',
    withSpecial.includes('TX &amp; &lt;TEST&gt;') && withSpecial.includes('A &amp; B &lt;Ltd&gt;') && v4.valid,
    `valid=${v4.valid}`
  );

  // --- Test 5: eksik zorunlu alan → XSD GERÇEKTEN reddediyor ---
  const broken = sample.replace(/<cbc:IssueDate>.*?<\/cbc:IssueDate>/, '');
  const v5 = validateDespatchAdviceXml(broken);
  check(
    'Test 5: zorunlu alan (IssueDate) eksikken XSD doğrulaması BAŞARISIZ (her zaman true dönmüyor)',
    !v5.valid && v5.errors.length > 0,
    `valid=${v5.valid}, ilk hata: ${v5.errors[0]?.slice(0, 90)}`
  );

  // --- HTTP testleri -----------------------------------------------------
  const camsaToken = await login('camsa');
  const gebzeToken = await login('gebze-santiye');

  // Test 6: token yok → 401
  const r6 = await getXml('/transactions/nonexistent/e-irsaliye');
  check('Test 6: token olmadan 401', r6.status === 401, `Alınan: ${r6.status}`);

  // Test 7: kayıtlı sürücülü gerçek ikmal → e-İrsaliye üretiliyor, indirilen
  // XML ayrıca gerçek XSD'den geçiriliyor + belge no/ETTN header'ları doğru.
  const txId = await dispense(camsaToken, 'Gebze Ana Şantiye', `34 CMP ${RUN_TAG % 9000}`, 'Ahmet Yılmaz', 275.25);
  const r7 = await getXml(`/transactions/${txId}/e-irsaliye`, camsaToken);
  const num7 = r7.headers.get('x-despatch-advice-number') ?? '';
  const ettn7 = r7.headers.get('x-despatch-advice-ettn') ?? '';
  const v7 = r7.status === 200 ? validateDespatchAdviceXml(r7.text) : { valid: false, errors: ['HTTP ' + r7.status] };
  check(
    'Test 7: kayıtlı sürücülü ikmal için e-İrsaliye üretiliyor, indirilen XML gerçek XSD\'den geçiyor',
    r7.status === 200 &&
      r7.contentType?.includes('application/xml') === true &&
      /^IRS\d{4}\d{9}$/.test(num7) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ettn7) &&
      r7.text.includes(`<cbc:ID>${num7}</cbc:ID>`) &&
      r7.text.includes(`<cbc:UUID>${ettn7}</cbc:UUID>`) &&
      r7.text.includes('<cbc:ID>10928374821</cbc:ID>') &&
      v7.valid,
    `status=${r7.status}, belgeNo=${num7}, ettn=${ettn7}, xsd-valid=${v7.valid}`
  );

  // Test 8: AYNI ikmal için tekrar → AYNI belge no + AYNI ETTN (idempotent).
  const r8 = await getXml(`/transactions/${txId}/e-irsaliye`, camsaToken);
  check(
    'Test 8: aynı ikmalin e-İrsaliyesi tekrar istenince AYNI belge no + AYNI ETTN dönüyor',
    r8.headers.get('x-despatch-advice-number') === num7 &&
      r8.headers.get('x-despatch-advice-ettn') === ettn7,
    `1. no=${num7} / 2. no=${r8.headers.get('x-despatch-advice-number')}`
  );

  // Test 9: FARKLI iki ikmal → ardışık sıralı belge no, boşluk yok.
  const txA = await dispense(camsaToken, 'Gebze Ana Şantiye', `34 SEQ ${RUN_TAG % 9000}`, 'Ahmet Yılmaz', 30);
  const txB = await dispense(camsaToken, 'Gebze Ana Şantiye', `34 SEQ ${(RUN_TAG % 9000) + 1}`, 'Ahmet Yılmaz', 40);
  const numA = (await getXml(`/transactions/${txA}/e-irsaliye`, camsaToken)).headers.get('x-despatch-advice-number') ?? '';
  const numB = (await getXml(`/transactions/${txB}/e-irsaliye`, camsaToken)).headers.get('x-despatch-advice-number') ?? '';
  const seqA = parseInt(numA.slice(-9), 10);
  const seqB = parseInt(numB.slice(-9), 10);
  check(
    'Test 9: iki farklı ikmal ardışık belge no alıyor (boşluksuz sıralı — denetim gereği)',
    Number.isInteger(seqA) && seqB === seqA + 1,
    `numA=${numA} (seq ${seqA}), numB=${numB} (seq ${seqB})`
  );

  // Test 10: GTIP HTTP yolunda da yakıt tipine göre değişiyor.
  // Bir tankın fuel_type'ını geçici olarak LPG yapıp o tanktan ikmal alıp
  // e-İrsaliyede GTIP'in LPG kodu olduğunu doğruluyoruz, sonra geri alıyoruz.
  const pg = pgClient();
  await pg.connect();
  // T-2 kasıtlı: T-1'i test_fuel404_2 "son 1 dakikada bu tanktan işlem yok"
  // varsayımıyla ölçüyor — o testle çakışmamak için yedek depoyu kullanıyoruz.
  const TANK = 'Gebze Yedek Depo (T-2)';
  const original = (await pg.query('SELECT fuel_type FROM tanks WHERE name = $1 LIMIT 1', [TANK])).rows[0]?.fuel_type ?? 'Motorin (Euro Diesel)';
  try {
    await pg.query('UPDATE tanks SET fuel_type = $1 WHERE name = $2', ['LPG (Otogaz)', TANK]);
    const txLpg = await dispense(camsaToken, 'Gebze Ana Şantiye', `34 LPG ${RUN_TAG % 9000}`, 'Ahmet Yılmaz', 15, TANK);
    const rLpg = await getXml(`/transactions/${txLpg}/e-irsaliye`, camsaToken);
    check(
      'Test 10: LPG tankından ikmalde e-İrsaliye GTIP kodu LPG (2711129700) — sabit değil',
      rLpg.status === 200 &&
        rLpg.text.includes('<cbc:ItemClassificationCode listID="GTIP">2711129700</cbc:ItemClassificationCode>') &&
        rLpg.text.includes('<cbc:Name>LPG (Otogaz)</cbc:Name>'),
      `status=${rLpg.status}, GTIP LPG mi: ${rLpg.text.includes('2711129700')}`
    );
  } finally {
    await pg.query('UPDATE tanks SET fuel_type = $1 WHERE name = $2', [original, TANK]);
    await pg.end();
  }

  // Test 11: sicilde kayıtlı olmayan sürücü → 400.
  const txU = await dispense(camsaToken, 'Gebze Ana Şantiye', `34 CMP ${(RUN_TAG % 9000) + 2}`, `Bilinmeyen Şoför ${RUN_TAG}`, 50);
  const r11 = await call('GET', `/transactions/${txU}/e-irsaliye`, { token: camsaToken });
  check('Test 11: sicilde kayıtlı olmayan sürücü için 400', r11.status === 400, `Alınan: ${r11.status}`);

  // Test 12: SITE_MANAGER başka şantiyenin ikmali → 404.
  const txOther = await dispense(camsaToken, 'Orman Şantiyesi', `34 CMP ${(RUN_TAG % 9000) + 3}`, 'Hasan Kaya', 60);
  const r12 = await call('GET', `/transactions/${txOther}/e-irsaliye`, { token: gebzeToken });
  check('Test 12: SITE_MANAGER başka şantiyenin ikmali için 404', r12.status === 404, `Alınan: ${r12.status}`);

  // Test 13: var olmayan ikmal ID → 404.
  const r13 = await call('GET', '/transactions/tx-does-not-exist-12345/e-irsaliye', { token: camsaToken });
  check('Test 13: var olmayan ikmal ID → 404', r13.status === 404, `Alınan: ${r13.status}`);

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
