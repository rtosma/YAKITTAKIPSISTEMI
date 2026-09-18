import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * REP-711 (#168) — İkmal Hareket Raporu.
 *
 * Ortak filtre/sayfalama/CSV/PDF motoru REP-703'e (GitHub #166) ait ve
 * test_rep703_report_framework.ts'te ZATEN egzersiz ediliyor — bu dosya
 * SADECE bu raporun KENDİ AC'lerine özgü davranışı sınar (bkz.
 * reports/definitions/rep711DispenseMovement.ts'in başındaki genişletme
 * notları): birim fiyat/tutar GENEL TOPLAM'ı, fiyatsız kayıtların toplamı
 * BOZMADAN 0 katkı yapması, yetki tipine (Manuel/Otomatik/Çevrimdışı
 * Senkron) göre ayrışma+filtreleme, YENİ tank/yakıt tipi filtreleri, ve
 * CSV export'un yeni sütunları JSON listeleme ile TUTARLI üretmesi.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const MARKER_PLATE_PREFIX = `REP711-${RUN}`;
const GEBZE_SITE = 'Gebze Ana Şantiye';
const SILIVRI_SITE = 'Silivri Tesisleri';

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg();
  await c.connect();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function call(method: string, path: string, token: string): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${API_URL}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const raw = await res.text();
  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* CSV/PDF export gövdesi JSON DEĞİL */
  }
  return { status: res.status, body, raw };
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: '123456' }) });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

async function run() {
  console.log('===========================================================');
  console.log('🧾 [REP-711] İKMAL HAREKET RAPORU TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };

  const owner = await login('camsa');
  const gebzeMgr = await login('gebze-santiye');
  const txIds: string[] = [];

  try {
    // === Fixture: aynı vehiclePlate ÖNEKİNİ paylaşan 4 kayıt — 3'ü Gebze'de
    // (Manuel/fiyatlı, Otomatik/fiyatlı, Çevrimdışı/FİYATSIZ), 1'i Silivri'de
    // (site-scoping testi için). ===
    const manualId = `tx-rep711-manual-${RUN}`;
    const otomatikId = `tx-rep711-otomatik-${RUN}`;
    const offlineId = `tx-rep711-offline-${RUN}`;
    const otherSiteId = `tx-rep711-othersite-${RUN}`;
    txIds.push(manualId, otomatikId, offlineId, otherSiteId);

    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, type, device_id, fuel_type, unit_cost_liters, total_cost, created_at)
       VALUES ($1, 'comp-camsa', $2, $3, 'Test Sürücü', 'Tank-A', 100, 'Manuel', NULL, 'Motorin', 25.50, 2550.00, NOW())`,
      [manualId, GEBZE_SITE, `${MARKER_PLATE_PREFIX}-1`]
    );
    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, type, device_id, fuel_type, unit_cost_liters, total_cost, created_at)
       VALUES ($1, 'comp-camsa', $2, $3, 'Test Sürücü', 'Tank-A', 50, 'Otomatik', 'esp32-pump-01', 'Motorin', 25.50, 1275.00, NOW())`,
      [otomatikId, GEBZE_SITE, `${MARKER_PLATE_PREFIX}-2`]
    );
    // Fiyat geçmişi olmayan tank → unit_cost_liters/total_cost NULL (AC — GENEL TOPLAM'ı bozmamalı).
    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, type, device_id, fuel_type, unit_cost_liters, total_cost, created_at)
       VALUES ($1, 'comp-camsa', $2, $3, 'Test Sürücü', 'Tank-B', 30, 'Çevrimdışı Senkron', 'esp32-pump-01', 'Benzin', NULL, NULL, NOW())`,
      [offlineId, GEBZE_SITE, `${MARKER_PLATE_PREFIX}-3`]
    );
    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, type, device_id, fuel_type, unit_cost_liters, total_cost, created_at)
       VALUES ($1, 'comp-camsa', $2, $3, 'Test Sürücü', 'Tank-C', 999, 'Manuel', NULL, 'Motorin', 10.00, 9990.00, NOW())`,
      [otherSiteId, SILIVRI_SITE, `${MARKER_PLATE_PREFIX}-4`]
    );

    // === Test 1 (ASIL AC — eksiksiz listeleme): vehiclePlate filtresiyle
    // (site kısıtı OLMAYAN COMPANY_OWNER) TÜM 4 kayıt görünür. ===
    const listAll = await call('GET', `/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE_PREFIX)}&pageSize=10`, owner);
    const idsAll = new Set((listAll.body?.data || []).map((r: any) => r.id));
    check(
      'Test 1 (ASIL AC — eksiksiz listeleme): COMPANY_OWNER (site kısıtsız) TÜM 4 fixture kaydını görür',
      listAll.status === 200 && [manualId, otomatikId, offlineId, otherSiteId].every((id) => idsAll.has(id)),
      `status=${listAll.status}, count=${listAll.body?.data?.length}, ids=${JSON.stringify([...idsAll])}`
    );

    // === Test 2 (ASIL AC — GENEL TOPLAM litre+tutar, fiyatsız kayıt 0 katkı yapar):
    // 4 kaydın toplamı: litre=100+50+30+999=1179, tutar=2550+1275+0(NULL)+9990=13815. ===
    check(
      'Test 2 (ASIL AC — GENEL TOPLAM litre+tutar): fiyatsız (NULL) kayıt toplamı BOZMADAN 0 katkı yapar',
      listAll.body?.aggregates?.total_liters === 1179 && listAll.body?.aggregates?.total_amount === 13815,
      `aggregates=${JSON.stringify(listAll.body?.aggregates)}`
    );

    // === Test 3 (ASIL AC — yetki tipine göre ayrışma+filtreleme): type filtresi
    // 'Çevrimdışı Senkron' yalnızca offline kaydı döndürür; 'Otomatik' yalnızca
    // RFID/cihaz kaydını; sütunlarda device_id/unit_cost_liters/total_cost DOĞRU. ===
    const listOffline = await call('GET', `/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE_PREFIX)}&type=${encodeURIComponent('Çevrimdışı Senkron')}`, owner);
    const offlineRow = (listOffline.body?.data || [])[0];
    const listOtomatik = await call('GET', `/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE_PREFIX)}&type=Otomatik`, owner);
    const otomatikRow = (listOtomatik.body?.data || [])[0];
    check(
      "Test 3 (ASIL AC — yetki tipiyle ayrışma+filtreleme): 'Çevrimdışı Senkron' filtresi SADECE offline kaydı döndürür (unit_cost_liters/total_cost NULL), 'Otomatik' filtresi SADECE device_id'li RFID kaydını döndürür",
      listOffline.body?.data?.length === 1 && offlineRow?.id === offlineId && offlineRow?.unit_cost_liters === null && offlineRow?.device_id === 'esp32-pump-01' &&
        listOtomatik.body?.data?.length === 1 && otomatikRow?.id === otomatikId && otomatikRow?.unit_cost_liters === '25.5000',
      `offlineCount=${listOffline.body?.data?.length}, offlineId=${offlineRow?.id}, otomatikCount=${listOtomatik.body?.data?.length}, otomatikUnitCost=${otomatikRow?.unit_cost_liters}`
    );

    // === Test 4 (Kapsam — YENİ tank/yakıt tipi filtreleri): tankName='Tank-B'
    // VE fuelType='Benzin' kombinasyonu SADECE offline kaydı döndürür. ===
    const listTankFuel = await call('GET', `/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE_PREFIX)}&tankName=Tank-B&fuelType=Benzin`, owner);
    check(
      "Test 4 (Kapsam — yeni tank+yakıt tipi filtreleri): tankName='Tank-B' + fuelType='Benzin' SADECE offline kaydı döndürür",
      listTankFuel.body?.data?.length === 1 && listTankFuel.body.data[0].id === offlineId,
      `count=${listTankFuel.body?.data?.length}, id=${listTankFuel.body?.data?.[0]?.id}`
    );

    // === Test 5 (ASIL AC — rol bazlı görünürlük/site scoping): Gebze SITE_MANAGER
    // yalnızca KENDİ şantiyesindeki 3 kaydı görür, Silivri'deki 4. kayıt HARİÇ. ===
    const listGebzeMgr = await call('GET', `/reports/rep-711?vehiclePlate=${encodeURIComponent(MARKER_PLATE_PREFIX)}&pageSize=10`, gebzeMgr);
    const idsGebze = new Set((listGebzeMgr.body?.data || []).map((r: any) => r.id));
    check(
      'Test 5 (ASIL AC — rol bazlı görünürlük): Gebze SITE_MANAGER 3 Gebze kaydını görür, Silivri kaydını GÖRMEZ',
      listGebzeMgr.status === 200 && idsGebze.has(manualId) && idsGebze.has(otomatikId) && idsGebze.has(offlineId) && !idsGebze.has(otherSiteId),
      `status=${listGebzeMgr.status}, count=${listGebzeMgr.body?.data?.length}, hasOtherSite=${idsGebze.has(otherSiteId)}`
    );

    // === Test 6 (ASIL AC — CSV/PDF tutarlılığı): CSV export başlıkları YENİ
    // sütunları içerir VE manuel kaydın satırı doğru birim fiyat/tutar taşır;
    // PDF export AYNI filtreyle 200 döner (yeni sütunlarla PDF render ÇÖKMEZ). ===
    const csvRes = await call('GET', `/reports/rep-711/export?format=csv&vehiclePlate=${encodeURIComponent(MARKER_PLATE_PREFIX)}&type=Manuel&siteName=${encodeURIComponent(GEBZE_SITE)}`, owner);
    const pdfRes = await fetch(`${API_URL}/reports/rep-711/export?format=pdf&vehiclePlate=${encodeURIComponent(MARKER_PLATE_PREFIX)}`, { headers: { Authorization: `Bearer ${owner}` } });
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
    check(
      "Test 6 (ASIL AC — CSV/PDF tutarlılığı): CSV başlıkları 'Birim Fiyat'/'Tutar'/'Yetki Tipi' içerir, manuel kaydın satırı 25.5000/2550.00 taşır; PDF export (11 sütunla) 200 + geçerli %PDF döner",
      csvRes.status === 200 && csvRes.raw.includes('Birim Fiyat') && csvRes.raw.includes('Tutar') && csvRes.raw.includes('Yetki Tipi') && csvRes.raw.includes('25.5000') && csvRes.raw.includes('2550.00') &&
        pdfRes.status === 200 && pdfBuffer.subarray(0, 5).toString('latin1') === '%PDF-',
      `csvStatus=${csvRes.status}, hasHeaders=${csvRes.raw.includes('Birim Fiyat') && csvRes.raw.includes('Tutar')}, pdfStatus=${pdfRes.status}, pdfMagic=${pdfBuffer.subarray(0, 5).toString('latin1')}`
    );
  } finally {
    await q('DELETE FROM transactions WHERE id = ANY($1)', [txIds]);
    await resetLoginRateLimit();
    console.log('🧹 Test fixture verisi temizlendi.\n');
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
