import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FUEL-405 — manuel ikmal girişi (cihaz arızası) + çift onay mekanizması.
 *
 * CANLI HTTP + doğrudan PG (src import YOK). Kobay tank: 'Orman Depo Tankı
 * (T-3)' (tank-orman-1). Test SONUNDA (finally) tank seviyesi/durumu
 * başlangıç değerine geri yazılır; yaratılan manual_dispense_requests +
 * transactions + audit_logs satırları silinir.
 *
 * Roller: gebze-santiye/orman-santiye = SITE_MANAGER, camsa = COMPANY_OWNER,
 * admin = SUPER_ADMIN, pompa-op-01 = PUMP_OPERATOR.
 */

const API_URL = 'http://localhost:5000/api/v1';
const TANK_ID = 'tank-orman-1';
const SITE = 'Orman Şantiyesi';
const PLATE = 'FUEL405-TEST';

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
async function tankLevel(): Promise<number> {
  const c = pg(); await c.connect();
  const r = await c.query('SELECT current_level_liters FROM tanks WHERE id = $1', [TANK_ID]);
  await c.end();
  return Number(r.rows[0].current_level_liters);
}
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FUEL-405] MANUEL İKMAL GİRİŞİ + ÇİFT ONAY MEKANİZMASI');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  let startLevel = 0, startStatus = 'GÜVENLİ';
  {
    const c = pg(); await c.connect();
    const r = await c.query('SELECT current_level_liters, status FROM tanks WHERE id = $1', [TANK_ID]);
    startLevel = Number(r.rows[0].current_level_liters); startStatus = r.rows[0].status;
    await c.end();
  }
  const createdIds: string[] = [];

  try {
    const siteMgrReq = await login('gebze-santiye');  // talep eden (SITE_MANAGER)
    const siteMgr = await login('orman-santiye');     // onaylayan (SITE_MANAGER)
    const owner = await login('camsa');               // onaylayan (COMPANY_OWNER)
    const admin = await login('admin');               // onaylayan (SUPER_ADMIN)
    const pumpOp = await login('pompa-op-01');        // PUMP_OPERATOR

    const mkReq = async (token: string, over: any = {}) => {
      const r = await call('POST', '/manual-dispense-requests', { token, body: {
        tankId: TANK_ID, vehiclePlate: PLATE, driverName: 'Test Şoför', liters: 100,
        dispensedAt: isoAgo(3600_000), reason: 'Cihaz arızası — elle pompalandı', ...over
      }});
      if (r.body.data?.id) createdIds.push(r.body.data.id);
      return r;
    };

    // ── Test 1: kayıt oluştur → ONAY_BEKLIYOR ─────────────────────────
    const r1 = await mkReq(siteMgrReq);
    const reqId1 = r1.body.data?.id;
    check('Test 1: POST /manual-dispense-requests → 201, status ONAY_BEKLIYOR, site tanktan alınır',
      r1.status === 201 && r1.body.data?.status === 'ONAY_BEKLIYOR' && r1.body.data?.site_name === SITE && !r1.body.data?.transaction_id,
      `status=${r1.status}, durum=${r1.body.data?.status}, site=${r1.body.data?.site_name}`);

    // ── Test 2: talep eden onaylayamaz ───────────────────────────────
    const r2 = await call('POST', `/manual-dispense-requests/${reqId1}/approve`, { token: siteMgrReq });
    check('Test 2: talebi oluşturan (gebze-santiye) onaylayınca → 403 REQUESTER_CANNOT_APPROVE',
      r2.status === 403 && r2.body.details?.error === 'REQUESTER_CANNOT_APPROVE',
      `status=${r2.status}, err=${r2.body.details?.error}`);

    // ── Test 3: tek onay kesinleştirmez ─────────────────────────────
    const beforeL3 = await tankLevel();
    const r3 = await call('POST', `/manual-dispense-requests/${reqId1}/approve`, { token: siteMgr });
    const afterL3 = await tankLevel();
    check('Test 3: ilk onay (orman-santiye) → finalized:false, ONAY_BEKLIYOR, tank değişmez',
      r3.status === 200 && r3.body.data?.finalized === false &&
      r3.body.data?.request?.status === 'ONAY_BEKLIYOR' && !r3.body.data?.request?.transaction_id &&
      Math.abs(afterL3 - beforeL3) < 0.01,
      `finalized=${r3.body.data?.finalized}, durum=${r3.body.data?.request?.status}, tankΔ=${(afterL3 - beforeL3).toFixed(2)}`);

    // ── Test 4: aynı yetkili ikinci kez onaylayamaz ─────────────────
    const r4 = await call('POST', `/manual-dispense-requests/${reqId1}/approve`, { token: siteMgr });
    check('Test 4: aynı onaylayan tekrar → 409 DUPLICATE_APPROVER',
      r4.status === 409 && r4.body.details?.error === 'DUPLICATE_APPROVER',
      `status=${r4.status}, err=${r4.body.details?.error}`);

    // ── Test 5: ikinci onay (COMPANY_OWNER) → kesinleşir, stok düşer ─
    const beforeL5 = await tankLevel();
    const r5 = await call('POST', `/manual-dispense-requests/${reqId1}/approve`, { token: owner });
    const afterL5 = await tankLevel();
    const txId = r5.body.data?.transactionId;
    check('Test 5: ikinci onay (camsa/COMPANY_OWNER) → ONAYLANDI, transactionId var, tank −100',
      r5.status === 200 && r5.body.data?.finalized === true && !!txId &&
      r5.body.data?.request?.status === 'ONAYLANDI' && r5.body.data?.request?.transaction_id === txId &&
      Math.abs(afterL5 - (beforeL5 - 100)) < 0.01,
      `finalized=${r5.body.data?.finalized}, txId=${txId}, tankΔ=${(afterL5 - beforeL5).toFixed(2)}`);

    // ── Test 6: üretilen transactions kaydı — geriye tarihli + ayrı tip ─
    {
      const c = pg(); await c.connect();
      const tr = await c.query('SELECT type, amount_liters, created_at, rfid_auth FROM transactions WHERE id = $1', [txId]);
      await c.end();
      const row = tr.rows[0];
      check('Test 6: transactions kaydı type="Manuel (Çift Onaylı)", 100 L, dispensedAt tarihli, rfid_auth=false',
        !!row && row.type === 'Manuel (Çift Onaylı)' && Number(row.amount_liters) === 100 &&
        row.rfid_auth === false && (Date.now() - new Date(row.created_at).getTime()) > 1800_000,
        `type=${row?.type}, litre=${row?.amount_liters}, yaş(dk)=${row ? Math.round((Date.now() - new Date(row.created_at).getTime()) / 60000) : '?'}`);
    }

    // ── Test 7: rol kuralı — COMPANY_OWNER + SUPER_ADMIN yetmez ─────
    const r7c = await mkReq(siteMgrReq);
    const reqId7 = r7c.body.data?.id;
    await call('POST', `/manual-dispense-requests/${reqId7}/approve`, { token: owner });   // 1. onay: COMPANY_OWNER
    const r7b = await call('POST', `/manual-dispense-requests/${reqId7}/approve`, { token: admin }); // 2. onay: SUPER_ADMIN
    check('Test 7: roller [COMPANY_OWNER, SUPER_ADMIN] → 403 APPROVAL_ROLE_RULE_UNMET (SITE_MANAGER yok)',
      r7b.status === 403 && r7b.body.details?.error === 'APPROVAL_ROLE_RULE_UNMET',
      `status=${r7b.status}, err=${r7b.body.details?.error}`);

    // ── Test 8: geçerli SITE_MANAGER ikinci onayı ile kurtarılır ───
    const beforeL8 = await tankLevel();
    const r8 = await call('POST', `/manual-dispense-requests/${reqId7}/approve`, { token: siteMgr }); // SITE_MANAGER
    const afterL8 = await tankLevel();
    check('Test 8: sonra orman-santiye (SITE_MANAGER) onaylayınca → ONAYLANDI, tank −100',
      r8.status === 200 && r8.body.data?.finalized === true &&
      Math.abs(afterL8 - (beforeL8 - 100)) < 0.01,
      `finalized=${r8.body.data?.finalized}, tankΔ=${(afterL8 - beforeL8).toFixed(2)}`);

    // ── Test 9: geriye dönük tarih / gelecek tarih sınırı ──────────
    const r9a = await mkReq(siteMgrReq, { dispensedAt: isoAgo(10 * 86400_000) });   // 10 gün önce
    const r9b = await mkReq(siteMgrReq, { dispensedAt: new Date(Date.now() + 86400_000).toISOString() }); // yarın
    check('Test 9: 10 gün öncesi → 400 BACKDATE_LIMIT_EXCEEDED, gelecek tarih → 400 FUTURE_DATE',
      r9a.status === 400 && r9a.body.details?.error === 'BACKDATE_LIMIT_EXCEEDED' &&
      r9b.status === 400 && r9b.body.details?.error === 'FUTURE_DATE',
      `geçmiş=${r9a.status}/${r9a.body.details?.error}, gelecek=${r9b.status}/${r9b.body.details?.error}`);

    // ── Test 10: red akışı ────────────────────────────────────────
    const r10c = await mkReq(siteMgrReq);
    const reqId10 = r10c.body.data?.id;
    const beforeL10 = await tankLevel();
    const r10r = await call('POST', `/manual-dispense-requests/${reqId10}/reject`, { token: owner, body: { reason: 'Gerekçe yetersiz, tutanak yok' } });
    const afterL10 = await tankLevel();
    const r10a = await call('POST', `/manual-dispense-requests/${reqId10}/approve`, { token: siteMgr });
    check('Test 10: reddedilen kayıt → REDDEDİLDİ, tank değişmez, sonradan approve → 409 ALREADY_RESOLVED',
      r10r.status === 200 && r10r.body.data?.status === 'REDDEDİLDİ' && !r10r.body.data?.transaction_id &&
      Math.abs(afterL10 - beforeL10) < 0.01 && r10a.status === 409 && r10a.body.details?.error === 'ALREADY_RESOLVED',
      `red=${r10r.body.data?.status}, tankΔ=${(afterL10 - beforeL10).toFixed(2)}, sonraApprove=${r10a.status}`);

    // ── Test 11: manuel giriş oranı + eşik uyarısı ────────────────
    const r11a = await call('GET', `/manual-dispense-requests/ratio?siteName=${encodeURIComponent(SITE)}&days=1&thresholdPct=0.0001`, { token: owner });
    const r11b = await call('GET', `/manual-dispense-requests/ratio?siteName=${encodeURIComponent(SITE)}&days=1&thresholdPct=100`, { token: owner });
    const row11a = (r11a.body.data?.rows || []).find((x: any) => x.siteName === SITE);
    check('Test 11: ratio — düşük eşikte overThreshold+alertSites, yüksek eşikte temiz',
      r11a.status === 200 && row11a && row11a.manualCount >= 2 && row11a.ratioPct > 0 && row11a.overThreshold === true &&
      r11a.body.data.alertSites.includes(SITE) &&
      r11b.status === 200 && !((r11b.body.data?.rows || []).find((x: any) => x.siteName === SITE)?.overThreshold),
      `manualCount=${row11a?.manualCount}, ratio%=${row11a?.ratioPct}, alertSites=${JSON.stringify(r11a.body.data?.alertSites)}`);

    // ── Test 12: listeleme + filtre ──────────────────────────────
    const r12a = await call('GET', '/manual-dispense-requests?status=ONAYLANDI', { token: owner });
    const r12b = await call('GET', '/manual-dispense-requests?status=REDDEDİLDİ', { token: owner });
    check('Test 12: GET ?status=ONAYLANDI ve ?status=REDDEDİLDİ doğru filtreler',
      r12a.status === 200 && r12a.body.data.length >= 2 && r12a.body.data.every((x: any) => x.status === 'ONAYLANDI') &&
      r12b.status === 200 && r12b.body.data.every((x: any) => x.status === 'REDDEDİLDİ'),
      `onaylı=${r12a.body.totalCount}, reddedilen=${r12b.body.totalCount}`);

    // ── Test 13: Zod + RBAC ─────────────────────────────────────
    const z1 = await call('POST', '/manual-dispense-requests', { token: siteMgrReq, body: { vehiclePlate: PLATE, liters: 10, dispensedAt: isoAgo(1000), reason: 'yeterince uzun gerekçe' } });
    const z2 = await call('POST', '/manual-dispense-requests', { token: siteMgrReq, body: { tankId: TANK_ID, vehiclePlate: PLATE, liters: 10, dispensedAt: 'dün', reason: 'yeterince uzun gerekçe' } });
    const z3 = await call('POST', `/manual-dispense-requests/${reqId1}/reject`, { token: owner, body: { reason: 'kısa' } });
    const rb1 = await call('GET', '/manual-dispense-requests', { token: pumpOp });
    const rb2 = await call('GET', '/manual-dispense-requests');
    const rb3 = await call('POST', `/manual-dispense-requests/${reqId1}/approve`, { token: pumpOp });
    check('Test 13: Zod (tankId yok / tarih bozuk / kısa reason) → 400; RBAC (PUMP_OPERATOR list/approve → 403, tokensiz → 401)',
      z1.status === 400 && z2.status === 400 && z3.status === 400 &&
      rb1.status === 403 && rb2.status === 401 && rb3.status === 403,
      `zod=${z1.status}/${z2.status}/${z3.status}, rbac=${rb1.status}/${rb2.status}/${rb3.status}`);

    // ── Test 14: audit log ──────────────────────────────────────
    {
      const c = pg(); await c.connect();
      const r = await c.query(
        `SELECT action, count(*)::int AS n FROM audit_logs
          WHERE tenant_id='comp-camsa' AND target_id = ANY($1::text[])
            AND action IN ('MANUAL_DISPENSE_REQUESTED','MANUAL_DISPENSE_APPROVED','MANUAL_DISPENSE_FINALIZED','MANUAL_DISPENSE_REJECTED')
          GROUP BY action`,
        [createdIds]
      );
      await c.end();
      const m = Object.fromEntries(r.rows.map((x: any) => [x.action, x.n]));
      check('Test 14: audit_logs — REQUESTED / APPROVED / FINALIZED / REJECTED kayıtları yazıldı',
        (m['MANUAL_DISPENSE_REQUESTED'] || 0) >= 3 && (m['MANUAL_DISPENSE_FINALIZED'] || 0) >= 2 &&
        (m['MANUAL_DISPENSE_REJECTED'] || 0) >= 1 && (m['MANUAL_DISPENSE_APPROVED'] || 0) >= 2,
        JSON.stringify(m));
    }

  } finally {
    const c = pg();
    await c.connect();
    if (createdIds.length) {
      await c.query("DELETE FROM audit_logs WHERE target_id = ANY($1::text[]) AND action LIKE 'MANUAL_DISPENSE_%'", [createdIds]);
    }
    await c.query("DELETE FROM transactions WHERE vehicle_plate = $1 AND type = 'Manuel (Çift Onaylı)'", [PLATE]);
    await c.query('DELETE FROM manual_dispense_requests WHERE vehicle_plate = $1', [PLATE]);
    await c.query('UPDATE tanks SET current_level_liters = $1, status = $2 WHERE id = $3', [startLevel, startStatus, TANK_ID]);
    await c.end();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
