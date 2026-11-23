import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * INV-1507 — şantiye laboratuvar numunesi + test sonucu takibi (AI-507'ye
 * UYGUNSUZ sonuçlarda CRITICAL alarm akışı).
 *
 * Kullanılan hazır veriler (önceki testlerle AYNI tenant): tenant comp-camsa,
 * şantiye Gebze Ana Şantiye.
 */

const API_URL = 'http://localhost:5000/api/v1';

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function resetLoginRl(): Promise<void> {
  const k = await redis.keys('rl:auth-login:*'); if (k.length) await redis.del(...k);
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json().catch(() => ({})) : {};
  return { status: res.status, body };
}
async function login(u: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username: u, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${u}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect(); const r = await c.query(sql, params); await c.end(); return r.rows;
}

let createdSampleIds: string[] = [];

async function cleanup(): Promise<void> {
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'LAB_%' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q("DELETE FROM alarms WHERE tenant_id='comp-camsa' AND category='LAB_NONCONFORMING_RESULT' AND alarm_key LIKE 'lab-nonconforming:%'");
  if (createdSampleIds.length > 0) {
    await q('DELETE FROM lab_test_results WHERE tenant_id=$1 AND sample_id = ANY($2::text[])', ['comp-camsa', createdSampleIds]);
    await q('DELETE FROM lab_samples WHERE tenant_id=$1 AND id = ANY($2::text[])', ['comp-camsa', createdSampleIds]);
  }
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [INV-1507] ŞANTİYE LABORATUVAR NUMUNE + TEST SONUCU TAKİBİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();

  try {
    const owner = await login('camsa'); // COMPANY_OWNER
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR

    // ── Test 1: numune kaydı ────────────────────────────────────────
    const r1 = await call('POST', '/lab-samples', {
      token: owner, body: { sampleType: 'BETON', siteName: 'Gebze Ana Şantiye', location: 'Temel K1', referenceNo: 'BTN-2026-001', collectedAt: '2026-06-01' }
    });
    check('Test 1: POST /lab-samples → 201, status BEKLIYOR',
      r1.status === 201 && r1.body.data.status === 'BEKLIYOR' && r1.body.data.sampleType === 'BETON',
      `status=${r1.status}, durum=${r1.body.data?.status}, tip=${r1.body.data?.sampleType}`);
    const sampleId = r1.body.data.id;
    createdSampleIds.push(sampleId);

    // ── Test 2: liste + tekil sorgu ───────────────────────────────────
    const r2list = await call('GET', '/lab-samples', { token: owner });
    const r2get = await call('GET', `/lab-samples/${sampleId}`, { token: owner });
    check('Test 2: GET liste numuneyi içerir; GET tekil AYNI kaydı döner',
      r2list.status === 200 && r2list.body.data.some((s: any) => s.id === sampleId) && r2get.status === 200 && r2get.body.data.referenceNo === 'BTN-2026-001',
      `listede=${r2list.body.data?.some((s: any) => s.id === sampleId)}, tekilRef=${r2get.body.data?.referenceNo}`);

    // ── Test 3: spec sınırları İÇİNDE sonuç → UYGUN, numune TEST_EDILDI ─
    const r3 = await call('POST', `/lab-samples/${sampleId}/results`, {
      token: owner, body: { testType: 'Basınç Dayanımı', testedAt: '2026-06-08', resultValue: 32, unit: 'MPa', specMin: 25 }
    });
    const r3sample = await call('GET', `/lab-samples/${sampleId}`, { token: owner });
    check('Test 3: 32 MPa (specMin=25 içinde) → UYGUN; numune otomatik TEST_EDILDI',
      r3.status === 201 && r3.body.data.conformity === 'UYGUN' && r3sample.body.data.status === 'TEST_EDILDI',
      `status=${r3.status}, uygunluk=${r3.body.data?.conformity}, numuneDurumu=${r3sample.body.data?.status}`);

    // ── Test 4: spec sınırının DIŞINDA sonuç → UYGUNSUZ + AI-507 CRITICAL ─
    const r4 = await call('POST', `/lab-samples/${sampleId}/results`, {
      token: owner, body: { testType: 'Basınç Dayanımı (2. Küp)', testedAt: '2026-06-08', resultValue: 18, unit: 'MPa', specMin: 25 }
    });
    const alarm4 = await q("SELECT severity, status FROM alarms WHERE tenant_id='comp-camsa' AND category='LAB_NONCONFORMING_RESULT' AND subject_id=$1", [sampleId]);
    check('Test 4: 18 MPa (specMin=25 dışında) → UYGUNSUZ + CRITICAL alarm',
      r4.status === 201 && r4.body.data.conformity === 'UYGUNSUZ' && alarm4[0]?.severity === 'CRITICAL' && alarm4[0]?.status === 'OPEN',
      `uygunluk=${r4.body.data?.conformity}, alarm=${alarm4[0]?.severity}/${alarm4[0]?.status}`);

    // ── Test 5: doğrudan (kalitatif) conformity ile sonuç ────────────────
    const r5 = await call('POST', `/lab-samples/${sampleId}/results`, {
      token: owner, body: { testType: 'Görsel Muayene', testedAt: '2026-06-08', conformity: 'UYGUN', note: 'Görsel olarak kusursuz.' }
    });
    check('Test 5: sayısal değer olmadan doğrudan conformity=UYGUN kabul edilir',
      r5.status === 201 && r5.body.data.conformity === 'UYGUN' && r5.body.data.resultValue === null,
      `status=${r5.status}, uygunluk=${r5.body.data?.conformity}, değer=${r5.body.data?.resultValue}`);

    // ── Test 6: Zod — conformity YOK ve spec de YOK → 400 ─────────────────
    const r6 = await call('POST', `/lab-samples/${sampleId}/results`, { token: owner, body: { testType: 'Belirsiz Test', testedAt: '2026-06-08', resultValue: 10 } });
    check('Test 6: conformity/spec ikisi de yoksa → 400', r6.status === 400, `status=${r6.status}`);

    // ── Test 7: sonuç geçmişi — 3 kayıt, en yeni önce ──────────────────────
    const r7 = await call('GET', `/lab-samples/${sampleId}/results`, { token: owner });
    check('Test 7: sonuç geçmişi 3 kayıt, en yeni ("Görsel Muayene") önce',
      r7.status === 200 && r7.body.data.length === 3 && r7.body.data[0].testType === 'Görsel Muayene',
      `sayı=${r7.body.data?.length}, ilk=${r7.body.data?.[0]?.testType}`);

    // ── Test 8: uygunsuz sonuçlar raporu ────────────────────────────────────
    const r8 = await call('GET', '/lab/nonconforming-results', { token: owner });
    const found8 = r8.body.data?.find((x: any) => x.sampleId === sampleId && x.testType === 'Basınç Dayanımı (2. Küp)');
    check('Test 8: GET /lab/nonconforming-results raporunda UYGUNSUZ sonuç sampleType+siteName ile görünür',
      r8.status === 200 && found8 && found8.sampleType === 'BETON' && found8.siteName === 'Gebze Ana Şantiye',
      `bulundu=${!!found8}, tip=${found8?.sampleType}, şantiye=${found8?.siteName}`);

    // ── Test 9: numune iptali + tekrar iptal reddi ────────────────────────
    const r9a = await call('POST', `/lab-samples/${sampleId}/cancel`, { token: owner, body: { reason: 'Numune bozulmuş, tekrar alınacak.' } });
    const r9b = await call('POST', `/lab-samples/${sampleId}/cancel`, { token: owner, body: { reason: 'İkinci iptal denemesi.' } });
    check('Test 9: iptal → 200 İPTAL; tekrar iptal → 409 ALREADY_CANCELLED',
      r9a.status === 200 && r9a.body.data.status === 'İPTAL' && r9b.status === 409 && r9b.body.details?.error === 'ALREADY_CANCELLED',
      `iptal=${r9a.status}/${r9a.body.data?.status}, tekrar=${r9b.status}/${r9b.body.details?.error}`);

    // ── Test 10: iptal edilmiş numuneye sonuç eklenemez ───────────────────
    const r10 = await call('POST', `/lab-samples/${sampleId}/results`, { token: owner, body: { testType: 'X', testedAt: '2026-06-09', conformity: 'UYGUN' } });
    check('Test 10: İPTAL numuneye sonuç eklenemez → 409 SAMPLE_CANCELLED',
      r10.status === 409 && r10.body.details?.error === 'SAMPLE_CANCELLED', `status=${r10.status}, err=${r10.body.details?.error}`);

    // ── Test 11: Zod — geçersiz sampleType ────────────────────────────────
    const r11 = await call('POST', '/lab-samples', { token: owner, body: { sampleType: 'GEÇERSİZ', siteName: 'Gebze Ana Şantiye', collectedAt: '2026-06-01' } });
    check('Test 11: Zod — geçersiz sampleType → 400', r11.status === 400, `status=${r11.status}`);

    // ── Test 12: RBAC — PUMP_OPERATOR / tokensiz ──────────────────────────
    const r12a = await call('POST', '/lab-samples', { token: pumpOp, body: { sampleType: 'DİĞER', siteName: 'Gebze Ana Şantiye', collectedAt: '2026-06-01' } });
    const r12b = await call('GET', '/lab-samples', {});
    check('Test 12: RBAC — PUMP_OPERATOR numune ekleyemez → 403, tokensiz → 401',
      r12a.status === 403 && r12b.status === 401, `pumpOp=${r12a.status}, tokensiz=${r12b.status}`);

    // ── Test 13: olmayan numune → 404 ─────────────────────────────────────
    const r13a = await call('GET', '/lab-samples/nonexistent-sample-id', { token: owner });
    const r13b = await call('POST', `/lab-samples/nonexistent-sample-id/results`, { token: owner, body: { testType: 'X', testedAt: '2026-06-09', conformity: 'UYGUN' } });
    check('Test 13: olmayan numune — GET/POST results → 404 SAMPLE_NOT_FOUND',
      r13a.status === 404 && r13a.body.details?.error === 'SAMPLE_NOT_FOUND' && r13b.status === 404 && r13b.body.details?.error === 'SAMPLE_NOT_FOUND',
      `get=${r13a.status}/${r13a.body.details?.error}, post=${r13b.status}/${r13b.body.details?.error}`);

    // ── Test 14: audit_logs ────────────────────────────────────────────────
    const auditSample = await q("SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action='LAB_SAMPLE_REGISTERED' AND created_at > NOW() - INTERVAL '10 minutes'");
    const auditResult = await q("SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action='LAB_TEST_RESULT_RECORDED' AND created_at > NOW() - INTERVAL '10 minutes'");
    const auditCancel = await q("SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action='LAB_SAMPLE_CANCELLED' AND created_at > NOW() - INTERVAL '10 minutes'");
    check('Test 14: audit_logs — LAB_SAMPLE_REGISTERED (≥1), LAB_TEST_RESULT_RECORDED (≥3), LAB_SAMPLE_CANCELLED (≥1)',
      auditSample[0].c >= 1 && auditResult[0].c >= 3 && auditCancel[0].c >= 1,
      `numune=${auditSample[0].c}, sonuç=${auditResult[0].c}, iptal=${auditCancel[0].c}`);

  } finally {
    await cleanup();
    await redis.quit();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥 Beklenmeyen hata:', err); process.exit(1); });
