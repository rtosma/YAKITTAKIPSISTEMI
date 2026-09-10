import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * AI-504 — mesai dışı / gece alımı + kısa aralıklı mükerrer alım tespiti.
 *
 * CANLI HTTP + doğrudan PG (src import YOK). Kobay şantiye: 'Silivri
 * Tesisleri'. Kontrollü ikmaller sabit UTC zaman damgalarıyla eklenir
 * (Istanbul = UTC+3):
 *   - ai504-tx-mesai-night  : 2026-09-09T00:30Z → Ist Çar 03:30 (gece, mesai dışı)
 *   - ai504-tx-mesai-sunday : 2026-09-06T10:00Z → Ist Paz 13:00 (çalışma günü dışı)
 *   - ai504-tx-repeat-1/2/3 : 2026-09-08 09:00 / 09:20 / 10:30 Z (Ist Sal öğle;
 *                             2. alım 1.'den 20 dk sonra → kısa aralıklı mükerrer)
 * Test SONUNDA (finally) tüm bu satırlar + üretilen işaretler + mesai tanımı
 * + audit kayıtları temizlenir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const SITE = 'Silivri Tesisleri';
const SINCE = 300; // saat — 2026-09-06'yı kapsayacak kadar geniş

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
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length) await redis.del(...keys);
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${username}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect();
  const r = await c.query(sql, params);
  await c.end();
  return r.rows;
}
async function flagCount(likeId: string, type?: string): Promise<number> {
  const rows = await q(
    `SELECT count(*)::int AS n FROM transaction_anomaly_flags WHERE transaction_id LIKE $1 ${type ? 'AND anomaly_type = $2' : ''}`,
    type ? [likeId, type] : [likeId]
  );
  return rows[0].n;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [AI-504] MESAİ DIŞI / KISA ARALIKLI MÜKERRER ALIM TESPİTİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  // Setup: temiz başla + kontrollü ikmalleri ekle.
  {
    const c = pg(); await c.connect();
    await c.query("DELETE FROM transaction_anomaly_flags WHERE transaction_id LIKE 'ai504-tx-%'");
    await c.query("DELETE FROM transactions WHERE id LIKE 'ai504-tx-%'");
    await c.query("DELETE FROM site_working_hours WHERE tenant_id='comp-camsa' AND site_name=$1", [SITE]);
    const ins = (id: string, plate: string, at: string) => c.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, created_at)
       VALUES ($1,'comp-camsa',$2,$3,'Test Şoför',80,$4)`,
      [id, SITE, plate, at]
    );
    await ins('ai504-tx-mesai-night', 'AI504-TEST', '2026-09-09T00:30:00.000Z');
    await ins('ai504-tx-mesai-sunday', 'AI504-TEST', '2026-09-06T10:00:00.000Z');
    await ins('ai504-tx-repeat-1', 'AI504-REPEAT', '2026-09-08T09:00:00.000Z');
    await ins('ai504-tx-repeat-2', 'AI504-REPEAT', '2026-09-08T09:20:00.000Z');
    await ins('ai504-tx-repeat-3', 'AI504-REPEAT', '2026-09-08T10:30:00.000Z');
    await c.end();
  }

  try {
    const owner = await login('camsa');            // COMPANY_OWNER
    const siteMgr = await login('silivri-santiye'); // SITE_MANAGER

    // ── Test 1: mesai tanımı yok → varsayılan ───────────────────────
    const r1 = await call('GET', `/sites/${encodeURIComponent(SITE)}/working-hours`, { token: owner });
    check('Test 1: GET working-hours (tanımsız) → isDefault:true, 07:00-19:00, Pzt-Cmt',
      r1.status === 200 && r1.body.data?.isDefault === true &&
      r1.body.data.start_minute === 420 && r1.body.data.end_minute === 1140 &&
      JSON.stringify(r1.body.data.working_days) === '[1,2,3,4,5,6]',
      `isDefault=${r1.body.data?.isDefault}, ${r1.body.data?.start_minute}-${r1.body.data?.end_minute}`);

    // ── Test 2: tarama — varsayılan mesaiyle işaretleme ─────────────
    const r2 = await call('POST', '/anomaly-flags/scan', { token: owner, body: { sinceHours: SINCE } });
    check('Test 2: scan → gece + Pazar alımı MESAI_DISI (≥2), 20 dk arayla mükerrer (≥1)',
      r2.status === 200 &&
      (await flagCount('ai504-tx-mesai-%', 'MESAI_DISI')) === 2 &&
      (await flagCount('ai504-tx-repeat-%', 'KISA_ARALIK_MUKERRER')) === 1 &&
      r2.body.data.newFlags.MESAI_DISI >= 2 && r2.body.data.newFlags.KISA_ARALIK_MUKERRER >= 1,
      `newFlags=${JSON.stringify(r2.body.data?.newFlags)}, mesaiCount=${await flagCount('ai504-tx-mesai-%', 'MESAI_DISI')}`);

    // ── Test 3: MESAI_DISI detayları (gece + çalışma günü dışı) ─────
    const r3 = await call('GET', `/anomaly-flags?type=MESAI_DISI&siteName=${encodeURIComponent(SITE)}`, { token: siteMgr });
    const night = (r3.body.data || []).find((f: any) => f.transaction_id === 'ai504-tx-mesai-night');
    const sunday = (r3.body.data || []).find((f: any) => f.transaction_id === 'ai504-tx-mesai-sunday');
    check('Test 3: gece alımı detail.isNight=true & reason=MESAI_SAATI_DISI; Pazar alımı reason=CALISMA_GUNU_DISI',
      r3.status === 200 &&
      night?.detail?.isNight === true && night?.detail?.reason === 'MESAI_SAATI_DISI' && night?.detail?.localTime === '03:30' &&
      sunday?.detail?.reason === 'CALISMA_GUNU_DISI' && sunday?.detail?.isNight === false,
      `night=${JSON.stringify(night?.detail)}, sunday.reason=${sunday?.detail?.reason}`);

    // ── Test 4: kısa aralıklı mükerrer detayları ───────────────────
    const r4 = await call('GET', '/anomaly-flags?type=KISA_ARALIK_MUKERRER', { token: owner });
    const rep = (r4.body.data || []).find((f: any) => f.transaction_id === 'ai504-tx-repeat-2');
    check('Test 4: mükerrer işaret 2. alımda, gapMinutes≈20, previousTransactionId=repeat-1, severity INCELEME',
      r4.status === 200 && rep && rep.severity === 'INCELEME' &&
      rep.detail?.previousTransactionId === 'ai504-tx-repeat-1' && Math.abs(rep.detail?.gapMinutes - 20) <= 1,
      `rep=${JSON.stringify(rep?.detail)}, severity=${rep?.severity}`);

    // ── Test 5: tespit idempotent ─────────────────────────────────
    const before5 = await flagCount('ai504-tx-%');
    await call('POST', '/anomaly-flags/scan', { token: owner, body: { sinceHours: SINCE } });
    const after5 = await flagCount('ai504-tx-%');
    check('Test 5: aynı tarama tekrar → ai504 işaret sayısı değişmez (idempotent)',
      before5 === after5 && before5 === 3, `önce=${before5}, sonra=${after5}`);

    // ── Test 6: is247 şantiye MESAI_DISI kuralından MUAF (AC) ───────
    await q("DELETE FROM transaction_anomaly_flags WHERE transaction_id LIKE 'ai504-tx-mesai-%'");
    const r6put = await call('PUT', `/sites/${encodeURIComponent(SITE)}/working-hours`, { token: owner, body: {
      startMinute: 420, endMinute: 1140, workingDays: [1, 2, 3, 4, 5, 6], is247: true, rapidRepeatWindowMinutes: 30
    }});
    await call('POST', '/anomaly-flags/scan', { token: owner, body: { sinceHours: SINCE } });
    check('Test 6: is247=true → gece/Pazar alımları YENİDEN işaretlenMEZ (muaf şantiyede kural çalışmaz)',
      r6put.status === 200 && r6put.body.data?.is_24_7 === true &&
      (await flagCount('ai504-tx-mesai-%', 'MESAI_DISI')) === 0,
      `is247=${r6put.body.data?.is_24_7}, mesaiCount=${await flagCount('ai504-tx-mesai-%', 'MESAI_DISI')}`);

    // ── Test 7: dar mesai penceresi → önceden temiz alımlar işaretlenir ─
    await q("DELETE FROM transaction_anomaly_flags WHERE transaction_id LIKE 'ai504-tx-%'");
    await call('PUT', `/sites/${encodeURIComponent(SITE)}/working-hours`, { token: owner, body: {
      startMinute: 600, endMinute: 660, workingDays: [1, 2, 3, 4, 5, 6, 7], is247: false, rapidRepeatWindowMinutes: 30
    }});
    await call('POST', '/anomaly-flags/scan', { token: owner, body: { sinceHours: SINCE } });
    check('Test 7: mesai 10:00-11:00’a daraltılınca öğle (12:00) alımları da MESAI_DISI olur (≥2 repeat kaydı)',
      (await flagCount('ai504-tx-repeat-%', 'MESAI_DISI')) >= 2,
      `repeat MESAI_DISI = ${await flagCount('ai504-tx-repeat-%', 'MESAI_DISI')}`);

    // ── Test 8: inceleme (review) akışı ──────────────────────────
    const anyFlag = (await call('GET', "/anomaly-flags?type=KISA_ARALIK_MUKERRER", { token: owner })).body.data
      .find((f: any) => f.transaction_id === 'ai504-tx-repeat-2');
    const r8 = await call('PATCH', `/anomaly-flags/${anyFlag.id}`, { token: siteMgr, body: { status: 'MUAF', reviewNote: 'Tabanca hava aldı, kesinti sonrası devam' } });
    const r8acik = await call('GET', '/anomaly-flags?status=ACIK', { token: owner });
    const r8muaf = await call('GET', '/anomaly-flags?status=MUAF', { token: owner });
    check('Test 8: PATCH status=MUAF → reviewed_by set; ?status=ACIK dışında, ?status=MUAF içinde',
      r8.status === 200 && r8.body.data?.status === 'MUAF' && !!r8.body.data?.reviewed_by &&
      !r8acik.body.data.some((f: any) => f.id === anyFlag.id) &&
      r8muaf.body.data.some((f: any) => f.id === anyFlag.id),
      `status=${r8.body.data?.status}, reviewedBy=${r8.body.data?.reviewed_by}`);

    // ── Test 9: Zod ─────────────────────────────────────────────
    const z1 = await call('PUT', `/sites/${encodeURIComponent(SITE)}/working-hours`, { token: owner, body: { startMinute: 800, endMinute: 700, workingDays: [1] } });
    const z2 = await call('POST', '/anomaly-flags/scan', { token: owner, body: { sinceHours: 0 } });
    const z3 = await call('PATCH', `/anomaly-flags/${anyFlag.id}`, { token: owner, body: { status: 'BILINMEYEN' } });
    check('Test 9: Zod — start≥end & is247 yok / sinceHours=0 / geçersiz review status → 400',
      z1.status === 400 && z2.status === 400 && z3.status === 400,
      `hours=${z1.status}, scan=${z2.status}, review=${z3.status}`);

    // ── Test 10: RBAC ──────────────────────────────────────────
    const r10a = await call('POST', '/anomaly-flags/scan', { token: siteMgr, body: { sinceHours: 24 } }); // SITE_MANAGER tarama yapamaz
    const r10b = await call('GET', '/anomaly-flags');                                                     // tokensiz
    const r10c = await call('GET', `/sites/${encodeURIComponent(SITE)}/working-hours`, { token: siteMgr }); // SITE_MANAGER okuyabilir
    check('Test 10: RBAC — SITE_MANAGER scan → 403, tokensiz list → 401, SITE_MANAGER working-hours GET → 200',
      r10a.status === 403 && r10b.status === 401 && r10c.status === 200,
      `scan=${r10a.status}, tokensiz=${r10b.status}, whGet=${r10c.status}`);

    // ── Test 11: audit log ─────────────────────────────────────
    {
      const rows = await q(
        `SELECT action, count(*)::int AS n FROM audit_logs
          WHERE tenant_id='comp-camsa' AND created_at > NOW() - INTERVAL '5 minutes'
            AND action IN ('ANOMALY_SCAN','SITE_WORKING_HOURS_SET','ANOMALY_FLAG_REVIEWED')
          GROUP BY action`
      );
      const m = Object.fromEntries(rows.map((x: any) => [x.action, x.n]));
      check('Test 11: audit_logs — ANOMALY_SCAN / SITE_WORKING_HOURS_SET / ANOMALY_FLAG_REVIEWED yazıldı',
        (m['ANOMALY_SCAN'] || 0) >= 1 && (m['SITE_WORKING_HOURS_SET'] || 0) >= 2 && (m['ANOMALY_FLAG_REVIEWED'] || 0) >= 1,
        JSON.stringify(m));
    }

  } finally {
    const c = pg();
    await c.connect();
    await c.query("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND created_at > NOW() - INTERVAL '15 minutes' AND action IN ('ANOMALY_SCAN','SITE_WORKING_HOURS_SET','ANOMALY_FLAG_REVIEWED')");
    await c.query("DELETE FROM transaction_anomaly_flags WHERE transaction_id LIKE 'ai504-tx-%'");
    await c.query("DELETE FROM transactions WHERE id LIKE 'ai504-tx-%'");
    await c.query("DELETE FROM site_working_hours WHERE tenant_id='comp-camsa' AND site_name=$1", [SITE]);
    // Tenant-geneli tarama, başka testlerin bıraktığı ikmallere de işaret
    // koymuş olabilir — silinmiş işlemlere ait öksüz işaretleri temizle.
    await c.query("DELETE FROM transaction_anomaly_flags f WHERE tenant_id='comp-camsa' AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = f.transaction_id)");
    // AI-507: tarama artık birleşik alarm da üretiyor — bu testin plakalarına
    // ait alarmları ve olaylarını temizle.
    await c.query("DELETE FROM alarm_events WHERE alarm_id IN (SELECT id FROM alarms WHERE tenant_id='comp-camsa' AND (alarm_key LIKE 'OFFHOURS_DISPENSE:AI504-%' OR alarm_key LIKE 'RAPID_REPEAT:AI504-%'))");
    await c.query("DELETE FROM alarms WHERE tenant_id='comp-camsa' AND (alarm_key LIKE 'OFFHOURS_DISPENSE:AI504-%' OR alarm_key LIKE 'RAPID_REPEAT:AI504-%')");
    await c.end();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
