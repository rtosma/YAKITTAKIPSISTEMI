import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { getDeviceOnlineSla } from '../src/db/tenantDb';
import { runWithTenant } from '../src/context/tenantContext';

/**
 * REP-717 (#174) — Cihaz Sağlık ve Kesinti Raporu.
 *
 * Sentetik presence olayları (Test Notu) SQL ile kurulur, beklenen değerler ELLE
 * hesaplanmıştır; varsayılan 30 günlük pencere ayrıca IOT-308'in
 * getDeviceOnlineSla'sıyla KARŞILAŞTIRILIR (parite — rapor o mantığın SQL karşılığı).
 * Pencere: 2021-12-01 00:00Z → 2021-12-11 00:00Z (10 gün = 864000 sn).
 *
 *  D1 Gebze fw A: ONLINE 11-20; OFFLINE 12-02 00:00→06:00 (21600); 12-05 12:00→12-06 12:00 (86400);
 *     12-10 22:00 → SÜRÜYOR (pencere sonuna 7200)  ⇒ offline 115200 → online %86.67, 3 kesinti, en uzun 86400
 *  D2 Gebze fw A: İLK olay 12-05 00:00 (gözlem 6 gün=518400); OFFLINE 12-07 00:00→12:00 (43200) ⇒ %91.67, 1, 43200
 *  D3 Silivri fw B: OFFLINE 11-30 20:00→12-01 04:00 (pencereye 14400 sarkar) ⇒ %98.33, 1, 14400
 *  D4 Silivri (sürümsüz): HİÇ olay yok ⇒ online % NULL (VERİ YOK)
 *  Sağlık skoru (en son): D1 42 (eski 90 yok sayılır), D2 75, D3 20, D4 yok
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const SILIVRI = 'Silivri Tesisleri';
const WIN_QS = 'startDate=2021-12-01&endDate=2021-12-10&pageSize=50';

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
  console.log('📡 [REP-717] CİHAZ SAĞLIK VE KESİNTİ RAPORU TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };
  const n = (v: any) => Number(v);
  const near = (a: any, b: number, eps = 0.01) => a !== null && a !== undefined && Math.abs(n(a) - b) <= eps;

  const owner = await login('camsa');
  const gebzeMgr = await login('gebze-santiye');
  const pumpOp = await login('pompa-op-01');

  const S6 = String(RUN).slice(-6);
  const FW_A = `r717a.${S6}`;
  const FW_B = `r717b.${S6}`;
  const dev = {
    D1: { id: `R717-D1-${RUN}`, site: GEBZE, fw: FW_A as string | null },
    D2: { id: `R717-D2-${RUN}`, site: GEBZE, fw: FW_A as string | null },
    D3: { id: `R717-D3-${RUN}`, site: SILIVRI, fw: FW_B as string | null },
    D4: { id: `R717-D4-${RUN}`, site: SILIVRI, fw: null as string | null },
    D5: { id: `R717-D5-${RUN}`, site: GEBZE, fw: FW_A as string | null }
  };
  const devIds = Object.values(dev).map((d) => d.id);
  const DEV_QS = `deviceId=-${RUN}`;
  const txIds: string[] = [];
  let evSeq = 0;

  async function ev(d: { id: string; site: string }, status: 'ONLINE' | 'OFFLINE', at: string) {
    await q(`INSERT INTO device_presence_events (id, tenant_id, device_id, site_name, status, occurred_at) VALUES ($1,$2,$3,$4,$5,$6)`, [`dpe-r717-${RUN}-${evSeq++}`, TENANT, d.id, d.site, status, at]);
  }
  async function offTx(tag: string, d: { id: string; site: string }, at: string, type = 'Çevrimdışı Senkron') {
    const id = `tx-r717-${RUN}-${tag}`;
    txIds.push(id);
    await q(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, type, device_id, created_at) VALUES ($1,$2,$3,'R717 PLK',10,$4,$5,$6)`, [id, TENANT, d.site, type, d.id, at]);
  }
  async function score(d: { id: string; site: string }, value: number, computedAt: string, tag: string) {
    await q(`INSERT INTO device_health_scores (id, tenant_id, device_id, site_name, period_days, sample_count, score, computed_at) VALUES ($1,$2,$3,$4,30,10,$5,$6)`, [`dhs-r717-${RUN}-${tag}`, TENANT, d.id, d.site, value, computedAt]);
  }
  const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
  const H = 3600 * 1000;

  try {
    for (const d of Object.values(dev)) {
      await q(`INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret, status, firmware_version) VALUES ($1,$2,$3,$4,$5,'x','AKTİF',$6)`, [`hwd-${d.id}`, TENANT, d.id, `Test ${d.id}`, d.site, d.fw]);
    }
    await ev(dev.D1, 'ONLINE', '2021-11-20T00:00:00Z');
    await ev(dev.D1, 'OFFLINE', '2021-12-02T00:00:00Z'); await ev(dev.D1, 'ONLINE', '2021-12-02T06:00:00Z');
    await ev(dev.D1, 'OFFLINE', '2021-12-05T12:00:00Z'); await ev(dev.D1, 'ONLINE', '2021-12-06T12:00:00Z');
    await ev(dev.D1, 'OFFLINE', '2021-12-10T22:00:00Z');
    await ev(dev.D2, 'ONLINE', '2021-12-05T00:00:00Z');
    await ev(dev.D2, 'OFFLINE', '2021-12-07T00:00:00Z'); await ev(dev.D2, 'ONLINE', '2021-12-07T12:00:00Z');
    await ev(dev.D3, 'OFFLINE', '2021-11-30T20:00:00Z'); await ev(dev.D3, 'ONLINE', '2021-12-01T04:00:00Z');
    // D5 (parite): son 30 gün — ONLINE now−40g; OFFLINE now−20g → ONLINE now−19g; OFFLINE now−3sa (sürüyor)
    await ev(dev.D5, 'ONLINE', iso(-40 * 24 * H));
    await ev(dev.D5, 'OFFLINE', iso(-20 * 24 * H)); await ev(dev.D5, 'ONLINE', iso(-19 * 24 * H));
    await ev(dev.D5, 'OFFLINE', iso(-3 * H));
    await offTx('1', dev.D1, '2021-12-03T10:00:00Z'); await offTx('2', dev.D1, '2021-12-06T13:00:00Z'); await offTx('3', dev.D1, '2021-12-06T14:00:00Z');
    await offTx('out', dev.D1, '2021-12-20T10:00:00Z');
    await offTx('oto', dev.D1, '2021-12-04T10:00:00Z', 'Otomatik');
    await offTx('d2', dev.D2, '2021-12-07T13:00:00Z');
    await score(dev.D1, 90, '2021-12-01T00:00:00Z', 'd1old'); await score(dev.D1, 42, '2021-12-08T00:00:00Z', 'd1new');
    await score(dev.D2, 75, '2021-12-08T00:00:00Z', 'd2'); await score(dev.D3, 20, '2021-12-08T00:00:00Z', 'd3');

    const rep = await call('GET', `/reports/rep-717?${WIN_QS}&${DEV_QS}`, owner);
    const r: Record<string, any> = {};
    for (const x of rep.body?.data || []) r[x.device_id.slice(5, 7)] = x;

    // === Test 1 (AC — online oranı ve kesinti hesabı): elle hesaplı ===
    check(
      'Test 1 (AC — online oranı/kesinti): D1 %86.67 (115200 sn, 3 kesinti, en uzun 86400); D2 %91.67 (ilk olaydan itibaren 6 gün gözlem, 43200 sn); D3 %98.33 (pencereye sarkan 14400 sn); D4 olay yok → online NULL (%100 DEĞİL)',
      rep.status === 200 && rep.body.data.length === 5 &&
        near(r.D1?.online_ratio_pct, 86.67) && n(r.D1.offline_seconds) === 115200 && r.D1.outage_count === 3 && n(r.D1.longest_outage_seconds) === 86400 &&
        near(r.D2?.online_ratio_pct, 91.67) && n(r.D2.offline_seconds) === 43200 && n(r.D2.observed_seconds) === 518400 && r.D2.outage_count === 1 &&
        near(r.D3?.online_ratio_pct, 98.33) && n(r.D3.offline_seconds) === 14400 && r.D3.outage_count === 1 && n(r.D3.longest_outage_seconds) === 14400 &&
        r.D4?.online_ratio_pct === null && r.D4.offline_seconds === null && r.D4.outage_count === null,
      `D1=${r.D1?.online_ratio_pct}/${r.D1?.offline_seconds}/${r.D1?.outage_count}/${r.D1?.longest_outage_seconds}, D2=${r.D2?.online_ratio_pct}/${r.D2?.observed_seconds}, D3=${r.D3?.online_ratio_pct}/${r.D3?.offline_seconds}, D4=${r.D4?.online_ratio_pct}`
    );

    // === Test 2 (PARİTE — IOT-308 SLA): varsayılan 30 günlük pencerede D5 için rapor = getDeviceOnlineSla ===
    const def = await call('GET', `/reports/rep-717?deviceId=${dev.D5.id}`, owner);
    const d5 = def.body?.data?.[0];
    const sla = await runWithTenant({ tenantId: TENANT }, () => getDeviceOnlineSla(dev.D5.id, 1));
    check(
      'Test 2 (PARİTE): pencere verilmeyince (son 30 gün) D5 online % ve toplam kesinti IOT-308 getDeviceOnlineSla ile AYNI (elle: 86400+10800 sn → %96.25)',
      !!d5 && sla.onlineRatioPct !== null && Math.abs(n(d5.online_ratio_pct) - n(sla.onlineRatioPct)) <= 0.01 && Math.abs(n(d5.offline_seconds) - sla.offlineSeconds) <= 10 && near(d5.online_ratio_pct, 96.25, 0.05),
      `rapor=${d5?.online_ratio_pct}/${d5?.offline_seconds}, sla=${sla.onlineRatioPct}/${sla.offlineSeconds}`
    );

    // === Test 3 (AC — kesinti dökümü): başlangıç-bitiş-süre; süren kesinti; tarih filtresi başlangıca göre ===
    const out = await call('GET', `/reports/rep-717-kesinti?${DEV_QS}&pageSize=50`, owner);
    const outWin = await call('GET', `/reports/rep-717-kesinti?${WIN_QS}&${DEV_QS}`, owner);
    const d1Out = (out.body?.data || []).filter((x: any) => x.device_id === dev.D1.id).sort((a: any, b: any) => a.outage_start.localeCompare(b.outage_start));
    const csvOut = await call('GET', `/reports/rep-717-kesinti/export?format=csv&${DEV_QS}`, owner);
    const csvD1 = csvOut.raw.split('\r\n').filter((l) => l.includes(dev.D1.id));
    check(
      'Test 3 (AC — kesinti dökümü): 7 kesinti (D1×3, D2, D3, D5×2); D1 süreleri 21600/86400 sn ve SÜREN kesinti (bitiş NULL, süre>0); tarih filtresi başlangıca göre → D3 (11-30 başlangıçlı) DIŞARIDA (4 satır); CSV "6sa 0dk"/"1g 0sa 0dk"/"DEVAM EDİYOR"',
      out.body?.data?.length === 7 && d1Out.length === 3 && n(d1Out[0].duration_seconds) === 21600 && d1Out[0].outage_end !== null && n(d1Out[1].duration_seconds) === 86400 && d1Out[2].outage_end === null && n(d1Out[2].duration_seconds) > 0 &&
        outWin.body?.data?.length === 4 && !(outWin.body?.data || []).some((x: any) => x.device_id === dev.D3.id) &&
        csvD1.some((l) => l.includes('6sa 0dk')) && csvD1.some((l) => l.includes('1g 0sa 0dk')) && csvD1.some((l) => l.includes('DEVAM EDİYOR')),
      `all=${out.body?.data?.length}, d1=${d1Out.length}, win=${outWin.body?.data?.length}, ongoingEnd=${d1Out[2]?.outage_end}`
    );

    // === Test 4 (Teknik Not — offline biriken kayıt): D1=3 (pencere dışı ve offline-olmayan sayılmaz), D2=1; eşik filtresi ===
    const minRec = await call('GET', `/reports/rep-717?${WIN_QS}&${DEV_QS}&minOfflineRecords=2`, owner);
    check(
      "Test 4 (Teknik Not — offline biriken kayıt): D1 = 3 (pencere dışı 12-20 ve type='Otomatik' SAYILMAZ), D2 = 1, D3 = 0; minOfflineRecords=2 → yalnız D1; toplam 4",
      n(r.D1?.offline_records) === 3 && n(r.D2?.offline_records) === 1 && n(r.D3?.offline_records) === 0 && minRec.body?.data?.length === 1 && minRec.body.data[0].device_id === dev.D1.id && n(rep.body?.aggregates?.total_offline_records) === 4,
      `D1=${r.D1?.offline_records}, D2=${r.D2?.offline_records}, minRec=${minRec.body?.data?.length}, total=${rep.body?.aggregates?.total_offline_records}`
    );

    // === Test 5 (AC — sağlık skoruna göre sıralama + öncelik): EN SON skor (D1 42, eski 90 değil); skor artan sıra D3,D1,D2; öncelik KRİTİK/DÜŞÜK ===
    const sorted = await call('GET', `/reports/rep-717?${WIN_QS}&${DEV_QS}&sortBy=health_score&sortDir=asc`, owner);
    const order = (sorted.body?.data || []).filter((x: any) => x.health_score !== null).map((x: any) => x.device_id.slice(5, 7));
    const low = await call('GET', `/reports/rep-717?${WIN_QS}&${DEV_QS}&maxHealthScore=50`, owner);
    const lowSet = new Set((low.body?.data || []).map((x: any) => x.device_id.slice(5, 7)));
    check(
      'Test 5 (AC — sağlık skoru sıralama/öncelik): en son skorlar D1=42, D2=75, D3=20; sortBy=health_score asc → D3,D1,D2; öncelik D3 KRİTİK, D1 DÜŞÜK, D2 boş; maxHealthScore=50 → yalnız D3+D1',
      n(r.D1?.health_score) === 42 && n(r.D2?.health_score) === 75 && n(r.D3?.health_score) === 20 && r.D4?.health_score === null &&
        order.join(',') === 'D3,D1,D2' && r.D3?.priority === 'KRİTİK' && r.D1?.priority === 'DÜŞÜK' && r.D2?.priority === null &&
        lowSet.size === 2 && lowSet.has('D3') && lowSet.has('D1'),
      `scores=${['D1', 'D2', 'D3', 'D4'].map((k) => r[k]?.health_score).join('/')}, order=${order.join(',')}, prio=${r.D3?.priority}/${r.D1?.priority}/${r.D2?.priority}, low=${[...lowSet].join(',')}`
    );

    // === Test 6 (AC — firmware sürüm dağılımı) ===
    const fwA = await call('GET', `/reports/rep-717-firmware?firmwareVersion=${FW_A}`, owner);
    const fwB = await call('GET', `/reports/rep-717-firmware?firmwareVersion=${FW_B}`, owner);
    const fwUnknown = await call('GET', `/reports/rep-717-firmware?firmwareVersion=Bilinmiyor`, owner);
    const fwAll = await call('GET', '/reports/rep-717-firmware?pageSize=100', owner);
    const gebzeA = (fwA.body?.data || []).find((x: any) => x.site_name === GEBZE);
    check(
      "Test 6 (AC — firmware dağılımı): fwA Gebze'de 3 cihaz (D1,D2,D5; skoru olan 2, ort. (42+75)/2=58.50, en düşük 42); fwB Silivri'de 1 cihaz (ort. 20); sürümsüz D4 'Bilinmiyor' grubunda; toplam cihaz = tüm gruplar toplamı",
      gebzeA?.device_count === 3 && gebzeA.scored_count === 2 && near(gebzeA.avg_health_score, 58.5) && n(gebzeA.min_health_score) === 42 &&
        fwB.body?.data?.length === 1 && fwB.body.data[0].site_name === SILIVRI && fwB.body.data[0].device_count === 1 && near(fwB.body.data[0].avg_health_score, 20) &&
        (fwUnknown.body?.data || []).some((x: any) => x.site_name === SILIVRI && x.device_count >= 1) &&
        n(fwAll.body?.aggregates?.total_devices) === (fwAll.body?.data || []).reduce((s: number, x: any) => s + x.device_count, 0),
      `fwA=${gebzeA?.device_count}/${gebzeA?.scored_count}/${gebzeA?.avg_health_score}/${gebzeA?.min_health_score}, fwB=${fwB.body?.data?.[0]?.device_count}, unknownGroups=${fwUnknown.body?.data?.length}`
    );

    // === Test 7 (AC — rol bazlı görünürlük) ===
    const gRep = await call('GET', `/reports/rep-717?${WIN_QS}&${DEV_QS}`, gebzeMgr);
    const gOut = await call('GET', `/reports/rep-717-kesinti?${DEV_QS}&pageSize=50`, gebzeMgr);
    const gFw = await call('GET', `/reports/rep-717-firmware?firmwareVersion=${FW_B}`, gebzeMgr);
    const pump = await call('GET', `/reports/rep-717?${WIN_QS}`, pumpOp);
    const catO = await call('GET', '/reports', owner);
    const catP = await call('GET', '/reports', pumpOp);
    const catIds = (c: any) => new Set((c.body?.data || []).map((x: any) => x.id));
    check(
      'Test 7 (AC — rol bazlı görünürlük): Gebze SITE_MANAGER yalnız Gebze cihazları (özet 3: D1,D2,D5; kesinti 6: D1×3+D2+D5×2; Silivri fwB grubu YOK); PUMP_OPERATOR 403 ve katalogda üç rapor YOK; COMPANY_OWNER katalogda ÜÇÜ DE VAR',
      gRep.body?.data?.length === 3 && gRep.body.data.every((x: any) => x.site_name === GEBZE) && gOut.body?.data?.length === 6 && gOut.body.data.every((x: any) => x.site_name === GEBZE) && gFw.body?.data?.length === 0 &&
        pump.status === 403 && ['rep-717', 'rep-717-kesinti', 'rep-717-firmware'].every((id) => catIds(catO).has(id) && !catIds(catP).has(id)),
      `gebze=${gRep.body?.data?.length}/${gOut.body?.data?.length}/${gFw.body?.data?.length}, pump=${pump.status}`
    );

    // === Test 8 (AC — CSV/PDF tutarlılığı) ===
    const csv = await call('GET', `/reports/rep-717/export?format=csv&${WIN_QS}&${DEV_QS}`, owner);
    const line = (id: string) => (csv.raw.split('\r\n').find((l) => l.includes(`,${id},`)) || '').split(',');
    const c1 = line(dev.D1.id);
    const c4 = line(dev.D4.id);
    const rows = (c: { raw: string }, needle: string) => c.raw.split('\r\n').filter((l) => l.includes(needle)).length;
    const pdfs = await Promise.all(
      [`rep-717?${WIN_QS}&${DEV_QS}`, `rep-717-kesinti?${DEV_QS}`, 'rep-717-firmware?'].map(async (p) => {
        const [id, qs] = p.split('?');
        const res = await fetch(`${API_URL}/reports/${id}/export?format=pdf&${qs}`, { headers: { Authorization: `Bearer ${owner}` } });
        return { status: res.status, magic: Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString('latin1') };
      })
    );
    check(
      "Test 8 (AC — CSV/PDF tutarlılığı): CSV satır sayısı JSON'la AYNI (5); D1 satırı 86.67 / gözlenen '10g 0sa 0dk' / '1g 8sa 0dk' (115200 sn) / 3 kesinti / '1g 0sa 0dk' (en uzun) / 3 kayıt / 42 / DÜŞÜK; D4 satırı 'VERİ YOK' ve 'Bilinmiyor'; üç rapor için PDF 200 + %PDF-",
      rows(csv, `R717-D`) === rep.body?.pagination?.totalCount && rows(csv, 'R717-D') === 5 &&
        c1[5] === '86.67' && c1[6] === '10g 0sa 0dk' && c1[7] === '1g 8sa 0dk' && c1[8] === '3' && c1[9] === '1g 0sa 0dk' && c1[10] === '3' && c1[11] === '42' && c1[12] === 'DÜŞÜK' &&
        c4[4] === 'Bilinmiyor' && c4[5] === 'VERİ YOK' && pdfs.every((p) => p.status === 200 && p.magic === '%PDF-'),
      `csv=${rows(csv, 'R717-D')}/${rep.body?.pagination?.totalCount}, D1=[${c1.slice(4, 13).join('|')}], D4=[${c4.slice(4, 6).join('|')}], pdf=${pdfs.map((p) => p.status).join('/')}`
    );
  } finally {
    await q('DELETE FROM device_health_scores WHERE device_id = ANY($1)', [devIds]);
    await q('DELETE FROM device_presence_events WHERE device_id = ANY($1)', [devIds]);
    await q('DELETE FROM transactions WHERE id = ANY($1)', [txIds]);
    await q('DELETE FROM hardware_devices WHERE device_id = ANY($1)', [devIds]);
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
