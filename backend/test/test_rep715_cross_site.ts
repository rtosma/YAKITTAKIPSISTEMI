import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * REP-715 (#172) — Çapraz Alım ve Mahsuplaşma Raporu.
 *
 * Elle hesaplı fixture (2021-08/09; başka veri yok). "Firma" = şantiye uyarlaması
 * (bkz. rep715CrossSite.ts). Reddedilen denemeler GERÇEK uçtan (POST /dispense)
 * üretilir — cihaz yolunun kaydı test_fuel402_2_quota_concurrency.ts'te.
 *
 * Şantiye çifti (A=Gebze < B=Silivri), Eylül 2021:
 *   Gebze araçları Silivri tankından: 100 L/2500 + 40 L/1200 + 10 L/FİYATSIZ + (geçmişte Gebze'ye bağlı, sonradan Orman'a atanan araç) 20 L/600
 *     → A→B 170 L, 4300 TL; Silivri araçları Gebze'den: 30 L/900 → B→A
 *     → NET 3400 (Gebze borçlu, Silivri alacaklı), 5 hareket, 1 fiyatsız
 *   Ağustos: Gebze→Silivri 50 L/1000 → net 1000; Eylül değişim = 3400−1000 = +2400
 *   Gebze↔Orman: Orman aracı Gebze'den 60 L/1800 → net −1800 (Orman borçlu)
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const SILIVRI = 'Silivri Tesisleri';
const ORMAN = 'Orman Şantiyesi';
const SEP_QS = 'startDate=2021-09-01&endDate=2021-09-30&pageSize=50';
const RANGE_QS = 'startDate=2021-08-01&endDate=2021-09-30&pageSize=50';

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
  console.log('🔀 [REP-715] ÇAPRAZ ALIM VE MAHSUPLAŞMA RAPORU TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };
  const n = (v: any) => Number(v);

  const owner = await login('camsa');
  const gebzeMgr = await login('gebze-santiye');
  const ormanMgr = await login('orman-santiye');
  const pumpOp = await login('pompa-op-01');

  const L4 = String(RUN).slice(-4);
  const veh = {
    VA: { id: `veh-r715-a-${RUN}`, plate: `34 RXA ${L4}`, site: GEBZE },
    VB: { id: `veh-r715-b-${RUN}`, plate: `34 RXB ${L4}`, site: SILIVRI },
    VC: { id: `veh-r715-c-${RUN}`, plate: `34 RXC ${L4}`, site: ORMAN }, // ŞU AN Orman, 2021-09'da Gebze'ydi
    VD: { id: `veh-r715-d-${RUN}`, plate: `34 RXD ${L4}`, site: ORMAN },
    VE: { id: `veh-r715-e-${RUN}`, plate: `34 RXE ${L4}`, site: GEBZE }, // izni YOK (ret testi)
    VF: { id: `veh-r715-f-${RUN}`, plate: `34 RXF ${L4}`, site: GEBZE }  // kotası tükenmek üzere (ret testi)
  };
  const vIds = Object.values(veh).map((v) => v.id);
  const plates = Object.values(veh).map((v) => v.plate);
  const txIds: string[] = [];

  async function tx(tag: string, v: { plate: string }, source: string, liters: number, unit: number | null, cost: number | null, when: string) {
    const id = `tx-r715-${RUN}-${tag}`;
    txIds.push(id);
    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, unit_cost_liters, total_cost, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, TENANT, source, v.plate, liters, unit, cost, when]
    );
  }

  try {
    for (const v of Object.values(veh)) {
      await q(`INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status) VALUES ($1,$2,$3,'Test','Kamyon',$4,$5,'AKTİF')`, [v.id, TENANT, v.plate, `rfid-r715-${RUN}-${v.id.slice(-8, -7)}`, v.site]);
    }
    // VC: 2021-10-15'te Gebze → Orman'a atandı (geçmiş).
    await q(`INSERT INTO vehicle_site_assignments (id, tenant_id, vehicle_id, from_site_name, to_site_name, changed_at) VALUES ($1,$2,$3,$4,$5,'2021-10-15T00:00:00Z')`, [`vsa-r715-${RUN}`, TENANT, veh.VC.id, GEBZE, ORMAN]);
    // VA'nın Silivri izni: 1000 L, 250 kullanıldı → %25.
    await q(`INSERT INTO cross_site_permissions (id, tenant_id, vehicle_plate, home_site, target_site, allowed_liters, used_liters, expiry_date, created_at) VALUES ($1,$2,$3,$4,$5,1000,250,'2030-01-01','2021-01-01')`, [`csp-r715-a-${RUN}`, TENANT, veh.VA.plate, GEBZE, SILIVRI]);

    await tx('aug', veh.VA, SILIVRI, 50, 20, 1000, '2021-08-15T12:00:00Z');
    await tx('1', veh.VA, SILIVRI, 100, 25, 2500, '2021-09-05T12:00:00Z');
    await tx('2', veh.VA, SILIVRI, 40, 30, 1200, '2021-09-06T12:00:00Z');
    await tx('4', veh.VA, SILIVRI, 10, null, null, '2021-09-07T12:00:00Z');
    await tx('own', veh.VA, GEBZE, 500, 25, 12500, '2021-09-08T12:00:00Z'); // KENDİ şantiyesi → çapraz DEĞİL
    await tx('3', veh.VB, GEBZE, 30, 30, 900, '2021-09-09T12:00:00Z');
    await tx('5', veh.VC, SILIVRI, 20, 30, 600, '2021-09-10T12:00:00Z');
    await tx('6', veh.VD, GEBZE, 60, 30, 1800, '2021-09-11T12:00:00Z');

    // === Test 1 (AC — çapraz alım listesi): kendi şantiyesindeki alım DIŞLANIR; 6 çapraz hareket, elle toplamlar ===
    const det = await call('GET', `/reports/rep-715?${SEP_QS}`, owner);
    const rowsById: Record<string, any> = {};
    for (const r of det.body?.data || []) rowsById[r.id.replace(`tx-r715-${RUN}-`, '')] = r;
    check(
      'Test 1 (AC — çapraz alım listesi): 6 çapraz hareket (kendi şantiyesindeki 500 L HARİÇ); toplam 260 L / 7000 TL (fiyatsız 10 L katkısız); kaynak/çeken doğru',
      det.status === 200 && det.body.data.length === 6 && !rowsById['own'] &&
        rowsById['1']?.source_site === SILIVRI && rowsById['1']?.home_site === GEBZE && rowsById['3']?.source_site === GEBZE && rowsById['3']?.home_site === SILIVRI &&
        n(det.body.aggregates.total_liters) === 260 && n(det.body.aggregates.total_cost) === 7000,
      `rows=${det.body?.data?.length}, hasOwn=${!!rowsById['own']}, liters=${det.body?.aggregates?.total_liters}, cost=${det.body?.aggregates?.total_cost}`
    );

    // === Test 2 (AC — kota kullanım oranları): VA→Silivri izni 250/1000 = %25; iznisiz VB satırı '-' ; alım anı birim maliyeti ===
    check(
      "Test 2 (AC — kota kullanım oranı): VA satırlarında %25.00; izni olmayan VB satırında NULL; tutar alım anındaki birim maliyet (100 L × 25 = 2500)",
      n(rowsById['1']?.quota_usage_pct) === 25 && rowsById['3']?.quota_usage_pct === null && n(rowsById['1']?.unit_cost_liters) === 25 && n(rowsById['1']?.total_cost) === 2500,
      `VA=${rowsById['1']?.quota_usage_pct}, VB=${rowsById['3']?.quota_usage_pct}, unit=${rowsById['1']?.unit_cost_liters}`
    );

    // === Test 3 (AC — NET mahsuplaşma): Eylül Gebze↔Silivri net 3400 (Gebze borçlu), geçmiş atamalı araç Gebze'ye yazılır; fiyatsız sayılır; Gebze↔Orman −1800 ===
    const st = await call('GET', `/reports/rep-715-mahsup?${RANGE_QS}`, owner);
    const pair = (a: string, b: string, m: string) => (st.body?.data || []).find((r: any) => r.site_a === a && r.site_b === b && r.month_label === m);
    const sep = pair(GEBZE, SILIVRI, '2021-09');
    const aug = pair(GEBZE, SILIVRI, '2021-08');
    const ormanPair = pair(GEBZE, ORMAN, '2021-09');
    check(
      'Test 3 (AC — net mahsuplaşma): Eylül Gebze↔Silivri A→B 170 L/4300, B→A 30 L/900, net +3400 → borçlu Gebze, alacaklı Silivri, 5 hareket, 1 fiyatsız (VC geçmişteki Gebze\'ye yazıldı); Gebze↔Orman net −1800 → borçlu Orman',
      st.body?.data?.length === 3 && sep?.movement_count === 5 && n(sep.liters_a_pulled_at_b) === 170 && n(sep.cost_a_owes_b) === 4300 && n(sep.liters_b_pulled_at_a) === 30 && n(sep.cost_b_owes_a) === 900 &&
        n(sep.net_cost) === 3400 && sep.debtor === GEBZE && sep.creditor === SILIVRI && sep.unpriced_count === 1 &&
        n(ormanPair?.net_cost) === -1800 && ormanPair?.debtor === ORMAN && ormanPair?.creditor === GEBZE,
      `rows=${st.body?.data?.length}, net=${sep?.net_cost}, debtor=${sep?.debtor}, mov=${sep?.movement_count}, unpriced=${sep?.unpriced_count}, orman=${ormanPair?.net_cost}/${ormanPair?.debtor}`
    );

    // === Test 4 (Kapsam — dönemsel karşılaştırma): Ağustos net 1000 (önceki 0), Eylül önceki 1000, değişim +2400 ===
    check(
      'Test 4 (Kapsam — dönemsel karşılaştırma): Ağustos net 1000 (önceki ay 0, değişim +1000); Eylül önceki ay net 1000, değişim +2400',
      n(aug?.net_cost) === 1000 && n(aug?.prev_net_cost) === 0 && n(aug?.net_change) === 1000 && n(sep?.prev_net_cost) === 1000 && n(sep?.net_change) === 2400,
      `aug=${aug?.net_cost}/${aug?.prev_net_cost}/${aug?.net_change}, sep=${sep?.prev_net_cost}/${sep?.net_change}`
    );

    // === Test 5 (AC — reddedilen talepler): GERÇEK POST /dispense ret'leri KALICI kaydedilir, yanıt kodları DEĞİŞMEZ ===
    await q(`INSERT INTO cross_site_permissions (id, tenant_id, vehicle_plate, home_site, target_site, allowed_liters, used_liters, expiry_date) VALUES ($1,$2,$3,$4,$5,100,90,'2030-01-01')`, [`csp-r715-f-${RUN}`, TENANT, veh.VF.plate, GEBZE, SILIVRI]);
    const noPerm = await call('POST', '/dispense', owner, { siteName: SILIVRI, vehiclePlate: veh.VE.plate, amountLiters: 50 });
    const overQuota = await call('POST', '/dispense', owner, { siteName: SILIVRI, vehiclePlate: veh.VF.plate, amountLiters: 50 });
    const den = await call('GET', `/reports/rep-715-red?vehiclePlate=${encodeURIComponent('34 RX')}&pageSize=50`, owner);
    const dE = (den.body?.data || []).find((r: any) => r.vehicle_plate === veh.VE.plate);
    const dF = (den.body?.data || []).find((r: any) => r.vehicle_plate === veh.VF.plate);
    check(
      'Test 5 (AC — reddedilen talepler): iznisiz VE → 403 NO_SITE_PERMISSION, kotası yetmeyen VF (100 izin/90 kullanılan, 50 istenen) → 409 QUOTA_EXHAUSTED; ikisi de rapor listesinde (istenen/izin/kullanılan/kalan/%90), source=MANUEL',
      noPerm.status === 403 && noPerm.body?.details?.error === 'NO_SITE_PERMISSION' && overQuota.status === 409 && overQuota.body?.details?.error === 'QUOTA_EXHAUSTED' &&
        den.body?.data?.length === 2 && dE?.reason === 'NO_SITE_PERMISSION' && dE?.home_site === GEBZE && dE?.target_site === SILIVRI && n(dE?.requested_liters) === 50 && dE?.source === 'MANUEL' &&
        dF?.reason === 'QUOTA_EXHAUSTED' && n(dF?.allowed_liters) === 100 && n(dF?.used_liters) === 90 && n(dF?.remaining_liters) === 10 && n(dF?.quota_usage_pct) === 90 &&
        n(den.body?.aggregates?.denial_count) === 2 && n(den.body?.aggregates?.quota_exhausted_count) === 1,
      `noPerm=${noPerm.status}/${noPerm.body?.details?.error}, over=${overQuota.status}/${overQuota.body?.details?.error}, rows=${den.body?.data?.length}, F=${dF?.remaining_liters}/${dF?.quota_usage_pct}`
    );
    const byReason = await call('GET', `/reports/rep-715-red?vehiclePlate=${encodeURIComponent('34 RX')}&reason=QUOTA_EXHAUSTED`, owner);

    // === Test 6 (AC — rol bazlı görünürlük): Orman SITE_MANAGER yalnız Orman'ı ilgilendiren satırları görür (geçmişte Gebze'ye bağlı VC'nin alımı DAHİL DEĞİL) ===
    const oDet = await call('GET', `/reports/rep-715?${SEP_QS}`, ormanMgr);
    const oSt = await call('GET', `/reports/rep-715-mahsup?${RANGE_QS}`, ormanMgr);
    const oDen = await call('GET', `/reports/rep-715-red?vehiclePlate=${encodeURIComponent('34 RX')}`, ormanMgr);
    const gDet = await call('GET', `/reports/rep-715?${SEP_QS}`, gebzeMgr);
    const gDen = await call('GET', `/reports/rep-715-red?vehiclePlate=${encodeURIComponent('34 RX')}`, gebzeMgr);
    const pump = await call('GET', `/reports/rep-715?${SEP_QS}`, pumpOp);
    const catO = await call('GET', '/reports', owner);
    const catP = await call('GET', '/reports', pumpOp);
    const ids = (c: any) => new Set((c.body?.data || []).map((r: any) => r.id));
    check(
      'Test 6 (AC — rol bazlı görünürlük): Orman yöneticisi 1 hareket (yalnız VD) + 1 çift satırı (Gebze↔Orman) görür, VC hareketi/denemeler YOK; Gebze yöneticisi 6 hareket + 2 ret görür; PUMP_OPERATOR 403 ve katalogda üç rapor YOK; COMPANY_OWNER katalogda ÜÇÜ DE VAR',
      oDet.body?.data?.length === 1 && oDet.body.data[0].vehicle_plate === veh.VD.plate && oSt.body?.data?.length === 1 && oSt.body.data[0].site_b === ORMAN && oDen.body?.data?.length === 0 &&
        gDet.body?.data?.length === 6 && gDen.body?.data?.length === 2 && pump.status === 403 &&
        ['rep-715', 'rep-715-mahsup', 'rep-715-red'].every((id) => ids(catO).has(id) && !ids(catP).has(id)),
      `orman=${oDet.body?.data?.length}/${oSt.body?.data?.length}/${oDen.body?.data?.length}, gebze=${gDet.body?.data?.length}/${gDen.body?.data?.length}, pump=${pump.status}`
    );
    check(
      "Test 6b (Kapsam — ret filtreleri): reason=QUOTA_EXHAUSTED yalnız VF'yi döndürür",
      byReason.body?.data?.length === 1 && byReason.body.data[0].vehicle_plate === veh.VF.plate,
      `byReason=${byReason.body?.data?.length}`
    );

    // === Test 7 (AC — CSV/PDF tutarlılığı): üç rapor ===
    const csvDet = await call('GET', `/reports/rep-715/export?format=csv&${SEP_QS}`, owner);
    const csvSt = await call('GET', `/reports/rep-715-mahsup/export?format=csv&${RANGE_QS}`, owner);
    const csvDen = await call('GET', `/reports/rep-715-red/export?format=csv&vehiclePlate=${encodeURIComponent('34 RX')}`, owner);
    const count = (csv: { raw: string }, needle: string) => csv.raw.split('\r\n').filter((l) => l.includes(needle)).length;
    const pdfs = await Promise.all(
      [`rep-715&${SEP_QS}`, `rep-715-mahsup&${RANGE_QS}`, `rep-715-red&vehiclePlate=${encodeURIComponent('34 RX')}`].map(async (p) => {
        const [id, ...rest] = p.split('&');
        const r = await fetch(`${API_URL}/reports/${id}/export?format=pdf&${rest.join('&')}`, { headers: { Authorization: `Bearer ${owner}` } });
        return { status: r.status, magic: Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString('latin1') };
      })
    );
    const sepLine = csvSt.raw.split('\r\n').find((l) => l.includes('2021-09') && l.includes(`${GEBZE},${SILIVRI}`)) || '';
    check(
      "Test 7 (AC — CSV/PDF tutarlılığı): CSV satır sayıları JSON'la AYNI (6 / 3 / 2); mahsuplaşma CSV'sinde Eylül çifti '+3400.00' ve borçlu/alacaklı; üç rapor için PDF 200 + %PDF-",
      count(csvDet, `tx-r715-${RUN}`) === 6 && count(csvSt, '2021-') === 3 && count(csvDen, '34 RX') === 2 &&
        sepLine.includes('+3400.00') && sepLine.includes(`,${GEBZE},${SILIVRI},`) && pdfs.every((p) => p.status === 200 && p.magic === '%PDF-'),
      `csv=${count(csvDet, `tx-r715-${RUN}`)}/${count(csvSt, '2021-')}/${count(csvDen, '34 RX')}, pdf=${pdfs.map((p) => p.status).join('/')}`
    );
  } finally {
    await q('DELETE FROM cross_site_denials WHERE vehicle_plate = ANY($1)', [plates]);
    await q('DELETE FROM cross_site_permissions WHERE vehicle_plate = ANY($1)', [plates]);
    await q('DELETE FROM vehicle_site_assignments WHERE vehicle_id = ANY($1)', [vIds]);
    await q('DELETE FROM transactions WHERE id = ANY($1) OR vehicle_plate = ANY($2)', [txIds, plates]);
    await q('DELETE FROM vehicles WHERE id = ANY($1)', [vIds]);
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
