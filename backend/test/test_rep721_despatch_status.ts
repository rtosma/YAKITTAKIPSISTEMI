import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { MOCK_INTEGRATOR_FORCE_FAIL_PLATE } from '../src/compliance/integratorAdapter';

/**
 * REP-721 (#178) — e-İrsaliye Durum Raporu.
 *
 * Belgeler GERÇEK COMP-601..603 akışıyla (transmit → sweep → reject/cancel/resubmit) üretilir; yalnızca
 * zamana bağlı durumlar (takılı kuyruk) ve numara boşlukları SQL ile kurulur (2031–2033 yılları, gerçek
 * numaralarla karışmaz; geliştirme DB'sinde test temizlikleri zaten gerçek boşluklar bırakır).
 *
 *  T1 SENT (alıcı unvanlı) → GONDERILDI, 60 L, 1500.50 TL      T2 SENT + reject → REDDEDILDI (sebepli)
 *  T3 SENT + cancel → IPTAL                                      T4 sentinel plaka → 5 deneme → GONDERIM_BASARISIZ
 *  T5 SENDING + queued_at 2 sa önce → TAKILI                     T6 SENDING + şimdi → GONDERILIYOR (dikkat yok)
 *  T7 yalnız belge (kuyruğa alınmadı) → URETILDI                 T9 transmit, süpürülmedi → KUYRUKTA
 *  T8 SENT → REDDEDILDI → resubmit → eski YERINE_YENISI, yeni URETILDI → gönderilince GONDERILDI
 *  Boşluklar: 2031 seq 1,2,5,6,9 (ARA 3–4, ARA 7–8) | 2032 seq 3 + sayaç 5 (BASLANGIC 1–2, SON 4–5) | 2033 seq 1,3 (tek eksik)
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const VKN = '9999999990';
const TX = Array.from({ length: 9 }, (_, i) => `r721-${RUN}-t${i + 1}`);
const TX_QS = `transactionId=${TX.join(',')}&pageSize=50`;
const [T1, T2, T3, T4, T5, T6, T7, T8, T9] = TX;

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
async function call(method: string, path: string, token: string, body?: any): Promise<{ status: number; body: any; raw: string; ct: string }> {
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
    /* CSV/XML gövdesi */
  }
  return { status: res.status, body: parsed, raw, ct: res.headers.get('content-type') || '' };
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
  console.log('📄 [REP-721] e-İRSALİYE DURUM RAPORU TESTİ');
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

  async function seedTx(id: string, plate: string, liters: number, cost: number) {
    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, total_cost, created_at)
       VALUES ($1,$2,$3,$4,'Ahmet Yılmaz','Gebze Ana Tank (T-1)',$5,$6,NOW())`,
      [id, TENANT, GEBZE, plate, liters, cost]
    );
  }
  const transmit = (id: string) => call('POST', `/transactions/${id}/e-irsaliye/transmit`, owner, {});
  const sweep = () => call('POST', '/despatch-advice-transmissions/sweep', owner);
  const docOf = async (txId: string) => (await q(`SELECT * FROM despatch_advice_documents WHERE transaction_id = $1 ORDER BY created_at DESC LIMIT 1`, [txId]))[0];
  const rowsOf = async (qs = TX_QS, token = owner, id = 'rep-721') => call('GET', `/reports/${id}?${qs}`, token);
  const byTx = (body: any, tx: string) => (body?.data || []).find((r: any) => r.id === docIds[tx]);
  const docIds: Record<string, string> = {};

  const yearDocIds: string[] = [];
  async function yearDoc(year: number, seq: number, day: string) {
    const id = `da-r721-${RUN}-${year}-${seq}`;
    yearDocIds.push(id);
    await q(
      `INSERT INTO despatch_advice_documents (id, tenant_id, transaction_id, document_number, ettn, issue_year, sequence_no, created_at)
       VALUES ($1,$2,$3,$4,gen_random_uuid(),$5,$6,$7)`,
      [id, TENANT, `r721-none-${RUN}-${year}-${seq}`, `IRS${year}${String(seq).padStart(9, '0')}`, year, seq, `${year}-${day}T09:00:00Z`]
    );
  }

  try {
    await seedTx(T1, 'R721-VEH-1', 60, 1500.5);
    await seedTx(T2, 'R721-VEH-2', 40, 1000);
    await seedTx(T3, 'R721-VEH-3', 25, 600.25);
    await seedTx(T4, MOCK_INTEGRATOR_FORCE_FAIL_PLATE, 10, 250);
    await seedTx(T5, 'R721-VEH-5', 20, 500);
    await seedTx(T6, 'R721-VEH-6', 30, 750);
    await seedTx(T7, 'R721-VEH-7', 5, 125);
    await seedTx(T8, 'R721-VEH-8', 50, 1250);
    await seedTx(T9, 'R721-VEH-9', 15, 375);

    // Alıcı unvanı: gerçek COMP-605 tablosuna kayıt; belgenin VKN'si SQL ile bağlanır (append-only tablo → süper kullanıcı).
    await q(
      `INSERT INTO recipient_taxpayers (id, tenant_id, tax_id, tax_id_type, title, created_by) VALUES ($1,$2,$3,'VKN','R721 Alıcı A.Ş.','test')
       ON CONFLICT (tenant_id, tax_id) DO UPDATE SET title = 'R721 Alıcı A.Ş.'`,
      [`rt-r721-${RUN}`, TENANT, VKN]
    );

    // === Gerçek akışlar ===
    for (const t of [T1, T2, T3, T4, T8]) await transmit(t);
    for (let i = 0; i < 5; i++) await sweep(); // T4 sentinel: 5 deneme → kalıcı FAILED
    await call('POST', `/transactions/${T2}/e-irsaliye/reject`, owner, { reason: 'Miktar sevk irsaliyesiyle uyuşmuyor.' });
    await call('POST', `/transactions/${T3}/e-irsaliye/cancel`, owner, { reason: 'Sevkiyat müşteri talebiyle iptal edildi.' });
    await call('GET', `/transactions/${T7}/e-irsaliye?format=json`, owner);
    for (const t of [T5, T6]) await transmit(t);
    for (const t of TX) docIds[t] = (await docOf(t))?.id;
    await q(`UPDATE despatch_advice_documents SET recipient_tax_id = $2 WHERE id = $1`, [docIds[T1], VKN]);
    await q(`UPDATE despatch_advice_transmissions SET status = 'SENDING', queued_at = NOW() - INTERVAL '2 hours' WHERE despatch_advice_document_id = $1`, [docIds[T5]]);
    await q(`UPDATE despatch_advice_transmissions SET status = 'SENDING', queued_at = NOW() WHERE despatch_advice_document_id = $1`, [docIds[T6]]);
    await transmit(T9); // süpürülmeden hemen okunacak (KUYRUKTA)
    docIds[T9] = (await docOf(T9))?.id;

    const rep = await rowsOf();
    const r = (t: string) => byTx(rep.body, t);
    const ettn1 = (await q('SELECT ettn::text FROM despatch_advice_documents WHERE id = $1', [docIds[T1]]))[0].ettn;
    // Arka plan süpürücüsü (dakikada bir) QUEUED satırı testin ortasında göndermesin: KUYRUKTA yalnız Test 1'de (yukarıdaki okumada) doğrulanır, sonra taze SENDING'e sabitlenir.
    await q(`UPDATE despatch_advice_transmissions SET status = 'SENDING', queued_at = NOW() WHERE despatch_advice_document_id = $1`, [docIds[T9]]);

    // === Test 1 (AC1 — hepsi durum + GİB koduyla): dokuz belge, her biri beklenen durum/kod/sebep/litre/tutar/alıcı ===
    check(
      'Test 1 (AC — tüm belgeler durum ve GİB koduyla): T1 GONDERILDI (kod MOCKREF-<ettn>, 60 L, 1500.50 TL, alıcı "R721 Alıcı A.Ş."), T2 REDDEDILDI (sebep dolu), T3 IPTAL, T4 GONDERIM_BASARISIZ (5 deneme, kod yok), T5 GONDERILIYOR(takılı), T6 GONDERILIYOR, T7 URETILDI (iletim yok), T8 GONDERILDI, T9 KUYRUKTA',
      rep.status === 200 && rep.body.data.length === 9 &&
        r(T1)?.status_code === 'GONDERILDI' && r(T1)?.gib_code === `MOCKREF-${ettn1}` && r(T1)?.ettn === ettn1 && near(r(T1)?.liters, 60) && near(r(T1)?.amount, 1500.5) && r(T1)?.recipient === 'R721 Alıcı A.Ş.' && /^IRS\d{13}$/.test(r(T1)?.document_number) &&
        r(T2)?.status_code === 'REDDEDILDI' && r(T2)?.reason === 'Miktar sevk irsaliyesiyle uyuşmuyor.' &&
        r(T3)?.status_code === 'IPTAL' && r(T3)?.reason === 'Sevkiyat müşteri talebiyle iptal edildi.' &&
        r(T4)?.status_code === 'GONDERIM_BASARISIZ' && r(T4)?.attempt_count === 5 && r(T4)?.gib_code === null &&
        r(T5)?.status_code === 'GONDERILIYOR' && r(T6)?.status_code === 'GONDERILIYOR' && r(T7)?.status_code === 'URETILDI' && r(T7)?.transmission_status === null && r(T8)?.status_code === 'GONDERILDI' && r(T9)?.status_code === 'KUYRUKTA',
      `rows=${rep.body?.data?.length}, statuses=${TX.map((t) => r(t)?.status_code).join('/')}, gib1=${r(T1)?.gib_code}`
    );

    // === Test 2 (Kapsam — durum bazlı sayaçlar): özet sayaçlar ve rep-721-durum kırılımı aynı sayıları verir ===
    const ag = rep.body?.aggregates || {};
    const dur = await call('GET', `/reports/rep-721-durum?transactionId=${TX.join(',')}&pageSize=50`, owner);
    const cnt = (s: string) => n((dur.body?.data || []).find((x: any) => x.status_code === s)?.document_count ?? 0);
    check(
      'Test 2 (Kapsam — durum sayaçları): 9 belge; iletilen (SENT) 4 (T1,T2,T3,T8); onaylanan 2 (T1,T8); reddedilen 1; iptal 1; takılı 1 (T5); gönderim hatası 1 (T4); litre 255, tutar 6350.75; rep-721-durum kırılımı: GONDERILDI 2 (T1,T8), REDDEDILDI 1, IPTAL 1, GONDERIM_BASARISIZ 1, GONDERILIYOR 3 (T5,T6,T9; T9 Test 1 sonrası sabitlendi), URETILDI 1',
      n(ag.total_documents) === 9 && n(ag.sent_count) === 4 && n(ag.accepted_count) === 2 && n(ag.rejected_count) === 1 && n(ag.cancelled_count) === 1 && n(ag.stuck_count) === 1 && n(ag.failed_count) === 1 &&
        near(ag.total_liters, 255) && near(ag.total_amount, 6350.75) &&
        cnt('GONDERILDI') === 2 && cnt('REDDEDILDI') === 1 && cnt('IPTAL') === 1 && cnt('GONDERIM_BASARISIZ') === 1 && cnt('GONDERILIYOR') === 3 && cnt('URETILDI') === 1 && cnt('KUYRUKTA') === 0 &&
        near(dur.body?.aggregates?.total_amount, 6350.75) && n(dur.body?.aggregates?.total_documents) === 9,
      `agg=${JSON.stringify(ag)}, durum=${(dur.body?.data || []).map((x: any) => `${x.status_code}:${x.document_count}`).join(',')}`
    );

    // === Test 3 (AC — reddedilen/takılı öne çıkarma): attention filtreleri + sortBy=attention_rank + çoklu durum filtresi ===
    const red = await rowsOf(`${TX_QS}&attention=RED`);
    const stuck = await rowsOf(`${TX_QS}&attention=TAKILI`);
    const failed = await rowsOf(`${TX_QS}&attention=GONDERIM_HATASI`);
    const sorted = await rowsOf(`${TX_QS}&sortBy=attention_rank&sortDir=desc`);
    const multi = await rowsOf(`${TX_QS}&status=REDDEDILDI,IPTAL`);
    const ids = (b: any) => (b?.data || []).map((x: any) => x.id).sort().join(',');
    check(
      'Test 3 (AC — öne çıkarma): attention=RED → yalnız T2; TAKILI → yalnız T5 (T6 taze SENDING ve T9 taze KUYRUKTA DEĞİL); GONDERIM_HATASI → yalnız T4; attention_rank azalan sıralamada 3 dikkatli belge ilk 3 satır; status=REDDEDILDI,IPTAL → T2+T3',
      ids(red.body) === docIds[T2] && ids(stuck.body) === docIds[T5] && ids(failed.body) === docIds[T4] &&
        sorted.body.data.slice(0, 3).every((x: any) => x.attention_rank === 1) && sorted.body.data.slice(3).every((x: any) => x.attention_rank === 0) &&
        ids(multi.body) === [docIds[T2], docIds[T3]].sort().join(',') && r(T6)?.attention === '-' && r(T9)?.attention === '-',
      `red=${red.body?.data?.length}, stuck=${stuck.body?.data?.length}, failed=${failed.body?.data?.length}, rank=${sorted.body?.data?.map((x: any) => x.attention_rank).join('')}`
    );

    // === Test 4 (AC2 — numara boşlukları): satır uyarısı, tek/çoklu eksik, tarih filtresinden bağımsızlık, ayrı boşluk raporu (BASLANGIC/ARA/SON) ===
    for (const [s, d] of [[1, '01-01'], [2, '01-02'], [5, '01-05'], [6, '01-06'], [9, '01-09']] as const) await yearDoc(2031, s, d);
    await yearDoc(2032, 3, '02-03');
    await yearDoc(2033, 1, '03-01');
    await yearDoc(2033, 3, '03-03');
    await q(`INSERT INTO despatch_advice_counters (tenant_id, issue_year, last_sequence) VALUES ($1,2031,9),($1,2032,5),($1,2033,3) ON CONFLICT (tenant_id, issue_year) DO UPDATE SET last_sequence = EXCLUDED.last_sequence`, [TENANT]);
    const y31 = await call('GET', '/reports/rep-721?year=2031&pageSize=50&sortBy=created_at&sortDir=asc', owner);
    const seq = (b: any, s: number) => (b.body.data || []).find((x: any) => x.document_number === `IRS2031${String(s).padStart(9, '0')}`);
    const gapOnly = await call('GET', '/reports/rep-721?year=2031&gapOnly=1&pageSize=50', owner);
    const late = await call('GET', '/reports/rep-721?year=2031&startDate=2031-01-05&pageSize=50', owner);
    const y33 = await call('GET', '/reports/rep-721?year=2033&pageSize=50', owner);
    const gaps31 = await call('GET', '/reports/rep-721-bosluk?year=2031', owner);
    const gaps32 = await call('GET', '/reports/rep-721-bosluk?year=2032', owner);
    const gaps33 = await call('GET', '/reports/rep-721-bosluk?year=2033', owner);
    const g = (b: any) => (b.body.data || []).map((x: any) => `${x.gap_type}:${x.from_number.slice(-9)}-${x.to_number.slice(-9)}:${x.missing_count}`).sort().join('|');
    check(
      'Test 4 (AC — numara boşlukları): 2031 (1,2,5,6,9): seq5 uyarısı "BOŞLUK: IRS2031000000003 – IRS2031000000004 eksik (2)", seq9 "…07 – …08 eksik (2)", diğerleri uyarısız; gapOnly=1 → 2 belge, eksik toplamı 4; startDate=2031-01-05 filtresi seq5\'in boşluğunu 2 tutar (yeniden hesaplanmaz); 2033 (1,3) → "BOŞLUK: IRS2033000000002 eksik (1)"; rep-721-bosluk: 2031 ARA 3–4 + ARA 7–8, 2032 BASLANGIC 1–2 + SON 4–5 (sayaç ileride), 2033 ARA 2–2',
      seq(y31, 5)?.numbering_warning === 'BOŞLUK: IRS2031000000003 – IRS2031000000004 eksik (2)' && seq(y31, 9)?.numbering_warning === 'BOŞLUK: IRS2031000000007 – IRS2031000000008 eksik (2)' &&
        [1, 2, 6].every((s) => seq(y31, s)?.numbering_warning === null && seq(y31, s)?.gap_before === 0) &&
        gapOnly.body.data.length === 2 && n(gapOnly.body.aggregates.missing_numbers) === 4 &&
        late.body.data.length === 3 && (late.body.data || []).find((x: any) => x.document_number.endsWith('000000005'))?.gap_before === 2 &&
        y33.body.data.find((x: any) => x.document_number.endsWith('000000003'))?.numbering_warning === 'BOŞLUK: IRS2033000000002 eksik (1)' &&
        g(gaps31) === 'ARA:000000003-000000004:2|ARA:000000007-000000008:2' && g(gaps32) === 'BASLANGIC:000000001-000000002:2|SON:000000004-000000005:2' && g(gaps33) === 'ARA:000000002-000000002:1' &&
        n(gaps31.body.aggregates.total_missing) === 4 && n(gaps32.body.aggregates.total_gaps) === 2,
      `w5=${seq(y31, 5)?.numbering_warning}, gapOnly=${gapOnly.body?.data?.length}/${gapOnly.body?.aggregates?.missing_numbers}, gaps31=${g(gaps31)}, gaps32=${g(gaps32)}, gaps33=${g(gaps33)}`
    );

    // === Test 5 (AC3 — indirme): rapordaki bağlantılar çalışır; XML arşiv içeriğiyle birebir, PDF %PDF-; arşivsiz belge 404 XML_NOT_ARCHIVED ve xml_link boş; hatalı format 400; her indirme audit'li ===
    const stamp = new Date();
    const link = (t: string, k: 'xml_link' | 'pdf_link') => (r(t)?.[k] as string | null)?.replace('/api/v1', '');
    const xml = await call('GET', link(T1, 'xml_link')!, owner);
    const snap = (await q('SELECT xml_snapshot FROM despatch_advice_transmissions WHERE despatch_advice_document_id = $1', [docIds[T1]]))[0].xml_snapshot;
    const pdf = await fetch(`${API_URL}${link(T1, 'pdf_link')}`, { headers: { Authorization: `Bearer ${owner}` } });
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    const noXml = await call('GET', `/despatch-advice-documents/${docIds[T7]}/download?format=xml`, owner);
    const pdfNoXml = await fetch(`${API_URL}/despatch-advice-documents/${docIds[T7]}/download?format=pdf`, { headers: { Authorization: `Bearer ${owner}` } });
    const badFmt = await call('GET', `/despatch-advice-documents/${docIds[T1]}/download?format=docx`, owner);
    const missing = await call('GET', `/despatch-advice-documents/da-yok-${RUN}/download?format=xml`, owner);
    const dlAudit = await q(`SELECT after_value FROM audit_logs WHERE action = 'DESPATCH_ADVICE_DOWNLOAD' AND target_id = ANY($1) AND created_at >= $2`, [[docIds[T1], docIds[T7]], stamp]);
    check(
      'Test 5 (AC — indirme bağlantıları): xml_link/pdf_link çalışır; XML indirmesi xml_snapshot ile birebir aynı (application/xml, belge no içerir); PDF %PDF-; iletilmemiş T7 için xml_link null + XML 404 XML_NOT_ARCHIVED, PDF yine indirilir; format=docx → 400; olmayan belge 404; başarılı 3 indirme audit\'e yazıldı',
      xml.status === 200 && xml.ct.includes('application/xml') && xml.raw === snap && xml.raw.includes(r(T1).document_number) &&
        pdf.status === 200 && pdfBuf.subarray(0, 5).toString('latin1') === '%PDF-' && r(T7)?.xml_link === null && /\/download\?format=pdf$/.test(r(T7)?.pdf_link) &&
        noXml.status === 404 && noXml.body?.details?.error === 'XML_NOT_ARCHIVED' && pdfNoXml.status === 200 &&
        badFmt.status === 400 && missing.status === 404 && dlAudit.length === 3 && dlAudit.filter((a: any) => a.after_value.format === 'xml').length === 1,
      `xml=${xml.status}/${xml.ct}, eşit=${xml.raw === snap}, pdf=${pdf.status}, noXml=${noXml.status}/${noXml.body?.details?.error}, bad=${badFmt.status}, missing=${missing.status}, audit=${dlAudit.length}`
    );

    // === Test 6 (AC — rol/şantiye): Gebze SITE_MANAGER yalnız Gebze belgelerini görür/indirir (2031-33 şantiyesiz belgeler görünmez); Silivri SITE_MANAGER hiçbirini; PUMP_OPERATOR 403; boşluk raporu yalnız SUPER_ADMIN/COMPANY_OWNER; katalog ===
    const gm = await rowsOf(TX_QS, gebzeMgr);
    const gmYears = await call('GET', '/reports/rep-721?year=2031&pageSize=50', gebzeMgr);
    const sm = await rowsOf(TX_QS, silivriMgr);
    const gmDl = await call('GET', `/despatch-advice-documents/${docIds[T1]}/download?format=xml`, gebzeMgr);
    const smDl = await call('GET', `/despatch-advice-documents/${docIds[T1]}/download?format=xml`, silivriMgr);
    const pumpRep = await rowsOf(TX_QS, pumpOp);
    const pumpDl = await call('GET', `/despatch-advice-documents/${docIds[T1]}/download?format=pdf`, pumpOp);
    const pumpDur = await call('GET', '/reports/rep-721-durum', pumpOp);
    const gmGaps = await call('GET', '/reports/rep-721-bosluk', gebzeMgr);
    const catO = await call('GET', '/reports', owner);
    const catG = await call('GET', '/reports', gebzeMgr);
    const catP = await call('GET', '/reports', pumpOp);
    const cat = (c: any) => new Set((c.body?.data || []).map((x: any) => x.id));
    check(
      'Test 6 (AC — rol görünürlüğü): Gebze SITE_MANAGER 9 belge görür/XML indirir, 2031 şantiyesiz belgeleri GÖRMEZ; Silivri SITE_MANAGER 0 belge, indirme 404 (varlık sızmaz); PUMP_OPERATOR rapor/durum/indirme 403; rep-721-bosluk SITE_MANAGER 403; katalog: owner 3 rapor, Gebze mgr rep-721+durum (bosluk YOK), pompa hiçbiri',
      gm.status === 200 && gm.body.data.length === 9 && gm.body.data.every((x: any) => x.site_name === GEBZE) && gmYears.body.data.length === 0 && sm.status === 200 && sm.body.data.length === 0 &&
        gmDl.status === 200 && smDl.status === 404 && smDl.body?.details?.error === 'DESPATCH_ADVICE_NOT_FOUND' &&
        pumpRep.status === 403 && pumpDl.status === 403 && pumpDur.status === 403 && gmGaps.status === 403 &&
        ['rep-721', 'rep-721-durum', 'rep-721-bosluk'].every((id) => cat(catO).has(id)) && cat(catG).has('rep-721') && cat(catG).has('rep-721-durum') && !cat(catG).has('rep-721-bosluk') &&
        ['rep-721', 'rep-721-durum', 'rep-721-bosluk'].every((id) => !cat(catP).has(id)),
      `gm=${gm.body?.data?.length}, gmYears=${gmYears.body?.data?.length}, sm=${sm.body?.data?.length}, dl=${gmDl.status}/${smDl.status}, pump=${pumpRep.status}/${pumpDl.status}/${pumpDur.status}, gapsGm=${gmGaps.status}`
    );

    // === Test 7 (AC — CSV/PDF/JSON tutarlılığı): üç rapor için CSV satır sayısı = JSON; hücreler (belge no, durum metni, GİB kodu, uyarı, link) eşleşir; PDF %PDF- ===
    const csv = await call('GET', `/reports/rep-721/export?format=csv&${TX_QS}`, owner);
    const csvDur = await call('GET', `/reports/rep-721-durum/export?format=csv&transactionId=${TX.join(',')}`, owner);
    const csvGap = await call('GET', '/reports/rep-721-bosluk/export?format=csv&year=2031', owner);
    const csvLines = (raw: string) => raw.split('\r\n').filter(Boolean).length - 1;
    const line1 = csv.raw.split('\r\n').find((l) => l.includes(r(T1).document_number)) || '';
    const pdfs = await Promise.all(
      [`rep-721?${TX_QS}`, `rep-721-durum?transactionId=${TX.join(',')}`, 'rep-721-bosluk?year=2031'].map(async (p) => {
        const [id, qs] = p.split('?');
        const res = await fetch(`${API_URL}/reports/${id}/export?format=pdf&${qs}`, { headers: { Authorization: `Bearer ${owner}` } });
        return { status: res.status, magic: Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString('latin1') };
      })
    );
    check(
      'Test 7 (AC — CSV/PDF/JSON tutarlılığı): rep-721 CSV 9 satır (=JSON), durum kırılımı CSV 6 (=JSON), boşluk CSV 2 (=JSON); T1 satırında "GÖNDERİLDİ", MOCKREF kodu ve indirme bağlantıları; üç rapor PDF 200 + %PDF-',
      csvLines(csv.raw) === rep.body.pagination.totalCount && csvLines(csv.raw) === 9 && csvLines(csvDur.raw) === dur.body.pagination.totalCount && csvLines(csvDur.raw) === 6 && csvLines(csvGap.raw) === gaps31.body.pagination.totalCount && csvLines(csvGap.raw) === 2 &&
        line1.includes('GÖNDERİLDİ') && line1.includes(`MOCKREF-${ettn1}`) && line1.includes(r(T1).xml_link) && line1.includes(r(T1).pdf_link) && csv.raw.includes('TAKILI') &&
        pdfs.every((p) => p.status === 200 && p.magic === '%PDF-'),
      `csv=${csvLines(csv.raw)}/${rep.body?.pagination?.totalCount}, durum=${csvLines(csvDur.raw)}/${dur.body?.pagination?.totalCount}, gap=${csvLines(csvGap.raw)}, pdf=${pdfs.map((p) => p.status).join('/')}`
    );

    // === Test 8 (Kapsam — canlı yaşam döngüsü): T8 GONDERILDI → reject → REDDEDILDI → resubmit → eski YERINE_YENISI, yeni URETILDI → gönderilince GONDERILDI; iki belge birlikte listelenir ===
    const s0 = (await rowsOf(`transactionId=${T8}`)).body.data;
    await call('POST', `/transactions/${T8}/e-irsaliye/reject`, owner, { reason: 'Alıcı reddetti (R721).' });
    const s1 = (await rowsOf(`transactionId=${T8}`)).body.data;
    await call('POST', `/transactions/${T8}/e-irsaliye/resubmit`, owner);
    const s2 = (await rowsOf(`transactionId=${T8}`)).body.data;
    await transmit(T8);
    await sweep();
    const s3 = (await rowsOf(`transactionId=${T8}&sortBy=created_at&sortDir=asc`)).body.data;
    check(
      'Test 8 (Kapsam — yaşam döngüsü): T8 önce GONDERILDI(1 belge) → reject → REDDEDILDI(sebep) → resubmit → 2 belge: eski YERINE_YENISI, yeni URETILDI → transmit+sweep → yeni GONDERILDI (eski YERINE_YENISI kalır, farklı belge no)',
      s0.length === 1 && s0[0].status_code === 'GONDERILDI' && s1[0].status_code === 'REDDEDILDI' && s1[0].reason === 'Alıcı reddetti (R721).' &&
        s2.length === 2 && s2.map((x: any) => x.status_code).sort().join() === 'URETILDI,YERINE_YENISI' &&
        s3.length === 2 && s3[0].status_code === 'YERINE_YENISI' && s3[1].status_code === 'GONDERILDI' && s3[0].document_number !== s3[1].document_number && !!s3[1].gib_code,
      `s0=${s0.map((x: any) => x.status_code)}, s1=${s1.map((x: any) => x.status_code)}, s2=${s2.map((x: any) => x.status_code)}, s3=${s3.map((x: any) => x.status_code)}`
    );
  } finally {
    await q(`DELETE FROM despatch_advice_documents_status WHERE despatch_advice_document_id IN (SELECT id FROM despatch_advice_documents WHERE transaction_id = ANY($1))`, [TX]);
    await q('DELETE FROM despatch_advice_transmissions WHERE transaction_id = ANY($1)', [TX]);
    await q('DELETE FROM despatch_advice_documents WHERE transaction_id = ANY($1) OR id = ANY($2)', [TX, yearDocIds]);
    await q('DELETE FROM despatch_advice_counters WHERE tenant_id = $1 AND issue_year IN (2031, 2032, 2033)', [TENANT]);
    await q('DELETE FROM recipient_taxpayers WHERE tenant_id = $1 AND tax_id = $2', [TENANT, VKN]);
    await q('DELETE FROM transactions WHERE id = ANY($1)', [TX]);
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
