import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * REP-714 (#171) — Tank Mutabakat ve Fire Raporu.
 *
 * Mutabakatlar GERÇEK uç (POST /tanks/:id/reconciliations) ile üretilir,
 * beklenen değerler ELLE hesaplanmıştır (pencere 2021-05/06 — başka veri yok).
 *  T1 (Gebze):  P1 05-01→02: 1000 +200 −150 = 1050, fiziksel 1044 → −6   (−0.5714%) TOLERANS_İÇİ
 *               P2 05-02→03: açılış=önceki fiziksel 1044, fiziksel 1030 → −14  (−1.3410%) AÇIKLANAMAYAN (alarm)
 *               P3 05-03→04: açılış 1030, fiziksel 1050 → +20 (+1.9417%) ÖLÇÜM_HATASI (alarm)
 *  T2 (Silivri, KÜÇÜK tank): 100 → fiziksel 95 → −5 (−5.0%) AÇIKLANAMAYAN (alarm)
 *  T3 (Gebze): AYLIK (30 gün) 2021-06: 10000 → 9895 → −105 (−1.05%) BUHARLAŞMA/NORMAL
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const SILIVRI = 'Silivri Tesisleri';
const RANGE_QS = 'startDate=2021-05-01&endDate=2021-07-01&pageSize=50';

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
  console.log('📉 [REP-714] TANK MUTABAKAT VE FİRE RAPORU TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };
  const n = (v: any) => Number(v);
  const near = (a: any, b: number, eps = 0.001) => Math.abs(n(a) - b) <= eps;

  const owner = await login('camsa');
  const gebzeMgr = await login('gebze-santiye');
  const pumpOp = await login('pompa-op-01');

  const tanks = {
    T1: { id: `tank-r714-t1-${RUN}`, name: `R714-T1-${RUN}`, site: GEBZE, capacity: 5000 },
    T2: { id: `tank-r714-t2-${RUN}`, name: `R714-T2-${RUN}`, site: SILIVRI, capacity: 200 },
    T3: { id: `tank-r714-t3-${RUN}`, name: `R714-T3-${RUN}`, site: GEBZE, capacity: 20000 }
  };
  const tankIds = Object.values(tanks).map((t) => t.id);
  const W1 = ['2021-05-01T00:00:00.000Z', '2021-05-02T00:00:00.000Z'];
  const W2 = ['2021-05-02T00:00:00.000Z', '2021-05-03T00:00:00.000Z'];
  const W3 = ['2021-05-03T00:00:00.000Z', '2021-05-04T00:00:00.000Z'];
  const W6 = ['2021-06-01T00:00:00.000Z', '2021-07-01T00:00:00.000Z'];

  async function recon(t: { id: string }, w: string[], physical: number, opening?: number, periodType = 'AD_HOC') {
    const body: any = { periodType, periodStart: w[0], periodEnd: w[1], physicalLiters: physical };
    if (opening !== undefined) body.openingBookLiters = opening;
    const r = await call('POST', `/tanks/${t.id}/reconciliations`, owner, body);
    if (r.status !== 201) throw new Error(`mutabakat oluşturulamadı (${t.id}): ${r.status} ${r.raw}`);
  }

  try {
    for (const t of Object.values(tanks)) {
      await q(`INSERT INTO tanks (id, tenant_id, name, capacity_liters, current_level_liters, fuel_type, site_name) VALUES ($1,$2,$3,$4,50,'Motorin',$5)`, [t.id, TENANT, t.name, t.capacity, t.site]);
    }
    await q(
      `INSERT INTO fuel_intake_receipts (id, tenant_id, tank_id, tank_name, site_name, supplier_name, waybill_no, delivery_date, declared_liters, declared_liters_15c, added_liters, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,'Test A.Ş.',$6,'2021-05-01',200,200,200,'KAYITLI','test','2021-05-01T12:00:00Z')`,
      [`intk-${tanks.T1.id}`, TENANT, tanks.T1.id, tanks.T1.name, GEBZE, `IRS-${RUN}`]
    );
    await q(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, tank_name, amount_liters, created_at) VALUES ($1,$2,$3,'R714 PLK',$4,150,'2021-05-01T12:00:00Z')`, [`tx-${tanks.T1.name}`, TENANT, GEBZE, tanks.T1.name]);
    await recon(tanks.T1, W1, 1044, 1000);
    await recon(tanks.T1, W2, 1030);
    await recon(tanks.T1, W3, 1050);
    await recon(tanks.T2, W1, 95, 100);
    await recon(tanks.T3, W6, 9895, 10000, 'MONTHLY');

    const det = await call('GET', `/reports/rep-714?${RANGE_QS}`, owner);
    const rows: Record<string, any> = {};
    for (const r of det.body?.data || []) rows[`${r.tank_name.slice(5, 7)}${r.period_start.slice(8, 10)}`] = r;
    const p1 = rows['T101'], p2 = rows['T102'], p3 = rows['T103'], t2 = rows['T201'], t3 = rows['T301'];

    // === Test 1 (AC — fark litre ve % ): elle hesaplı değerler + bakiye tutarlılığı ===
    const balanceOk = Object.values(rows).every((r: any) => near(n(r.opening_book_liters) + n(r.intake_liters) - n(r.outflow_liters), n(r.closing_book_liters), 0.005));
    check(
      'Test 1 (AC — fark litre ve %): elle hesap P1 −6 / −0.5714, P2 −14 / −1.3410, P3 +20 / +1.9417, T2 −5 / −5.0, T3 −105 / −1.05; açılış+dolum−çıkış=teorik her satırda; P1 çıkış 150',
      det.status === 200 && Object.keys(rows).length === 5 && balanceOk &&
        near(p1?.variance_liters, -6) && near(p1?.variance_pct, -0.5714) && near(p1?.outflow_liters, 150) && near(p1?.closing_book_liters, 1050) &&
        near(p2?.variance_liters, -14) && near(p2?.variance_pct, -1.341) && near(p3?.variance_liters, 20) && near(p3?.variance_pct, 1.9417) &&
        near(t2?.variance_liters, -5) && near(t2?.variance_pct, -5) && near(t3?.variance_liters, -105) && near(t3?.variance_pct, -1.05),
      `rows=${Object.keys(rows).length}, balanceOk=${balanceOk}, P1=${p1?.variance_liters}/${p1?.variance_pct}, P2=${p2?.variance_pct}, P3=${p3?.variance_pct}, T2=${t2?.variance_pct}, T3=${t3?.variance_pct}`
    );

    // === Test 2 (AC — tolerans dışı vurgusu): P1 içinde; P2,P3,T2,T3 dışında (T3 buharlaşma: literal dışı ama NORMAL) ===
    const csv = await call('GET', `/reports/rep-714/export?format=csv&${RANGE_QS}`, owner);
    const cell = (tag: string) => (csv.raw.split('\r\n').find((l) => l.includes(`,${tag}-${RUN},`)) || '').split(',');
    const oot = await call('GET', `/reports/rep-714?${RANGE_QS}&outOfTolerance=true`, owner);
    const alarm = await call('GET', `/reports/rep-714?${RANGE_QS}&status=MUTABAKAT_ALARMI`, owner);
    const t1Cells = csv.raw.split('\r\n').filter((l) => l.includes(`,R714-T1-${RUN},`)).map((l) => l.split(','));
    check(
      "Test 2 (AC — tolerans dışı vurgusu): out_of_tolerance P1=false, P2/P3/T2/T3=true; CSV 'TOLERANS DIŞI'/'İçinde'; outOfTolerance=true → 4 satır; status=MUTABAKAT_ALARMI → 3 (BUHARLAŞMA alarm DEĞİL)",
      p1?.out_of_tolerance === false && p2?.out_of_tolerance === true && p3?.out_of_tolerance === true && t2?.out_of_tolerance === true && t3?.out_of_tolerance === true &&
        t1Cells.some((c) => c[17] === 'İçinde') && t1Cells.filter((c) => c[17] === 'TOLERANS DIŞI').length === 2 && cell('R714-T3')[17] === 'TOLERANS DIŞI' && t3?.status === 'NORMAL' &&
        oot.body?.data?.length === 4 && alarm.body?.data?.length === 3,
      `flags=${[p1, p2, p3, t2, t3].map((r) => r?.out_of_tolerance).join(',')}, oot=${oot.body?.data?.length}, alarm=${alarm.body?.data?.length}`
    );

    // === Test 3 (Kapsam — trend verisi): T1 dönemleri artan sırada prev_variance_pct ve değişim; filtre uygulansa da 'önceki' gerçek önceki ===
    const trend = await call('GET', `/reports/rep-714?${RANGE_QS}&tankName=${encodeURIComponent(tanks.T1.name)}&sortBy=period_start&sortDir=asc`, owner);
    const tr = trend.body?.data || [];
    const filtered = await call('GET', `/reports/rep-714?${RANGE_QS}&tankName=${encodeURIComponent(tanks.T1.name)}&classification=${encodeURIComponent('AÇIKLANAMAYAN')}`, owner);
    check(
      'Test 3 (Kapsam — trend grafiği verisi): T1 artan sırada [P1,P2,P3]; prev_variance_pct [null, −0.5714, −1.3410]; değişim (puan) [null, −0.7696, +3.2827]; sınıf filtresiyle yalnız P2 dönse de prev −0.5714 (LAG filtreden ÖNCE)',
      tr.length === 3 && tr[0].prev_variance_pct === null && near(tr[1].prev_variance_pct, -0.5714) && near(tr[2].prev_variance_pct, -1.341) &&
        tr[0].variance_pct_change === null && near(tr[1].variance_pct_change, -0.7696) && near(tr[2].variance_pct_change, 3.2827) &&
        filtered.body?.data?.length === 1 && near(filtered.body.data[0].prev_variance_pct, -0.5714),
      `trend=${tr.length}, prev=[${tr.map((r: any) => r.prev_variance_pct).join('|')}], chg=[${tr.map((r: any) => r.variance_pct_change).join('|')}], filteredPrev=${filtered.body?.data?.[0]?.prev_variance_pct}`
    );

    // === Test 4 (Teknik Not — mutlak litre ve % AYRI eşikler): 5 L / %5'lik KÜÇÜK tank T2 yalnız % filtresinde görünür ===
    const minL = await call('GET', `/reports/rep-714?${RANGE_QS}&minAbsVarianceLiters=10`, owner);
    const minP = await call('GET', `/reports/rep-714?${RANGE_QS}&minAbsVariancePct=3`, owner);
    const namesL = new Set((minL.body?.data || []).map((r: any) => `${r.tank_name.slice(5, 7)}${r.period_start.slice(8, 10)}`));
    check(
      'Test 4 (Teknik Not — litre vs %): minAbsVarianceLiters=10 → P2(14),P3(20),T3(105) (T2 5 L ve P1 6 L DEĞİL); minAbsVariancePct=3 → yalnız küçük tank T2 (%5)',
      minL.body?.data?.length === 3 && namesL.has('T102') && namesL.has('T103') && namesL.has('T301') && minP.body?.data?.length === 1 && minP.body.data[0].tank_name === tanks.T2.name,
      `minL=${[...namesL].join(',')}, minP=${minP.body?.data?.map((r: any) => r.tank_name.slice(5, 7)).join(',')}`
    );

    // === Test 5 (AC — fire sınıfına göre kırılım): şantiye × sınıf × ay, elle hesaplı ===
    const br = await call('GET', `/reports/rep-714-fire-sinifi?${RANGE_QS}`, owner);
    const b = (site: string, month: string, cls: string) => (br.body?.data || []).find((r: any) => r.site_name === site && r.month_label === month && r.classification === cls);
    const gebzeFilter = await call('GET', `/reports/rep-714-fire-sinifi?${RANGE_QS}&siteName=${encodeURIComponent(GEBZE)}`, owner);
    check(
      'Test 5 (AC — fire sınıfı kırılımı): Gebze 2021-05: TOLERANS_İÇİ(1, kayıp 6) / AÇIKLANAMAYAN(1, 14) / ÖLÇÜM_HATASI(1, fazla 20); 2021-06 BUHARLAŞMA(1, 105); Silivri AÇIKLANAMAYAN(1, 5); Gebze toplam kayıp 125, fazla 20, mutabakat 4',
      br.body?.data?.length === 5 &&
        b(GEBZE, '2021-05', 'TOLERANS_İÇİ')?.reconciliation_count === 1 && near(b(GEBZE, '2021-05', 'TOLERANS_İÇİ')?.loss_liters, 6) &&
        near(b(GEBZE, '2021-05', 'AÇIKLANAMAYAN')?.loss_liters, 14) && near(b(GEBZE, '2021-05', 'ÖLÇÜM_HATASI')?.surplus_liters, 20) &&
        b(GEBZE, '2021-06', 'BUHARLAŞMA')?.reconciliation_count === 1 && near(b(GEBZE, '2021-06', 'BUHARLAŞMA')?.loss_liters, 105) &&
        near(b(SILIVRI, '2021-05', 'AÇIKLANAMAYAN')?.loss_liters, 5) &&
        near(gebzeFilter.body?.aggregates?.total_loss_liters, 125) && near(gebzeFilter.body?.aggregates?.total_surplus_liters, 20) && near(gebzeFilter.body?.aggregates?.total_reconciliations, 4),
      `rows=${br.body?.data?.length}, gebzeLoss=${gebzeFilter.body?.aggregates?.total_loss_liters}, surplus=${gebzeFilter.body?.aggregates?.total_surplus_liters}, n=${gebzeFilter.body?.aggregates?.total_reconciliations}`
    );

    // === Test 6 (AC — rol bazlı görünürlük) ===
    const gDet = await call('GET', `/reports/rep-714?${RANGE_QS}`, gebzeMgr);
    const gBr = await call('GET', `/reports/rep-714-fire-sinifi?${RANGE_QS}`, gebzeMgr);
    const pump = await call('GET', `/reports/rep-714?${RANGE_QS}`, pumpOp);
    const catO = await call('GET', '/reports', owner);
    const catP = await call('GET', '/reports', pumpOp);
    const ids = (c: any) => new Set((c.body?.data || []).map((r: any) => r.id));
    check(
      'Test 6 (AC — rol bazlı görünürlük): Gebze SITE_MANAGER yalnız Gebze (detay 4, kırılım 4; Silivri YOK); PUMP_OPERATOR 403, katalogda rep-714/rep-714-fire-sinifi YOK; COMPANY_OWNER katalogda İKİSİ VAR',
      gDet.body?.data?.length === 4 && gDet.body.data.every((r: any) => r.site_name === GEBZE) && gBr.body?.data?.length === 4 && gBr.body.data.every((r: any) => r.site_name === GEBZE) &&
        pump.status === 403 && !ids(catP).has('rep-714') && !ids(catP).has('rep-714-fire-sinifi') && ids(catO).has('rep-714') && ids(catO).has('rep-714-fire-sinifi'),
      `gebzeDetay=${gDet.body?.data?.length}, gebzeKirilim=${gBr.body?.data?.length}, pump=${pump.status}`
    );

    // === Test 7 (AC — CSV/PDF tutarlılığı) ===
    const csvBr = await call('GET', `/reports/rep-714-fire-sinifi/export?format=csv&${RANGE_QS}`, owner);
    const csvDetRows = csv.raw.split('\r\n').filter((l) => l.includes('R714-T')).length;
    const csvBrRows = csvBr.raw.split('\r\n').filter((l) => l.includes(GEBZE) || l.includes(SILIVRI)).length;
    const pdf1 = await fetch(`${API_URL}/reports/rep-714/export?format=pdf&${RANGE_QS}`, { headers: { Authorization: `Bearer ${owner}` } });
    const pdfBuf = Buffer.from(await pdf1.arrayBuffer());
    const pdf2 = await fetch(`${API_URL}/reports/rep-714-fire-sinifi/export?format=pdf&${RANGE_QS}`, { headers: { Authorization: `Bearer ${owner}` } });
    check(
      'Test 7 (AC — CSV/PDF tutarlılığı): CSV satır sayıları JSON totalCount ile AYNI (detay 5, kırılım 5), başlıklar yeni sütunları içerir, iki rapor için PDF 200 + %PDF-',
      csvDetRows === det.body?.pagination?.totalCount && csvDetRows === 5 && csvBrRows === br.body?.pagination?.totalCount && csvBrRows === 5 &&
        csv.raw.includes('Teorik Kapanış') && csv.raw.includes('Ölçülen Kapanış') && csv.raw.includes('Fire Sınıfı') &&
        pdf1.status === 200 && pdfBuf.subarray(0, 5).toString('latin1') === '%PDF-' && pdf2.status === 200,
      `csvDet=${csvDetRows}/${det.body?.pagination?.totalCount}, csvBr=${csvBrRows}/${br.body?.pagination?.totalCount}, pdf=${pdf1.status}/${pdf2.status}`
    );
  } finally {
    const keys = tankIds.map((id) => `STOCK_RECON:${id}`);
    await q(`DELETE FROM alarm_events WHERE alarm_id IN (SELECT id FROM alarms WHERE tenant_id = $1 AND alarm_key = ANY($2))`, [TENANT, keys]);
    await q(`DELETE FROM alarms WHERE tenant_id = $1 AND alarm_key = ANY($2)`, [TENANT, keys]);
    await q('DELETE FROM fire_records WHERE tank_id = ANY($1)', [tankIds]);
    await q('DELETE FROM stock_reconciliations WHERE tank_id = ANY($1)', [tankIds]);
    await q('DELETE FROM fuel_intake_receipts WHERE tank_id = ANY($1)', [tankIds]);
    await q('DELETE FROM transactions WHERE tank_name = ANY($1)', [Object.values(tanks).map((t) => t.name)]);
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
