import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * REP-722 (#179) — Denetim (Audit) Raporu.
 *
 * İki tür veri: (1) GERÇEK kritik işlemler API'den yapılır (kalibrasyon isteği, araç yakıt limiti,
 * manuel ikmal talebi, RFID kart blokajı) ve raporda görünmeleri doğrulanır; (2) sütun/özet/kapsam
 * uç durumları için SQL ile kontrollü audit satırları (target_id = `r722-<RUN>` etiketi, 2020 tarihli):
 *  S1 R722_UPDATE   gebze-santiye  ip 10.0.0.7  trace-r722-a  {limit:100,mode:A,same:1} → {limit:150,mode:A,same:1,extra:true}
 *                   → özet "extra: ∅ → true; limit: 100 → 150" (yalnız değişenler, anahtar sıralı)
 *  S2 R722_SYSTEM   user_id NULL, before/after NULL   S3 R722_DELETED_USER  user_id silinmiş kullanıcı
 *  S4 R722_ARRAY    after_value dizi                  S5..S9 beş kritik-önekli işlem   S10 CALIBRATIONX (kritik DEĞİL)
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const TAG = `r722-${RUN}`;
const CARD = `R722CARD${RUN}`.slice(0, 32);
const DEVICE = 'ESP32-PUMP-01';
const TEST_START = new Date();
const TODAY = TEST_START.toISOString().slice(0, 10);

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
  console.log('🧾 [REP-722] DENETİM (AUDIT) RAPORU TESTİ');
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
  const pumpOp = await login('pompa-op-01');
  const ownerId = (await q(`SELECT id FROM users WHERE username = 'camsa'`))[0].id;
  const gebzeMgrId = (await q(`SELECT id FROM users WHERE username = 'gebze-santiye'`))[0].id;
  const TAG_QS = `targetId=${TAG}&startDate=2020-06-01&endDate=2020-06-30&pageSize=50`;

  const origK = (await q(`SELECT k_factor FROM hardware_devices WHERE device_id = $1`, [DEVICE]))[0]?.k_factor;
  const createdCalibrationIds: string[] = [];
  let manualId: string | undefined;

  async function synth(tag: string, o: { action: string; user?: string | null; ip?: string; trace?: string; before?: any; after?: any; at: string }) {
    await q(
      `INSERT INTO audit_logs (id, tenant_id, user_id, trace_id, ip_address, action, target_type, target_id, before_value, after_value, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'r722_target',$7,$8::jsonb,$9::jsonb,$10)`,
      [`audit-r722-${RUN}-${tag}`, TENANT, o.user ?? null, o.trace ?? null, o.ip ?? null, o.action, TAG,
        o.before === undefined ? null : JSON.stringify(o.before), o.after === undefined ? null : JSON.stringify(o.after), o.at]
    );
  }
  const rep = (qs: string, token = owner) => call('GET', `/reports/rep-722?${qs}`, token);
  const auditRowsSince = (action: string) =>
    q(`SELECT * FROM audit_logs WHERE tenant_id = $1 AND action = $2 AND target_id = 'rep-722' AND created_at >= $3 ORDER BY created_at`, [TENANT, action, TEST_START]);

  try {
    // ── (2) SQL ile kontrollü satırlar ──
    await synth('s1', { action: 'R722_UPDATE', user: gebzeMgrId, ip: '10.0.0.7', trace: 'trace-r722-a', before: { limit: 100, mode: 'A', same: 1 }, after: { limit: 150, mode: 'A', same: 1, extra: true }, at: '2020-06-01T10:00:00Z' });
    await synth('s2', { action: 'R722_SYSTEM', at: '2020-06-02T10:00:00Z' });
    await synth('s3', { action: 'R722_DELETED_USER', user: `usr-yok-${RUN}`, ip: '10.0.0.9', at: '2020-06-03T10:00:00Z' });
    await synth('s4', { action: 'R722_ARRAY', user: ownerId, after: [1, 2, 3], at: '2020-06-04T10:00:00Z' });
    await synth('s5', { action: 'CALIBRATION_R722', user: ownerId, at: '2020-06-05T10:00:00Z' });
    await synth('s6', { action: 'VEHICLE_FUEL_LIMIT_R722', user: ownerId, at: '2020-06-06T10:00:00Z' });
    await synth('s7', { action: 'FUEL_QUOTA_R722', user: ownerId, at: '2020-06-07T10:00:00Z' });
    await synth('s8', { action: 'MANUAL_DISPENSE_R722', user: ownerId, at: '2020-06-08T10:00:00Z' });
    await synth('s9', { action: 'RFID_CARD_R722', user: ownerId, at: '2020-06-09T10:00:00Z' });
    await synth('s10', { action: 'CALIBRATIONX_R722', user: ownerId, at: '2020-06-10T10:00:00Z' });
    const S = (t: string, body: any) => (body?.data || []).find((r: any) => r.id === `audit-r722-${RUN}-${t}`);

    // === Test 1 (AC1 — tüm kritik işlemler raporda): dört kritik işlem GERÇEKTEN yapılır; her biri kullanıcı/rol/IP/trace ve doğru kategoriyle listelenir ===
    await q(`UPDATE hardware_devices SET k_factor = 450.0000 WHERE device_id = $1`, [DEVICE]);
    const stamp = new Date();
    const cal = await call('POST', `/devices/${DEVICE}/calibration`, owner, { newKFactor: 459, reason: 'REP-722 testi — küçük sapma düzeltmesi' });
    if (cal.body?.data?.id) createdCalibrationIds.push(cal.body.data.id);
    const lim = await call('PUT', '/vehicles/veh-1/fuel-limit', owner, { periodType: 'DAILY', limitLiters: 100, enforcement: 'WARN' });
    const man = await call('POST', '/manual-dispense-requests', owner, { tankId: 'tank-orman-1', vehiclePlate: `R722-${RUN}`.slice(0, 20), driverName: 'REP722 Test', liters: 10, dispensedAt: new Date(Date.now() - 3600_000).toISOString(), reason: 'REP-722 testi — cihaz arızası, elle pompalandı' });
    manualId = man.body?.data?.id;
    const blk = await call('POST', `/rfid-cards/${CARD}/block`, owner, { status: 'LOST', reason: 'REP-722 testi kayıp kart' });
    const dbRows = await q(
      `SELECT id, action, target_id, trace_id, ip_address FROM audit_logs WHERE tenant_id = $1 AND user_id = $2 AND created_at >= $3 AND action IN ('CALIBRATION_REQUESTED','VEHICLE_FUEL_LIMIT_SET','MANUAL_DISPENSE_REQUESTED','RFID_CARD_BLOCKED')`,
      [TENANT, ownerId, stamp]
    );
    const crit = await rep(`criticalOnly=1&startDate=${TODAY}&pageSize=100`);
    const wantCat: Record<string, string> = { CALIBRATION_REQUESTED: 'KALIBRASYON', VEHICLE_FUEL_LIMIT_SET: 'LIMIT', MANUAL_DISPENSE_REQUESTED: 'MANUEL_IKMAL', RFID_CARD_BLOCKED: 'KART_BLOKAJI' };
    const shown = dbRows.map((d: any) => (crit.body?.data || []).find((r: any) => r.id === d.id));
    check(
      'Test 1 (AC — kritik işlemler raporda): gerçek kalibrasyon isteği, araç limiti, manuel ikmal talebi, kart blokajı → 4 audit satırı; her biri criticalOnly raporunda doğru kategori, kullanıcı "camsa", rol COMPANY_OWNER ve trace_id ile listelenir',
      cal.status === 200 && lim.status === 200 && man.status === 201 && blk.status === 201 && dbRows.length === 4 &&
        shown.every((r: any) => !!r && r.username === 'camsa' && r.user_role === 'COMPANY_OWNER' && !!r.trace_id && r.critical_category === wantCat[r.action]) &&
        new Set(shown.map((r: any) => r.action)).size === 4 && shown.some((r: any) => r.action === 'RFID_CARD_BLOCKED' && r.target_id === CARD),
      `cal=${cal.status}, limit=${lim.status}, manual=${man.status}/${JSON.stringify(man.body).slice(0, 60)}, block=${blk.status}, db=${dbRows.length}, shown=${shown.filter(Boolean).length}`
    );

    // === Test 2 (AC — sütunlar): rol/IP/trace_id/hedef/özet; yalnız DEĞİŞEN anahtarlar; sistem kaydı (user NULL) ve silinmiş kullanıcı KAYBOLMAZ; dizi değeri kırpılmış ham metin ===
    const all = await rep(`${TAG_QS}&sortBy=created_at&sortDir=asc`);
    check(
      'Test 2 (AC — sütunlar ve tam kapsam): S1 → kullanıcı gebze-santiye, rol SITE_MANAGER, IP 10.0.0.7, trace-r722-a, hedef r722_target/etiket, özet "extra: ∅ → true; limit: 100 → 150" (değişmeyen mode/same YOK); S2 sistem kaydı (kullanıcı NULL) görünür; S3 silinmiş kullanıcı kimliğiyle görünür, rol NULL; S4 dizi → "[1, 2, 3]"; 10 satırın hepsi listelenir',
      all.status === 200 && all.body.data.length === 10 && n(all.body.aggregates.total_events) === 10 &&
        S('s1', all.body)?.username === 'gebze-santiye' && S('s1', all.body)?.user_role === 'SITE_MANAGER' && S('s1', all.body)?.ip_address === '10.0.0.7' && S('s1', all.body)?.trace_id === 'trace-r722-a' &&
        S('s1', all.body)?.target_type === 'r722_target' && S('s1', all.body)?.target_id === TAG && S('s1', all.body)?.change_summary === 'extra: ∅ → true; limit: 100 → 150' &&
        S('s2', all.body)?.username === null && S('s2', all.body)?.change_summary === null &&
        S('s3', all.body)?.username === `usr-yok-${RUN}` && S('s3', all.body)?.user_role === null && S('s4', all.body)?.change_summary === '[1, 2, 3]',
      `rows=${all.body?.data?.length}, s1=${JSON.stringify([S('s1', all.body)?.username, S('s1', all.body)?.user_role, S('s1', all.body)?.change_summary])}, s3=${S('s3', all.body)?.username}, s4=${S('s4', all.body)?.change_summary}`
    );

    // === Test 3 (AC — filtreler): kullanıcı (id/ad), işlem (çoklu), hedef tipi/kaydı, trace, rol, tarih aralığı, kritik kategori ===
    const c = async (qs: string) => (await rep(`targetId=${TAG}&pageSize=50&${qs}`)).body;
    const byId = await c(`userId=${gebzeMgrId}`);
    const byName = await c(`username=camsa`);
    const byAct = await c(`action=R722_UPDATE,R722_SYSTEM`);
    const byTrace = await c(`traceId=trace-r722-a`);
    const byRole = await c(`userRole=SITE_MANAGER`);
    const byRange = await c(`startDate=2020-06-03&endDate=2020-06-04`);
    const byCrit = await c(`critical=MANUEL_IKMAL`);
    const bySite = await call('GET', `/reports/rep-722?targetType=r722_target&targetId=${TAG}&pageSize=50`, owner);
    check(
      'Test 3 (AC — filtreler): userId=gebze-mgr → 1; username=camsa → 7 (S4..S10); action=R722_UPDATE,R722_SYSTEM → 2; traceId → 1; userRole=SITE_MANAGER → 1; 06-03..06-04 → 2 (S3,S4); critical=MANUEL_IKMAL → 1; hedef tipi+kaydı → 10',
      byId.data.length === 1 && byName.data.length === 7 && byAct.data.length === 2 && byTrace.data.length === 1 && byRole.data.length === 1 &&
        byRange.data.length === 2 && byCrit.data.length === 1 && byCrit.data[0].action === 'MANUAL_DISPENSE_R722' && bySite.body.data.length === 10,
      `id=${byId.data?.length}, name=${byName.data?.length}, act=${byAct.data?.length}, trace=${byTrace.data?.length}, role=${byRole.data?.length}, range=${byRange.data?.length}, crit=${byCrit.data?.length}`
    );

    // === Test 4 (AC — kritik vurgusu): 5 kritik önek doğru kategoriye; CALIBRATIONX (alt çizgisiz) kritik DEĞİL; sayaçlar ve criticalOnly ===
    const catOf = (t: string) => S(t, all.body)?.critical_category;
    const critOnly = await c('criticalOnly=1');
    const nonCrit = await c('criticalOnly=0');
    check(
      'Test 4 (AC — kritik işlemlerin öne çıkarılması): CALIBRATION_→KALIBRASYON, VEHICLE_FUEL_LIMIT_→LIMIT, FUEL_QUOTA_→LIMIT, MANUAL_DISPENSE_→MANUEL_IKMAL, RFID_CARD_→KART_BLOKAJI; CALIBRATIONX ve R722_* kritik değil; critical_events=5 (özet), criticalOnly=1 → 5 satır',
      catOf('s5') === 'KALIBRASYON' && catOf('s6') === 'LIMIT' && catOf('s7') === 'LIMIT' && catOf('s8') === 'MANUEL_IKMAL' && catOf('s9') === 'KART_BLOKAJI' &&
        catOf('s10') === null && catOf('s1') === null && n(all.body.aggregates.critical_events) === 5 && critOnly.data.length === 5 && critOnly.aggregates.critical_events === 5 && nonCrit.data.length === 10,
      `cats=${['s5', 's6', 's7', 's8', 's9', 's10'].map(catOf).join('/')}, critical=${all.body?.aggregates?.critical_events}, criticalOnly=${critOnly.data?.length}`
    );

    // === Test 5 (AC — değiştirilemezlik + tam kapsam): app_user UPDATE/DELETE/TRUNCATE yapamaz; API'de değiştirme ucu yok; sayfalama tüm satırları tekrarsız kapsar; rapor toplamı DB ile aynı ===
    const denied = async (stmt: string): Promise<boolean> => {
      const cl = pg();
      await cl.connect();
      try {
        await cl.query('BEGIN');
        await cl.query('SET LOCAL ROLE app_user');
        await cl.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT]);
        await cl.query(stmt);
        await cl.query('ROLLBACK');
        return false;
      } catch (e: any) {
        await cl.query('ROLLBACK').catch(() => undefined);
        return e.code === '42501';
      } finally {
        await cl.end();
      }
    };
    const upd = await denied(`UPDATE audit_logs SET action = 'X' WHERE target_id = '${TAG}'`);
    const del = await denied(`DELETE FROM audit_logs WHERE target_id = '${TAG}'`);
    const trunc = await denied('TRUNCATE audit_logs');
    const apiPut = await call('PUT', `/audit-logs/audit-r722-${RUN}-s1`, owner, { action: 'X' });
    const apiDel = await call('DELETE', `/audit-logs/audit-r722-${RUN}-s1`, owner);
    const seen = new Set<string>();
    let totalPages = 0;
    for (let p = 1; p <= 4; p++) {
      const page = await rep(`targetId=${TAG}&startDate=2020-06-01&endDate=2020-06-30&pageSize=3&page=${p}&sortBy=created_at&sortDir=asc`);
      totalPages = page.body.pagination.totalPages;
      for (const r of page.body.data) seen.add(r.id);
    }
    const dbCount = (await q('SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id = $1 AND target_id = $2', [TENANT, TAG]))[0].c;
    check(
      'Test 5 (AC — değiştirilemezlik ve tam kapsam): app_user UPDATE/DELETE/TRUNCATE → 42501 (DB seviyesi); API PUT/DELETE /audit-logs/:id → 404; pageSize=3 ile 4 sayfa 10 satırı TEKRARSIZ kapsar; rapor toplamı DB COUNT ile aynı (10)',
      upd && del && trunc && apiPut.status === 404 && apiDel.status === 404 && totalPages === 4 && seen.size === 10 && dbCount === 10 && n(all.body.aggregates.total_events) === dbCount,
      `upd=${upd}, del=${del}, trunc=${trunc}, api=${apiPut.status}/${apiDel.status}, pages=${totalPages}, seen=${seen.size}, db=${dbCount}`
    );

    // === Test 6 (AC — rapor erişimi audit'e): her görüntüleme REPORT_VIEW, her CSV/PDF REPORT_EXPORT; kullanıcı/rol/filtre kayıtlı; reddedilen (403) istekler kayıt YARATMAZ; erişim kayıtları raporun kendisinde görünür ===
    const viewsBefore = (await auditRowsSince('REPORT_VIEW')).length;
    const exportsBefore = (await auditRowsSince('REPORT_EXPORT')).length;
    await rep(`targetType=r722_target&startDate=2020-06-01&pageSize=5`);
    await rep(`traceId=trace-r722-a`);
    const csv = await call('GET', `/reports/rep-722/export?format=csv&${TAG_QS}`, owner);
    const pdfRes = await fetch(`${API_URL}/reports/rep-722/export?format=pdf&${TAG_QS}`, { headers: { Authorization: `Bearer ${owner}` } });
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    await rep(`pageSize=5`, gebzeMgr); // 403
    await call('GET', `/reports/rep-722/export?format=csv`, pumpOp); // 403
    const views = await auditRowsSince('REPORT_VIEW');
    const exports = await auditRowsSince('REPORT_EXPORT');
    const vLast = views[views.length - 1];
    const eCsv = exports.find((e: any) => e.after_value?.format === 'csv');
    const inReport = await rep(`action=REPORT_VIEW,REPORT_EXPORT&targetId=rep-722&startDate=${TODAY}&pageSize=100`);
    check(
      'Test 6 (AC — rapor erişimi audit\'lenir): 2 görüntüleme → +2 REPORT_VIEW (kullanıcı camsa, filtre traceId=trace-r722-a kayıtlı); CSV → REPORT_EXPORT{format:csv, role, filtreler}; PDF → REPORT_EXPORT{pdf}; SITE_MANAGER/PUMP_OPERATOR 403 → kayıt YOK; erişim kayıtları rep-722\'de görünür ve report_accesses sayacı onları sayar',
      views.length - viewsBefore === 2 && vLast.user_id === ownerId && vLast.after_value.format === 'view' && vLast.after_value.filters.traceId === 'trace-r722-a' && vLast.after_value.role === 'COMPANY_OWNER' &&
        exports.length - exportsBefore === 2 && eCsv?.user_id === ownerId && eCsv.after_value.filters.targetId === TAG && csv.status === 200 && pdfRes.status === 200 && pdfBuf.subarray(0, 5).toString('latin1') === '%PDF-' &&
        (inReport.body?.data || []).some((r: any) => r.action === 'REPORT_VIEW' && r.username === 'camsa') && n(inReport.body?.aggregates?.report_accesses) >= 4,
      `views+${views.length - viewsBefore}, exports+${exports.length - exportsBefore}, last=${JSON.stringify(vLast?.after_value)}, inReport=${inReport.body?.data?.length}, accesses=${inReport.body?.aggregates?.report_accesses}`
    );

    // === Test 7 (AC — rol görünürlüğü): yalnız SUPER_ADMIN/COMPANY_OWNER; SITE_MANAGER ve PUMP_OPERATOR görüntüleme/indirme 403; katalogda yalnız owner'da; audit yazılamazsa veri verilmez (fail-closed) ===
    const smView = await rep('pageSize=5', gebzeMgr);
    const smExp = await call('GET', '/reports/rep-722/export?format=pdf', gebzeMgr);
    const pumpView = await rep('pageSize=5', pumpOp);
    const catO = await call('GET', '/reports', owner);
    const catS = await call('GET', '/reports', gebzeMgr);
    const has = (cat: any) => (cat.body?.data || []).some((x: any) => x.id === 'rep-722');
    await q('REVOKE INSERT ON audit_logs FROM app_user');
    let fcView: { status: number; raw: string };
    let fcCsv: { status: number; raw: string };
    try {
      fcView = await rep(`${TAG_QS}`);
      fcCsv = await call('GET', `/reports/rep-722/export?format=csv&${TAG_QS}`, owner);
    } finally {
      await q('GRANT INSERT ON audit_logs TO app_user');
    }
    check(
      'Test 7 (AC — rol görünürlüğü + fail-closed): SITE_MANAGER görüntüleme/PDF 403, PUMP_OPERATOR 403; katalogda yalnız owner rep-722 görür; audit INSERT yasaklanınca hem görüntüleme hem CSV ≥500 ve gövdede hiçbir hedef/eylem verisi YOK',
      smView.status === 403 && smExp.status === 403 && pumpView.status === 403 && has(catO) && !has(catS) &&
        fcView!.status >= 500 && !fcView!.raw.includes(TAG) && fcCsv!.status >= 500 && !fcCsv!.raw.includes(TAG),
      `sm=${smView.status}/${smExp.status}, pump=${pumpView.status}, cat=${has(catO)}/${has(catS)}, failClosed=${fcView!.status}/${fcCsv!.status}`
    );

    // === Test 8 (AC — CSV/PDF/JSON tutarlılığı): CSV satır sayısı = JSON; başlıklar (Rol, Trace ID, Öncesi → Sonrası); S1 satırında IP/trace/rol/özet; kritik etiket 'KALİBRASYON' ===
    const csv8 = await call('GET', `/reports/rep-722/export?format=csv&${TAG_QS}`, owner);
    const lines = csv8.raw.split('\r\n').filter(Boolean);
    const s1Line = lines.find((l) => l.startsWith(`audit-r722-${RUN}-s1,`)) || '';
    const calLine = lines.find((l) => l.includes('CALIBRATION_R722')) || '';
    check(
      'Test 8 (AC — CSV/PDF/JSON tutarlılığı): CSV 10 satır (=JSON totalCount); başlıkta Rol/IP Adresi/Trace ID/Öncesi → Sonrası; S1 satırı SITE_MANAGER, 10.0.0.7, trace-r722-a ve "limit: 100 → 150"; CALIBRATION_R722 satırında "KALİBRASYON"; PDF Test 6\'da %PDF- doğrulandı',
      lines.length - 1 === 10 && lines.length - 1 === all.body.pagination.totalCount && ['Rol', 'IP Adresi', 'Trace ID', 'Öncesi → Sonrası', 'Tarih-Saat'].every((h) => lines[0].includes(h)) &&
        s1Line.includes('SITE_MANAGER') && s1Line.includes('10.0.0.7') && s1Line.includes('trace-r722-a') && s1Line.includes('limit: 100 → 150') && calLine.includes('KALİBRASYON'),
      `csv=${lines.length - 1}/${all.body?.pagination?.totalCount}, s1="${s1Line.slice(0, 120)}"`
    );
  } finally {
    await q('GRANT INSERT ON audit_logs TO app_user').catch(() => undefined);
    await q('DELETE FROM audit_logs WHERE target_id = $1', [TAG]);
    // Bu testin gerçek işlemlerinin yan etkileri (test kaydı olarak silinir — üretimde audit_logs değiştirilemez):
    await q(`DELETE FROM audit_logs WHERE tenant_id = $1 AND created_at >= $2 AND (action IN ('CALIBRATION_REQUESTED','VEHICLE_FUEL_LIMIT_SET','MANUAL_DISPENSE_REQUESTED','RFID_CARD_BLOCKED') OR (action IN ('REPORT_VIEW','REPORT_EXPORT') AND target_id = 'rep-722'))`, [TENANT, TEST_START]);
    if (createdCalibrationIds.length) await q('DELETE FROM calibration_commands WHERE id = ANY($1)', [createdCalibrationIds]);
    if (origK !== undefined) await q(`UPDATE hardware_devices SET k_factor = $2 WHERE device_id = $1`, [DEVICE, origK]);
    await q(`DELETE FROM vehicle_fuel_limits WHERE vehicle_id = 'veh-1'`);
    await q(`DELETE FROM rfid_card_blacklist WHERE tenant_id = $1 AND card_uid = $2`, [TENANT, CARD]);
    if (manualId) await q('DELETE FROM manual_dispense_requests WHERE id = $1', [manualId]);
    await resetLoginRateLimit();
    console.log('🧹 Test fixture verisi temizlendi (test kayıtları silindi; üretimde audit_logs app_user için değiştirilemezdir).\n');
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
