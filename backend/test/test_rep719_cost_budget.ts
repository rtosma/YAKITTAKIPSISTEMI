import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * REP-719 (#176) — Maliyet ve Bütçe Raporu.
 *
 * Elle hesaplı fixture (2022-03/04). Bütçeler GERÇEK uçtan (PUT /fuel-budgets).
 * "İkmal anı fiyatı" GERÇEK akışla doğrulanır: dolum fiyatı DEĞİŞİRKEN iki ikmal
 * POST /dispense ile yapılır (INV-1503 her ikmalde maliyeti dondurur).
 *
 *  Gebze Mart : T1 100 L/2000, T2 100 L/2200, T3 50 L Benzin/1500, T4 30 L FİYATSIZ
 *               → 280 L (fiyatlı 250), maliyet 5700, ort. 22.8000 | bütçe 5000 → +700 (%14.00) AŞIM
 *  Gebze Nisan: T5 200 L/5000, T6 100 L Benzin/3300 → 300 L, 8300, ort. 27.6667 | bütçe 9000 → −700 (%−7.78)
 *               fiyat değişimi +21.35%, maliyet değişimi +45.61%
 *  Gebze Mayıs: yalnız BÜTÇE 1000 (harcama yok) → maliyet 0, sapma −1000 (%−100.00)
 *  Silivri Mart: T7 100 L/2000 + T8 10 L (tipi/fiyatı YOK) → 110 L, 2000, ort. 20.0000 | bütçe 2500 → −500 (%−20.00)
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const SILIVRI = 'Silivri Tesisleri';
const QS = 'startDate=2022-03-01&endDate=2022-05-31&pageSize=50';

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
  console.log('💰 [REP-719] MALİYET VE BÜTÇE RAPORU TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };
  const n = (v: any) => Number(v);
  const near = (a: any, b: number, eps = 0.005) => a !== null && a !== undefined && Math.abs(n(a) - b) <= eps;

  const owner = await login('camsa');
  const gebzeMgr = await login('gebze-santiye');
  const pumpOp = await login('pompa-op-01');

  const L4 = String(RUN).slice(-4);
  const V1 = `34 RYA ${L4}`;
  const V2 = `34 RYB ${L4}`;
  const V3 = `34 RYE ${L4}`; // gerçek akış aracı
  const txIds: string[] = [];
  const budgetIds: string[] = [];
  const tank = { id: `tank-r719-${RUN}`, name: `R719-TANK-${RUN}` };

  async function tx(tag: string, plate: string, site: string, liters: number, cost: number | null, unit: number | null, fuel: string | null, at: string) {
    const id = `tx-r719-${RUN}-${tag}`;
    txIds.push(id);
    await q(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, unit_cost_liters, total_cost, fuel_type, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, TENANT, site, plate, liters, unit, cost, fuel, at]);
  }
  async function budget(site: string, month: string, amount: number) {
    const r = await call('PUT', '/fuel-budgets', owner, { siteName: site, month, amountTry: amount });
    if (r.status !== 200) throw new Error(`bütçe tanımlanamadı: ${r.status} ${r.raw}`);
    return r.body.data;
  }

  try {
    await tx('1', V1, GEBZE, 100, 2000, 20, 'Motorin', '2022-03-05T12:00:00Z');
    await tx('2', V1, GEBZE, 100, 2200, 22, 'Motorin', '2022-03-15T12:00:00Z');
    await tx('3', V2, GEBZE, 50, 1500, 30, 'Benzin', '2022-03-16T12:00:00Z');
    await tx('4', V1, GEBZE, 30, null, null, 'Motorin', '2022-03-20T12:00:00Z');
    await tx('5', V1, GEBZE, 200, 5000, 25, 'Motorin', '2022-04-05T12:00:00Z');
    await tx('6', V2, GEBZE, 100, 3300, 33, 'Benzin', '2022-04-10T12:00:00Z');
    await tx('7', V1, SILIVRI, 100, 2000, 20, 'Motorin', '2022-03-08T12:00:00Z');
    await tx('8', V2, SILIVRI, 10, null, null, null, '2022-03-09T12:00:00Z');

    // === Test 3 (Bütçe tanımı — uç): upsert, RBAC, doğrulama ===
    const first = await budget(GEBZE, '2022-03', 6000);
    const updated = await budget(GEBZE, '2022-03', 5000);
    budgetIds.push(updated.id);
    budgetIds.push((await budget(GEBZE, '2022-04', 9000)).id);
    budgetIds.push((await budget(GEBZE, '2022-05', 1000)).id);
    budgetIds.push((await budget(SILIVRI, '2022-03', 2500)).id);
    const list = await call('GET', '/fuel-budgets?month=2022-03', owner);
    const mgrPut = await call('PUT', '/fuel-budgets', gebzeMgr, { siteName: GEBZE, month: '2022-03', amountTry: 1 });
    const badMonth = await call('PUT', '/fuel-budgets', owner, { siteName: GEBZE, month: '2022-13', amountTry: 100 });
    const zero = await call('PUT', '/fuel-budgets', owner, { siteName: GEBZE, month: '2022-03', amountTry: 0 });
    const tmp = await budget(GEBZE, '2022-06', 777);
    const del = await call('DELETE', `/fuel-budgets/${tmp.id}`, owner);
    const del404 = await call('DELETE', `/fuel-budgets/${tmp.id}`, owner);
    const march = (list.body?.data || []).filter((b: any) => b.site_name === GEBZE);
    check(
      'Test 1 (Kapsam — bütçe tanımı): PUT aynı (şantiye, ay) için GÜNCELLER (aynı id, 6000 → 5000, tek satır); SITE_MANAGER 403; geçersiz ay 400; tutar 0 → 400; DELETE 200, tekrar DELETE 404',
      first.id === updated.id && n(updated.amount_try) === 5000 && march.length === 1 && n(march[0].amount_try) === 5000 &&
        mgrPut.status === 403 && badMonth.status === 400 && zero.status === 400 && del.status === 200 && del404.status === 404,
      `sameId=${first.id === updated.id}, amount=${updated.amount_try}, marchRows=${march.length}, mgr=${mgrPut.status}, badMonth=${badMonth.status}, zero=${zero.status}, del=${del.status}/${del404.status}`
    );

    const rep = await call('GET', `/reports/rep-719?${QS}`, owner);
    const r = (site: string, month: string) => (rep.body?.data || []).find((x: any) => x.site_name === site && x.month_label === month);
    const gm = r(GEBZE, '2022-03'), ga = r(GEBZE, '2022-04'), gy = r(GEBZE, '2022-05'), sm = r(SILIVRI, '2022-03');

    // === Test 2 (AC — maliyet ikmal anı fiyatı; fiyatsız açıkça): Gebze Mart ===
    check(
      "Test 2 (AC — maliyet): Gebze Mart 280 L, maliyet 5700 (dondurulmuş total_cost toplamı), fiyatsız 30 L AÇIKÇA, ort. birim fiyat 22.8000 = 5700/250 fiyatlı litre; Nisan 300 L / 8300 / 27.6667",
      rep.status === 200 && n(gm?.liters) === 280 && n(gm?.total_cost) === 5700 && n(gm?.unpriced_liters) === 30 && near(gm?.avg_unit_price, 22.8, 0.0001) &&
        n(ga?.liters) === 300 && n(ga?.total_cost) === 8300 && near(ga?.avg_unit_price, 27.6667, 0.0001),
      `Mart=${gm?.liters}/${gm?.total_cost}/${gm?.unpriced_liters}/${gm?.avg_unit_price}, Nisan=${ga?.liters}/${ga?.total_cost}/${ga?.avg_unit_price}`
    );

    // === Test 3 (AC — bütçe aşımı vurgulanır): elle hesaplı sapma ===
    const over = await call('GET', `/reports/rep-719?${QS}&overBudgetOnly=true`, owner);
    const csv = await call('GET', `/reports/rep-719/export?format=csv&${QS}`, owner);
    const line = (site: string, month: string) => (csv.raw.split('\r\n').find((l) => l.includes(`${site},`) && l.includes(`,${month},`)) || '').split(',');
    const cGm = line(GEBZE, '2022-03');
    check(
      "Test 3 (AC — bütçe aşımı): Gebze Mart 5700 > 5000 → sapma +700 (+14.00%) AŞIM; Nisan −700 (−7.78%) aşım DEĞİL; Mayıs yalnız bütçe → maliyet 0, sapma −1000 (−100.00%); Silivri Mart −500 (−20.00%); overBudgetOnly → yalnız Gebze Mart; CSV 'AŞIM'; aşım sayısı 1",
      near(gm?.variance, 700) && near(gm?.variance_pct, 14) && gm?.is_over_budget === true && near(ga?.variance, -700) && near(ga?.variance_pct, -7.78) && ga?.is_over_budget === false &&
        n(gy?.total_cost) === 0 && n(gy?.liters) === 0 && near(gy?.variance, -1000) && near(gy?.variance_pct, -100) && near(sm?.variance, -500) && near(sm?.variance_pct, -20) &&
        over.body?.data?.length === 1 && over.body.data[0].month_label === '2022-03' && over.body.data[0].site_name === GEBZE &&
        cGm[10] === 'AŞIM' && cGm[8] === '+700.00' && n(rep.body?.aggregates?.over_budget_count) === 1 && n(rep.body?.aggregates?.total_budget) === 17500,
      `GM=${gm?.variance}/${gm?.variance_pct}/${gm?.is_over_budget}, GA=${ga?.variance}/${ga?.variance_pct}, GY=${gy?.total_cost}/${gy?.variance}, SM=${sm?.variance}, over=${over.body?.data?.length}, csv=[${cGm[8]}|${cGm[10]}], agg=${rep.body?.aggregates?.over_budget_count}/${rep.body?.aggregates?.total_budget}`
    );

    // === Test 4 (AC — birim fiyat trendi/dönemsel karşılaştırma): Nisan vs Mart ===
    check(
      'Test 4 (AC — fiyat trendi): Gebze Nisan önceki ay fiyat 22.8000, fiyat değişimi +21.35%, maliyet değişimi +45.61%; Mart (önceki ay yok) → NULL; Mayıs (fiyatsız) → NULL',
      near(ga?.prev_avg_unit_price, 22.8, 0.0001) && near(ga?.price_change_pct, 21.35) && near(ga?.cost_change_pct, 45.61) &&
        gm?.prev_avg_unit_price === null && gm?.price_change_pct === null && gy?.price_change_pct === null,
      `Nisan=${ga?.prev_avg_unit_price}/${ga?.price_change_pct}/${ga?.cost_change_pct}, Mart=${gm?.price_change_pct}`
    );

    // === Test 5 (Kapsam — yakıt tipi kırılımı + tip bazında fiyat trendi) ===
    const ft = await call('GET', `/reports/rep-719-yakit-tipi?${QS}`, owner);
    const f = (site: string, type: string, month: string) => (ft.body?.data || []).find((x: any) => x.site_name === site && x.fuel_type === type && x.month_label === month);
    check(
      "Test 5 (Kapsam — yakıt tipi kırılımı): Gebze Motorin Mart 230 L/4200/21.0000 → Nisan 200 L/5000/25.0000 (+19.05%); Gebze Benzin Mart 50 L/30.0000 → Nisan 100 L/33.0000 (+10.00%); Silivri tipi bilinmeyen ikmal 'Bilinmiyor' grubunda (fiyat NULL); toplam maliyet özetle AYNI",
      near(f(GEBZE, 'Motorin', '2022-03')?.total_cost, 4200) && n(f(GEBZE, 'Motorin', '2022-03')?.liters) === 230 && near(f(GEBZE, 'Motorin', '2022-03')?.avg_unit_price, 21, 0.0001) &&
        near(f(GEBZE, 'Motorin', '2022-04')?.avg_unit_price, 25, 0.0001) && near(f(GEBZE, 'Motorin', '2022-04')?.price_change_pct, 19.05) &&
        near(f(GEBZE, 'Benzin', '2022-04')?.price_change_pct, 10) && n(f(SILIVRI, 'Bilinmiyor', '2022-03')?.liters) === 10 && f(SILIVRI, 'Bilinmiyor', '2022-03')?.avg_unit_price === null &&
        n(ft.body?.aggregates?.total_cost) === 5700 + 8300 + 2000,
      `GMot=${f(GEBZE, 'Motorin', '2022-03')?.liters}/${f(GEBZE, 'Motorin', '2022-03')?.total_cost}/${f(GEBZE, 'Motorin', '2022-04')?.price_change_pct}, GBen=${f(GEBZE, 'Benzin', '2022-04')?.price_change_pct}, agg=${ft.body?.aggregates?.total_cost}`
    );

    // === Test 6 (Kapsam — araç bazında maliyet): iki şantiyeden yakıt alan araç için ayrı satırlar ===
    const veh = await call('GET', `/reports/rep-719-arac?${QS}&vehiclePlate=${encodeURIComponent('34 RY')}`, owner);
    const v = (plate: string, site: string, month: string) => (veh.body?.data || []).find((x: any) => x.vehicle_plate === plate && x.site_name === site && x.month_label === month);
    check(
      'Test 6 (Kapsam — araç bazında): V1 Gebze Mart 230 L/4200/fiyatsız 30, V1 Gebze Nisan 200 L/5000, V1 Silivri Mart 100 L/2000 (iki şantiye → ayrı satır), V2 Gebze Mart 50/1500, Nisan 100/3300; 6 satır (V2 Silivri Mart fiyatsız 10 L dahil)',
      veh.body?.data?.length === 6 && near(v(V1, GEBZE, '2022-03')?.total_cost, 4200) && n(v(V1, GEBZE, '2022-03')?.unpriced_liters) === 30 && n(v(V1, GEBZE, '2022-04')?.liters) === 200 &&
        near(v(V1, SILIVRI, '2022-03')?.total_cost, 2000) && near(v(V2, GEBZE, '2022-04')?.total_cost, 3300) && v(V2, SILIVRI, '2022-03')?.avg_unit_price === null,
      `rows=${veh.body?.data?.length}, V1Mar=${v(V1, GEBZE, '2022-03')?.total_cost}, V1Sil=${v(V1, SILIVRI, '2022-03')?.total_cost}`
    );

    // === Test 7 (AC — İKMAL ANI fiyatı, GERÇEK akış): dolum fiyatı 20 → 40 değişirken iki ikmal; maliyetler o anın fiyatıyla DONDURULUR ===
    await q(`INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name) VALUES ($1,$2,$3,10000,5000,'Motorin',$4)`, [tank.id, TENANT, tank.name, GEBZE]);
    const receipt = (tag: string, price: number, daysAgo: number) =>
      q(
        `INSERT INTO fuel_intake_receipts (id, tenant_id, tank_id, tank_name, site_name, supplier_name, waybill_no, delivery_date, declared_liters, declared_liters_15c, added_liters, unit_price, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'Test A.Ş.',$6,CURRENT_DATE - $7::int,1000,1000,1000,$8,'KAYITLI','test')`,
        [`rcp-r719-${RUN}-${tag}`, TENANT, tank.id, tank.name, GEBZE, `IRS-${tag}-${RUN}`, daysAgo, price]
      );
    await receipt('a', 20, 3);
    const d1 = await call('POST', '/dispense', owner, { siteName: GEBZE, vehiclePlate: V3, amountLiters: 100, tankName: tank.name });
    await receipt('b', 40, 0); // fiyat DEĞİŞTİ (ağırlıklı ortalama 20 → 30)
    const d2 = await call('POST', '/dispense', owner, { siteName: GEBZE, vehiclePlate: V3, amountLiters: 100, tankName: tank.name });
    const real = await call('GET', `/reports/rep-719-arac?vehiclePlate=${encodeURIComponent(V3)}`, owner);
    const rr = real.body?.data?.[0];
    check(
      'Test 7 (AC — ikmal anı fiyatı): dolum fiyatı 20→40 değişirken iki gerçek ikmal (100 L) → ilk 2000 (fiyat 20), ikincisi 3000 (o anki ağırlıklı ort. 30); rapor DONDURULMUŞ maliyetlerin toplamı 5000, ort. 25.0000 — geriye dönük 200×30=6000 veya 200×40=8000 DEĞİL',
      d1.status === 200 && d2.status === 200 && real.body?.data?.length === 1 && n(rr.liters) === 200 && near(rr.total_cost, 5000) && near(rr.avg_unit_price, 25, 0.0001),
      `d1=${d1.status}, d2=${d2.status}, rows=${real.body?.data?.length}, cost=${rr?.total_cost}, avg=${rr?.avg_unit_price}`
    );

    // === Test 8 (AC — rol bazlı görünürlük + CSV/PDF tutarlılığı) ===
    const gRep = await call('GET', `/reports/rep-719?${QS}`, gebzeMgr);
    const gFt = await call('GET', `/reports/rep-719-yakit-tipi?${QS}`, gebzeMgr);
    const pump = await call('GET', `/reports/rep-719?${QS}`, pumpOp);
    const catO = await call('GET', '/reports', owner);
    const catP = await call('GET', '/reports', pumpOp);
    const catIds = (c: any) => new Set((c.body?.data || []).map((x: any) => x.id));
    const rows = (c: { raw: string }, needle: string) => c.raw.split('\r\n').filter((l) => l.includes(needle)).length;
    const pdfs = await Promise.all(
      [`rep-719?${QS}`, `rep-719-yakit-tipi?${QS}`, `rep-719-arac?${QS}`].map(async (p) => {
        const [id, qs] = p.split('?');
        const res = await fetch(`${API_URL}/reports/${id}/export?format=pdf&${qs}`, { headers: { Authorization: `Bearer ${owner}` } });
        return { status: res.status, magic: Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString('latin1') };
      })
    );
    check(
      "Test 8 (AC — rol/CSV/PDF): Gebze SITE_MANAGER yalnız Gebze (3 ay satırı, Silivri YOK), PUMP_OPERATOR 403 ve katalogda üç rapor YOK; CSV satır sayısı JSON'la AYNI (rep-719: 4 = Gebze×3 + Silivri); üç rapor için PDF 200 + %PDF-",
      gRep.body?.data?.length === 3 && gRep.body.data.every((x: any) => x.site_name === GEBZE) && gFt.body?.data?.every((x: any) => x.site_name === GEBZE) && pump.status === 403 &&
        ['rep-719', 'rep-719-yakit-tipi', 'rep-719-arac'].every((id) => catIds(catO).has(id) && !catIds(catP).has(id)) &&
        rows(csv, '2022-0') === rep.body?.pagination?.totalCount && rows(csv, '2022-0') === 4 && pdfs.every((p) => p.status === 200 && p.magic === '%PDF-'),
      `gebze=${gRep.body?.data?.length}, pump=${pump.status}, csv=${rows(csv, '2022-0')}/${rep.body?.pagination?.totalCount}, pdf=${pdfs.map((p) => p.status).join('/')}`
    );
  } finally {
    await q('DELETE FROM transactions WHERE id = ANY($1) OR vehicle_plate = $2', [txIds, V3]);
    await q('DELETE FROM fuel_intake_receipts WHERE tank_id = $1', [tank.id]);
    await q('DELETE FROM tanks WHERE id = $1', [tank.id]);
    await q(`DELETE FROM fuel_budgets WHERE tenant_id = $1 AND month IN ('2022-03','2022-04','2022-05','2022-06')`, [TENANT]);
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
