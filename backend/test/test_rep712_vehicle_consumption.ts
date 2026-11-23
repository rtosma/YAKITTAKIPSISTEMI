import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { getFleetConsumptionReport } from '../src/db/tenantDb';
import { runWithTenant } from '../src/context/tenantContext';

/**
 * REP-712 (#169) — Araç Bazlı Tüketim Raporu.
 *
 * Rapor, FLEET-1405'in JS motorunu SQL'de yeniden ifade eder (bkz.
 * reports/definitions/rep712VehicleConsumption.ts) — bu yüzden Test 2 bir
 * PARİTE testidir: rapor satırları getFleetConsumptionReport'un (JS motoru)
 * çıktısıyla karşılaştırılır. Fixture ayları GÜNCEL İstanbul ayına göre
 * hesaplanır (rapor son 13 ayı üretir); okumalar/ikmaller ayın 15'i 12:00Z'ye
 * (İstanbul 15:00) konur — ay sınırından güvenli uzak.
 *
 * Araçlar: A (Kamyon/KM, 25→40 L/100km, ANOMALİ işaretli), B (Ekskavatör/
 * MOTOR_SAAT, 3.00 L/saat), C (bu ay kapanış okuması YOK → EKSIK_VERI),
 * D (Silivri, 20→22, +%10), E (kapanış=açılış → GECERSIZ_VERI).
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const SILIVRI = 'Silivri Tesisleri';
const PLATE_PREFIX = `R712-${RUN}`;

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
async function call(path: string, token: string): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const raw = await res.text();
  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* CSV gövdesi JSON değil */
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

// Güncel İstanbul ayı (sabit UTC+3) ve ay ofsetleri.
const nowLocal = new Date(Date.now() + 3 * 60 * 60 * 1000);
function midOf(offset: number): Date {
  return new Date(Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth() + offset, 15, 12, 0, 0));
}
function labelOf(offset: number): string {
  const d = midOf(offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const C = labelOf(0);
const P = labelOf(-1);

async function run() {
  console.log('===========================================================');
  console.log('🚛 [REP-712] ARAÇ BAZLI TÜKETİM RAPORU TESTİ');
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

  const veh = {
    A: { id: `veh-r712-a-${RUN}`, plate: `${PLATE_PREFIX}-A`, type: 'Kamyon', site: GEBZE },
    B: { id: `veh-r712-b-${RUN}`, plate: `${PLATE_PREFIX}-B`, type: 'Ekskavatör', site: GEBZE },
    C: { id: `veh-r712-c-${RUN}`, plate: `${PLATE_PREFIX}-C`, type: 'Kamyon', site: GEBZE },
    D: { id: `veh-r712-d-${RUN}`, plate: `${PLATE_PREFIX}-D`, type: 'Kamyon', site: SILIVRI },
    E: { id: `veh-r712-e-${RUN}`, plate: `${PLATE_PREFIX}-E`, type: 'Kamyon', site: GEBZE }
  };
  const alarmId = `alarm-r712-${RUN}`;
  const txIds: string[] = [];

  async function reading(v: { id: string; plate: string }, meter: 'KM' | 'MOTOR_SAAT', offset: number, value: number) {
    await q(
      `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AD_HOC','test')`,
      [`vmr-r712-${RUN}-${v.plate}-${offset}`, TENANT, v.id, v.plate, meter, value, midOf(offset).toISOString()]
    );
  }
  async function fuel(v: { plate: string; site: string }, offset: number, liters: number, cost: number) {
    const id = `tx-r712-${RUN}-${v.plate}-${offset}`;
    txIds.push(id);
    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, total_cost, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, TENANT, v.site, v.plate, liters, cost, midOf(offset).toISOString()]
    );
  }

  try {
    for (const v of Object.values(veh)) {
      await q(
        `INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status) VALUES ($1,$2,$3,'Test Model',$4,$5,$6,'AKTİF')`,
        [v.id, TENANT, v.plate, v.type, `rfid-r712-${RUN}-${v.plate}`, v.site]
      );
    }
    // A: 1000 → 2000 → 3000 km; P: 250 L, C: 400 L → 25.00 → 40.00 L/100km (+%60)
    await reading(veh.A, 'KM', -2, 1000); await reading(veh.A, 'KM', -1, 2000); await reading(veh.A, 'KM', 0, 3000);
    await fuel(veh.A, -1, 250, 2500); await fuel(veh.A, 0, 400, 4000);
    // B: motor-saat 500 (P) → 600 (C), C: 300 L → 3.00 L/saat; P'nin açılışı YOK → P eksik
    await reading(veh.B, 'MOTOR_SAAT', -1, 500); await reading(veh.B, 'MOTOR_SAAT', 0, 600);
    await fuel(veh.B, 0, 300, 3000);
    // C: bu ay kapanış okuması YOK → C dönemi EKSIK_VERI (gerçek litre 120 yine görünmeli)
    await reading(veh.C, 'KM', -2, 1000); await reading(veh.C, 'KM', -1, 2000);
    await fuel(veh.C, 0, 120, 1200);
    // D (Silivri): 20 → 22 L/100km (+%10)
    await reading(veh.D, 'KM', -2, 1000); await reading(veh.D, 'KM', -1, 2000); await reading(veh.D, 'KM', 0, 3000);
    await fuel(veh.D, -1, 200, 2000); await fuel(veh.D, 0, 220, 2200);
    // E: kapanış = açılış → kullanım 0 → GECERSIZ_VERI
    await reading(veh.E, 'KM', -2, 4000); await reading(veh.E, 'KM', -1, 5000); await reading(veh.E, 'KM', 0, 5000);
    await fuel(veh.E, 0, 50, 500);
    // AI-503: A aracı için C döneminde anomali alarmı olayı
    await q(
      `INSERT INTO alarms (id, tenant_id, alarm_key, category, severity, title, subject_type, subject_id) VALUES ($1,$2,$3,'CONSUMPTION_ANOMALY','WARNING','Test anomali','VEHICLE',$4)`,
      [alarmId, TENANT, `CONSUMPTION_ANOMALY:${veh.A.id}`, veh.A.plate]
    );
    await q(`INSERT INTO alarm_events (id, tenant_id, alarm_id, detail) VALUES ($1,$2,$3,$4)`, [`almev-r712-${RUN}`, TENANT, alarmId, JSON.stringify({ periodLabel: C })]);

    const base = `vehiclePlate=${encodeURIComponent(PLATE_PREFIX)}&pageSize=50`;
    const cur = await call(`/reports/rep-712?${base}&period=${C}`, owner);
    const rows: Record<string, any> = {};
    for (const r of cur.body?.data || []) rows[r.vehicle_plate.slice(-1)] = r;

    // === Test 1 (AC — L/100km ve L/saat doğru): ===
    check(
      'Test 1 (AC — L/100km ve L/saat doğru): A=40.00 L/100km, B=3.00 L/saat (L/100km NULL), D=22.00',
      cur.status === 200 && Number(rows.A?.l_per_100km) === 40 && Number(rows.B?.l_per_hour) === 3 && rows.B?.l_per_100km === null && Number(rows.D?.l_per_100km) === 22,
      `status=${cur.status}, A=${rows.A?.l_per_100km}, B_hour=${rows.B?.l_per_hour}, B_100=${rows.B?.l_per_100km}, D=${rows.D?.l_per_100km}`
    );

    // === Test 2 (PARİTE — FLEET-1405 JS motoru ile aynı sonuç): ===
    const js = await runWithTenant({ tenantId: TENANT }, () => getFleetConsumptionReport(C));
    let parityOk = true;
    const parityDetail: string[] = [];
    for (const key of ['A', 'B', 'C', 'D', 'E'] as const) {
      const j = js.vehicles.find((x) => x.vehiclePlate === veh[key].plate);
      const r = rows[key];
      const jsMetric = j?.meterType === 'KM' ? j?.consumptionPer100Unit : j?.consumptionPerHour;
      const sqlMetric = j?.meterType === 'KM' ? r?.l_per_100km : r?.l_per_hour;
      const ok = !!j && !!r && j.status === r.data_status && (j.status !== 'HESAPLANDI' || Math.abs(Number(sqlMetric) - Number(jsMetric)) <= 0.01);
      if (!ok) parityOk = false;
      parityDetail.push(`${key}:${j?.status}/${r?.data_status}/${jsMetric}/${sqlMetric}`);
    }
    check('Test 2 (PARİTE): 5 fixture aracın durum + metrik değeri FLEET-1405 JS motoruyla (getFleetConsumptionReport) AYNI', parityOk, parityDetail.join(' | '));

    // === Test 3 (AC — eksik sayaç verisi açıkça belirtilir): ===
    const csv = await call(`/reports/rep-712/export?format=csv&${base}&period=${C}`, owner);
    const csvLine = (key: keyof typeof veh) => (csv.raw.split('\r\n').find((l) => l.includes(`,${veh[key].plate},`)) || '').split(',');
    const cCells = csvLine('C');
    const eCells = csvLine('E');
    const bCells = csvLine('B');
    check(
      "Test 3 (AC — eksik veri AÇIKÇA belirtilir): C (kapanış yok) → JSON EKSIK_VERI + CSV L/100km & kat edilen hücresi 'VERİ EKSİK' (boş/0 DEĞİL), gerçek litre 120.00; E → 'GEÇERSİZ VERİ'; B'nin (motor-saat) L/100km hücresi '-'",
      rows.C?.data_status === 'EKSIK_VERI' && rows.C?.l_per_100km === null && cCells[8] === 'VERİ EKSİK' && cCells[9] === 'VERİ EKSİK' && cCells[10] === '-' && cCells[6] === '120.00' &&
        rows.E?.data_status === 'GECERSIZ_VERI' && eCells[9] === 'GEÇERSİZ VERİ' && bCells[9] === '-' && bCells[10] === '3.00',
      `C=[${cCells.slice(6, 13).join('|')}], E=[${eCells.slice(8, 13).join('|')}], B=[${bCells.slice(8, 11).join('|')}]`
    );

    // === Test 4 (AC — dönem karşılaştırması): ===
    const aCells = csvLine('A');
    check(
      'Test 4 (AC — dönem karşılaştırması): A önceki aya göre +%60, D +%10, hesaplanamayan (B/C/E) NULL; CSV A hücresi +60.00',
      Number(rows.A?.change_pct) === 60 && Number(rows.D?.change_pct) === 10 && rows.B?.change_pct === null && rows.C?.change_pct === null && rows.E?.change_pct === null && aCells[11] === '+60.00',
      `A=${rows.A?.change_pct}, D=${rows.D?.change_pct}, B=${rows.B?.change_pct}, csvA=${aCells[11]}`
    );

    // === Test 5 (Kapsam — AI-503 anomali vurgusu, dönem bazlı): ===
    const prev = await call(`/reports/rep-712?${base}&period=${P}`, owner);
    const prevA = (prev.body?.data || []).find((r: any) => r.vehicle_plate === veh.A.plate);
    check(
      "Test 5 (Kapsam — AI-503 vurgusu): A yalnızca alarm olayının dönemi (C) için anomaly_flagged=true + CSV 'ANOMALİ'; önceki dönemde ve D'de işaretsiz",
      rows.A?.anomaly_flagged === true && aCells[13] === 'ANOMALİ' && prevA?.anomaly_flagged === false && rows.D?.anomaly_flagged === false && csvLine('D')[13] === '-',
      `A_C=${rows.A?.anomaly_flagged}, A_P=${prevA?.anomaly_flagged}, D=${rows.D?.anomaly_flagged}`
    );

    // === Test 6 (Kapsam — filtreler: sapma eşiği, araç tipi, şantiye): ===
    const dev = await call(`/reports/rep-712?${base}&period=${C}&minDeviationPct=50`, owner);
    const typ = await call(`/reports/rep-712?${base}&period=${C}&vehicleType=${encodeURIComponent('Ekskavatör')}`, owner);
    const sit = await call(`/reports/rep-712?${base}&period=${C}&siteName=${encodeURIComponent(SILIVRI)}`, owner);
    check(
      'Test 6 (Kapsam — filtreler): minDeviationPct=50 → yalnız A; vehicleType=Ekskavatör → yalnız B; siteName=Silivri → yalnız D',
      dev.body?.data?.length === 1 && dev.body.data[0].vehicle_plate === veh.A.plate &&
        typ.body?.data?.length === 1 && typ.body.data[0].vehicle_plate === veh.B.plate &&
        sit.body?.data?.length === 1 && sit.body.data[0].vehicle_plate === veh.D.plate,
      `dev=${dev.body?.data?.length}, type=${typ.body?.data?.length}, site=${sit.body?.data?.length}`
    );

    // === Test 7 (AC — rol bazlı görünürlük): ===
    const gebze = await call(`/reports/rep-712?${base}&period=${C}`, gebzeMgr);
    const gebzePlates = new Set((gebze.body?.data || []).map((r: any) => r.vehicle_plate));
    const pump = await call(`/reports/rep-712?${base}&period=${C}`, pumpOp);
    const catalogOwner = await call('/reports', owner);
    const catalogPump = await call('/reports', pumpOp);
    check(
      'Test 7 (AC — rol bazlı görünürlük): Gebze SITE_MANAGER yalnız Gebze araçlarını (A,B,C,E) görür, D (Silivri) YOK; PUMP_OPERATOR 403 ve katalogda rep-712 YOK; COMPANY_OWNER katalogda VAR',
      gebzePlates.has(veh.A.plate) && gebzePlates.has(veh.E.plate) && !gebzePlates.has(veh.D.plate) && pump.status === 403 &&
        (catalogOwner.body?.data || []).some((r: any) => r.id === 'rep-712') && !(catalogPump.body?.data || []).some((r: any) => r.id === 'rep-712'),
      `gebzeCount=${gebzePlates.size}, hasD=${gebzePlates.has(veh.D.plate)}, pump=${pump.status}`
    );

    // === Test 8 (AC — CSV/PDF tutarlılığı): ===
    const csvRows = csv.raw.split('\r\n').filter((l) => l.includes(PLATE_PREFIX)).length;
    const pdf = await fetch(`${API_URL}/reports/rep-712/export?format=pdf&${base}&period=${C}`, { headers: { Authorization: `Bearer ${owner}` } });
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    check(
      'Test 8 (AC — CSV/PDF tutarlılığı): CSV veri satır sayısı JSON totalCount ile AYNI (5), CSV başlığı yeni sütunları içerir, PDF 200 + %PDF-',
      csvRows === cur.body?.pagination?.totalCount && csvRows === 5 && csv.raw.includes('L/100km') && csv.raw.includes('Önceki Döneme Göre %') &&
        pdf.status === 200 && pdfBuf.subarray(0, 5).toString('latin1') === '%PDF-',
      `csvRows=${csvRows}, totalCount=${cur.body?.pagination?.totalCount}, pdf=${pdf.status}`
    );
  } finally {
    const vIds = Object.values(veh).map((v) => v.id);
    await q('DELETE FROM alarm_events WHERE alarm_id = $1', [alarmId]);
    await q('DELETE FROM alarms WHERE id = $1', [alarmId]);
    await q('DELETE FROM vehicle_meter_readings WHERE vehicle_id = ANY($1)', [vIds]);
    await q('DELETE FROM transactions WHERE id = ANY($1)', [txIds]);
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
