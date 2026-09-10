import Redis from 'ioredis';
import {
  interpolateStrappingVolume,
  cylinderVolume,
  correctToStandardVolume,
  volumeCorrectionFactor
} from '../src/fuel/tankVolume';

/**
 * FUEL-403.1 / FUEL-403.2 — daldırma cetveli import + doğrulama + cache
 * (403.1) ve lineer interpolasyon + ASTM D1250 sıcaklık düzeltmesi (403.2).
 *
 * Saf matematik doğrudan import ile; import/doğrulama/cache ve seviye→hacim
 * uçları canlı backend'e karşı HTTP ile test edilir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const TANK_ID_STRAP = 'tank-gebze-1';  // 'Gebze Ana Tank (T-1)', Motorin
const TANK_ID_CYL = 'tank-gebze-2';    // 'Gebze Yedek Depo (T-2)'
const TANK_ID_NO_TABLE = 'tank-orman-1';

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });

async function resetIpLoginRateLimit(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length > 0) await redis.del(...keys);
}
async function login(username: string): Promise<string> {
  await resetIpLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const b = await res.json();
  if (!b.accessToken) throw new Error(`login ${username}: ${JSON.stringify(b)}`);
  return b.accessToken;
}
async function call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FUEL-403.1/403.2] DALDIRMA CETVELİ + SEVİYE→HACİM TESTİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (name: string, cond: boolean, detail: string) => {
    total++;
    if (cond) { console.log(`✅ [PASS] ${name}\n   ${detail}\n`); passed++; }
    else { console.log(`❌ [FAIL] ${name}\n   ${detail}\n`); }
  };

  // ── SAF MATEMATİK ──────────────────────────────────────────────────────
  const pts = [
    { levelMm: 0, volumeLiters: 0 },
    { levelMm: 1000, volumeLiters: 5000 },
    { levelMm: 2000, volumeLiters: 12000 }
  ];
  const exact = interpolateStrappingVolume(pts, 1000);
  const mid = interpolateStrappingVolume(pts, 1500);   // 5000 + 0.5*(12000-5000) = 8500
  const below = interpolateStrappingVolume(pts, -50);
  const above = interpolateStrappingVolume(pts, 2500);
  check('Test 1: lineer interpolasyon (tam nokta / orta nokta / aralık dışı kırpma)',
    exact.observedLiters === 5000 && mid.observedLiters === 8500 &&
    below.observedLiters === 0 && below.outOfRange === true &&
    above.observedLiters === 12000 && above.outOfRange === true,
    `exact=${exact.observedLiters}, mid=${mid.observedLiters}, below oor=${below.outOfRange}, above oor=${above.outOfRange}`);

  // Yatay silindir: çap 2000mm (r=1000), uzunluk 5000mm. Yarı dolu (h=r) → πr²L/2
  const rMm = 1000, L = 5000;
  const halfFullExpected = (Math.PI * rMm * rMm * L / 2) / 1_000_000; // litre
  const fullExpected = (Math.PI * rMm * rMm * L) / 1_000_000;
  const cylHalf = cylinderVolume({ diameterMm: 2000, lengthMm: 5000, orientation: 'HORIZONTAL' }, 1000);
  const cylFull = cylinderVolume({ diameterMm: 2000, lengthMm: 5000, orientation: 'HORIZONTAL' }, 2000);
  const cylEmpty = cylinderVolume({ diameterMm: 2000, lengthMm: 5000, orientation: 'HORIZONTAL' }, 0);
  check('Test 2: yatay silindir kapalı form (boş / yarı / tam)',
    cylEmpty.observedLiters === 0 &&
    Math.abs(cylHalf.observedLiters - halfFullExpected) / halfFullExpected < 0.001 &&
    Math.abs(cylFull.observedLiters - fullExpected) / fullExpected < 0.001,
    `empty=${cylEmpty.observedLiters}, half=${cylHalf.observedLiters} (~${halfFullExpected.toFixed(1)}), full=${cylFull.observedLiters} (~${fullExpected.toFixed(1)})`);

  // Dikey silindir: taban alanı × yükseklik
  const cylVert = cylinderVolume({ diameterMm: 2000, lengthMm: 3000, orientation: 'VERTICAL' }, 1500);
  const vertExpected = (Math.PI * rMm * rMm * 1500) / 1_000_000;
  check('Test 3: dikey silindir (taban alanı × yükseklik)',
    Math.abs(cylVert.observedLiters - vertExpected) / vertExpected < 0.001,
    `vert=${cylVert.observedLiters} (~${vertExpected.toFixed(1)})`);

  // ASTM D1250 — dizel 25°C: VCF < 1, standart < gözlenen
  const dieselStd = correctToStandardVolume(1000, 25, 'Motorin (Euro Diesel)');
  const gasolineStd = correctToStandardVolume(1000, 25, 'Kurşunsuz 95 Benzin');
  check('Test 4: ASTM D1250 sıcaklık düzeltmesi — dizel 25°C → VCF<1, standart<gözlenen',
    dieselStd.temperatureCorrected === true && dieselStd.vcf < 1 && dieselStd.standardLiters < 1000 &&
    dieselStd.productGroup === 'DIESEL',
    `vcf=${dieselStd.vcf}, std=${dieselStd.standardLiters}, group=${dieselStd.productGroup}`);
  check('Test 5: benzin dizelden DAHA BÜYÜK düzeltme (farklı genleşme katsayısı — AC)',
    gasolineStd.productGroup === 'GASOLINE' && (1000 - gasolineStd.standardLiters) > (1000 - dieselStd.standardLiters),
    `dizel Δ=${(1000 - dieselStd.standardLiters).toFixed(2)} L, benzin Δ=${(1000 - gasolineStd.standardLiters).toFixed(2)} L`);
  const noTemp = correctToStandardVolume(1000, null, 'Motorin');
  check('Test 6: sıcaklık yoksa DÜZELTME YOK, "uncorrected" işaretli (standart=gözlenen)',
    noTemp.temperatureCorrected === false && noTemp.standardLiters === 1000 && noTemp.vcf === 1,
    `corrected=${noTemp.temperatureCorrected}, std=${noTemp.standardLiters}`);

  // ±%0.5 doğruluk (AC 1): elle hesaplanan VCF ile karşılaştır
  const vcf30 = volumeCorrectionFactor(30, 'DIESEL'); // ΔT=15
  const expectedStd = 1000 * vcf30;
  const got = correctToStandardVolume(1000, 30, 'Motorin (Euro Diesel)').standardLiters;
  check('Test 7: ±%0.5 doğruluk — dizel 30°C, elle hesaplanan VCF ile eşleşiyor',
    Math.abs(got - expectedStd) / expectedStd < 0.005,
    `beklenen ${expectedStd.toFixed(3)} L, alınan ${got} L (VCF=${vcf30.toFixed(6)})`);

  // ── HTTP: import + doğrulama ──────────────────────────────────────────
  const owner = await login('camsa');

  // Test 8: geçerli monoton CSV → 201
  const goodCsv = 'mm,litre\n0,0\n500,2400\n1000,5000\n1500,7800\n2000,10600';
  const r8 = await call('POST', `/tanks/${TANK_ID_STRAP}/strapping-table`, owner, { csvContent: goodCsv, notes: 'test v1' });
  check('Test 8: geçerli monoton CSV cetveli import → 201', r8.status === 201 && r8.body.data?.pointCount === 5,
    `status=${r8.status}, pointCount=${r8.body.data?.pointCount}`);

  // Test 9: hacim seviyeyle AZALAN CSV → 400 + satır hatası
  const nonMonoCsv = 'mm,litre\n0,0\n500,2400\n1000,2000\n1500,7800';
  const r9 = await call('POST', `/tanks/${TANK_ID_STRAP}/strapping-table`, owner, { csvContent: nonMonoCsv });
  check('Test 9: hacmi azalan cetvel reddediliyor (400 + satır hatası)',
    r9.status === 400 && Array.isArray(r9.body.details?.rows) && r9.body.details.rows.length > 0,
    `status=${r9.status}, rows=${JSON.stringify(r9.body.details?.rows)}`);

  // Test 10: mm seviyesi artmayan CSV → 400
  const badLevelCsv = 'mm,litre\n0,0\n1000,5000\n1000,6000';
  const r10 = await call('POST', `/tanks/${TANK_ID_STRAP}/strapping-table`, owner, { csvContent: badLevelCsv });
  check('Test 10: mm seviyesi kesin artmayan cetvel reddediliyor', r10.status === 400 && r10.body.details?.rows?.length > 0,
    `status=${r10.status}`);

  // Test 11: sayısal olmayan hücre → 400 satır hatası
  const nonNumericCsv = 'mm,litre\n0,0\n500,abc\n1000,5000';
  const r11 = await call('POST', `/tanks/${TANK_ID_STRAP}/strapping-table`, owner, { csvContent: nonNumericCsv });
  check('Test 11: sayısal olmayan hücre → 400 (satır 3)', r11.status === 400 && r11.body.details?.rows?.some((x: any) => x.row === 3),
    `status=${r11.status}, rows=${JSON.stringify(r11.body.details?.rows)}`);

  // Test 12: <2 nokta → 400 (Zod)
  const r12 = await call('POST', `/tanks/${TANK_ID_STRAP}/strapping-table`, owner, { points: [{ levelMm: 0, volumeLiters: 0 }] });
  check('Test 12: tek noktalı cetvel reddediliyor', r12.status === 400, `status=${r12.status}`);

  // ── HTTP: seviye→hacim (403.2) ───────────────────────────────────────
  // v1 cetveli aktif (Test 8). levelMm=750 → 2400 + 0.5*(5000-2400) = 3700
  const r13 = await call('GET', `/tanks/${TANK_ID_STRAP}/volume?levelMm=750`, owner);
  check('Test 13: GET /volume interpolasyon — 750mm → 3700 L ham',
    r13.status === 200 && r13.body.data?.observedLiters === 3700 && r13.body.data?.method === 'STRAPPING_INTERPOLATION',
    `status=${r13.status}, observed=${r13.body.data?.observedLiters}`);

  // Test 14: tempC ile → standart < ham (dizel), temperatureCorrected:true
  const r14 = await call('GET', `/tanks/${TANK_ID_STRAP}/volume?levelMm=1000&tempC=28`, owner);
  check('Test 14: GET /volume tempC=28 → 15°C standart hacim (ham + standart AYRI alanlarda)',
    r14.status === 200 && r14.body.data?.temperatureCorrected === true &&
    r14.body.data?.standardLiters < r14.body.data?.observedLiters && r14.body.data?.observedLiters === 5000,
    `observed=${r14.body.data?.observedLiters}, standard=${r14.body.data?.standardLiters}, vcf=${r14.body.data?.vcf}`);

  // Test 15: tempC yok → temperatureCorrected:false, standart=ham
  const r15 = await call('GET', `/tanks/${TANK_ID_STRAP}/volume?levelMm=1000`, owner);
  check('Test 15: GET /volume tempC yok → temperatureCorrected:false, standard=observed',
    r15.body.data?.temperatureCorrected === false && r15.body.data?.standardLiters === r15.body.data?.observedLiters,
    `corrected=${r15.body.data?.temperatureCorrected}, obs=${r15.body.data?.observedLiters}, std=${r15.body.data?.standardLiters}`);

  // Test 16: cache — cetvel Redis'te; ikinci sorgu aynı sonuç
  const cacheKeys = await redis.keys('tank:strapping:comp-camsa:*');
  const r16b = await call('GET', `/tanks/${TANK_ID_STRAP}/volume?levelMm=750`, owner);
  check('Test 16: efektif cetvel Redis cache\'inde + tekrar sorgu tutarlı',
    cacheKeys.length > 0 && r16b.body.data?.observedLiters === 3700,
    `cache keys=${cacheKeys.length}, tekrar observed=${r16b.body.data?.observedLiters}`);

  // Test 17: yeni versiyon → cache invalide, yeni değerler geçerli
  const v2Csv = 'mm,litre\n0,0\n1000,6000\n2000,12000'; // 750mm → 4500
  const r17set = await call('POST', `/tanks/${TANK_ID_STRAP}/strapping-table`, owner, { csvContent: v2Csv });
  const r17get = await call('GET', `/tanks/${TANK_ID_STRAP}/volume?levelMm=750`, owner);
  check('Test 17: yeni cetvel versiyonu cache\'i invalide ediyor (750mm artık 4500 L)',
    r17set.status === 201 && r17get.body.data?.observedLiters === 4500,
    `yeni observed=${r17get.body.data?.observedLiters}`);

  // Test 18: versiyon geçmişi korunuyor (append-only)
  const r18 = await call('GET', `/tanks/${TANK_ID_STRAP}/strapping-table`, owner);
  check('Test 18: cetvel versiyon geçmişi korunuyor (≥2 versiyon)',
    r18.status === 200 && r18.body.data?.versionCount >= 2 && r18.body.data?.effective?.pointCount === 3,
    `versionCount=${r18.body.data?.versionCount}, effective pointCount=${r18.body.data?.effective?.pointCount}`);

  // Test 19: silindirik tank formülü — cetvel YOK ama hesaplanabiliyor (AC)
  const r19set = await call('POST', `/tanks/${TANK_ID_CYL}/strapping-table`, owner, {
    cylinderConfig: { diameterMm: 2000, lengthMm: 4000, orientation: 'HORIZONTAL' }
  });
  const r19get = await call('GET', `/tanks/${TANK_ID_CYL}/volume?levelMm=1000`, owner); // yarı dolu
  const cylExpectedHalf = (Math.PI * 1000 * 1000 * 4000 / 2) / 1_000_000;
  check('Test 19: silindirik tank — strapping cetveli olmadan formülle hacim',
    r19set.status === 201 && r19get.status === 200 && r19get.body.data?.method === 'CYLINDER_FORMULA' &&
    Math.abs(r19get.body.data?.observedLiters - cylExpectedHalf) / cylExpectedHalf < 0.001,
    `method=${r19get.body.data?.method}, observed=${r19get.body.data?.observedLiters} (~${cylExpectedHalf.toFixed(1)})`);

  // Test 20: cetvel/formül tanımsız tank → 404
  const r20 = await call('GET', `/tanks/${TANK_ID_NO_TABLE}/volume?levelMm=500`, owner);
  check('Test 20: cetvel/formül tanımsız tank → 404', r20.status === 404, `status=${r20.status}`);

  // Test 21: kimlik doğrulaması olmadan → 401
  const r21 = await call('GET', `/tanks/${TANK_ID_STRAP}/volume?levelMm=500`);
  check('Test 21: token olmadan 401', r21.status === 401, `status=${r21.status}`);

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  if (passed !== total) process.exit(1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
