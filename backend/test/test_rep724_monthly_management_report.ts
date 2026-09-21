import { SMTPServer } from 'smtp-server';
import { Client } from 'pg';
import ExcelJS from 'exceljs';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { runWithTenant } from '../src/context/tenantContext';
import {
  generateMonthlyManagementReport, runMonthlyManagementReportSweepForCurrentTenant, verifyNarrative, parseTrNumber, previousMonthOf,
  isMonthlyReportDue, buildMonthlyPrompt, getMonthlyReportRecord, compileMonthlyFacts, pdfInputFor, MonthlyFacts
} from '../src/services/monthlyManagementReportService';
import { buildMonthlyReportPdfModel } from '../src/reports/monthlyManagementPdf';

/**
 * REP-724 (#210) — AI destekli aylık yönetim raporu.
 *
 * Sabit veri seti (el ile hesaplanmış): 2001-03 ayı için tek tenant'ta bilinen ikmal/alarm satırları; hiçbir başka test bu aya
 * dokunmaz, beklenen toplamlar test içinde (elle) yazılıdır — kod çıktısından türetilmez.
 * Model GERÇEK Gemini DEĞİL: `deps.generateContent` ile deterministik test çifti (gerçek ücretli API anahtarı yok — AI-502 ile aynı gerekçe);
 * "model erişilemez" senaryosu çifti hata fırlattırarak ve gerçek yolda anahtarsız çağırarak sınanır. E-posta: gerçek yerel SMTP dinleyicisi (REP-705 deseni).
 *
 * HAND-COMPUTED (2001-03, Gebze = 'Gebze Ana Şantiye', Orman = 'Orman Şantiyesi'):
 *   Gebze  : 100 + 50.4 + 200 + 25(ay başı 00:00:00Z DAHİL) = 375.40 L; 3000+1512+6000+750 = 11262.00 ₺; 4 ikmal; önceki ay 40(28 Şub 23:59:59Z)+160 = 200 L/6000 ₺; değişim (375.4-200)/200 = %87.7; 2 alarm
 *   Orman  : 300 L / 9000 ₺ / 1 ikmal; önceki ay 250 L / 7500 ₺; değişim %20.0; 0 alarm
 *   '-'    : şantiyesiz ALARM satırı (transactions.site_name NOT NULL → ikmal yok): 0 L / 0 ₺ / 0 ikmal; önceki ay 0 → değişim TANIMSIZ; 1 alarm
 *   TOPLAM : 675.40 L, 20262.00 ₺, 5 ikmal, 3 alarm, önceki 450 L / 13500 ₺, değişim (675.4-450)/450 = %50.1 (litre) ve (20262-13500)/13500 = %50.1 (tutar), 3 farklı araç
 *   En çok tüketen: 41 CCC 03 (300) > 34 BBB 02 (200) > 34 AAA 01 (175.4, 3 ikmal)
 *   Ay dışı (sayılmamalı): 2001-04-01T00:00:00Z'de 999 L (Nisan), başka tenant'ta (kusak) 777 L.
 */

const API_URL = 'http://localhost:5000/api/v1';
const SMTP_PORT = 2525;
const RUN = Date.now();
const TENANT = 'comp-camsa';
const OTHER_TENANT = 'comp-kusak';
const MONTH = '2001-03';
const EMPTY_MONTH = '2001-01';
const GEBZE = 'Gebze Ana Şantiye';
const ORMAN = 'Orman Şantiyesi';
const DRIVER_NAME = 'Zeynep Kaçmazoğlu'; // fixture sürücü adı — modele ASLA gitmemeli

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost', port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres', password: process.env.POSTGRES_PASSWORD || 'postgres', database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function raw(path: string, token: string): Promise<{ status: number; buf: Buffer; type: string }> {
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' };
}
async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}
const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant({ tenantId: TENANT }, fn);
function csvRows(text: string): string[][] {
  return text.replace(/^﻿/, '').trim().split(/\r?\n/).map((l) => l.split(','));
}
function mailAttachmentBytes(rawMail: string): Buffer {
  const m = rawMail.match(/Content-Disposition: attachment[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/);
  return m ? Buffer.from(m[1].replace(/\r?\n/g, ''), 'base64') : Buffer.alloc(0);
}
/** nodemailer text/plain parçasını (quoted-printable ya da base64, UTF-8) çözer. */
const decodeBody = (rawMail: string): string => {
  const m = rawMail.match(/Content-Type: text\/plain[^\r\n]*\r\n((?:[^\r\n]+\r\n)*)\r\n([\s\S]*?)\r\n--/);
  if (!m) return rawMail;
  const enc = /Content-Transfer-Encoding:\s*(\S+)/i.exec(m[1])?.[1]?.toLowerCase();
  if (enc === 'base64') return Buffer.from(m[2].replace(/\r?\n/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    const src = m[2].replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '=' && /^[0-9A-F]{2}$/i.test(src.substr(i + 1, 2))) { bytes.push(parseInt(src.substr(i + 1, 2), 16)); i += 2; } else bytes.push(...Buffer.from(src[i]));
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return m[2];
};

const GOOD_MODEL = {
  summary: 'Mart ayında toplam 675,4 L yakıt kullanıldı; tutar 20.262 ₺ oldu.',
  findings: [
    { text: 'Toplam tüketim önceki aya göre %50,1 arttı.', evidence: [{ metric: 'liters_change_pct', value: 50.1 }] },
    { text: 'Gebze Ana Şantiye 375,4 L ile en yüksek tüketimli şantiye.', evidence: [{ metric: `site:${GEBZE}:liters`, value: 375.4 }] }
  ],
  risks: [{ text: 'Gebze Ana Şantiye tüketimi önceki aya göre %87,7 arttı; 2 alarm kaydı var.', evidence: [{ metric: `site:${GEBZE}:change_pct`, value: 87.7 }, { metric: `site:${GEBZE}:alarms`, value: 2 }] }],
  recommendations: [{ text: '34 AAA 01 plakalı aracın 3 ikmalini gözden geçirin.', evidence: [] }]
};

async function run() {
  console.log('===========================================================');
  console.log('📈 [REP-724] AI DESTEKLİ AYLIK YÖNETİM RAPORU TESTİ');
  console.log('===========================================================\n');
  let passed = 0; let total = 0;
  const check = (name: string, ok: boolean, detail: string) => { total++; if (ok) { passed++; console.log(`✅ [PASS] ${name}\n   ${detail}\n`); } else console.log(`❌ [FAIL] ${name}\n   ${detail}\n`); };

  const received: Array<{ to: string; raw: string }> = [];
  const smtp = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'],
    onRcptTo(address, _s, cb) { if (address.address.startsWith('bounce')) { const e: any = new Error('550 5.1.1 Kullanıcı bilinmiyor'); e.responseCode = 550; return cb(e); } cb(); },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => { received.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), raw: Buffer.concat(chunks).toString('utf-8') }); cb(); });
    }
  });
  await new Promise<void>((resolve, reject) => { smtp.listen(SMTP_PORT, resolve); smtp.on('error', reject); });

  const owner = await login('camsa');
  const gebzeMgr = await login('gebze-santiye');
  const kusak = await login('kusak');
  const pumpOp = await login('pompa-op-01');

  const userIds: string[] = [];
  const savedEmails: Array<{ id: string; email: string }> = [];
  let modulesBackup: any = null;

  const cleanup = async () => {
    await q(`DELETE FROM monthly_management_reports WHERE tenant_id = ANY($1) AND period_month = ANY($2)`, [[TENANT, OTHER_TENANT], [MONTH, EMPTY_MONTH, '2001-02']]);
    await q(`DELETE FROM transactions WHERE id LIKE $1`, [`tx-rep724-${RUN}-%`]);
    await q(`DELETE FROM alarms WHERE id LIKE $1`, [`al-rep724-${RUN}-%`]);
    if (userIds.length) await q(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
    for (const u of savedEmails) await q(`UPDATE users SET email = $2 WHERE id = $1`, [u.id, u.email]);
    if (modulesBackup) await q(`UPDATE companies SET modules = $2::jsonb WHERE id = $1`, [TENANT, JSON.stringify(modulesBackup)]);
  };

  try {
    // ── Sabit veri seti ──
    let n = 0;
    const tx = async (tenant: string, site: string | null, plate: string, liters: number, cost: number, at: string) => {
      await q(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, total_cost, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [`tx-rep724-${RUN}-${++n}`, tenant, site, plate, DRIVER_NAME, liters, cost, at]);
    };
    await tx(TENANT, GEBZE, '34 AAA 01', 100, 3000, '2001-03-05T10:00:00Z');
    await tx(TENANT, GEBZE, '34 AAA 01', 50.4, 1512, '2001-03-20T10:00:00Z');
    await tx(TENANT, GEBZE, '34 BBB 02', 200, 6000, '2001-03-31T12:00:00Z');
    await tx(TENANT, GEBZE, '34 AAA 01', 25, 750, '2001-03-01T00:00:00Z');       // ay başı sınırı: DAHİL
    await tx(TENANT, ORMAN, '41 CCC 03', 300, 9000, '2001-03-10T10:00:00Z');
    await tx(TENANT, GEBZE, '34 AAA 01', 999, 29970, '2001-04-01T00:00:00Z');   // sonraki ay: HARİÇ
    await tx(TENANT, GEBZE, '34 BBB 02', 40, 1200, '2001-02-28T23:59:59Z');     // önceki ay son saniye
    await tx(TENANT, GEBZE, '34 AAA 01', 160, 4800, '2001-02-10T10:00:00Z');
    await tx(TENANT, ORMAN, '41 CCC 03', 250, 7500, '2001-02-12T10:00:00Z');
    await tx(OTHER_TENANT, 'Kusak Şantiyesi', '35 ZZZ 99', 777, 23310, '2001-03-12T10:00:00Z'); // başka tenant
    const alarm = async (site: string | null, at: string, key: string) => q(`INSERT INTO alarms (id, tenant_id, alarm_key, category, title, site_name, first_seen_at, last_seen_at) VALUES ($1,$2,$3,'TEST','REP-724 fixture',$4,$5,$5)`, [`al-rep724-${RUN}-${key}`, TENANT, `REP724:${RUN}:${key}`, site, at]);
    await alarm(GEBZE, '2001-03-12T09:00:00Z', 'a1');
    await alarm(GEBZE, '2001-03-13T09:00:00Z', 'a2');
    await alarm(null, '2001-03-14T09:00:00Z', 'a3');
    await alarm(GEBZE, '2001-02-10T09:00:00Z', 'a4'); // önceki ay: sayılmaz

    // === T1: rep-724 sabit veri seti — satırlar ve toplamlar el ile hesaplanan değerler ===
    const rep = await call('GET', `/reports/rep-724?month=${MONTH}&pageSize=100`, { token: owner });
    const byId: Record<string, any> = Object.fromEntries((rep.body?.data ?? []).map((r: any) => [r.site_name, r]));
    const g = byId[GEBZE]; const o = byId[ORMAN]; const dash = byId['-'];
    const ag = rep.body?.aggregates ?? {};
    check(
      'T1 (ölçülen veri, el hesabı): Gebze 375.40 L/11262 ₺/4 ikmal/önceki 200 L/%87.7/2 alarm (ay başı 00:00:00Z DAHİL, Nisan 999 L ve Şubat sonu HARİÇ); Orman 300/9000/1/%20.0/0 alarm; şantiyesiz alarm "-" satırı 0 L/0 ₺/önceki 0 → değişim boş/1 alarm; TOPLAM 675.40 L, 20262 ₺, 5 ikmal, 3 alarm, önceki 450 L/13500 ₺; başka tenant (777 L) YOK',
      rep.status === 200 && rep.body.pagination?.totalCount === 3 &&
        Number(g?.liters) === 375.4 && Number(g?.cost) === 11262 && g?.dispenses === 4 && Number(g?.prev_liters) === 200 && Number(g?.prev_cost) === 6000 && Number(g?.change_pct) === 87.7 && g?.alarms === 2 &&
        Number(o?.liters) === 300 && Number(o?.cost) === 9000 && o?.dispenses === 1 && Number(o?.prev_liters) === 250 && Number(o?.change_pct) === 20 && o?.alarms === 0 &&
        Number(dash?.liters) === 0 && Number(dash?.cost) === 0 && dash?.dispenses === 0 && Number(dash?.prev_liters) === 0 && dash?.change_pct === null && dash?.alarms === 1 &&
        ag.total_liters === 675.4 && ag.total_cost === 20262 && ag.total_dispenses === 5 && ag.total_alarms === 3 && ag.total_prev_liters === 450 && ag.total_prev_cost === 13500,
      `status=${rep.status} total=${rep.body.pagination?.totalCount} G=${JSON.stringify(g && { l: g.liters, c: g.cost, d: g.dispenses, p: g.prev_liters, pct: g.change_pct, a: g.alarms })} O=${o?.liters}/${o?.change_pct} dash=${dash?.liters}/${dash?.change_pct}/${dash?.alarms} agg=${JSON.stringify(ag)}`
    );

    // === T2: geçersiz month → 400 INVALID_MONTH (JSON, CSV, XLSX, management-report) ===
    const badJson = await call('GET', '/reports/rep-724?month=2001-13', { token: owner });
    const badCsv = await raw('/reports/rep-724/export?format=csv&month=abc', owner);
    const badXlsx = await raw('/reports/rep-724/export?format=xlsx&month=2001-3', owner);
    const badMgmt = await call('GET', '/management-reports/2001-3', { token: owner });
    check('T2: geçersiz ay biçimi (2001-13 / abc / 2001-3) JSON, CSV, XLSX ve yönetim raporu uçlarında 400 döner (Postgres hatası → 500 OLMAZ)', badJson.status === 400 && badJson.body?.details?.error === 'INVALID_MONTH' && badCsv.status === 400 && badXlsx.status === 400 && badMgmt.status === 400, `json=${badJson.status}/${badJson.body?.details?.error} csv=${badCsv.status} xlsx=${badXlsx.status} mgmt=${badMgmt.status}`);

    // === T3 (AC — Excel/PDF/CSV/JSON aynı veri): hücre hücre karşılaştırma ===
    const csv = await raw(`/reports/rep-724/export?format=csv&month=${MONTH}`, owner);
    const xlsx = await raw(`/reports/rep-724/export?format=xlsx&month=${MONTH}`, owner);
    const pdf = await raw(`/reports/rep-724/export?format=pdf&month=${MONTH}`, owner);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.buf as any);
    const ws = wb.worksheets[0];
    const xRows: any[][] = [];
    ws.eachRow((row) => { xRows.push((row.values as any[]).slice(1)); });
    const cRows = csvRows(csv.buf.toString('utf-8'));
    let cellMismatch = 0;
    cRows.forEach((cr, ri) => cr.forEach((cell, ci) => {
      const xv = xRows[ri]?.[ci]; const xs = xv === null || xv === undefined ? '' : String(xv);
      if (ri === 0 ? xs !== cell : (/^-?\d+(\.\d+)?$/.test(cell) ? Number(cell) !== Number(xs) : cell !== xs)) cellMismatch++;
    }));
    const jsonById = (rep.body.data as any[]).map((r) => [r.site_name, Number(r.liters).toFixed(2)]).sort().join('|');
    const csvIdx = cRows[0].indexOf('Litre'); const csvSite = cRows[0].indexOf('Şantiye');
    const csvById = cRows.slice(1).map((r) => [r[csvSite], r[csvIdx]]).sort().join('|');
    const litersCol = xRows[0].indexOf('Litre');
    check(
      'T3 (AC — Excel, PDF, CSV aynı veri): XLSX ve CSV başlık + her hücre aynı (sayı sütunları XLSX\'te SAYI hücresi, değer CSV ile eşit); JSON satırlarıyla şantiye/litre eşleşir; PDF geçerli (%PDF-) ve 200; Content-Type\'lar doğru',
      csv.status === 200 && xlsx.status === 200 && pdf.status === 200 && cRows.length === 4 && xRows.length === 4 && cellMismatch === 0 && jsonById === csvById &&
        typeof xRows[1][litersCol] === 'number' && pdf.buf.subarray(0, 5).toString('latin1') === '%PDF-' && /spreadsheetml/.test(xlsx.type) && /text\/csv/.test(csv.type) && /pdf/.test(pdf.type),
      `csvRows=${cRows.length} xlsxRows=${xRows.length} hücreFarkı=${cellMismatch} json==csv=${jsonById === csvById} xlsxLitreTipi=${typeof xRows[1]?.[litersCol]} types=${xlsx.type}|${csv.type}|${pdf.type}`
    );

    // === T4 (AC — rol görünürlüğü): SITE_MANAGER yalnız kendi şantiyesi ===
    const smRep = await call('GET', `/reports/rep-724?month=${MONTH}`, { token: gebzeMgr });
    const smXlsx = await raw(`/reports/rep-724/export?format=xlsx&month=${MONTH}`, gebzeMgr);
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(smXlsx.buf as any);
    const smSites: string[] = []; wb2.worksheets[0].eachRow((r, i) => { if (i > 1) smSites.push(String((r.values as any[])[2])); });
    const pumpRep = await call('GET', `/reports/rep-724?month=${MONTH}`, { token: pumpOp });
    check('T4 (AC — rol bazlı görünürlük): SITE_MANAGER JSON ve XLSX\'te yalnızca kendi şantiyesini (Gebze 375.40 L) görür — Orman/şantiyesiz satır ve toplam sızmaz; PUMP_OPERATOR raporu 403 alır', smRep.status === 200 && smRep.body.pagination?.totalCount === 1 && Number(smRep.body.data[0].liters) === 375.4 && smRep.body.aggregates.total_liters === 375.4 && smSites.length === 1 && smSites[0] === GEBZE && pumpRep.status === 403, `smTotal=${smRep.body.pagination?.totalCount} smSites=${JSON.stringify(smSites)} agg=${smRep.body?.aggregates?.total_liters} pump=${pumpRep.status}`);

    // === T5 (AC — ürettir + ayrı gösterim): model yorumu doğrulanır, ölçülen veri ayrı alanda ===
    let capturedPrompt = '';
    const good = await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', deps: { generateContent: async (p) => { capturedPrompt = p; return JSON.stringify(GOOD_MODEL); } } }));
    const view = await call('GET', `/management-reports/${MONTH}`, { token: owner });
    const d = view.body?.data;
    check(
      'T5 (AC — ölçülen ve model AYRI): model yorumu sistem verisiyle doğrulanıp URETILDI olarak kaydedilir; GET yanıtında `measured` (origin MEASURED, el hesabı toplamlar) ile `aiCommentary` (origin MODEL, özet+bulgu+risk+öneri) AYRI alanlardadır; her bulgunun dayanağı okunur etiketle ("Yakıt değişimi (önceki aya göre) = +50,1 %") birlikte döner',
      good.created && good.record.ai_status === 'URETILDI' && view.status === 200 &&
        d.measured.origin === 'MEASURED' && d.measured.totals.liters === 675.4 && d.measured.totals.cost === 20262 && d.measured.totals.dispenses === 5 && d.measured.totals.alarms === 3 && d.measured.totals.vehicleCount === 3 &&
        d.measured.totals.litersChangePct === 50.1 && d.measured.sites.length === 3 && d.measured.topVehicles[0].plate === '41 CCC 03' && d.measured.topVehicles[2].liters === 175.4 &&
        d.aiCommentary.origin === 'MODEL' && d.aiCommentary.status === 'URETILDI' && d.aiCommentary.narrative.findings.length === 2 && d.aiCommentary.narrative.risks.length === 1 && d.aiCommentary.narrative.recommendations.length === 1 &&
        d.aiCommentary.narrative.findings[0].evidence[0] === 'Yakıt değişimi (önceki aya göre) = +50,1 %' && d.aiCommentary.narrative.findings[1].evidence[0] === 'Gebze Ana Şantiye — yakıt = 375,40 L' && d.aiCommentary.rejectedCount === 0 && !('narrative' in d.measured),
      `status=${view.status} ai=${good.record.ai_status} totals=${JSON.stringify(d?.measured?.totals)} top1=${d?.measured?.topVehicles?.[0]?.plate} findings=${d?.aiCommentary?.narrative?.findings?.length}`
    );

    // === T6 (KVKK): modele kişi adı gitmez; istem ölçümleri adıyla içerir ===
    check('T6 (KVKK/COMP-606): modele giden istemde sürücü adı YOK (fixture sürücüsü "Zeynep Kaçmazoğlu" ikmallerde var); ölçümler ad=değer olarak var (total_liters = 675.4, site:Gebze…:liters = 375.4)', !capturedPrompt.includes('Zeynep') && !capturedPrompt.includes('Kaçmazoğlu') && capturedPrompt.includes('total_liters = 675.4') && capturedPrompt.includes(`site:${GEBZE}:liters = 375.4`) && capturedPrompt.includes('vehicle:41 CCC 03:liters = 300'), `promptUzunluk=${capturedPrompt.length} adSızdı=${capturedPrompt.includes('Zeynep')}`);

    // === T7 (AC — çapraz doğrulama): uydurma/yanlış ifadeler ÇIKARILIR, doğrular kalır ===
    const facts: MonthlyFacts = good.record.facts;
    const evilModel = {
      summary: 'Mart ayında 700 L yakıt kullanıldı.', // yanlış: gerçek 675,4 → yuvarlanmışı 675 (700 değil)
      findings: [
        { text: 'Toplam tüketim önceki aya göre %50,1 arttı.', evidence: [{ metric: 'liters_change_pct', value: 50.1 }] },                           // DOĞRU
        { text: 'Toplam tüketim 999 L oldu.', evidence: [{ metric: 'total_liters', value: 999 }] },                                                   // dayanak değeri yanlış
        { text: 'Orman şantiyesi tüketimi %75 azaldı.', evidence: [{ metric: `site:${ORMAN}:change_pct`, value: 20 }] },                            // metindeki %75 doğrulanamaz
        { text: 'Bilinmeyen ölçüme dayanan bir bulgu.', evidence: [{ metric: 'fuel_theft_index', value: 5 }] },                                     // olmayan ölçüm
        { text: 'Dayanaksız bir iddia.', evidence: [] }                                                                                             // dayanak yok
      ],
      risks: [{ text: '99 ZZZ 99 plakalı araç aşırı yakıt tüketiyor.', evidence: [{ metric: 'vehicle_count', value: 3 }] }],                          // plaka ölçümde yok
      recommendations: [{ text: 'Stok sayımını sıklaştırın.', evidence: [] }, { text: 'Gebze için 1.000 L limit koyun.', evidence: [] }]              // ilki serbest (öneri), ikincideki 1.000 L ölçüm değil
    };
    const mixed = await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', regenerate: true, deps: { generateContent: async () => JSON.stringify(evilModel) } }));
    const rej = mixed.record.ai_rejected;
    const reasons = rej.map((r) => r.reason).join(' | ');
    const kept = mixed.record.ai_narrative;
    check(
      'T7 (AC — çapraz doğrulama): KISMEN_DOGRULANDI — yanlış toplam (999), doğrulanamayan %75, olmayan ölçüm, dayanaksız iddia, bilinmeyen plaka, ölçüm olmayan 1.000 L ve yanlış özet (700 L) rapordan ÇIKARILIR; nedenleri ai_rejected\'ta; doğru bulgu (%50,1) ve serbest öneri KALIR',
      mixed.record.ai_status === 'KISMEN_DOGRULANDI' && rej.length === 7 &&
        /EVIDENCE_MISMATCH:total_liters/.test(reasons) && /TEXT_NUMBER_UNVERIFIED:75/.test(reasons) && /UNKNOWN_METRIC:fuel_theft_index/.test(reasons) && /NO_EVIDENCE/.test(reasons) && /UNKNOWN_VEHICLE:99 ZZZ 99/.test(reasons) && /TEXT_NUMBER_UNVERIFIED:1\.000/.test(reasons) &&
        rej.some((r) => r.section === 'summary') === true &&
        kept!.summary === null && kept!.findings.length === 1 && kept!.findings[0].text.includes('%50,1') && kept!.risks.length === 0 && kept!.recommendations.length === 1 && kept!.recommendations[0].text === 'Stok sayımını sıklaştırın.',
      `status=${mixed.record.ai_status} rejected=${rej.length} reasons=${reasons.slice(0, 260)} keptFindings=${kept?.findings.length} keptRecs=${kept?.recommendations.length}`
    );

    // === T8: hiçbir ifade doğrulanamazsa DOGRULANAMADI; model metni rapora GİRMEZ ===
    const allBad = { summary: 'Her şey harika, 5000 L tasarruf.', findings: [{ text: 'Uydurma bulgu 12345 L.', evidence: [{ metric: 'total_liters', value: 12345 }] }], risks: [], recommendations: [] };
    const none = await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', regenerate: true, deps: { generateContent: async () => JSON.stringify(allBad) } }));
    check('T8: modelin HİÇBİR ifadesi doğrulanamazsa ai_status DOGRULANAMADI, narrative boş (uydurma metin rapora sızmaz), rapor ölçülen veriyle yine üretilir', none.record.ai_status === 'DOGRULANAMADI' && none.record.ai_narrative === null && none.record.ai_rejected.length === 2 && none.record.facts.totals.liters === 675.4, `status=${none.record.ai_status} narrative=${none.record.ai_narrative} rejected=${none.record.ai_rejected.length} liters=${none.record.facts.totals.liters}`);

    // === T9 (AC — model erişilemezse rapor yine üretilir): hata / bozuk JSON / şema dışı / anahtarsız gerçek yol ===
    const down = await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', regenerate: true, deps: { generateContent: async () => { throw new Error('503 UNAVAILABLE'); } } }));
    const junk = await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', regenerate: true, deps: { generateContent: async () => 'Elbette! İşte raporunuz: ...' } }));
    const badShape = await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', regenerate: true, deps: { generateContent: async () => JSON.stringify({ summary: 'x', findings: 'bu bir dizi değil' }) } }));
    const keyless = process.env.GEMINI_API_KEY ? null : await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', regenerate: true }));
    const downPdf = await raw(`/management-reports/${MONTH}/pdf`, owner);
    const downView = await call('GET', `/management-reports/${MONTH}`, { token: owner });
    check(
      'T9 (AC — model erişilemezse yine üretilir): 503 hatası → MODEL_ERISILEMEDI; JSON olmayan çıktı ve şema dışı çıktı → GECERSIZ_CIKTI; anahtarsız gerçek yol → MODEL_ERISILEMEDI; her durumda kayıt ÖLÇÜLEN VERİYLE (675.40 L) yazılır, model yorumu null, PDF üretilir',
      down.record.ai_status === 'MODEL_ERISILEMEDI' && /503/.test(down.record.ai_error ?? '') && junk.record.ai_status === 'GECERSIZ_CIKTI' && badShape.record.ai_status === 'GECERSIZ_CIKTI' &&
        (keyless === null || keyless.record.ai_status === 'MODEL_ERISILEMEDI') &&
        [down, junk, badShape].every((x) => x.record.facts.totals.liters === 675.4 && x.record.ai_narrative === null) &&
        downView.body.data.measured.totals.liters === 675.4 && downView.body.data.aiCommentary.narrative === null && downPdf.status === 200 && downPdf.buf.subarray(0, 5).toString('latin1') === '%PDF-',
      `down=${down.record.ai_status} junk=${junk.record.ai_status} shape=${badShape.record.ai_status} keyless=${keyless?.record.ai_status ?? 'atlandı'} pdf=${downPdf.status}`
    );

    // === T10: model kapalı paket → çağrılmaz; veri yok → çağrılmaz + e-posta atlanır ===
    let calls = 0;
    modulesBackup = (await q(`SELECT modules FROM companies WHERE id = $1`, [TENANT]))[0].modules;
    await q(`UPDATE companies SET modules = COALESCE(modules, '{}'::jsonb) || '{"aiAnomaly": false}'::jsonb WHERE id = $1`, [TENANT]);
    const noModule = await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', regenerate: true, deps: { generateContent: async () => { calls++; return JSON.stringify(GOOD_MODEL); } } }));
    await q(`UPDATE companies SET modules = $2::jsonb WHERE id = $1`, [TENANT, JSON.stringify(modulesBackup)]); modulesBackup = null;
    const empty = await inTenant(() => generateMonthlyManagementReport(EMPTY_MONTH, { generatedBy: 'test', deps: { generateContent: async () => { calls++; return JSON.stringify(GOOD_MODEL); } } }));
    check('T10: aiAnomaly modülü kapalı paket → MODUL_KAPALI (model HİÇ çağrılmaz, veri bölümü yine üretilir); ikmal/alarmı olmayan ay → VERI_YOK (model çağrılmaz, e-posta ATLANDI_BOŞ)', noModule.record.ai_status === 'MODUL_KAPALI' && noModule.record.facts.totals.liters === 675.4 && empty.record.ai_status === 'VERI_YOK' && empty.record.email_status === 'ATLANDI_BOŞ' && calls === 0, `modul=${noModule.record.ai_status} bos=${empty.record.ai_status}/${empty.record.email_status} modelCağrısı=${calls}`);

    // === T11 (AC — rol bazlı görünürlük, yönetim raporu): SITE_MANAGER ölçülen veriyi yalnız kendi şantiyesi için görür, model yorumunu GÖRMEZ ===
    await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', regenerate: true, deps: { generateContent: async () => JSON.stringify(GOOD_MODEL) } }));
    const smView = await call('GET', `/management-reports/${MONTH}`, { token: gebzeMgr });
    const sd = smView.body?.data;
    const smPdf = await raw(`/management-reports/${MONTH}/pdf`, gebzeMgr);
    const pumpView = await call('GET', `/management-reports/${MONTH}`, { token: pumpOp });
    const smGen = await call('POST', '/management-reports', { token: gebzeMgr, body: { month: MONTH } });
    const noAuth = await call('GET', `/management-reports/${MONTH}`);
    check(
      'T11 (AC — rol görünürlüğü): SITE_MANAGER yönetim raporunda yalnız Gebze (375.40 L, 1 satır, Orman/şantiyesiz YOK, en çok tüketen araçlar yalnız Gebze araçları) görür ve model yorumu SITE_SCOPE_RESTRICTED (firma geneli metin başka şantiyeleri anar); PDF\'i alır; PUMP_OPERATOR 403; SITE_MANAGER üretemez 403; anonim 401',
      smView.status === 200 && sd.measured.scope === 'SITE' && sd.measured.totals.liters === 375.4 && sd.measured.sites.length === 1 && sd.measured.sites[0].site === GEBZE &&
        sd.measured.topVehicles.every((v: any) => ['34 AAA 01', '34 BBB 02'].includes(v.plate)) && sd.aiCommentary.status === 'SITE_SCOPE_RESTRICTED' && sd.aiCommentary.narrative === null &&
        JSON.stringify(sd).includes('Orman') === false && smPdf.status === 200 && smPdf.buf.subarray(0, 5).toString('latin1') === '%PDF-' && pumpView.status === 403 && smGen.status === 403 && noAuth.status === 401,
      `sm=${smView.status} scope=${sd?.measured?.scope} litre=${sd?.measured?.totals?.liters} ai=${sd?.aiCommentary?.status} ormanSızdı=${JSON.stringify(sd).includes('Orman')} pdf=${smPdf.status} pump=${pumpView.status} smGen=${smGen.status} anon=${noAuth.status}`
    );

    // === T12 (RLS): başka firma bu raporu göremez, kendi verisi 777 L ===
    const kView = await call('GET', `/management-reports/${MONTH}`, { token: kusak });
    const kRep = await call('GET', `/reports/rep-724?month=${MONTH}`, { token: kusak });
    check('T12 (tenant izolasyonu): kusak firması camsa\'nın yönetim raporunu göremez (404 REPORT_NOT_GENERATED) ve kendi rep-724 verisi yalnızca kendi 777 L\'sidir', kView.status === 404 && kView.body?.details?.error === 'REPORT_NOT_GENERATED' && kRep.body.aggregates?.total_liters === 777 && kRep.body.data.length === 1, `kView=${kView.status} kusakToplam=${kRep.body?.aggregates?.total_liters}`);

    // === T13 (PDF şablonu): iki katman AYRI bloklarda ===
    const rec = (await inTenant(() => getMonthlyReportRecord(MONTH)))!;
    const model = buildMonthlyReportPdfModel(pdfInputFor(rec, rec.facts, true, 'ÇamSA'));
    const measuredText = model.blocks.filter((b) => b.origin === 'MEASURED').map((b) => JSON.stringify(b)).join(' ');
    const modelText = model.blocks.filter((b) => b.origin === 'MODEL').map((b) => JSON.stringify(b)).join(' ');
    const banners = model.blocks.filter((b) => b.kind === 'banner') as Array<{ origin: string; text: string }>;
    const noAiModel = buildMonthlyReportPdfModel(pdfInputFor({ ...rec, ai_status: 'MODEL_ERISILEMEDI', ai_narrative: null }, rec.facts, true, 'ÇamSA'));
    const siteModel = buildMonthlyReportPdfModel(pdfInputFor(rec, { ...rec.facts, scope: 'SITE', site: GEBZE, sites: rec.facts.sites.filter((s) => s.site === GEBZE) }, false, 'ÇamSA'));
    check(
      'T13 (AC — PDF\'te ayrı gösterim): PDF modeli iki başlık şeridi taşır (A. ÖLÇÜLEN VERİ / B. YAPAY ZEKÂ YORUMU — ölçüm değildir); ölçülen sayılar (675,40 L, 20.262,00 ₺, şantiye satırları) YALNIZCA MEASURED bloklarında, model cümleleri YALNIZCA MODEL bloklarında; model yoksa B bölümü neden metniyle durur ve A eksiksiz; site kapsamlı PDF\'te Orman yok ve yorum kısıtı yazılı',
      banners.length === 2 && banners[0].origin === 'MEASURED' && banners[1].origin === 'MODEL' && banners[1].text.includes('ölçüm değildir') &&
        measuredText.includes('675,40 L') && measuredText.includes('20.262,00 ₺') && measuredText.includes('375,40') && !modelText.includes('675,40 L') &&
        modelText.includes('Toplam tüketim önceki aya göre %50,1 arttı.') && !measuredText.includes('Toplam tüketim önceki aya göre') &&
        noAiModel.blocks.some((b) => b.origin === 'MODEL' && b.kind === 'note' && b.text.includes('ulaşılamadığı')) && noAiModel.blocks.filter((b) => b.origin === 'MEASURED').length === model.blocks.filter((b) => b.origin === 'MEASURED').length &&
        JSON.stringify(siteModel).includes('Orman') === false && JSON.stringify(siteModel).includes('şantiye kapsamlı'),
      `başlıklar=${banners.map((b) => b.origin).join('/')} measuredHas=${measuredText.includes('675,40 L')} modelHas=${modelText.includes('675,40 L')} noAiNote=${noAiModel.blocks.some((b) => b.origin === 'MODEL' && b.kind === 'note')}`
    );

    // === T14: saf doğrulayıcı birim testleri ===
    const F = facts;
    const vn = (text: string, evidence: any[] = [{ metric: 'total_liters', value: 675.4 }]) => verifyNarrative(F, { summary: '', findings: [{ text, evidence }], risks: [], recommendations: [] }).rejected.map((r) => r.reason);
    check(
      'T14 (doğrulayıcı birim): Türkçe sayı biçimleri (1.234,5 / 12,5 / 1.000 / 675.4) doğru ayrıştırılır; yazılan sayı gerçek ölçümün YAZILDIĞI BASAMAĞA yuvarlanmışıysa kabul (675 L, 675,4 L, %50,1, %50; 50,1 %), değilse red (676 L, 675,5 L, %51); yüzde ön/son ek; tolerans dışı dayanak (675.5) reddedilir',
      parseTrNumber('1.234,5') === 1234.5 && parseTrNumber('12,5') === 12.5 && parseTrNumber('1.000') === 1000 && parseTrNumber('675.4') === 675.4 &&
        vn('675 L kullanıldı').length === 0 && vn('675,4 L kullanıldı').length === 0 && vn('%50,1 arttı', [{ metric: 'liters_change_pct', value: 50.1 }]).length === 0 && vn('%50 arttı', [{ metric: 'liters_change_pct', value: 50.1 }]).length === 0 && vn('50,1 % arttı', [{ metric: 'liters_change_pct', value: 50.1 }]).length === 0 &&
        vn('676 L kullanıldı').length === 1 && vn('675,5 L kullanıldı').length === 1 && vn('%51 arttı', [{ metric: 'liters_change_pct', value: 50.1 }]).length === 1 &&
        vn('toplam', [{ metric: 'total_liters', value: 675.5 }]).length === 1 && vn('toplam', [{ metric: 'total_liters', value: 675.4 }]).length === 0 &&
        vn('34 AAA 01 aracı 175,4 L çekti').length === 0 && vn('34 AAA 01 ve 35 XYZ 12 araçları').some((r) => r.startsWith('UNKNOWN_VEHICLE')),
      `%51→${JSON.stringify(vn('%51 arttı', [{ metric: 'liters_change_pct', value: 50.1 }]))}`
    );

    // === T15: zamanlama hesapları (Europe/Istanbul UTC+3) ===
    check(
      'T15 (zamanlama): önceki ay Istanbul saatine göre bulunur (2001-04-01T10:00Z→2001-03; 2001-03-31T22:00Z = Istanbul 1 Nisan 01:00 → 2001-03; 2001-01-01T05:00Z→2000-12); rapor yalnız ayın 1\'inde 08:00\'dan (yerel) itibaren zamanı gelir: 1 Nisan 05:30Z (08:30) EVET, 1 Nisan 04:59Z (07:59) HAYIR, ayın 2\'si EVET',
      previousMonthOf(new Date('2001-04-01T10:00:00Z')) === '2001-03' && previousMonthOf(new Date('2001-03-31T22:00:00Z')) === '2001-03' && previousMonthOf(new Date('2001-01-01T05:00:00Z')) === '2000-12' &&
        isMonthlyReportDue(new Date('2001-04-01T05:30:00Z')) === true && isMonthlyReportDue(new Date('2001-04-01T04:59:00Z')) === false && isMonthlyReportDue(new Date('2001-04-02T00:00:00Z')) === true && isMonthlyReportDue(new Date('2001-03-31T22:00:00Z')) === false,
      `${previousMonthOf(new Date('2001-03-31T22:00:00Z'))} due(04:59Z)=${isMonthlyReportDue(new Date('2001-04-01T04:59:00Z'))}`
    );

    // === T16 (AC — otomatik üret + gönder; rol bazlı içerik; hata → yeniden deneme, çift e-posta yok) ===
    const others = await q(`SELECT id, email FROM users WHERE tenant_id = $1 AND role IN ('COMPANY_OWNER','SITE_MANAGER') AND email IS NOT NULL`, [TENANT]);
    for (const u of others) { savedEmails.push(u); await q(`UPDATE users SET email = NULL WHERE id = $1`, [u.id]); }
    const mkUser = async (suffix: string, role: string, site: string | null, email: string) => {
      const id = `usr-rep724-${suffix}-${RUN}`; userIds.push(id);
      await q(`INSERT INTO users (id, tenant_id, username, password_hash, role, site_name, email) SELECT $1, $2, $3, password_hash, $4, $5, $6 FROM users WHERE username = 'camsa'`, [id, TENANT, `rep724-${suffix}-${RUN}`, role, site, email]);
      return id;
    };
    const ownerMail = `owner-${RUN}@test.local`; const gebzeMail = `gebze-${RUN}@test.local`; const bounceMail = `bounce-${RUN}@test.local`;
    await mkUser('owner', 'COMPANY_OWNER', null, ownerMail);
    await mkUser('gebze', 'SITE_MANAGER', GEBZE, gebzeMail);
    const bounceId = await mkUser('bounce', 'SITE_MANAGER', ORMAN, bounceMail);
    await q(`DELETE FROM monthly_management_reports WHERE tenant_id = $1 AND period_month = $2`, [TENANT, MONTH]);

    const NOW = new Date('2001-04-02T10:00:00Z'); // Istanbul 2 Nisan 13:00 → hedef ay 2001-03
    const deps = { generateContent: async () => JSON.stringify(GOOD_MODEL) };
    const early = await inTenant(() => runMonthlyManagementReportSweepForCurrentTenant(new Date('2001-04-01T04:00:00Z'), deps)); // 07:00 yerel: henüz erken
    const early_rec = await inTenant(() => getMonthlyReportRecord(MONTH));
    const sweep1 = await inTenant(() => runMonthlyManagementReportSweepForCurrentTenant(NOW, deps));
    const rec1 = (await inTenant(() => getMonthlyReportRecord(MONTH)))!;
    const toOwner = received.filter((m) => m.to === ownerMail); const toGebze = received.filter((m) => m.to === gebzeMail);
    const ownerPdf = toOwner[0] ? mailAttachmentBytes(toOwner[0].raw) : Buffer.alloc(0); const gebzePdf = toGebze[0] ? mailAttachmentBytes(toGebze[0].raw) : Buffer.alloc(0);
    const ownerBody = toOwner[0] ? decodeBody(toOwner[0].raw) : ''; const gebzeBody = toGebze[0] ? decodeBody(toGebze[0].raw) : '';
    check(
      'T16a (AC — otomatik üret + gönder): ayın 1\'inde 08:00\'dan ÖNCE tur hiçbir şey üretmez; sonrasında önceki ay (2001-03) üretilir; COMPANY_OWNER firma geneli PDF ekli e-posta alır (675,40 L, yorum bölümü var); Gebze SITE_MANAGER YALNIZ Gebze (375,40 L, "yalnızca firma geneli raporda") PDF alır; hatalı adrese (550) gidemeyen 1 alıcı yüzünden durum KISMEN_GÖNDERILDI, deneme 1',
      early.generated === false && early.delivery === null && early_rec === null &&
        sweep1.generated === true && sweep1.month === '2001-03' && toOwner.length === 1 && toGebze.length === 1 && received.filter((m) => m.to === bounceMail).length === 0 &&
        ownerPdf.subarray(0, 5).toString('latin1') === '%PDF-' && gebzePdf.subarray(0, 5).toString('latin1') === '%PDF-' && ownerPdf.length !== gebzePdf.length &&
        ownerBody.includes('675,40 L') && ownerBody.includes('ekteki raporun B bölümünde') && gebzeBody.includes('375,40 L') && !gebzeBody.includes('675,40') && !gebzeBody.includes('Orman') && gebzeBody.includes('yalnızca firma geneli raporda') &&
        rec1.email_status === 'KISMEN_GÖNDERILDI' && rec1.email_attempts === 1 && rec1.emailed_user_ids.length === 2 && !rec1.emailed_user_ids.includes(bounceId) && /bounce/.test(rec1.last_email_error ?? ''),
      `early=${early.generated}/${early_rec === null ? 'kayıtYok' : 'VAR'} sweep1=${sweep1.month}/${sweep1.generated} owner=${toOwner.length} gebze=${toGebze.length} durum=${rec1.email_status}/${rec1.email_attempts} ownerPdf=${ownerPdf.length}B gebzePdf=${gebzePdf.length}B`
    );

    const sweep2 = await inTenant(() => runMonthlyManagementReportSweepForCurrentTenant(NOW, deps));
    const rec2 = (await inTenant(() => getMonthlyReportRecord(MONTH)))!;
    const sweep3 = await inTenant(() => runMonthlyManagementReportSweepForCurrentTenant(NOW, deps));
    const rec3 = (await inTenant(() => getMonthlyReportRecord(MONTH)))!;
    const sweep4 = await inTenant(() => runMonthlyManagementReportSweepForCurrentTenant(NOW, deps));
    const cnt = await q(`SELECT COUNT(*)::int AS c FROM monthly_management_reports WHERE tenant_id = $1 AND period_month = $2`, [TENANT, MONTH]);
    check(
      'T16b (AC — hata kaydı + yeniden deneme, çift e-posta yok): sonraki turlar YENİ rapor üretmez (tek satır), yalnızca teslim edilemeyene yeniden dener (deneme 2, 3); başarılı alıcılara İKİNCİ e-posta GİTMEZ (owner/gebze hâlâ 1); 3. başarısızlıkta KALICI_BAŞARISIZ olur ve sonraki tur artık denemez',
      sweep2.generated === false && rec2.email_attempts === 2 && rec2.email_status === 'KISMEN_GÖNDERILDI' && sweep3.generated === false && rec3.email_attempts === 3 && rec3.email_status === 'KALICI_BAŞARISIZ' &&
        sweep4.delivery === null && cnt[0].c === 1 && received.filter((m) => m.to === ownerMail).length === 1 && received.filter((m) => m.to === gebzeMail).length === 1,
      `attempts=${rec2.email_attempts}→${rec3.email_attempts} durum=${rec3.email_status} satır=${cnt[0].c} owner=${received.filter((m) => m.to === ownerMail).length} gebze=${received.filter((m) => m.to === gebzeMail).length}`
    );

    // === T17: bozuk alıcı düzelince (başarı yolu): yeni ay, hepsi teslim → GÖNDERILDI ===
    await q(`UPDATE users SET email = $2 WHERE id = $1`, [bounceId, `okorman-${RUN}@test.local`]);
    await q(`DELETE FROM monthly_management_reports WHERE tenant_id = $1 AND period_month = $2`, [TENANT, MONTH]);
    const before = received.length;
    await inTenant(() => runMonthlyManagementReportSweepForCurrentTenant(NOW, deps));
    const fin = (await inTenant(() => getMonthlyReportRecord(MONTH)))!;
    const ormanMail = received.slice(before).find((m) => m.to === `okorman-${RUN}@test.local`);
    check('T17: tüm alıcılar teslim edilebilirse durum GÖNDERILDI, emailed_at dolu, 3 alıcı e-posta alır; Orman SITE_MANAGER\'ın e-postası YALNIZ Orman verisini (300,00 L) taşır', fin.email_status === 'GÖNDERILDI' && !!fin.emailed_at && fin.emailed_user_ids.length === 3 && received.length - before === 3 && !!ormanMail && decodeBody(ormanMail.raw).includes('300,00 L') && !decodeBody(ormanMail.raw).includes('675,40'), `durum=${fin.email_status} yeniMail=${received.length - before} orman=${ormanMail ? decodeBody(ormanMail.raw).split('\n').find((l) => l.includes('Toplam yakıt')) : 'yok'}`);

    // === T18: API üretimi idempotent + yetki ===
    await q(`DELETE FROM monthly_management_reports WHERE tenant_id = $1 AND period_month = $2`, [TENANT, MONTH]);
    const p1 = await call('POST', '/management-reports', { token: owner, body: { month: MONTH } });
    const p2 = await call('POST', '/management-reports', { token: owner, body: { month: MONTH } });
    const p3 = await call('POST', '/management-reports', { token: owner, body: { month: MONTH, regenerate: true } });
    const badBody = await call('POST', '/management-reports', { token: owner, body: { month: '2001-99' } });
    const pumpPost = await call('POST', '/management-reports', { token: pumpOp, body: { month: MONTH } });
    const list = await call('GET', '/management-reports', { token: owner });
    check('T18: POST üretir (201), aynı ay tekrar POST mevcut raporu döner (200, aynı id — model yeniden çağrılmaz); regenerate:true yeniden üretir (200, aynı satır); bozuk ay 400; PUMP_OPERATOR 403; liste ay/ai/e-posta durumunu verir', p1.status === 201 && p2.status === 200 && p2.body.data.id === p1.body.data.id && p3.status === 200 && p3.body.data.id === p1.body.data.id && badBody.status === 400 && pumpPost.status === 403 && list.status === 200 && list.body.data.some((x: any) => x.period_month === MONTH), `p1=${p1.status} p2=${p2.status}(sameId=${p2.body?.data?.id === p1.body?.data?.id}) p3=${p3.status} bad=${badBody.status} pump=${pumpPost.status} liste=${list.body?.data?.length}`);

    // === T18b: idempotent üretim — mevcut ay için model TEKRAR çağrılmaz (maliyet/tutarlılık) ===
    let modelCalls = 0;
    const countingDeps = { generateContent: async () => { modelCalls++; return JSON.stringify(GOOD_MODEL); } };
    await q(`DELETE FROM monthly_management_reports WHERE tenant_id = $1 AND period_month = $2`, [TENANT, MONTH]);
    const first = await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', deps: countingDeps }));
    const again = await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', deps: countingDeps }));
    const forced = await inTenant(() => generateMonthlyManagementReport(MONTH, { generatedBy: 'test', regenerate: true, deps: countingDeps }));
    check('T18b (idempotency): aynı ay için ikinci üretim mevcut kaydı döner (created=false, model ÇAĞRILMAZ); yalnızca regenerate:true modeli yeniden çağırır ve aynı satırı günceller', first.created === true && again.created === false && again.record.id === first.record.id && forced.created === false && forced.record.id === first.record.id && modelCalls === 2, `created=${first.created}/${again.created}/${forced.created} modelÇağrısı=${modelCalls} (beklenen 2: ilk + regenerate)`);

    // === T19: audit ===
    const audits = await q(`SELECT action FROM audit_logs WHERE tenant_id = $1 AND action IN ('MONTHLY_MANAGEMENT_REPORT_GENERATED','MONTHLY_MANAGEMENT_REPORT_EMAILED') AND created_at > NOW() - INTERVAL '10 minutes'`, [TENANT]);
    check('T19 (denetim): rapor üretimi ve e-posta gönderimi audit_logs\'a yazılır', audits.some((a) => a.action === 'MONTHLY_MANAGEMENT_REPORT_GENERATED') && audits.some((a) => a.action === 'MONTHLY_MANAGEMENT_REPORT_EMAILED'), `kayıt=${audits.map((a) => a.action).join(',')}`);
  } catch (err) {
    console.error('Beklenmeyen hata:', err);
  } finally {
    await cleanup();
    await new Promise<void>((r) => smtp.close(() => r()));
  }

  console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
  process.exit(passed === total && total >= 21 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
