import { Client } from 'pg';
import Redis from 'ioredis';
import { validateTaxId } from '../src/compliance/taxIdValidation'; // saf — config yüklemez

/**
 * COMP-605 — VKN/TCKN algoritmik doğrulama + mükellefiyet sorgusu + alıcı
 * bilgisi kontrolü + e-İrsaliye entegrasyonu.
 *
 * Kraft edilmiş kimlikler:
 *   1234567808 — GEÇERLİ VKN, rakam toplamı 44 (çift) → mükellef (ELEKTRONIK)
 *   1234567890 — GEÇERLİ VKN, rakam toplamı 45 (tek)  → mükellef DEĞİL (KAĞIT)
 *   1234567891 — GEÇERSİZ VKN (kontrol hanesi tutmaz)
 *   12345678950 — GEÇERLİ TCKN
 *   12345678951 — GEÇERSİZ TCKN
 */

const API_URL = 'http://localhost:5000/api/v1';
const VKN_OBLIG = '1234567808';
const VKN_NONOBLIG = '1234567890';
const VKN_BAD = '1234567891';
const TCKN_OK = '12345678950';
const TCKN_BAD = '12345678951';

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
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any; text?: string; headers: Headers }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  const t = await res.text();
  return { status: res.status, body: {}, text: t, headers: res.headers };
}
async function login(u: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username: u, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${u}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect(); const r = await c.query(sql, params); await c.end(); return r.rows;
}
async function cleanup(): Promise<void> {
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action='RECIPIENT_TAXPAYER_UPSERTED' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q("DELETE FROM despatch_advice_documents WHERE transaction_id LIKE 'comp605-tx-%'");
  await q("DELETE FROM transactions WHERE id LIKE 'comp605-tx-%'");
  await q("DELETE FROM recipient_taxpayers WHERE tenant_id='comp-camsa' AND tax_id = ANY($1::text[])", [[VKN_OBLIG, VKN_NONOBLIG, TCKN_OK]]);
  try {
    const ks = await redis.keys('taxpayer:oblig:*'); if (ks.length) await redis.del(...ks);
  } catch { /* */ }
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [COMP-605] MÜKELLEF (VKN/TCKN) DOĞRULAMA + ALICI BİLGİSİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();
  {
    const c = pg(); await c.connect();
    const ins = (id: string) => c.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, created_at)
       VALUES ($1,'comp-camsa','Gebze Ana Şantiye','COMP605-VEH','Ahmet Yılmaz','Gebze Ana Tank (T-1)',120,'2026-09-01T09:00:00.000Z')`, [id]
    );
    await ins('comp605-tx-1'); await ins('comp605-tx-2'); await ins('comp605-tx-3');
    await c.end();
  }

  try {
    // ── Test 1: saf algoritma (unit) ──────────────────────────────
    const u = validateTaxId;
    check('Test 1: VKN/TCKN algoritması — geçerli/geçersiz ayrımı doğru',
      u(VKN_OBLIG).ok && u(VKN_OBLIG).kind === 'VKN' &&
      u(VKN_NONOBLIG).ok && !u(VKN_BAD).ok && u(VKN_BAD).kind === 'VKN' &&
      u(TCKN_OK).ok && u(TCKN_OK).kind === 'TCKN' && !u(TCKN_BAD).ok &&
      !u('123').ok && u('123').kind === null,
      `okVKN=${u(VKN_OBLIG).ok}, badVKN=${u(VKN_BAD).ok}, okTCKN=${u(TCKN_OK).ok}, badTCKN=${u(TCKN_BAD).ok}`);

    const owner = await login('camsa');
    const pumpOp = await login('pompa-op-01');

    // ── Test 2: POST /taxpayers/validate ─────────────────────────
    const v2a = await call('POST', '/taxpayers/validate', { token: owner, body: { taxId: VKN_OBLIG } });
    const v2b = await call('POST', '/taxpayers/validate', { token: owner, body: { taxId: VKN_BAD } });
    const v2c = await call('POST', '/taxpayers/validate', { token: owner, body: { taxId: TCKN_OK } });
    check('Test 2: /taxpayers/validate — geçerli VKN→mükellef, geçersiz→valid:false+reason, geçerli TCKN',
      v2a.status === 200 && v2a.body.data.valid === true && v2a.body.data.kind === 'VKN' && v2a.body.data.obligation?.obligated === true &&
      v2b.body.data.valid === false && !!v2b.body.data.reason && v2b.body.data.obligation === null &&
      v2c.body.data.valid === true && v2c.body.data.kind === 'TCKN',
      `okVKN oblig=${v2a.body.data?.obligation?.obligated}, bad valid=${v2b.body.data?.valid}, tckn=${v2c.body.data?.kind}`);

    // ── Test 3: geçersiz VKN ile recipient → 400 (AC: belge üretimini engelle) ─
    const r3 = await call('POST', '/recipients', { token: owner, body: { taxId: VKN_BAD, title: 'X', address: 'Y', taxOffice: 'Z' } });
    check('Test 3: POST /recipients geçersiz VKN → 400 INVALID_TAX_ID',
      r3.status === 400 && r3.body.details?.error === 'INVALID_TAX_ID', `status=${r3.status}, err=${r3.body.details?.error}`);

    // ── Test 4: tam alanlı, mükellef alıcı ──────────────────────
    const r4 = await call('POST', '/recipients', { token: owner, body: {
      taxId: VKN_OBLIG, title: 'Taşeron İnşaat Ltd.', address: 'OSB 3. Cad. No:5 Gebze', taxOffice: 'Gebze VD'
    }});
    check('Test 4: tam alanlı mükellef alıcı → 201, missing_fields boş, is_einvoice_obligated true, uyarı yok',
      r4.status === 201 && r4.body.data.recipient.tax_id === VKN_OBLIG && r4.body.data.recipient.tax_id_type === 'VKN' &&
      (r4.body.data.recipient.missing_fields || []).length === 0 &&
      r4.body.data.recipient.is_einvoice_obligated === true && (r4.body.data.warnings || []).length === 0,
      `status=${r4.status}, missing=${JSON.stringify(r4.body.data?.recipient?.missing_fields)}, warnings=${r4.body.data?.warnings?.length}`);
    const recipId = r4.body.data.recipient.id;

    // ── Test 5: eksik alanlı + mükellef olmayan alıcı → uyarılar ──
    const r5 = await call('POST', '/recipients', { token: owner, body: { taxId: VKN_NONOBLIG } });
    check('Test 5: yalnız taxId → 201 ama missing_fields=[title,address,tax_office] + mükellef değil uyarısı',
      r5.status === 201 &&
      JSON.stringify((r5.body.data.recipient.missing_fields || []).sort()) === JSON.stringify(['address', 'tax_office', 'title']) &&
      r5.body.data.recipient.is_einvoice_obligated === false &&
      (r5.body.data.warnings || []).length >= 2,
      `missing=${JSON.stringify(r5.body.data?.recipient?.missing_fields)}, warnings=${JSON.stringify(r5.body.data?.warnings)}`);

    // ── Test 6: listeleme + tekil + mükellefiyet tazeleme ────────
    const r6a = await call('GET', '/recipients', { token: owner });
    const r6b = await call('GET', `/recipients/${recipId}`, { token: owner });
    const r6c = await call('POST', `/recipients/${recipId}/refresh-obligation`, { token: owner });
    check('Test 6: GET /recipients (≥2), GET /recipients/:id, refresh-obligation → source CACHE değil',
      r6a.status === 200 && r6a.body.data.length >= 2 &&
      r6b.status === 200 && r6b.body.data.id === recipId &&
      r6c.status === 200 && r6c.body.data.obligation_source !== 'CACHE',
      `list=${r6a.body.totalCount}, one=${r6b.body.data?.id === recipId}, refreshSrc=${r6c.body.data?.obligation_source}`);

    // ── Test 7: e-İrsaliye — mükellef alıcı → ELEKTRONIK ─────────
    const r7j = await call('GET', `/transactions/comp605-tx-1/e-irsaliye?recipientTaxId=${VKN_OBLIG}&format=json`, { token: owner });
    const r7x = await call('GET', `/transactions/comp605-tx-1/e-irsaliye?recipientTaxId=${VKN_OBLIG}`, { token: owner });
    check('Test 7: mükellef alıcıyla e-İrsaliye → format=json 200 deliveryMode ELEKTRONIK; XML 200 + X-Delivery-Mode header',
      r7j.status === 200 && r7j.body.data?.deliveryMode === 'ELEKTRONIK' && r7j.body.data?.recipientObligated === true && !!r7j.body.data?.documentNumber &&
      r7x.status === 200 && (r7x.text || '').includes('<?xml') && r7x.headers.get('x-delivery-mode') === 'ELEKTRONIK',
      `json=${r7j.status}/${r7j.body.data?.deliveryMode}, xml=${r7x.status}/${r7x.headers.get('x-delivery-mode')}`);

    // ── Test 8: e-İrsaliye — mükellef OLMAYAN alıcı → 409 KAĞIT ──
    const r8 = await call('GET', `/transactions/comp605-tx-2/e-irsaliye?recipientTaxId=${VKN_NONOBLIG}`, { token: owner });
    const docRows = await q("SELECT delivery_mode, recipient_tax_id FROM despatch_advice_documents WHERE transaction_id = 'comp605-tx-2'");
    check('Test 8: mükellef olmayan alıcı → 409 RECIPIENT_NOT_EINVOICE_OBLIGATED, belge KAĞIT işaretli',
      r8.status === 409 && r8.body.error === 'RECIPIENT_NOT_EINVOICE_OBLIGATED' && r8.body.data?.deliveryMode === 'KAGIT' &&
      (r8.body.data?.warnings || []).some((w: string) => w.includes('KAĞIT')) &&
      docRows[0]?.delivery_mode === 'KAGIT' && docRows[0]?.recipient_tax_id === VKN_NONOBLIG,
      `status=${r8.status}, err=${r8.body.error}, mode=${r8.body.data?.deliveryMode}, doc=${docRows[0]?.delivery_mode}`);

    // ── Test 9: e-İrsaliye — geçersiz alıcı VKN → 400 ───────────
    const r9 = await call('GET', `/transactions/comp605-tx-3/e-irsaliye?recipientTaxId=${VKN_BAD}`, { token: owner });
    check('Test 9: geçersiz alıcı VKN ile e-İrsaliye → 400 INVALID_RECIPIENT_TAX_ID',
      r9.status === 400 && r9.body.details?.error === 'INVALID_RECIPIENT_TAX_ID', `status=${r9.status}, err=${r9.body.details?.error}`);

    // ── Test 10: recipientTaxId'siz e-İrsaliye (geriye uyumluluk) ─
    const r10 = await call('GET', `/transactions/comp605-tx-3/e-irsaliye`, { token: owner });
    check('Test 10: recipientTaxId verilmeden e-İrsaliye → 200 XML, deliveryMode varsayılan ELEKTRONIK',
      r10.status === 200 && (r10.text || '').includes('DespatchAdvice') && r10.headers.get('x-delivery-mode') === 'ELEKTRONIK',
      `status=${r10.status}, mode=${r10.headers.get('x-delivery-mode')}`);

    // ── Test 11: Zod + RBAC ────────────────────────────────────
    const z1 = await call('POST', '/taxpayers/validate', { token: owner, body: { taxId: '12' } });
    const z2 = await call('POST', '/recipients', { token: pumpOp, body: { taxId: VKN_OBLIG } });
    const z3 = await call('GET', '/recipients');
    check('Test 11: Zod (taxId "12" → 400); RBAC (PUMP_OPERATOR POST /recipients → 403, tokensiz GET → 401)',
      z1.status === 400 && z2.status === 403 && z3.status === 401, `zod=${z1.status}, rbac=${z2.status}/${z3.status}`);

    // ── Test 12: audit log ─────────────────────────────────────
    {
      const rows = await q(
        "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id='comp-camsa' AND action='RECIPIENT_TAXPAYER_UPSERTED' AND created_at > NOW() - INTERVAL '10 minutes'"
      );
      check('Test 12: alıcı kayıtları audit_logs’a RECIPIENT_TAXPAYER_UPSERTED olarak yazılır',
        rows[0].n >= 2, `audit=${rows[0].n}`);
    }

  } finally {
    await cleanup();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
