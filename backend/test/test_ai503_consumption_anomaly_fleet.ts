import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * AI-503 — km/motor-saat bazlı tüketim anomalisi (L/100km sapması).
 *
 * CANLI HTTP + doğrudan PG. "Şimdi"ye göre son 7 takvim ayı kullanılır (tarih
 * kayması olmasın). Kobaylar: veh-1 (34 CTP 82, Kamyon→KM — 6 ay ~10 L/100km
 * sonra bu ay 18 L/100km sıçraması), veh-2 (34 BKT 19, Ekskavatör→MOTOR_SAAT —
 * tutarlı, anomali YOK), veh-3 (35 EGE 40, Dozer→MOTOR_SAAT — yalnızca 1
 * geçmiş dönem, yetersiz veri). Test SONUNDA tüm sayaç okumaları + işlemler +
 * CONSUMPTION_ANOMALY alarmları + audit temizlenir.
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
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect(); const r = await c.query(sql, params); await c.end(); return r.rows;
}
async function resetLoginRl(): Promise<void> {
  const k = await redis.keys('rl:auth-login:*'); if (k.length) await redis.del(...k);
}
async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetLoginRl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(u: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username: u, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${u}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

function monthLabel(monthsAgo: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 15));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function isoAt(monthsAgo: number, day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day, 0, 0, 0)).toISOString();
}

const M0 = monthLabel(0); // bu ay — anomali/kontrol dönemi

async function run() {
  console.log('===========================================================');
  console.log('🧪 [AI-503] KM/MOTOR-SAAT BAZLI TÜKETİM ANOMALİSİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  const cleanup = async () => {
    await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action='CONSUMPTION_ANOMALY_SCAN' AND created_at > NOW() - INTERVAL '30 minutes'");
    await q("DELETE FROM alarm_events WHERE alarm_id IN (SELECT id FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key LIKE 'CONSUMPTION_ANOMALY:veh-%')");
    await q("DELETE FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key LIKE 'CONSUMPTION_ANOMALY:veh-%'");
    await q("DELETE FROM vehicle_meter_readings WHERE id LIKE 'ai503-%'");
    await q("DELETE FROM transactions WHERE id LIKE 'ai503-tx-%'");
  };
  await cleanup();

  // ── Kurulum ────────────────────────────────────────────────────
  // veh-1 (KM): 6 ay geriye (M6..M1) hafif değişken ~9-11 L/100km, bu ay (M0)
  // 18 L/100km sıçraması (aynı 100 km'de 18 L — %80 sapma + yüksek z-score).
  const fuelHistoryV1 = [9, 10, 11, 9, 10, 11]; // M6..M1
  for (let i = 0; i < 6; i++) {
    const monthsAgo = 6 - i;
    const openingKm = 100000 + (7 - monthsAgo) * 100; // her ay +100 km (M7 taban = 100000)
    await q(
      `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
       VALUES ($1,'comp-camsa','veh-1','34 CTP 82','KM',$2,$3,$4,'MANUEL','usr-camsa-owner')`,
      [`ai503-v1-m${monthsAgo}`, openingKm, isoAt(monthsAgo, 20), monthLabel(monthsAgo)]
    );
    await q(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ($1,'comp-camsa','Gebze Ana Şantiye','34 CTP 82',$2,$3)`,
      [`ai503-tx-v1-m${monthsAgo}`, fuelHistoryV1[i], isoAt(monthsAgo, 22)]
    );
  }
  // Dönem başı okuması (M7) — M6'nın açılışı için.
  await q(
    `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
     VALUES ('ai503-v1-m7','comp-camsa','veh-1','34 CTP 82','KM',100000,$1,$2,'MANUEL','usr-camsa-owner')`,
    [isoAt(7, 20), monthLabel(7)]
  );
  // Bu ay (M0): +100 km ama 18 L → 18.0 L/100km (anomali).
  await q(
    `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
     VALUES ('ai503-v1-m0','comp-camsa','veh-1','34 CTP 82','KM',100700,$1,$2,'MANUEL','usr-camsa-owner')`,
    [isoAt(0, 20), M0]
  );
  await q(
    `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ('ai503-tx-v1-m0','comp-camsa','Gebze Ana Şantiye','34 CTP 82',18,$1)`,
    [isoAt(0, 22)]
  );

  // veh-2 (MOTOR_SAAT): M4 (taban) + M3..M0 hepsi +20 motor-saat / 40 L →
  // tutarlı 2.0 L/saat (M1,M2,M3 geçerli geçmiş + M0 cari — anomali YOK).
  for (let i = 0; i <= 4; i++) {
    await q(
      `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
       VALUES ($1,'comp-camsa','veh-2','34 BKT 19','MOTOR_SAAT',$2,$3,$4,'MANUEL','usr-camsa-owner')`,
      [`ai503-v2-m${i}`, 5000 + (5 - i) * 20, isoAt(i, 20), monthLabel(i)]
    );
    if (i < 4) {
      await q(
        `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ($1,'comp-camsa','Gebze Ana Şantiye','34 BKT 19',40,$2)`,
        [`ai503-tx-v2-m${i}`, isoAt(i, 22)]
      );
    }
  }

  // veh-3 (Dozer→MOTOR_SAAT): yalnızca 1 geçmiş dönem + bu ay → yetersiz veri.
  await q(
    `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
     VALUES ('ai503-v3-m1','comp-camsa','veh-3','35 EGE 40','MOTOR_SAAT',3000,$1,$2,'MANUEL','usr-camsa-owner')`,
    [isoAt(1, 20), monthLabel(1)]
  );
  await q(
    `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
     VALUES ('ai503-v3-m0','comp-camsa','veh-3','35 EGE 40','MOTOR_SAAT',3500,$1,$2,'MANUEL','usr-camsa-owner')`,
    [isoAt(0, 20), M0]
  );
  await q(
    `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ('ai503-tx-v3-m0','comp-camsa','Orman Şantiyesi','35 EGE 40',5000,$1)`,
    [isoAt(0, 22)]
  );

  try {
    const owner = await login('camsa');
    const siteMgr = await login('gebze-santiye');
    const pumpOp = await login('pompa-op-01');

    // ── Test 1: kendi geçmişine göre anomali — z-score + %sapma (AC) ────
    const r1 = await call('GET', `/fleet/consumption/anomaly?vehicleId=veh-1&periodLabel=${M0}`, { token: owner });
    const d1 = r1.body.data;
    check('Test 1: veh-1 bu ay 18 L/100km, geçmiş ort ~10 → anomalous:true, z-score≥2, %sapma≥25, direction YUKSEK',
      r1.status === 200 && d1?.anomalous === true && d1?.historyCount === 6 && !d1?.insufficientHistory &&
      Math.abs(d1?.zScore) >= 2 && Math.abs(d1?.deviationPct) >= 25 && d1?.direction === 'YUKSEK',
      `anomalous=${d1?.anomalous}, z=${d1?.zScore}, dev%=${d1?.deviationPct}, hist=${d1?.historyCount}`);

    // ── Test 2: aynı tip (Kamyon) başka araç yok → peer 0, kirlenme yok ─
    check('Test 2: aynı araç tipi (Kamyon) içinde başka araç yok → peerVehicleCount=0, peerAverage=null (AC: karşılaştırma tip içinde)',
      d1?.peerVehicleCount === 0 && d1?.peerAverage === null,
      `peerCount=${d1?.peerVehicleCount}, peerAvg=${d1?.peerAverage}`);

    // ── Test 3: tutarlı tüketim → anomali YOK ───────────────────────
    const r3 = await call('GET', `/fleet/consumption/anomaly?vehicleId=veh-2&periodLabel=${M0}`, { token: owner });
    check('Test 3: veh-2 tutarlı ~2 L/saat → anomalous:false, yeterli geçmiş var',
      r3.status === 200 && r3.body.data?.anomalous === false && !r3.body.data?.insufficientHistory && r3.body.data?.historyCount >= 3,
      `anomalous=${r3.body.data?.anomalous}, hist=${r3.body.data?.historyCount}`);

    // ── Test 4: yetersiz veri (<3 dönem) → anomali ASLA üretilmez (AC) ─
    const r4 = await call('GET', `/fleet/consumption/anomaly?vehicleId=veh-3&periodLabel=${M0}`, { token: siteMgr });
    check('Test 4: veh-3 yalnızca 1 geçmiş dönem → insufficientHistory:true, anomalous KESİNLİKLE false',
      r4.status === 200 && r4.body.data?.insufficientHistory === true && r4.body.data?.anomalous === false,
      `insufficient=${r4.body.data?.insufficientHistory}, anomalous=${r4.body.data?.anomalous}, histCount=${r4.body.data?.historyCount}`);

    // ── Test 5: önizleme alarm ÜRETMEZ ─────────────────────────────
    const beforeAlarm = await q("SELECT count(*)::int AS n FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key = 'CONSUMPTION_ANOMALY:veh-1'");
    check('Test 5: GET /fleet/consumption/anomaly (önizleme) alarm oluşturmaz',
      beforeAlarm[0].n === 0, `alarmSayısı=${beforeAlarm[0].n}`);

    // ── Test 6: tarama → AI-507 birleşik alarmına akar ────────────
    const r6 = await call('POST', '/fleet/consumption/anomaly-scan', { token: owner, body: { periodLabel: M0 } });
    const alarmRow = (await q("SELECT * FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key = 'CONSUMPTION_ANOMALY:veh-1'"))[0];
    check('Test 6: POST /anomaly-scan → veh-1 anomalisi tespit edilir, alarms tablosuna CONSUMPTION_ANOMALY olarak düşer',
      r6.status === 200 && r6.body.data.anomalies >= 1 &&
      r6.body.data.results.some((x: any) => x.vehicleId === 'veh-1' && x.anomalous) &&
      !!alarmRow && alarmRow.category === 'CONSUMPTION_ANOMALY' && alarmRow.subject_type === 'VEHICLE' && alarmRow.event_count === 1,
      `anomalies=${r6.body.data?.anomalies}, alarm=${!!alarmRow}, severity=${alarmRow?.severity}, events=${alarmRow?.event_count}`);

    // ── Test 7: tekrar tarama → GRUPLANIR (yeni satır değil, event_count artar) ─
    await call('POST', '/fleet/consumption/anomaly-scan', { token: owner, body: { periodLabel: M0 } });
    const alarmRow2 = (await q("SELECT * FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key = 'CONSUMPTION_ANOMALY:veh-1'"))[0];
    const alarmCount = (await q("SELECT count(*)::int AS n FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key = 'CONSUMPTION_ANOMALY:veh-1'"))[0].n;
    check('Test 7: aynı dönem tekrar taranınca TEK alarm kalır, event_count 2\'ye çıkar (AI-507 gruplama)',
      alarmCount === 1 && alarmRow2?.event_count === 2, `alarmSayısı=${alarmCount}, event_count=${alarmRow2?.event_count}`);

    // ── Test 8: Zod + RBAC ─────────────────────────────────────
    const z1 = await call('GET', `/fleet/consumption/anomaly?periodLabel=${M0}`, { token: owner }); // vehicleId yok
    const z2 = await call('POST', '/fleet/consumption/anomaly-scan', { token: owner, body: {} });
    const rb1 = await call('GET', `/fleet/consumption/anomaly?vehicleId=veh-1&periodLabel=${M0}`, { token: pumpOp });
    const rb2 = await call('POST', '/fleet/consumption/anomaly-scan', { token: siteMgr, body: { periodLabel: M0 } });
    const rb3 = await call('GET', `/fleet/consumption/anomaly?vehicleId=veh-1&periodLabel=${M0}`);
    check('Test 8: Zod (vehicleId yok / periodLabel yok → 400); RBAC (PUMP_OPERATOR → 403, SITE_MANAGER scan → 403, tokensiz → 401)',
      z1.status === 400 && z2.status === 400 && rb1.status === 403 && rb2.status === 403 && rb3.status === 401,
      `zod=${z1.status}/${z2.status}, rbac=${rb1.status}/${rb2.status}/${rb3.status}`);

    // ── Test 9: olmayan araç → 404 ─────────────────────────────
    const r9 = await call('GET', `/fleet/consumption/anomaly?vehicleId=yok-arac&periodLabel=${M0}`, { token: owner });
    check('Test 9: olmayan vehicleId → 404 VEHICLE_NOT_FOUND', r9.status === 404 && r9.body.details?.error === 'VEHICLE_NOT_FOUND', `status=${r9.status}`);

    // ── Test 10: audit log ─────────────────────────────────────
    {
      const rows = await q("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id='comp-camsa' AND action='CONSUMPTION_ANOMALY_SCAN' AND created_at > NOW() - INTERVAL '10 minutes'");
      check('Test 10: audit_logs — CONSUMPTION_ANOMALY_SCAN yazıldı', rows[0].n >= 2, `audit=${rows[0].n}`);
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
