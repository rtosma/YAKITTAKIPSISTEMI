import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * REP-723 (#180) — Yönetici Özet Dashboard'u.
 *
 * Geliştirme DB'sinde başka veriler de var → mutlak değerler yerine FİXTURE ÖNCESİ/SONRASI FARK (delta) doğrulanır;
 * kartların detay raporlarıyla tutarlılığı ise kartın kendi `drilldown` yolu takip edilerek (mutlak) doğrulanır.
 *
 * Fixture (Gebze = SITE_MANAGER gebze-santiye'nin şantiyesi, Silivri = diğer):
 *  Gebze ikmal: bugün 100 L/2500 TL (f1), ay başı+1dk 50 L/1000 TL (f3; ayın 1'inde bugüne de girer), önceki ayın son dakikası 700 L (dışarıda),
 *  Silivri bugün 300 L/6000 TL. Araç R723-BIG: 50 000 L (ilk-10'da olmalı). Tank: A (kapasite 1000, seviye 100, eşik 200 → KRİTİK, %10.0),
 *  B (1000, 800, eşik yok → normal, %80.0). Alarm: Gebze OPEN (+1), Gebze RESOLVED (0), şantiyesiz OPEN (yalnız owner +1).
 *  Cihaz: R723-DEV1 ONLINE→OFFLINE (çevrimdışı +1), R723-DEV2 OFFLINE→ONLINE (0). Stok trendi: dün için A=100, B=800 günlük mutabakat (=900).
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const SILIVRI = 'Silivri Tesisleri';
const BIG = `R723-BIG-${RUN}`;

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
async function call(path: string, token?: string): Promise<{ status: number; body: any; raw: string; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${API_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const raw = await res.text();
  const ms = Date.now() - t0;
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* CSV gövdesi */
  }
  return { status: res.status, body: parsed, raw, ms };
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
  console.log('📊 [REP-723] YÖNETİCİ ÖZET DASHBOARD TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };
  const n = (v: any) => Number(v);
  const near = (a: any, b: number, eps = 0.01) => Math.abs(n(a) - b) <= eps;

  const owner = await login('camsa');
  const gebzeMgr = await login('gebze-santiye');
  const pumpOp = await login('pompa-op-01');
  const dash = (token: string, qs = '') => call(`/dashboard/executive${qs}`, token);
  const kv = (d: any) => Object.fromEntries(Object.entries(d.body.data.kpis).map(([k, v]: any) => [k, n(v.value)]));

  const txIds: string[] = [];
  const tankIds = [`tank-r723-a-${RUN}`, `tank-r723-b-${RUN}`];
  const alarmIds: string[] = [];
  const reconIds: string[] = [];
  const devEvents: string[] = [];
  let seq = 0;
  async function tx(site: string, plate: string, liters: number, cost: number, at: string) {
    const id = `tx-r723-${RUN}-${++seq}`;
    txIds.push(id);
    await q(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, total_cost, created_at) VALUES ($1,$2,$3,$4,$5,$6, ${at})`, [id, TENANT, site, plate, liters, cost]);
  }
  async function alarm(tag: string, site: string | null, status: string) {
    const id = `alarm-r723-${RUN}-${tag}`;
    alarmIds.push(id);
    await q(
      `INSERT INTO alarms (id, tenant_id, alarm_key, category, severity, title, site_name, subject_type, subject_id, status, event_count, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,'OTHER','WARNING',$4,$5,'TANK',$6,$7,1,NOW(),NOW())`,
      [id, TENANT, `R723:${tag}:${RUN}`, `R723-${tag}`, site, `subj-${tag}-${RUN}`, status]
    );
  }
  async function presence(dev: string, status: string, agoMin: number) {
    const id = `dpe-r723-${RUN}-${++seq}`;
    devEvents.push(id);
    await q(`INSERT INTO device_presence_events (id, tenant_id, device_id, site_name, status, occurred_at) VALUES ($1,$2,$3,$4,$5, NOW() - ($6 || ' minutes')::interval)`, [id, TENANT, dev, GEBZE, status, String(agoMin)]);
  }

  try {
    const dates = (await q(`SELECT NOW()::date::text AS today, date_trunc('month', NOW())::date::text AS month_start, (EXTRACT(DAY FROM NOW()) = 1) AS is_day1`))[0];
    const [ownerBefore, gebzeBefore] = [await dash(owner), await dash(gebzeMgr)];
    const ob = kv(ownerBefore);
    const gb = kv(gebzeBefore);

    // ── Fixture ──
    await tx(GEBZE, BIG, 100, 2500, 'NOW()');
    await tx(GEBZE, BIG, 50, 1000, `date_trunc('month', NOW()) + INTERVAL '1 minute'`);
    await tx(GEBZE, `R723-OLD-${RUN}`, 700, 9999, `date_trunc('month', NOW()) - INTERVAL '1 minute'`);
    await tx(SILIVRI, `R723-SIL-${RUN}`, 300, 6000, 'NOW()');
    await tx(GEBZE, BIG, 49850, 0, 'NOW() - INTERVAL \'1 second\'');
    await q(`INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name, low_stock_threshold_liters) VALUES ($1,$2,$3,1000,100,'Motorin',$4,200)`, [tankIds[0], TENANT, `R723 Tank A ${RUN}`, GEBZE]);
    await q(`INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name) VALUES ($1,$2,$3,1000,800,'Motorin',$4)`, [tankIds[1], TENANT, `R723 Tank B ${RUN}`, GEBZE]);
    await alarm('open-g', GEBZE, 'OPEN');
    await alarm('res-g', GEBZE, 'RESOLVED');
    await alarm('open-null', null, 'OPEN');
    await presence(`R723-DEV1-${RUN}`, 'ONLINE', 60);
    await presence(`R723-DEV1-${RUN}`, 'OFFLINE', 30);
    await presence(`R723-DEV2-${RUN}`, 'OFFLINE', 60);
    await presence(`R723-DEV2-${RUN}`, 'ONLINE', 30);
    for (const [i, lv] of [100, 800].entries()) {
      const id = `recon-r723-${RUN}-${i}`;
      reconIds.push(id);
      await q(
        `INSERT INTO stock_reconciliations (id, tenant_id, tank_id, tank_name, site_name, period_type, period_start, period_end, opening_book_liters, intake_liters, dispensed_liters, test_intake_liters,
           closing_book_liters, physical_liters, physical_liters_15c, variance_liters, variance_pct, tolerance_pct, evaporation_allowance_pct, classification, status, source, created_by)
         VALUES ($1,$2,$3,$4,$5,'DAILY', (NOW()::date - 1)::timestamptz, (NOW()::date - 1)::timestamptz + INTERVAL '12 hours', $6,0,0,0,$6,$6,$6,0,0,1,0,'TOLERANS_İÇİ','NORMAL','MANUEL','r723')`,
        [id, TENANT, tankIds[i], `R723 Tank ${i} ${RUN}`, GEBZE, lv]
      );
    }

    const oa = await dash(owner);
    const ga = await dash(gebzeMgr);
    const oAfter = kv(oa);
    const gAfter = kv(ga);
    const d = (a: any, b: any, k: string) => n(a[k]) - n(b[k]);
    const day1 = dates.is_day1 ? 50 : 0;

    // === Test 1 (AC — KPI değerleri, yetki kapsamı): Gebze SITE_MANAGER delta'ları yalnız Gebze fixture'ını yansıtır; owner tüm şantiyeleri + şantiyesiz alarmı ===
    check(
      'Test 1 (AC — KPI kartları ve kapsam): Gebze SITE_MANAGER: bugün +' + (49950 + day1) + ' L (100 + 49 850), ay +50 000 L, ay tutarı +3500 TL (önceki ayın son dakikası DIŞARIDA), açık alarm +1 (RESOLVED sayılmaz, şantiyesiz alarm görünmez), kritik tank +1, çevrimdışı +1 (DEV2 tekrar ONLINE → sayılmaz); owner: Silivri 300 L/6000 TL ve şantiyesiz alarm dahil',
      oa.status === 200 && ga.status === 200 &&
        near(d(gAfter, gb, 'dailyConsumptionLiters'), 49950 + day1) && near(d(gAfter, gb, 'monthlyConsumptionLiters'), 50000) && near(d(gAfter, gb, 'monthlyCost'), 3500) &&
        d(gAfter, gb, 'openAlarms') === 1 && d(gAfter, gb, 'criticalTanks') === 1 && d(gAfter, gb, 'offlineDevices') === 1 &&
        near(d(oAfter, ob, 'dailyConsumptionLiters'), 49950 + day1 + 300) && near(d(oAfter, ob, 'monthlyConsumptionLiters'), 50000 + 300) && near(d(oAfter, ob, 'monthlyCost'), 3500 + 6000) &&
        d(oAfter, ob, 'openAlarms') === 2 && d(oAfter, ob, 'criticalTanks') === 1 && d(oAfter, ob, 'offlineDevices') === 1,
      `gebzeΔ=${JSON.stringify(Object.fromEntries(Object.keys(gAfter).map((k) => [k, +d(gAfter, gb, k).toFixed(2)])))}, ownerΔ=${JSON.stringify(Object.fromEntries(Object.keys(oAfter).map((k) => [k, +d(oAfter, ob, k).toFixed(2)])))}`
    );

    // === Test 2 (AC — detay raporlarıyla tutarlılık): her KPI'nın drilldown yolu izlenir → detay raporu aynı sayıyı verir (owner ve Gebze SITE_MANAGER) ===
    async function drillCheck(token: string, data: any): Promise<{ ok: boolean; info: string }> {
      const k = data.kpis;
      const [dDay, dMonth, dCost, dAlarm, dTank, dDev] = await Promise.all([
        call(k.dailyConsumptionLiters.drilldown.path, token), call(k.monthlyConsumptionLiters.drilldown.path, token), call(k.monthlyCost.drilldown.path, token),
        call(k.openAlarms.drilldown.path, token), call(k.criticalTanks.drilldown.path, token), call(k.offlineDevices.drilldown.path, token)
      ]);
      const vals = [
        [n(dDay.body.aggregates?.total_liters), k.dailyConsumptionLiters.value], [n(dMonth.body.aggregates?.total_liters), k.monthlyConsumptionLiters.value],
        [n(dCost.body.aggregates?.total_amount), k.monthlyCost.value], [n(dAlarm.body.pagination?.totalCount), k.openAlarms.value],
        [n(dTank.body.pagination?.totalCount), k.criticalTanks.value], [n(dDev.body.pagination?.totalCount), k.offlineDevices.value]
      ];
      return { ok: [dDay, dMonth, dCost, dAlarm, dTank, dDev].every((r) => r.status === 200) && vals.every(([a, b]) => near(a, b)), info: vals.map(([a, b]) => `${a}/${b}`).join(' ') };
    }
    const dcO = await drillCheck(owner, oa.body.data);
    const dcG = await drillCheck(gebzeMgr, ga.body.data);
    check(
      'Test 2 (AC — KPI ↔ detay raporu): drilldown yolları (rep-711 gün/ay/tutar, rep-716 açık alarm, rep-723-tank kritik, rep-717-kesinti süren) izlenince detay rapor toplamları KPI ile birebir aynı — owner ve Gebze SITE_MANAGER için; drilldown bağlantıları rep-711/rep-716/rep-723-tank/rep-717-kesinti',
      dcO.ok && dcG.ok && oa.body.data.kpis.openAlarms.drilldown.reportId === 'rep-716' && oa.body.data.kpis.criticalTanks.drilldown.reportId === 'rep-723-tank' && oa.body.data.kpis.offlineDevices.drilldown.reportId === 'rep-717-kesinti' &&
        ga.body.data.kpis.monthlyConsumptionLiters.drilldown.query.siteName === GEBZE && oa.body.data.kpis.monthlyConsumptionLiters.drilldown.query.siteName === undefined,
      `owner=${dcO.info} | gebze=${dcG.info}`
    );

    // === Test 3 (Kapsam — trendler): günlük seri days=30 nokta (ikmalsiz gün 0), bugün = KPI; pencere toplamı rep-711 ile aynı; stok trendi dün +900 (A+B mutabakatı); güncel stok = tank özeti toplamı ===
    const win = await dash(gebzeMgr, '?days=30');
    const t = win.body.data.trends;
    const start = (await q(`SELECT (NOW()::date - 29)::text AS s`))[0].s;
    const rep711 = await call(`/reports/rep-711?startDate=${start}&endDate=${dates.today}&siteName=${encodeURIComponent(GEBZE)}&pageSize=1`, gebzeMgr);
    const yesterday = (await q(`SELECT (NOW()::date - 1)::text AS y`))[0].y;
    const stockBefore = (gebzeBefore.body.data.trends.stockLevel.find((p: any) => p.date === yesterday)?.liters) ?? 0;
    const stockYesterday = t.stockLevel.find((p: any) => p.date === yesterday)?.liters ?? 0;
    const sumLit = t.dailyConsumption.reduce((s: number, p: any) => s + p.liters, 0);
    const sumCost = t.dailyCost.reduce((s: number, p: any) => s + p.cost, 0);
    const tanksAgg = await call(`/reports/rep-723-tank?siteName=${encodeURIComponent(GEBZE)}&pageSize=1`, gebzeMgr);
    check(
      'Test 3 (Kapsam — trendler): 30 günlük tüketim/maliyet serisi (ikmalsiz günler 0 ile dolu), son nokta = bugünkü KPI; seri toplamı rep-711 (30 gün, Gebze) ile aynı; stok trendinde dün +900 L (A 100 + B 800 günlük mutabakat); currentStockLiters = rep-723-tank toplamı',
      t.dailyConsumption.length === 30 && t.dailyCost.length === 30 && t.dailyConsumption[29].date === dates.today && near(t.dailyConsumption[29].liters, ga.body.data.kpis.dailyConsumptionLiters.value) &&
        near(sumLit, n(rep711.body.aggregates.total_liters)) && near(sumCost, n(rep711.body.aggregates.total_amount)) && near(stockYesterday - stockBefore, 900) &&
        near(t.currentStockLiters, n(tanksAgg.body.aggregates.total_level_liters)),
      `days=${t.dailyConsumption.length}, Σlitre=${sumLit}/${rep711.body?.aggregates?.total_liters}, Σtutar=${sumCost}/${rep711.body?.aggregates?.total_amount}, stok Δ=${stockYesterday - stockBefore}, güncel=${t.currentStockLiters}/${tanksAgg.body?.aggregates?.total_level_liters}`
    );

    // === Test 4 (AC — ilk 10 listeleri): araçlar litreye göre azalan, ≤10, R723-BIG 50000 L ile listede ve drilldown rep-711 toplamı aynı; şantiyeler ay litresine göre azalan ≤10, Gebze SITE_MANAGER için yalnız Gebze ===
    const tv = win.body.data.topVehicles;
    const big = tv.find((v: any) => v.vehiclePlate === BIG);
    const bigDetail = big ? await call(big.drilldown.path, gebzeMgr) : { body: {} as any };
    const ts = oa.body.data.topSites;
    const tsG = ga.body.data.topSites;
    check(
      'Test 4 (AC — ilk 10): topVehicles ≤10 ve litreye göre azalan; R723-BIG 50 000 L (3 ikmal) listede, kendi drilldown\'ı (rep-711) 50 000 L verir; topSites ≤10 ve aylık litreye göre azalan; Gebze SITE_MANAGER\'da yalnız Gebze (owner\'da Gebze dahil çok şantiye, Gebze değeri aynı)',
      tv.length <= 10 && tv.every((v: any, i: number) => i === 0 || tv[i - 1].liters >= v.liters) && !!big && near(big.liters, 50000) && big.transactions === 3 && near(bigDetail.body.aggregates?.total_liters, 50000) &&
        ts.length <= 10 && ts.every((s: any, i: number) => i === 0 || ts[i - 1].monthLiters >= s.monthLiters) && tsG.length === 1 && tsG[0].siteName === GEBZE && ts.length >= 2 && ts.some((s: any) => s.siteName === GEBZE) && near(ts.find((s: any) => s.siteName === GEBZE)?.monthLiters, n(tsG[0].monthLiters)),
      `top1=${tv[0]?.vehiclePlate}/${tv[0]?.liters}, big=${big?.liters}/${big?.transactions}, bigDetail=${bigDetail.body?.aggregates?.total_liters}, sites=${ts.map((s: any) => s.siteName).join('|')}, gebze=${tsG.map((s: any) => s.siteName).join('|')}`
    );

    // === Test 5 (AC — tank doluluk özeti): A %10.0 KRİTİK, B %80.0 normal; azalan doluluk sırası (en boş önce); Gebze SITE_MANAGER yalnız Gebze tankları; kritik sayısı KPI ile aynı ===
    const tk = oa.body.data.tanks;
    const A = tk.find((x: any) => x.id === tankIds[0]);
    const B = tk.find((x: any) => x.id === tankIds[1]);
    check(
      'Test 5 (AC — tank görsel özeti): tank A doluluk %10.0 + isCritical, B %80.0 + normal (eşiksiz tank kritik değil); liste en boş tank önce (fill_pct artan); Gebze SITE_MANAGER\'da tüm tanklar Gebze; isCritical sayısı = kritik tank KPI\'ı',
      !!A && !!B && A.fillPct === 10 && A.isCritical === true && B.fillPct === 80 && B.isCritical === false && A.capacityLiters === 1000 && A.levelLiters === 100 &&
        tk.filter((x: any) => x.fillPct !== null).every((x: any, i: number, arr: any[]) => i === 0 || arr[i - 1].fillPct <= x.fillPct) &&
        ga.body.data.tanks.every((x: any) => x.siteName === GEBZE) && tk.filter((x: any) => x.isCritical).length === n(oa.body.data.kpis.criticalTanks.value),
      `A=${A?.fillPct}/${A?.isCritical}, B=${B?.fillPct}/${B?.isCritical}, tanks=${tk.length}, criticalKpi=${oa.body?.data?.kpis?.criticalTanks?.value}`
    );

    // === Test 6 (AC — rol/kapsam ve doğrulama): PUMP_OPERATOR 403, tokensiz 401, days=0/91/abc → 400; scope alanı; katalogda rep-723 yalnız yöneticilerde ===
    const pump = await dash(pumpOp);
    const anon = await call('/dashboard/executive');
    const badDays = await Promise.all(['0', '91', 'abc'].map((d) => dash(owner, `?days=${d}`)));
    const catO = await call('/reports', owner);
    const catP = await call('/reports', pumpOp);
    const has = (c: any, id: string) => (c.body?.data || []).some((x: any) => x.id === id);
    check(
      'Test 6 (AC — rol kuralları): PUMP_OPERATOR 403, tokensiz 401, days=0/91/abc → 400; scope: Gebze SITE_MANAGER siteName=Gebze, owner null; rep-723/rep-723-tank katalogda owner\'da var, PUMP_OPERATOR\'da yok; PUMP_OPERATOR rapor uçları da 403',
      pump.status === 403 && anon.status === 401 && badDays.every((r) => r.status === 400) && ga.body.data.scope.siteName === GEBZE && oa.body.data.scope.siteName === null &&
        has(catO, 'rep-723') && has(catO, 'rep-723-tank') && !has(catP, 'rep-723') && (await call('/reports/rep-723', pumpOp)).status === 403 && (await call('/reports/rep-723-tank', pumpOp)).status === 403,
      `pump=${pump.status}, anon=${anon.status}, bad=${badDays.map((r) => r.status).join('/')}`
    );

    // === Test 7 (AC — CSV/PDF/JSON tutarlılığı): rep-723 CSV sütun toplamları dashboard KPI'larıyla aynı; Gebze SITE_MANAGER CSV'si yalnız Gebze; tank CSV satırı = tank özeti; PDF %PDF- ===
    const csv = await call('/reports/rep-723/export?format=csv', owner);
    const csvG = await call('/reports/rep-723/export?format=csv', gebzeMgr);
    const csvTank = await call('/reports/rep-723-tank/export?format=csv', owner);
    const pdf = await fetch(`${API_URL}/reports/rep-723/export?format=pdf`, { headers: { Authorization: `Bearer ${owner}` } });
    const pdfTank = await fetch(`${API_URL}/reports/rep-723-tank/export?format=pdf`, { headers: { Authorization: `Bearer ${owner}` } });
    const cells = (raw: string) => raw.split('\r\n').filter(Boolean).slice(1).map((l) => l.split(','));
    const rowsO = cells(csv.raw);
    const rowsG = cells(csvG.raw);
    const colSum = (rows: string[][], idx: number) => rows.reduce((s, r) => s + n(r[idx] || 0), 0);
    check(
      'Test 7 (AC — CSV/PDF/JSON): rep-723 CSV (owner) sütun toplamları (Ay L, Ay Tutar, Açık Alarm, Kritik Tank, Çevrimdışı) dashboard KPI\'larıyla aynı; Gebze SITE_MANAGER CSV\'si tek satır (Gebze) ve Gebze KPI\'sıyla aynı; tank CSV satır sayısı = tank listesi; iki PDF de %PDF-',
      near(colSum(rowsO, 3), oa.body.data.kpis.monthlyConsumptionLiters.value, 0.05) && near(colSum(rowsO, 4), oa.body.data.kpis.monthlyCost.value, 0.05) &&
        colSum(rowsO, 5) === n(oa.body.data.kpis.openAlarms.value) && colSum(rowsO, 6) === n(oa.body.data.kpis.criticalTanks.value) && colSum(rowsO, 8) === n(oa.body.data.kpis.offlineDevices.value) &&
        rowsG.length === 1 && rowsG[0][1] === GEBZE && near(colSum(rowsG, 3), ga.body.data.kpis.monthlyConsumptionLiters.value, 0.05) &&
        cells(csvTank.raw).length === tk.length && pdf.status === 200 && pdfTank.status === 200 &&
        Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('latin1') === '%PDF-' && Buffer.from(await pdfTank.arrayBuffer()).subarray(0, 5).toString('latin1') === '%PDF-',
      `csvRows=${rowsO.length}, Σay=${colSum(rowsO, 3)}/${oa.body?.data?.kpis?.monthlyConsumptionLiters?.value}, gebzeRows=${rowsG.length}, tankRows=${cells(csvTank.raw).length}/${tk.length}`
    );

    // === Test 8 (AC — 1 sn altında): 8 ardışık istek (owner + SITE_MANAGER) — duvar saati ve sunucu ölçümü < 1000 ms; trend penceresi 90 gün de < 1 sn ===
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      times.push((await dash(owner)).ms);
      times.push((await dash(gebzeMgr)).ms);
    }
    const big90 = await dash(owner, '?days=90');
    const server = [oa, ga, big90].map((r) => n(r.body.data.meta.durationMs));
    check(
      'Test 8 (AC — < 1 sn): 8 ardışık dashboard isteği (owner/SITE_MANAGER) duvar saati < 1000 ms; days=90 de < 1000 ms; sunucu ölçümü (meta.durationMs) < 1000 ms',
      times.every((ms) => ms < 1000) && big90.ms < 1000 && server.every((ms) => ms < 1000) && big90.body.data.trends.dailyConsumption.length === 90,
      `wall=${times.join('/')}ms, 90g=${big90.ms}ms, server=${server.join('/')}ms`
    );
  } finally {
    await q('DELETE FROM stock_reconciliations WHERE id = ANY($1)', [reconIds]);
    await q('DELETE FROM tanks WHERE id = ANY($1)', [tankIds]);
    await q('DELETE FROM alarms WHERE id = ANY($1)', [alarmIds]);
    await q('DELETE FROM device_presence_events WHERE id = ANY($1)', [devEvents]);
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
