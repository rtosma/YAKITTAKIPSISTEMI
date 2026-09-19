import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { computeDriverBehaviorScores } from '../src/db/tenantDb';
import { runWithTenant } from '../src/context/tenantContext';
import { runReport, streamReportExport } from '../src/reports/reportEngine';
import { getReportDefinition } from '../src/reports';
import { maskPersonName } from '../src/reports/piiMask';

/**
 * REP-720 (#177) — Sürücü Bazlı Rapor (PII maskesi + denetimli indirme).
 *
 * Fixture (Mart 2020 penceresi; beklenenler ELLE hesaplı):
 *  D1 Gebze : 5 ikmal 100+50+70+80+200 = 500 L (ort 100.00); t2 ve t5 MESAI_DISI, t2 ayrıca MUKERRER
 *             bayraklı, t1 yalnız MUKERRER → mesai dışı = 2 (fan-out yok). Şubat'ta 999 L (pencere dışı).
 *  D1 Silivri: 1 ikmal 40 L. D2 Gebze: 30+60.5 = 90.5 L (ort 45.25). D3 Silivri: 10+20+30 = 60 L, skor YOK.
 *  Sürücüsüz (NULL) 5 L Gebze ikmali dışarıda kalmalı.
 *  Skorlar: D1 Şubat 88 → Nisan 71 (en son 71); D2 95.
 *  D1'in son skor bileşenleri: %40/%20/%20/%25/%40 × 25/20/20/20/15 = 10+4+4+5+6 = 29 puan → 100−29 = 71.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const SILIVRI = 'Silivri Tesisleri';
const QS = 'startDate=2020-03-01&endDate=2020-03-31&pageSize=50';
const D1 = `Ahmet Yılmaz R720-${RUN}`;
const D2 = `Bora Demir R720-${RUN}`;
const D3 = `Cem Kaya R720-${RUN}`;
const D4 = `Deniz Aksoy R720-${RUN}`;
const NAME_LIKE = `% R720-${RUN}`;
const TEST_START = new Date();

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
  console.log('🚛 [REP-720] SÜRÜCÜ BAZLI RAPOR (PII MASKESİ + DENETİM) TESTİ');
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
  const silivriMgr = await login('silivri-santiye');
  const pumpOp = await login('pompa-op-01');

  let seq = 0;
  async function tx(driver: string | null, site: string, liters: number, at: string): Promise<string> {
    const id = `tx-r720-${RUN}-${++seq}`;
    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, TENANT, site, `R720-${RUN}`, driver, liters, at]
    );
    return id;
  }
  async function flag(txId: string, type: string, driver: string, site: string, at: string) {
    await q(
      `INSERT INTO transaction_anomaly_flags (id, tenant_id, transaction_id, anomaly_type, site_name, vehicle_plate, driver_name, transaction_at, amount_liters, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'{}'::jsonb)`,
      [`fl-r720-${RUN}-${++seq}`, TENANT, txId, type, site, `R720-${RUN}`, driver, at]
    );
  }
  async function score(driver: string, site: string, sc: number, at: string, r: number[]) {
    await q(
      `INSERT INTO driver_behavior_scores (id, tenant_id, driver_name, site_name, period_days, transaction_count, score,
         offhours_ratio_pct, rapid_repeat_ratio_pct, consumption_deviation_ratio_pct, cancelled_ratio_pct, manual_entry_ratio_pct, computed_at)
       VALUES ($1,$2,$3,$4,90,10,$5,$6,$7,$8,$9,$10,$11)`,
      [`dbs-r720-${RUN}-${++seq}`, TENANT, driver, site, sc, r[0], r[1], r[2], r[3], r[4], at]
    );
  }
  const key = async (name: string): Promise<string> => (await q(`SELECT left(md5($1), 12) AS k`, [name]))[0].k;
  const auditRows = async (action = 'REPORT_EXPORT') =>
    q(`SELECT * FROM audit_logs WHERE action = $1 AND target_id IN ('rep-720','rep-720-skor','rep-711') AND created_at >= $2 ORDER BY created_at`, [action, TEST_START]);

  try {
    const d1t: string[] = [];
    for (const [i, l] of [100, 50, 70, 80, 200].entries()) d1t.push(await tx(D1, GEBZE, l, `2020-03-0${i + 1}T09:00:00Z`));
    await tx(D1, GEBZE, 999, '2020-02-10T09:00:00Z');
    await tx(D1, SILIVRI, 40, '2020-03-06T09:00:00Z');
    await tx(D2, GEBZE, 30, '2020-03-07T09:00:00Z');
    await tx(D2, GEBZE, 60.5, '2020-03-08T09:00:00Z');
    for (const [i, l] of [10, 20, 30].entries()) await tx(D3, SILIVRI, l, `2020-03-1${i}T09:00:00Z`);
    await tx(null, GEBZE, 5, '2020-03-09T09:00:00Z');
    await flag(d1t[1], 'MESAI_DISI', D1, GEBZE, '2020-03-02T09:00:00Z');
    await flag(d1t[1], 'KISA_ARALIK_MUKERRER', D1, GEBZE, '2020-03-02T09:00:00Z');
    await flag(d1t[4], 'MESAI_DISI', D1, GEBZE, '2020-03-05T09:00:00Z');
    await flag(d1t[0], 'KISA_ARALIK_MUKERRER', D1, GEBZE, '2020-03-01T09:00:00Z');
    await score(D1, GEBZE, 88, '2020-02-01T00:00:00Z', [20, 10, 10, 0, 20]);
    await score(D1, GEBZE, 71, '2020-04-01T00:00:00Z', [40, 20, 20, 25, 40]);
    await score(D2, GEBZE, 95, '2020-04-01T00:00:00Z', [0, 0, 0, 0, 0]);
    const k1 = await key(D1);

    const rep = await call(`/reports/rep-720?${QS}&driverName=R720-${RUN}`, owner);
    const row = (d: string, site: string, body = rep.body) => (body?.data || []).find((r: any) => r.driver_name === d && r.site_name === site);

    // === Test 1 (AC — istatistikler doğru): satır başına sayı/litre/ortalama/mesai dışı; pencere dışı ve sürücüsüz ikmal dışarıda; fan-out yok ===
    const ag = rep.body?.aggregates || {};
    check(
      'Test 1 (AC — istatistikler): D1@Gebze 5 alım/500 L/ort 100.00/mesai dışı 2 (t2 hem MESAI_DISI hem MÜKERRER — çift sayılmaz); D1@Silivri 1/40; D2 2/90.5/45.25; D3 3/60/20; Şubat 999 L ve sürücüsüz 5 L YOK; özet 4 satır/11 alım/690.5 L/2 mesai dışı',
      rep.status === 200 && rep.body.data.length === 4 &&
        row(D1, GEBZE)?.tx_count === 5 && near(row(D1, GEBZE)?.total_liters, 500) && near(row(D1, GEBZE)?.avg_liters, 100) && row(D1, GEBZE)?.offhours_count === 2 &&
        row(D1, SILIVRI)?.tx_count === 1 && near(row(D1, SILIVRI)?.total_liters, 40) && row(D1, SILIVRI)?.offhours_count === 0 &&
        row(D2, GEBZE)?.tx_count === 2 && near(row(D2, GEBZE)?.total_liters, 90.5) && near(row(D2, GEBZE)?.avg_liters, 45.25) &&
        row(D3, SILIVRI)?.tx_count === 3 && near(row(D3, SILIVRI)?.total_liters, 60) && near(row(D3, SILIVRI)?.avg_liters, 20) &&
        n(ag.total_rows) === 4 && n(ag.total_transactions) === 11 && near(ag.total_liters, 690.5) && n(ag.total_offhours) === 2,
      `rows=${rep.body?.data?.length}, D1G=${JSON.stringify([row(D1, GEBZE)?.tx_count, row(D1, GEBZE)?.total_liters, row(D1, GEBZE)?.avg_liters, row(D1, GEBZE)?.offhours_count])}, agg=${JSON.stringify(ag)}`
    );

    // === Test 2 (AC — dönem/şantiye/skor aralığı filtreleri): Şubat'ı kapsayan dönem D1@Gebze'yi 1499 L yapar; en son skor kazanır; skor yoksa (D3) aralık dışında ===
    const wide = await call(`/reports/rep-720?startDate=2020-02-01&endDate=2020-03-31&driverName=R720-${RUN}&pageSize=50`, owner);
    const minS = await call(`/reports/rep-720?${QS}&driverName=R720-${RUN}&minScore=90`, owner);
    const maxS = await call(`/reports/rep-720?${QS}&driverName=R720-${RUN}&maxScore=80`, owner);
    const silv = await call(`/reports/rep-720?${QS}&driverName=R720-${RUN}&siteName=${encodeURIComponent(SILIVRI)}`, owner);
    const names = (b: any) => (b?.data || []).map((r: any) => `${String(r.driver_name).split(' ')[0]}@${r.site_name === GEBZE ? 'G' : 'S'}`).sort().join(',');
    check(
      'Test 2 (Kapsam — filtreler): dönem Şubat+Mart → D1@Gebze 6 alım/1499 L; skor: D1=71 (Şubat 88 DEĞİL — en son), D2=95, D3 "SKOR YOK" (NULL); minScore=90 → yalnız D2; maxScore=80 → yalnız D1 (2 satır; D3 NULL olduğu için ikisinde de YOK); siteName=Silivri → D1@S + D3',
      row(D1, GEBZE, wide.body)?.tx_count === 6 && near(row(D1, GEBZE, wide.body)?.total_liters, 1499) &&
        row(D1, GEBZE)?.behavior_score === 71 && row(D1, SILIVRI)?.behavior_score === 71 && row(D2, GEBZE)?.behavior_score === 95 && row(D3, SILIVRI)?.behavior_score === null &&
        names(minS.body) === 'Bora@G' && names(maxS.body) === 'Ahmet@G,Ahmet@S' && names(silv.body) === 'Ahmet@S,Cem@S',
      `min=${names(minS.body)}, max=${names(maxS.body)}, silivri=${names(silv.body)}, wideD1=${row(D1, GEBZE, wide.body)?.total_liters}`
    );

    // === Test 3 (AC — PII maskesi): SITE_MANAGER adı "A*** Y*** R***" görür, ham ad JSON'un HİÇBİR yerinde yok; COMPANY_OWNER tam adı; şantiye kapsamı sürer ===
    const owKey = await call(`/reports/rep-720?${QS}&driverKey=${k1}`, owner);
    const gm = await call(`/reports/rep-720?${QS}&siteName=${encodeURIComponent(GEBZE)}&minScore=1`, gebzeMgr);
    const gmRows = (gm.body?.data || []).filter((r: any) => String(r.driver_name).endsWith('R***') && r.driver_key);
    const gmD1 = (gm.body?.data || []).find((r: any) => r.driver_key === k1);
    check(
      'Test 3 (AC — kişisel veri maskesi): Gebze SITE_MANAGER sürücü adını "A*** Y*** R***" görür, yanıt gövdesinde ham ad/soyad YOK; şantiye kapsamı (yalnız Gebze) korunur; COMPANY_OWNER tam adı görür; maske birim: "  ali   veli " → "a*** v***", NULL korunur, uzunluk sızmaz',
      gm.status === 200 && gmD1?.driver_name === 'A*** Y*** R***' && !gm.raw.includes('Ahmet') && !gm.raw.includes('Yılmaz') && !gm.raw.includes(`R720-${RUN}`) &&
        gm.body.data.every((r: any) => r.site_name === GEBZE) && gmRows.length >= 2 &&
        owKey.body?.data?.every((r: any) => r.driver_name === D1) && owKey.body.data.length === 2 &&
        maskPersonName('  ali   veli ') === 'a*** v***' && maskPersonName(null) === null && maskPersonName('Al') === maskPersonName('Alexander'),
      `gm=${gmD1?.driver_name}, leak=${gm.raw.includes('Ahmet')}, owner=${owKey.body?.data?.map((r: any) => r.driver_name).join('|')}`
    );

    // === Test 4 (Güvenlik — orakül kapalı): maskeli rolde adla filtre 403, adla sıralama varsayılana düşer; opak driverKey çalışır; COMPANY_OWNER'da ikisi de serbest ===
    const oracle = await call(`/reports/rep-720?${QS}&driverName=Ahmet`, gebzeMgr);
    const oracleCsv = await call(`/reports/rep-720/export?format=csv&${QS}&driverName=Ahmet`, gebzeMgr);
    const sortMasked = await call(`/reports/rep-720?${QS}&sortBy=driver_name&sortDir=asc`, gebzeMgr);
    const sortOwner = await call(`/reports/rep-720?${QS}&sortBy=driver_name&sortDir=asc&driverName=R720-${RUN}`, owner);
    const byKey = await call(`/reports/rep-720?${QS}&driverKey=${k1}`, gebzeMgr);
    check(
      'Test 4 (Güvenlik — orakül yok): Gebze SITE_MANAGER driverName=Ahmet → 403 REPORT_PII_FILTER_FORBIDDEN (JSON ve CSV); sortBy=driver_name → sıralama total_liters\'a düşer; COMPANY_OWNER adla sıralayabilir/filtreleyebilir; opak driverKey ile maskeli rol yalnız D1@Gebze satırını (site kapsamıyla) bulur',
      oracle.status === 403 && oracle.body?.details?.error === 'REPORT_PII_FILTER_FORBIDDEN' && oracleCsv.status === 403 && !oracleCsv.raw.includes('Ahmet') &&
        sortMasked.body?.sort?.column === 'total_liters' && sortOwner.body?.sort?.column === 'driver_name' && sortOwner.body?.data?.length === 4 &&
        byKey.body?.data?.length === 1 && byKey.body.data[0].site_name === GEBZE && byKey.body.data[0].tx_count === 5,
      `oracle=${oracle.status}/${oracle.body?.details?.error}, sortMasked=${sortMasked.body?.sort?.column}, sortOwner=${sortOwner.body?.sort?.column}, byKey=${byKey.body?.data?.length}`
    );

    // === Test 5 (AC — skor bileşenlerine inme): D1 skor geçmişi (2 tur, en yeni önce); bileşen oranı × ağırlık = puan; Σpuan = 100 − skor; maskeli rol driverKey ile iner ===
    const drill = await call(`/reports/rep-720-skor?driverKey=${k1}&pageSize=50`, owner);
    const dr = drill.body?.data || [];
    const pen = (r: any) => n(r.offhours_penalty) + n(r.rapid_repeat_penalty) + n(r.consumption_deviation_penalty) + n(r.cancelled_penalty) + n(r.manual_entry_penalty);
    const drillMasked = await call(`/reports/rep-720-skor?driverKey=${k1}&pageSize=50`, gebzeMgr);
    const drillSilivri = await call(`/reports/rep-720-skor?driverKey=${k1}&pageSize=50`, silivriMgr);
    check(
      'Test 5 (AC — skor detayı): rep-720-skor D1 için 2 tur (Nisan 71 → Şubat 88); Nisan bileşen puanları 10/4/4/5/6 (=%40×25, %20×20, %20×20, %25×20, %40×15), Σ=29=100−71; Gebze SITE_MANAGER aynı geçmişi MASKELİ ad ile görür; Silivri SITE_MANAGER göremez (skor satırı Gebze)',
      drill.status === 200 && dr.length === 2 && dr[0].score === 71 && dr[1].score === 88 &&
        near(dr[0].offhours_penalty, 10) && near(dr[0].rapid_repeat_penalty, 4) && near(dr[0].consumption_deviation_penalty, 4) && near(dr[0].cancelled_penalty, 5) && near(dr[0].manual_entry_penalty, 6) &&
        near(pen(dr[0]), 100 - 71) && near(pen(dr[1]), 100 - 88) && dr[0].driver_name === D1 &&
        drillMasked.body?.data?.length === 2 && drillMasked.body.data[0].driver_name === 'A*** Y*** R***' && !drillMasked.raw.includes('Ahmet') &&
        drillSilivri.status === 200 && drillSilivri.body.data.length === 0,
      `drill=${dr.map((r: any) => r.score).join('/')}, pen0=${dr[0] ? pen(dr[0]) : '-'}, masked=${drillMasked.body?.data?.[0]?.driver_name}, silivri=${drillSilivri.body?.data?.length}`
    );

    // === Test 6 (Kapsam — GERÇEK AI-506 ile eşitlik): 5 yakın ikmal + bayraklar → computeDriverBehaviorScores; rep-720-skor'daki skor ve Σ(oran×ağırlık) AI-506'nın kaydıyla uyumlu; rep-720 satırı aynı skoru ve mesai dışı=1 gösterir ===
    const recent: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `tx-r720-${RUN}-live-${i}`;
      recent.push(id);
      await q(
        `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, rfid_auth, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() - ($8 || ' hours')::interval)`,
        [id, TENANT, GEBZE, `R720-${RUN}`, D4, 100, i !== 3, String((i + 1) * 3)]
      );
    }
    await flag(recent[0], 'MESAI_DISI', D4, GEBZE, new Date().toISOString());
    const computed = await runWithTenant({ tenantId: TENANT }, () => computeDriverBehaviorScores({ driverName: D4, minTransactions: 5 }));
    const rec: any = computed.scores.find((s: any) => s.driver_name === D4);
    const k4 = await key(D4);
    const live = await call(`/reports/rep-720-skor?driverKey=${k4}`, owner);
    const liveRep = await call(`/reports/rep-720?driverKey=${k4}&startDate=${new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)}&pageSize=50`, owner);
    const lr = live.body?.data?.[0];
    check(
      'Test 6 (AC — AI-506 ile tutarlılık): gerçek computeDriverBehaviorScores kaydıyla rep-720-skor skoru aynı; Σ(bileşen puanları) ≈ 100 − skor (yuvarlama ≤ 0.5+ε); rep-720: 5 alım, mesai dışı 1, skor AI-506 kaydıyla aynı',
      !!rec && lr?.score === rec.score && lr?.transaction_count === 5 && Math.abs(100 - pen(lr) - lr.score) <= 0.55 &&
        near(lr.manual_entry_ratio_pct, n(rec.manual_entry_ratio_pct)) && near(lr.offhours_ratio_pct, 20) &&
        liveRep.body?.data?.length === 1 && liveRep.body.data[0].behavior_score === rec.score && liveRep.body.data[0].offhours_count === 1 && liveRep.body.data[0].tx_count === 5,
      `rec=${rec?.score}, report=${lr?.score}, Σpen=${lr ? pen(lr) : '-'}, rep720=${liveRep.body?.data?.[0]?.behavior_score}/${liveRep.body?.data?.[0]?.offhours_count}`
    );

    // === Test 7 (AC — denetim): CSV/PDF indirmeleri audit_logs'a REPORT_EXPORT olarak (rol, format, filtre, piiMasked); JSON görüntüleme ve denetimsiz rapor yazmaz; whitelist dışı parametre kayda girmez; rep-722 ile görünür ===
    const before = (await auditRows()).length;
    await call(`/reports/rep-720?${QS}`, owner); // JSON görüntüleme — audit YOK
    await call(`/reports/rep-711/export?format=csv&startDate=2020-03-01`, owner); // denetimsiz rapor — audit YOK (ayrıca rep-711 satırları sayılmaz)
    const unauditedAfter = (await auditRows()).filter((r: any) => r.target_id === 'rep-711').length;
    const csvOwner = await call(`/reports/rep-720/export?format=csv&${QS}&driverName=R720-${RUN}&junkParam=zzz`, owner);
    const pdfMgr = await fetch(`${API_URL}/reports/rep-720/export?format=pdf&${QS}`, { headers: { Authorization: `Bearer ${gebzeMgr}` } });
    const pdfMgrBuf = Buffer.from(await pdfMgr.arrayBuffer());
    const csvDrill = await call(`/reports/rep-720-skor/export?format=csv&driverKey=${k1}`, gebzeMgr);
    const pumpExport = await call(`/reports/rep-720/export?format=csv&${QS}`, pumpOp); // 403 → audit YOK
    const rows = (await auditRows()).filter((r: any) => r.target_id !== 'rep-711');
    const rOwner = rows.find((r: any) => r.target_id === 'rep-720' && r.after_value?.format === 'csv');
    const rMgr = rows.find((r: any) => r.target_id === 'rep-720' && r.after_value?.format === 'pdf');
    const rDrill = rows.find((r: any) => r.target_id === 'rep-720-skor');
    const viaRep722 = await call(`/reports/rep-722?action=REPORT_EXPORT&targetType=report&startDate=${TEST_START.toISOString().slice(0, 10)}&pageSize=50`, owner);
    check(
      'Test 7 (AC — indirme audit\'i): COMPANY_OWNER CSV → REPORT_EXPORT{format:csv, role:COMPANY_OWNER, piiMasked:false, filters={startDate,endDate,pageSize hariç driverName}, junkParam YOK}; SITE_MANAGER PDF → piiMasked:true, role SITE_MANAGER; skor detayı CSV\'si de kayıtlı; JSON görüntüleme/rep-711/403 (PUMP_OPERATOR) kayıt YARATMAZ; kullanıcı+hedef rep-722\'de görünür',
      before === 0 && unauditedAfter === 0 && rows.length === 3 && pumpExport.status === 403 &&
        rOwner?.after_value?.role === 'COMPANY_OWNER' && rOwner.after_value.piiMasked === false && rOwner.after_value.filters.startDate === '2020-03-01' && rOwner.after_value.filters.driverName === `R720-${RUN}` && !('junkParam' in rOwner.after_value.filters) && !!rOwner.user_id &&
        pdfMgr.status === 200 && pdfMgrBuf.subarray(0, 5).toString('latin1') === '%PDF-' && rMgr?.after_value?.role === 'SITE_MANAGER' && rMgr.after_value.piiMasked === true &&
        csvDrill.status === 200 && rDrill?.after_value?.piiMasked === true && csvOwner.status === 200 &&
        (viaRep722.body?.data || []).filter((r: any) => r.action === 'REPORT_EXPORT').length >= 3,
      `before=${before}, unaudited=${unauditedAfter}, rows=${rows.length}, owner=${JSON.stringify(rOwner?.after_value)}, mgr=${JSON.stringify(rMgr?.after_value)}, rep722=${viaRep722.body?.data?.length}`
    );

    // === Test 8 (AC — tutarlılık + güvenli varsayılan + fail-closed audit): CSV=JSON (satır/hücre), maskeli CSV JSON'la aynı maskeyi taşır; görüntüleyicisiz (zamanlanmış/arşiv) yol MASKELİ; audit yazılamazsa (INSERT yetkisi geçici alınır) HİÇ veri gönderilmez; PUMP_OPERATOR 403 + katalogda yok ===
    const csvO = await call(`/reports/rep-720/export?format=csv&${QS}&driverName=R720-${RUN}`, owner);
    const csvM = await call(`/reports/rep-720/export?format=csv&${QS}&siteName=${encodeURIComponent(GEBZE)}`, gebzeMgr);
    const gmJson = await call(`/reports/rep-720?${QS}&siteName=${encodeURIComponent(GEBZE)}`, gebzeMgr);
    const lines = (raw: string, needle: string) => raw.split('\r\n').filter((l) => l.includes(needle));
    const d1gLine = lines(csvO.raw, D1).find((l) => l.includes(GEBZE)) || '';
    const mgrLine = lines(csvM.raw, 'A*** Y*** R***').find((l) => l.includes(k1)) || '';
    const def = getReportDefinition('rep-720')!;
    const noViewer = await runWithTenant({ tenantId: TENANT }, () => runReport(def, { startDate: '2020-03-01', endDate: '2020-03-31', pageSize: 50 } as any, undefined));
    const streamed: string[] = [];
    await runWithTenant({ tenantId: TENANT }, () => streamReportExport(def, { startDate: '2020-03-01', endDate: '2020-03-31' } as any, undefined, (rs) => { for (const r of rs) streamed.push(String(r.driver_name)); }));
    const withOwner = await runWithTenant({ tenantId: TENANT }, () => runReport(def, { startDate: '2020-03-01', endDate: '2020-03-31', pageSize: 50 } as any, undefined, { role: 'COMPANY_OWNER' }));
    await q('REVOKE INSERT ON audit_logs FROM app_user');
    let failClosed: { status: number; raw: string };
    try {
      failClosed = await call(`/reports/rep-720/export?format=csv&${QS}`, owner);
    } finally {
      await q('GRANT INSERT ON audit_logs TO app_user');
    }
    const catO = await call('/reports', owner);
    const catP = await call('/reports', pumpOp);
    const ids = (c: any) => new Set((c.body?.data || []).map((x: any) => x.id));
    const pumpJson = await call(`/reports/rep-720?${QS}`, pumpOp);
    const pumpDrill = await call(`/reports/rep-720-skor`, pumpOp);
    const gmCsvRows = csvM.raw.split('\r\n').filter(Boolean).length - 1;
    check(
      'Test 8 (AC — CSV/JSON tutarlılığı, güvenli varsayılan, fail-closed): D1@Gebze CSV satırı 500.00/100.00/2/71 taşır ve JSON\'la aynı; maskeli CSV satır sayısı = JSON; görüntüleyicisiz runReport/streamReportExport MASKELİ, COMPANY_OWNER görüntüleyiciyle ham; audit INSERT\'i yasaklanınca export 500 ve gövdede AD YOK; PUMP_OPERATOR 403 + katalogda rep-720/rep-720-skor YOK',
      d1gLine.includes('500.00') && d1gLine.includes('100.00') && d1gLine.split(',').includes('71') && d1gLine.includes(D1) &&
        mgrLine.includes('500.00') && !csvM.raw.includes('Ahmet') && gmCsvRows === gmJson.body?.pagination?.totalCount &&
        noViewer.data.every((r: any) => String(r.driver_name).includes('***') && !String(r.driver_name).includes('Ahmet')) && streamed.length >= 4 && streamed.every((s) => s.includes('***')) &&
        withOwner.data.some((r: any) => r.driver_name === D1) &&
        failClosed!.status >= 500 && !failClosed!.raw.includes('Ahmet') && !failClosed!.raw.includes('Bora') &&
        pumpJson.status === 403 && pumpDrill.status === 403 && ids(catO).has('rep-720') && ids(catO).has('rep-720-skor') && !ids(catP).has('rep-720') && !ids(catP).has('rep-720-skor'),
      `d1g="${d1gLine.slice(0, 90)}", csvM=${gmCsvRows}/${gmJson.body?.pagination?.totalCount}, noViewer=${noViewer.data.length}, failClosed=${failClosed!.status}, pump=${pumpJson.status}/${pumpDrill.status}`
    );
  } finally {
    await q('GRANT INSERT ON audit_logs TO app_user').catch(() => undefined);
    await q('DELETE FROM transaction_anomaly_flags WHERE driver_name LIKE $1', [NAME_LIKE]);
    await q('DELETE FROM driver_behavior_scores WHERE driver_name LIKE $1', [NAME_LIKE]);
    await q('DELETE FROM alarms WHERE subject_id LIKE $1 OR alarm_key LIKE $2', [`%${D4}%`, `%${D4}%`]);
    await q('DELETE FROM transactions WHERE driver_name LIKE $1 OR vehicle_plate = $2', [NAME_LIKE, `R720-${RUN}`]);
    await resetLoginRateLimit();
    console.log('🧹 Test fixture verisi temizlendi (audit_logs kayıtları append-only olduğundan bilerek bırakıldı).\n');
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
