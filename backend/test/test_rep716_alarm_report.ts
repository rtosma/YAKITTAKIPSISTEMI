import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { raiseAlarmForCurrentTenant } from '../src/db/tenantDb';
import { runWithTenant } from '../src/context/tenantContext';

/**
 * REP-716 (#173) — Anomali ve Alarm Raporu.
 *
 * Alarm satırları SQL ile kontrollü zaman damgalarıyla kurulur (2021-11 penceresi),
 * beklenen metrikler ELLE hesaplanmıştır; tekrar gruplaması GERÇEK raiseAlarm ile
 * (aynı alarm_key iki kez → tek satır, event_count 2) doğrulanır.
 *
 *  A1 STOCK_RECONCILIATION Gebze  RESOLVED        4.00 sa  tekrar 3  atanan gebze-santiye
 *  A2 CONSUMPTION_ANOMALY  Gebze  FALSE_POSITIVE  1.00 sa  tekrar 1
 *  A3 CONSUMPTION_ANOMALY  Gebze  RESOLVED       12.00 sa  tekrar 5
 *  A4 DEVICE_HEALTH_SCORE_LOW Silivri OPEN                 tekrar 2
 *  A5 OTHER Gebze ACKNOWLEDGED tekrar 1;  A7 OTHER (şantiyesiz) OPEN tekrar 1
 *  Kapalı=3 → yanlış pozitif oranı 1/3 = %33.33, ortalama çözüm (4+1+12)/3 = 5.6667 sa
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const SILIVRI = 'Silivri Tesisleri';
const NOV_QS = 'startDate=2021-11-01&endDate=2021-11-30&pageSize=50';

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
  console.log('🚨 [REP-716] ANOMALİ VE ALARM RAPORU TESTİ');
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
  const gebzeMgrId = (await q(`SELECT id FROM users WHERE username = 'gebze-santiye'`))[0].id;

  const ids: Record<string, string> = {};
  const alarmIds: string[] = [];
  async function alarm(tag: string, o: { category: string; severity: string; site: string | null; subjectType?: string; status: string; assignee?: string; events: number; first: string; last: string; resolved?: string }) {
    const id = `alarm-r716-${RUN}-${tag}`;
    ids[tag] = id;
    alarmIds.push(id);
    await q(
      `INSERT INTO alarms (id, tenant_id, alarm_key, category, severity, title, site_name, subject_type, subject_id, status, assignee_id, event_count, first_seen_at, last_seen_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, TENANT, `R716:${tag}:${RUN}`, o.category, o.severity, `R716-${tag}-${RUN}`, o.site, o.subjectType ?? 'TANK', `subj-${tag}-${RUN}`, o.status, o.assignee ?? null, o.events, o.first, o.last, o.resolved ?? null]
    );
  }

  try {
    await alarm('A1', { category: 'STOCK_RECONCILIATION', severity: 'CRITICAL', site: GEBZE, status: 'RESOLVED', assignee: gebzeMgrId, events: 3, first: '2021-11-01T10:00:00Z', last: '2021-11-01T13:00:00Z', resolved: '2021-11-01T14:00:00Z' });
    await alarm('A2', { category: 'CONSUMPTION_ANOMALY', severity: 'WARNING', site: GEBZE, subjectType: 'VEHICLE', status: 'FALSE_POSITIVE', events: 1, first: '2021-11-02T08:00:00Z', last: '2021-11-02T08:00:00Z', resolved: '2021-11-02T09:00:00Z' });
    await alarm('A3', { category: 'CONSUMPTION_ANOMALY', severity: 'WARNING', site: GEBZE, subjectType: 'VEHICLE', status: 'RESOLVED', events: 5, first: '2021-11-03T08:00:00Z', last: '2021-11-03T18:00:00Z', resolved: '2021-11-03T20:00:00Z' });
    await alarm('A4', { category: 'DEVICE_HEALTH_SCORE_LOW', severity: 'CRITICAL', site: SILIVRI, subjectType: 'DEVICE', status: 'OPEN', events: 2, first: '2021-11-04T08:00:00Z', last: '2021-11-04T09:00:00Z' });
    await alarm('A5', { category: 'OTHER', severity: 'INFO', site: GEBZE, status: 'ACKNOWLEDGED', events: 1, first: '2021-11-05T08:00:00Z', last: '2021-11-05T08:00:00Z' });
    await alarm('A7', { category: 'OTHER', severity: 'WARNING', site: null, status: 'OPEN', events: 1, first: '2021-11-06T08:00:00Z', last: '2021-11-06T08:00:00Z' });

    const det = await call('GET', `/reports/rep-716?${NOV_QS}`, owner);
    const row = (tag: string) => (det.body?.data || []).find((r: any) => r.id === ids[tag]);

    // === Test 1 (AC — tüm alarmlar durum bilgisiyle): 6 alarm, her durum görünür; atanan kullanıcı adı, konu, tekrar ===
    const statuses = new Set((det.body?.data || []).map((r: any) => r.status));
    check(
      'Test 1 (AC — tüm anomaliler durumla): 6 alarm; RESOLVED/FALSE_POSITIVE/OPEN/ACKNOWLEDGED hepsi görünür; A1 atanan gebze-santiye, konu "TANK: subj-A1-...", tekrar 3',
      det.status === 200 && det.body.data.length === 6 && ['RESOLVED', 'FALSE_POSITIVE', 'OPEN', 'ACKNOWLEDGED'].every((s) => statuses.has(s)) &&
        row('A1')?.assignee === 'gebze-santiye' && row('A1')?.subject === `TANK: subj-A1-${RUN}` && row('A1')?.event_count === 3 && row('A4')?.assignee === null,
      `count=${det.body?.data?.length}, statuses=${[...statuses].join(',')}, A1=${row('A1')?.assignee}/${row('A1')?.subject}/${row('A1')?.event_count}`
    );

    // === Test 2 (AC — özet metrikler): çözüm süreleri 4/1/12 sa; FP oranı %33.33; ortalama 5.6667 sa; açık alarm süresi NULL; closed_count paydayı verir ===
    const ag = det.body?.aggregates || {};
    check(
      'Test 2 (AC — özet metrikler): çözüm süreleri A1=4.00, A2=1.00, A3=12.00 sa, açıklar NULL; yanlış pozitif oranı %33.33 (1/3), ortalama çözüm 5.67 sa, kapatılmış 3, toplam alarm 6, toplam olay 13',
      near(row('A1')?.resolution_hours, 4) && near(row('A2')?.resolution_hours, 1) && near(row('A3')?.resolution_hours, 12) && row('A4')?.resolution_hours === null &&
        near(ag.false_positive_rate_pct, 33.33) && near(ag.avg_resolution_hours, 5.6667) && n(ag.closed_count) === 3 && n(ag.total_alarms) === 6 && n(ag.total_events) === 13,
      `fp=${ag.false_positive_rate_pct}, avg=${ag.avg_resolution_hours}, closed=${ag.closed_count}, alarms=${ag.total_alarms}, events=${ag.total_events}`
    );

    // === Test 3 (AC — filtreler + özetin filtreyle yeniden hesaplanması): Gebze özeti; Silivri'de kapatılmış YOK (closed_count=0 → oran "bilinmiyor") ===
    const gebze = await call('GET', `/reports/rep-716?${NOV_QS}&siteName=${encodeURIComponent(GEBZE)}`, owner);
    const silivri = await call('GET', `/reports/rep-716?${NOV_QS}&siteName=${encodeURIComponent(SILIVRI)}`, owner);
    const crit = await call('GET', `/reports/rep-716?${NOV_QS}&severity=CRITICAL`, owner);
    const openOnly = await call('GET', `/reports/rep-716?${NOV_QS}&status=OPEN`, owner);
    const byCat = await call('GET', `/reports/rep-716?${NOV_QS}&category=CONSUMPTION_ANOMALY`, owner);
    const byAssignee = await call('GET', `/reports/rep-716?${NOV_QS}&assignee=gebze-santiye`, owner);
    check(
      'Test 3 (Kapsam — filtreler): siteName=Gebze → 4 alarm/10 olay/3 kapalı; Silivri → 1 alarm, closed_count=0; severity=CRITICAL → 2; status=OPEN → 2; category=CONSUMPTION_ANOMALY → 2 (oran %50); assignee=gebze-santiye → 1',
      gebze.body?.data?.length === 4 && n(gebze.body.aggregates.total_events) === 10 && n(gebze.body.aggregates.closed_count) === 3 &&
        silivri.body?.data?.length === 1 && n(silivri.body.aggregates.closed_count) === 0 && crit.body?.data?.length === 2 && openOnly.body?.data?.length === 2 &&
        byCat.body?.data?.length === 2 && near(byCat.body.aggregates.false_positive_rate_pct, 50) && byAssignee.body?.data?.length === 1,
      `gebze=${gebze.body?.data?.length}/${gebze.body?.aggregates?.total_events}, silivri=${silivri.body?.data?.length}/${silivri.body?.aggregates?.closed_count}, crit=${crit.body?.data?.length}, open=${openOnly.body?.data?.length}, cat=${byCat.body?.data?.length}/${byCat.body?.aggregates?.false_positive_rate_pct}`
    );

    // === Test 4 (AC — tekrar eden olaylar gruplu): GERÇEK raiseAlarm iki kez → TEK satır, event_count=2; CSV'de çözüm süresi 'AÇIK' ===
    const marker = `r716-group-${RUN}`;
    for (let i = 0; i < 2; i++) {
      const r = await runWithTenant({ tenantId: TENANT }, () =>
        raiseAlarmForCurrentTenant({ alarmKey: `R716:GROUP:${RUN}`, category: 'OTHER', severity: 'WARNING', title: `R716-GROUP-${RUN}`, siteName: GEBZE, subjectType: 'TANK', subjectId: marker })
      );
      if (i === 0) alarmIds.push(r.alarmId);
    }
    const grouped = await call('GET', `/reports/rep-716?subjectId=${marker}`, owner);
    const csvGrouped = await call('GET', `/reports/rep-716/export?format=csv&subjectId=${marker}`, owner);
    const gCells = (csvGrouped.raw.split('\r\n').find((l) => l.includes(`R716-GROUP-${RUN}`)) || '').split(',');
    check(
      "Test 4 (AC — tekrar gruplaması): aynı kök neden iki kez raise edildi → rapor TEK satır gösterir, tekrar (event_count)=2, durum OPEN; CSV'de çözüm süresi hücresi 'AÇIK' (boş değil), tekrar hücresi 2",
      grouped.body?.data?.length === 1 && grouped.body.data[0].event_count === 2 && grouped.body.data[0].status === 'OPEN' && gCells[9] === 'AÇIK' && gCells[10] === '2',
      `rows=${grouped.body?.data?.length}, events=${grouped.body?.data?.[0]?.event_count}, resCell=${gCells[9]}, tekrarCell=${gCells[10]}`
    );

    // === Test 5 (Kapsam — en sık tekrar eden tipler): şantiye × tip kırılımı toplam tekrara göre AZALAN; hesaplar elle ===
    const types = await call('GET', `/reports/rep-716-tip?${NOV_QS}`, owner);
    const t = (site: string | null, cat: string) => (types.body?.data || []).find((r: any) => r.site_name === site && r.category === cat);
    const cons = t(GEBZE, 'CONSUMPTION_ANOMALY');
    const events = (types.body?.data || []).map((r: any) => n(r.total_events));
    const sortedDesc = events.every((v: number, i: number) => i === 0 || events[i - 1] >= v);
    check(
      'Test 5 (Kapsam — en sık tekrar eden tipler): 5 grup, toplam tekrara göre azalan (ilk 3: CONSUMPTION 6, STOCK 3, DEVICE 2); Gebze/CONSUMPTION: 2 alarm, kapalı 2, YP 1, oran %50, ort. çözüm 6.50 sa; Silivri/DEVICE: açık 1, oran/ortalama NULL',
      types.body?.data?.length === 5 && sortedDesc && events[0] === 6 && events[1] === 3 && events[2] === 2 &&
        cons?.alarm_count === 2 && n(cons.total_events) === 6 && cons.closed_count === 2 && cons.false_positive_count === 1 && near(cons.false_positive_rate_pct, 50) && near(cons.avg_resolution_hours, 6.5) &&
        t(SILIVRI, 'DEVICE_HEALTH_SCORE_LOW')?.open_count === 1 && t(SILIVRI, 'DEVICE_HEALTH_SCORE_LOW')?.false_positive_rate_pct === null && t(null, 'OTHER')?.alarm_count === 1,
      `groups=${types.body?.data?.length}, events=[${events.join(',')}], cons=${cons?.alarm_count}/${cons?.total_events}/${cons?.false_positive_rate_pct}/${cons?.avg_resolution_hours}`
    );

    // === Test 6 (AC — gruplamadan ÖNCE tarih filtresi): endDate=2021-11-02 → CONSUMPTION yalnız A2 (1 alarm/1 tekrar/oran %100/1.00 sa); A3 kırılım toplamına GİRMEZ ===
    const narrow = await call('GET', `/reports/rep-716-tip?startDate=2021-11-01&endDate=2021-11-02&pageSize=50`, owner);
    const consN = (narrow.body?.data || []).find((r: any) => r.category === 'CONSUMPTION_ANOMALY');
    check(
      'Test 6 (beforeAggregation): tarih aralığı gruplamadan ÖNCE uygulanır — 11-01..11-02 aralığında Gebze/CONSUMPTION yalnız A2 (1 alarm, 1 tekrar, %100, 1.00 sa), STOCK (A1) dahil, A3 hariç; 2 grup; toplam tekrar 4',
      narrow.body?.data?.length === 2 && consN?.alarm_count === 1 && n(consN.total_events) === 1 && near(consN.false_positive_rate_pct, 100) && near(consN.avg_resolution_hours, 1) && n(narrow.body?.aggregates?.total_events) === 4,
      `groups=${narrow.body?.data?.length}, cons=${consN?.alarm_count}/${consN?.total_events}/${consN?.false_positive_rate_pct}, totalEvents=${narrow.body?.aggregates?.total_events}`
    );

    // === Test 7 (AC — rol bazlı görünürlük): Gebze yöneticisi yalnız Gebze alarmları (4; Silivri ve şantiyesiz YOK), kırılımda 3 grup; PUMP_OPERATOR 403 ===
    const gDet = await call('GET', `/reports/rep-716?${NOV_QS}`, gebzeMgr);
    const gTypes = await call('GET', `/reports/rep-716-tip?${NOV_QS}`, gebzeMgr);
    const pump = await call('GET', `/reports/rep-716?${NOV_QS}`, pumpOp);
    const catO = await call('GET', '/reports', owner);
    const catP = await call('GET', '/reports', pumpOp);
    const catIds = (c: any) => new Set((c.body?.data || []).map((r: any) => r.id));
    check(
      'Test 7 (AC — rol bazlı görünürlük): Gebze SITE_MANAGER 4 alarm (yalnız Gebze) + 3 tip grubu, Silivri/şantiyesiz alarm YOK; PUMP_OPERATOR 403 ve katalogda YOK; COMPANY_OWNER katalogda İKİSİ VAR',
      gDet.body?.data?.length === 4 && gDet.body.data.every((r: any) => r.site_name === GEBZE) && gTypes.body?.data?.length === 3 && gTypes.body.data.every((r: any) => r.site_name === GEBZE) &&
        pump.status === 403 && !catIds(catP).has('rep-716') && !catIds(catP).has('rep-716-tip') && catIds(catO).has('rep-716') && catIds(catO).has('rep-716-tip'),
      `gebze=${gDet.body?.data?.length}/${gTypes.body?.data?.length}, pump=${pump.status}`
    );

    // === Test 8 (AC — CSV/PDF tutarlılığı) ===
    const csv = await call('GET', `/reports/rep-716/export?format=csv&${NOV_QS}`, owner);
    const csvTypes = await call('GET', `/reports/rep-716-tip/export?format=csv&${NOV_QS}`, owner);
    const line = (tag: string) => (csv.raw.split('\r\n').find((l) => l.includes(`R716-${tag}-${RUN}`)) || '').split(',');
    const a1 = line('A1');
    const a4 = line('A4');
    const rows = (c: { raw: string }, needle: string) => c.raw.split('\r\n').filter((l) => l.includes(needle)).length;
    const pdf1 = await fetch(`${API_URL}/reports/rep-716/export?format=pdf&${NOV_QS}`, { headers: { Authorization: `Bearer ${owner}` } });
    const buf1 = Buffer.from(await pdf1.arrayBuffer());
    const pdf2 = await fetch(`${API_URL}/reports/rep-716-tip/export?format=pdf&${NOV_QS}`, { headers: { Authorization: `Bearer ${owner}` } });
    check(
      "Test 8 (AC — CSV/PDF tutarlılığı): CSV veri satır sayısı JSON totalCount'a eşit (6 / 5); A1 satırı gebze-santiye/4.00/3, A4 satırı -/AÇIK/2; iki rapor için PDF 200 + %PDF-",
      rows(csv, 'R716-') === det.body?.pagination?.totalCount && rows(csv, 'R716-') === 6 &&
        rows(csvTypes, ':') === types.body?.pagination?.totalCount && rows(csvTypes, ':') === 5 &&
        a1[8] === 'gebze-santiye' && a1[9] === '4.00' && a1[10] === '3' && a4[8] === '-' && a4[9] === 'AÇIK' && a4[10] === '2' &&
        pdf1.status === 200 && buf1.subarray(0, 5).toString('latin1') === '%PDF-' && pdf2.status === 200,
      `csv=${rows(csv, 'R716-')}/${det.body?.pagination?.totalCount}, csvTypes=${rows(csvTypes, ':')}/${types.body?.pagination?.totalCount}, A1=[${a1.slice(8, 11).join('|')}], A4=[${a4.slice(8, 11).join('|')}], pdf=${pdf1.status}/${pdf2.status}`
    );
  } finally {
    await q('DELETE FROM alarm_events WHERE alarm_id = ANY($1)', [alarmIds]);
    await q('DELETE FROM alarms WHERE id = ANY($1)', [alarmIds]);
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
