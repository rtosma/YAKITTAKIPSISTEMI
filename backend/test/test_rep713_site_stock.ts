import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * REP-713 (#170) — Şantiye Bazlı Tüketim ve Stok Raporu.
 *
 * Rapor FUEL-409 mutabakat satırlarını okur (yeniden hesaplamaz); bu test
 * "bilinen dolum/ikmal setiyle bakiye hesabını elle hesapla karşılaştırma"
 * Test Notu'nu uygular: fixture tanklar + dolum + ikmal + onaylı fire SQL ile
 * kurulur, mutabakatlar GERÇEK uç (POST /tanks/:id/reconciliations) üzerinden
 * üretilir, beklenen değerler ELLE hesaplanmıştır. Pencere 2021-03-01 (hiçbir
 * gerçek/başka test verisi yok, günlük süpürücü yalnızca güncel dönemleri üretir).
 *
 * Elle hesap (pencere 2021-03-01, AD_HOC):
 *  G1 Gebze/Motorin  KRİTİK(400<=500): 5000 +1000 −300 −0 = 5700, fiziksel 5680 → fark −20; onaylı fire 20
 *  G2 Gebze/Benzin   (8000>500):       2000 +0    −500    = 1500, fiziksel 1500 → 0
 *  G3 Gebze/Motorin  (eşik YOK):       3000 +500  −200    = 3300, fiziksel 3300 → 0
 *  S1 Silivri/Motorin KRİTİK(100<=500): 1000 +0   −100    = 900,  fiziksel 900  → 0
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const SILIVRI = 'Silivri Tesisleri';
const W_START = '2021-03-01T00:00:00.000Z';
const W_END = '2021-03-02T00:00:00.000Z';
const W_MID = '2021-03-01T12:00:00.000Z';
const WINDOW_QS = 'startDate=2021-03-01&endDate=2021-03-02&periodType=AD_HOC&pageSize=50';

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
async function call(method: string, path: string, token: string, body?: any): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const raw = await res.text();
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* CSV gövdesi */
  }
  return { status: res.status, body: parsed, raw };
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
  console.log('🛢️  [REP-713] ŞANTİYE BAZLI TÜKETİM VE STOK RAPORU TESTİ');
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
  const pumpOp = await login('pompa-op-01');

  const tanks = {
    G1: { id: `tank-r713-g1-${RUN}`, name: `R713-G1-${RUN}`, site: GEBZE, fuel: 'Motorin', level: 400, threshold: 500 as number | null },
    G2: { id: `tank-r713-g2-${RUN}`, name: `R713-G2-${RUN}`, site: GEBZE, fuel: 'Benzin', level: 8000, threshold: 500 as number | null },
    G3: { id: `tank-r713-g3-${RUN}`, name: `R713-G3-${RUN}`, site: GEBZE, fuel: 'Motorin', level: 3000, threshold: null as number | null },
    S1: { id: `tank-r713-s1-${RUN}`, name: `R713-S1-${RUN}`, site: SILIVRI, fuel: 'Motorin', level: 100, threshold: 500 as number | null }
  };
  const tankIds = Object.values(tanks).map((t) => t.id);
  const txIds: string[] = [];
  const intakeIds: string[] = [];
  const fireIds: string[] = [];

  async function intake(t: { id: string; name: string; site: string }, liters: number) {
    const id = `intk-${t.id}`;
    intakeIds.push(id);
    await q(
      `INSERT INTO fuel_intake_receipts (id, tenant_id, tank_id, tank_name, site_name, supplier_name, waybill_no, delivery_date, declared_liters, declared_liters_15c, added_liters, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,'Test A.Ş.',$6,'2021-03-01',$7,$7,$7,'KAYITLI','test',$8)`,
      [id, TENANT, t.id, t.name, t.site, `IRS-${id}`, liters, W_MID]
    );
  }
  async function dispense(t: { name: string; site: string }, liters: number) {
    const id = `tx-${t.name}`;
    txIds.push(id);
    await q(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, tank_name, amount_liters, created_at) VALUES ($1,$2,$3,'R713 PLK',$4,$5,$6)`, [id, TENANT, t.site, t.name, liters, W_MID]);
  }
  async function recon(t: { id: string }, opening: number, physical: number) {
    const r = await call('POST', `/tanks/${t.id}/reconciliations`, owner, { periodType: 'AD_HOC', periodStart: W_START, periodEnd: W_END, openingBookLiters: opening, physicalLiters: physical });
    if (r.status !== 201) throw new Error(`mutabakat oluşturulamadı (${t.id}): ${r.status} ${r.raw}`);
  }
  async function fire(t: { id: string; name: string; site: string }, liters: number, status: string, date: string, tag: string) {
    const id = `fire-r713-${RUN}-${tag}`;
    fireIds.push(id);
    await q(
      `INSERT INTO fire_records (id, tenant_id, tank_id, tank_name, site_name, record_date, quantity_liters, variance_direction, classification, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'KAYIP','BUHARLAŞMA',$8,'test')`,
      [id, TENANT, t.id, t.name, t.site, date, liters, status]
    );
  }

  try {
    for (const t of Object.values(tanks)) {
      await q(
        `INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name, low_stock_threshold_liters) VALUES ($1,$2,$3,10000,$4,$5,$6,$7)`,
        [t.id, TENANT, t.name, t.level, t.fuel, t.site, t.threshold]
      );
    }
    await intake(tanks.G1, 1000); await dispense(tanks.G1, 300);
    await dispense(tanks.G2, 500);
    await intake(tanks.G3, 500); await dispense(tanks.G3, 200);
    await dispense(tanks.S1, 100);
    await recon(tanks.G1, 5000, 5680);
    await recon(tanks.G2, 2000, 1500);
    await recon(tanks.G3, 3000, 3300);
    await recon(tanks.S1, 1000, 900);
    // Fire: yalnız ONAYLANDI + KAYIP + pencere içi sayılır.
    await fire(tanks.G1, 20, 'ONAYLANDI', '2021-03-01', 'ok');
    await fire(tanks.G1, 999, 'BEKLIYOR', '2021-03-01', 'pending');
    await fire(tanks.G1, 55, 'ONAYLANDI', '2021-04-01', 'outside');

    const tankRep = await call('GET', `/reports/rep-713-tank?${WINDOW_QS}`, owner);
    const byName: Record<string, any> = {};
    for (const r of tankRep.body?.data || []) byName[r.tank_name] = r;
    const g1 = byName[tanks.G1.name];
    const n = (v: any) => Number(v);

    // === Test 1 (AC — giren/çıkan/kalan tutarlı): elle hesaplı G1 + her satırda açılış+dolum−ikmal−test=teorik ===
    const balanceOk = Object.values(byName).every((r: any) => Math.abs(n(r.opening_book_liters) + n(r.intake_liters) - n(r.dispensed_liters) - n(r.test_intake_liters) - n(r.closing_book_liters)) < 0.005);
    check(
      'Test 1 (AC — giren/çıkan/kalan tutarlı): 4 tank satırının hepsinde açılış+dolum−ikmal−test = teorik kapanış; G1 elle hesap 5000/1000/300/0/5700',
      tankRep.status === 200 && Object.keys(byName).length === 4 && balanceOk &&
        n(g1?.opening_book_liters) === 5000 && n(g1?.intake_liters) === 1000 && n(g1?.dispensed_liters) === 300 && n(g1?.closing_book_liters) === 5700,
      `status=${tankRep.status}, rows=${Object.keys(byName).length}, balanceOk=${balanceOk}, G1=${g1?.opening_book_liters}/${g1?.intake_liters}/${g1?.dispensed_liters}/${g1?.closing_book_liters}`
    );

    // === Test 2 (AC — teorik/fiziksel fark gösterilir): fark = fiziksel − teorik, yüzde, CSV hücreleri ===
    const csvTank = await call('GET', `/reports/rep-713-tank/export?format=csv&${WINDOW_QS}`, owner);
    const line = (name: string) => (csvTank.raw.split('\r\n').find((l) => l.includes(`,${name},`)) || '').split(',');
    const g1Cells = line(tanks.G1.name);
    const diffOk = Object.values(byName).every((r: any) => Math.abs(n(r.physical_liters) - n(r.closing_book_liters) - n(r.variance_liters)) < 0.005);
    check(
      'Test 2 (AC — teorik/fiziksel fark): her satırda fark = fiziksel − teorik; G1 fiziksel 5680, fark −20 (−0.35%); CSV G1 satırı 5700.00/5680.00/-20.00',
      diffOk && n(g1?.physical_liters) === 5680 && n(g1?.variance_liters) === -20 && Math.abs(n(g1?.variance_pct) - -0.3509) < 0.01 &&
        g1Cells[12] === '5700.00' && g1Cells[13] === '5680.00' && g1Cells[14] === '-20.00',
      `diffOk=${diffOk}, G1 phys=${g1?.physical_liters}, var=${g1?.variance_liters}, pct=${g1?.variance_pct}, csv=[${g1Cells.slice(12, 15).join('|')}]`
    );

    // === Test 3 (AC — kritik tanklar vurgulanır): G1,S1 kritik; G2 (yeterli), G3 (eşik yok) değil; CSV 'KRİTİK'; isCritical filtresi ===
    const crit = await call('GET', `/reports/rep-713-tank?${WINDOW_QS}&isCritical=true`, owner);
    const critNames = new Set((crit.body?.data || []).map((r: any) => r.tank_name));
    check(
      "Test 3 (AC — kritik tank vurgusu): G1+S1 is_critical=true, G2 ve eşiksiz G3 false; CSV 'KRİTİK'; isCritical=true filtresi yalnız G1+S1",
      byName[tanks.G1.name]?.is_critical === true && byName[tanks.S1.name]?.is_critical === true && byName[tanks.G2.name]?.is_critical === false && byName[tanks.G3.name]?.is_critical === false &&
        g1Cells[17] === 'KRİTİK' && line(tanks.G2.name)[17] === '-' &&
        critNames.size === 2 && critNames.has(tanks.G1.name) && critNames.has(tanks.S1.name),
      `G1=${g1?.is_critical}, G2=${byName[tanks.G2.name]?.is_critical}, G3=${byName[tanks.G3.name]?.is_critical}, S1=${byName[tanks.S1.name]?.is_critical}, filtered=${[...critNames].join(',')}`
    );

    // === Test 4 (Kapsam — fire yalnız onaylı+kayıp+pencere içi): G1 fire=20 (BEKLIYOR 999 ve pencere dışı 55 SAYILMAZ) ===
    check(
      'Test 4 (Kapsam — fire): G1 onaylı fire 20 — BEKLIYOR (999) ve pencere dışı onaylı (55) kayıtlar sayılmaz; fire olmayan tanklarda 0',
      n(g1?.fire_liters) === 20 && n(byName[tanks.G2.name]?.fire_liters) === 0,
      `G1.fire=${g1?.fire_liters}, G2.fire=${byName[tanks.G2.name]?.fire_liters}`
    );

    // === Test 5 (Kapsam — şantiye × yakıt tipi kırılımı + özet/detay tutarlılığı): elle hesaplı özet satırları ===
    const siteRep = await call('GET', `/reports/rep-713?${WINDOW_QS}`, owner);
    const site = (s: string, f: string) => (siteRep.body?.data || []).find((r: any) => r.site_name === s && r.fuel_type === f);
    const gm = site(GEBZE, 'Motorin');
    const gb = site(GEBZE, 'Benzin');
    const sm = site(SILIVRI, 'Motorin');
    const aggOk =
      n(siteRep.body?.aggregates?.total_intake) === n(tankRep.body?.aggregates?.total_intake) && n(siteRep.body?.aggregates?.total_intake) === 1500 &&
      n(siteRep.body?.aggregates?.total_dispensed) === n(tankRep.body?.aggregates?.total_dispensed) && n(siteRep.body?.aggregates?.total_dispensed) === 1100 &&
      n(siteRep.body?.aggregates?.total_variance) === n(tankRep.body?.aggregates?.total_variance) && n(siteRep.body?.aggregates?.total_variance) === -20;
    check(
      'Test 5 (Kapsam — yakıt tipi kırılımı, özet=detay): 3 özet satırı; Gebze/Motorin = G1+G3 (2 tank, açılış 8000, dolum 1500, ikmal 500, teorik 9000, fiziksel 8980, fark −20, fire 20, 1 kritik); genel toplamlar özet ve detayda AYNI',
      siteRep.body?.data?.length === 3 && !!gb && !!sm &&
        gm?.tank_count === 2 && n(gm.opening_liters) === 8000 && n(gm.intake_liters) === 1500 && n(gm.dispensed_liters) === 500 && n(gm.closing_book_liters) === 9000 &&
        n(gm.physical_liters) === 8980 && n(gm.variance_liters) === -20 && n(gm.fire_liters) === 20 && gm.critical_tank_count === 1 &&
        gb.tank_count === 1 && gb.critical_tank_count === 0 && sm.critical_tank_count === 1 && aggOk,
      `rows=${siteRep.body?.data?.length}, GM=${gm?.tank_count}/${gm?.opening_liters}/${gm?.closing_book_liters}/${gm?.physical_liters}/${gm?.critical_tank_count}, aggOk=${aggOk}`
    );

    // === Test 6 (Kapsam — filtreler/drill-down): fuelType=Benzin → yalnız Gebze/Benzin; minCriticalTanks=1 → 2 özet satırı; tankName → tek tank ===
    const benz = await call('GET', `/reports/rep-713?${WINDOW_QS}&fuelType=Benzin`, owner);
    const minCrit = await call('GET', `/reports/rep-713?${WINDOW_QS}&minCriticalTanks=1`, owner);
    const oneTank = await call('GET', `/reports/rep-713-tank?${WINDOW_QS}&tankName=${encodeURIComponent(tanks.G3.name)}`, owner);
    check(
      'Test 6 (Kapsam — filtreler/drill-down): fuelType=Benzin → 1 özet satırı; minCriticalTanks=1 → 2 özet satırı (Gebze/Motorin + Silivri/Motorin); tankName=G3 → 1 detay satırı',
      benz.body?.data?.length === 1 && benz.body.data[0].site_name === GEBZE && minCrit.body?.data?.length === 2 && oneTank.body?.data?.length === 1 && oneTank.body.data[0].tank_name === tanks.G3.name,
      `benz=${benz.body?.data?.length}, minCrit=${minCrit.body?.data?.length}, oneTank=${oneTank.body?.data?.length}`
    );

    // === Test 7 (AC — rol bazlı görünürlük) ===
    const gebzeSite = await call('GET', `/reports/rep-713?${WINDOW_QS}`, gebzeMgr);
    const gebzeTank = await call('GET', `/reports/rep-713-tank?${WINDOW_QS}`, gebzeMgr);
    const pump = await call('GET', `/reports/rep-713?${WINDOW_QS}`, pumpOp);
    const catalogOwner = await call('GET', '/reports', owner);
    const catalogPump = await call('GET', '/reports', pumpOp);
    const ids = (c: any) => new Set((c.body?.data || []).map((r: any) => r.id));
    check(
      'Test 7 (AC — rol bazlı görünürlük): Gebze SITE_MANAGER yalnız Gebze satırlarını görür (özet 2, detay 3; Silivri YOK); PUMP_OPERATOR 403 ve katalogda rep-713/rep-713-tank YOK; COMPANY_OWNER katalogda İKİSİ de VAR',
      gebzeSite.body?.data?.length === 2 && gebzeSite.body.data.every((r: any) => r.site_name === GEBZE) &&
        gebzeTank.body?.data?.length === 3 && gebzeTank.body.data.every((r: any) => r.site_name === GEBZE) &&
        pump.status === 403 && !ids(catalogPump).has('rep-713') && !ids(catalogPump).has('rep-713-tank') && ids(catalogOwner).has('rep-713') && ids(catalogOwner).has('rep-713-tank'),
      `site=${gebzeSite.body?.data?.length}, tank=${gebzeTank.body?.data?.length}, pump=${pump.status}`
    );

    // === Test 8 (AC — CSV/PDF tutarlılığı) ===
    const csvSite = await call('GET', `/reports/rep-713/export?format=csv&${WINDOW_QS}`, owner);
    const csvSiteRows = csvSite.raw.split('\r\n').filter((l) => l.includes(GEBZE) || l.includes(SILIVRI)).length;
    const csvTankRows = csvTank.raw.split('\r\n').filter((l) => l.includes('R713-')).length;
    const pdf = await fetch(`${API_URL}/reports/rep-713/export?format=pdf&${WINDOW_QS}`, { headers: { Authorization: `Bearer ${owner}` } });
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    const pdfTank = await fetch(`${API_URL}/reports/rep-713-tank/export?format=pdf&${WINDOW_QS}`, { headers: { Authorization: `Bearer ${owner}` } });
    check(
      'Test 8 (AC — CSV/PDF tutarlılığı): CSV satır sayıları JSON toplamlarıyla AYNI (özet 3, detay 4), başlıklar yeni sütunları içerir, iki rapor için PDF 200 + %PDF-',
      csvSiteRows === siteRep.body?.pagination?.totalCount && csvSiteRows === 3 && csvTankRows === tankRep.body?.pagination?.totalCount && csvTankRows === 4 &&
        csvSite.raw.includes('Teorik Kapanış') && csvSite.raw.includes('Ölçülen Fiziksel') && csvSite.raw.includes('Kritik Tank') &&
        pdf.status === 200 && pdfBuf.subarray(0, 5).toString('latin1') === '%PDF-' && pdfTank.status === 200,
      `csvSite=${csvSiteRows}, csvTank=${csvTankRows}, pdf=${pdf.status}/${pdfTank.status}`
    );
  } finally {
    await q(`DELETE FROM alarm_events WHERE alarm_id IN (SELECT id FROM alarms WHERE tenant_id = $1 AND alarm_key = ANY($2))`, [TENANT, tankIds.map((id) => `STOCK_RECON:${id}`)]);
    await q(`DELETE FROM alarms WHERE tenant_id = $1 AND alarm_key = ANY($2)`, [TENANT, tankIds.map((id) => `STOCK_RECON:${id}`)]);
    await q('DELETE FROM fire_records WHERE tank_id = ANY($1)', [tankIds]);
    await q('DELETE FROM stock_reconciliations WHERE tank_id = ANY($1)', [tankIds]);
    await q('DELETE FROM fuel_intake_receipts WHERE id = ANY($1)', [intakeIds]);
    await q('DELETE FROM transactions WHERE id = ANY($1)', [txIds]);
    await q('DELETE FROM tanks WHERE id = ANY($1)', [tankIds]);
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
