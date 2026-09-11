import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FLEET-1408 — araç muayene/egzoz/sigorta son tarihleri + lastik (km bazlı
 * ömür + diş derinliği) takibi. "km/motor-saat/tarih bazlı bakım planı" AC'si
 * FLEET-1407'nin next_due_date/next_due_meter_value mekanizmasıyla ZATEN
 * karşılandığından burada TEKRAR test edilmiyor.
 *
 * Kullanılan hazır veriler (COMP-605/FLEET-1406/1407 testleriyle AYNI tenant):
 *   tenant: comp-camsa | şantiye: Gebze Ana Şantiye
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
function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

const V_DEADLINE = 'fleet1408-veh-deadline';
const V_TIRE = 'fleet1408-veh-tire';
const VEHICLE_IDS = [V_DEADLINE, V_TIRE];
const PLATES: Record<string, string> = { [V_DEADLINE]: 'F1408-DEADLINE', [V_TIRE]: 'F1408-TIRE' };

async function cleanup(): Promise<void> {
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'VEHICLE_COMPLIANCE_%' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'VEHICLE_TIRE_%' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q("DELETE FROM alarms WHERE tenant_id='comp-camsa' AND category IN ('COMPLIANCE_DEADLINE','TIRE_REPLACEMENT_DUE') AND subject_id = ANY($1::text[])", [VEHICLE_IDS]);
  await q('DELETE FROM vehicle_compliance_deadlines WHERE tenant_id=$1 AND vehicle_id = ANY($2::text[])', ['comp-camsa', VEHICLE_IDS]);
  await q('DELETE FROM vehicle_tires WHERE tenant_id=$1 AND vehicle_id = ANY($2::text[])', ['comp-camsa', VEHICLE_IDS]);
  await q('DELETE FROM vehicle_meter_readings WHERE tenant_id=$1 AND vehicle_id = ANY($2::text[])', ['comp-camsa', VEHICLE_IDS]);
  await q('DELETE FROM vehicles WHERE tenant_id=$1 AND id = ANY($2::text[])', ['comp-camsa', VEHICLE_IDS]);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FLEET-1408] MUAYENE/EGZOZ/SİGORTA + LASTİK TAKİBİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();
  const c = pg(); await c.connect();
  try {
    const insV = (id: string, plate: string) => c.query(
      `INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status)
       VALUES ($1,'comp-camsa',$2,'Test Kamyon','Kamyon',$1,'Gebze Ana Şantiye','AKTİF')`,
      [id, plate]
    );
    for (const id of VEHICLE_IDS) await insV(id, PLATES[id]);
    // V_TIRE için tek bir güncel KM okuması — dört lastiğin de remainingKm'i BUNA göre hesaplanır.
    await c.query(
      `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
       VALUES ('f1408-mr-1','comp-camsa',$1,$2,'KM',14900, NOW(), '2026-09','MANUEL','usr-super-admin')`,
      [V_TIRE, PLATES[V_TIRE]]
    );
  } finally {
    await c.end();
  }

  try {
    const owner = await login('camsa'); // COMPANY_OWNER
    const siteMgr = await login('gebze-santiye'); // SITE_MANAGER
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR

    // ── Test 1: muayene son tarihi ekle (20 gün sonra → WARNING penceresinde) ─
    const r1 = await call('POST', `/vehicles/${V_DEADLINE}/compliance-deadlines`, {
      token: siteMgr, body: { deadlineType: 'MUAYENE', issuedAt: daysFromNow(-345), dueDate: daysFromNow(20), referenceNo: 'MZ-2026-001' }
    });
    check('Test 1: POST .../compliance-deadlines → 201, plaka otomatik dolduruldu',
      r1.status === 201 && r1.body.data.vehiclePlate === PLATES[V_DEADLINE] && r1.body.data.deadlineType === 'MUAYENE',
      `status=${r1.status}, plate=${r1.body.data?.vehiclePlate}, tip=${r1.body.data?.deadlineType}`);

    // ── Test 2: yenileme → geçmişte 2 kayıt, "current" yalnızca EN SONU döner ─
    const r2new = await call('POST', `/vehicles/${V_DEADLINE}/compliance-deadlines`, {
      token: siteMgr, body: { deadlineType: 'MUAYENE', issuedAt: daysFromNow(0), dueDate: daysFromNow(365) }
    });
    const r2hist = await call('GET', `/vehicles/${V_DEADLINE}/compliance-deadlines`, { token: owner });
    const r2cur = await call('GET', `/vehicles/${V_DEADLINE}/compliance-deadlines/current`, { token: owner });
    check('Test 2: yenileme sonrası geçmiş 2 kayıt; "current" yalnızca en son (365 gün) kaydı döner',
      r2hist.body.data.length === 2 && r2cur.body.data.length === 1 && r2cur.body.data[0].dueDate === r2new.body.data.dueDate,
      `geçmiş=${r2hist.body.data?.length}, current=${r2cur.body.data?.length}, currentDue=${r2cur.body.data?.[0]?.dueDate}`);

    // ── Test 3: kritik (7 gün) + geciken (-3 gün) son tarihler ─────────────
    await call('POST', `/vehicles/${V_DEADLINE}/compliance-deadlines`, { token: owner, body: { deadlineType: 'EGZOZ', issuedAt: daysFromNow(-350), dueDate: daysFromNow(15) } });
    await call('POST', `/vehicles/${V_DEADLINE}/compliance-deadlines`, { token: owner, body: { deadlineType: 'SİGORTA', issuedAt: daysFromNow(-368), dueDate: daysFromNow(-3) } });

    // ── Test 4: lastik kaydı + otomatik değişim (aynı konum) ───────────────
    const r4a = await call('POST', `/vehicles/${V_TIRE}/tires`, {
      token: owner, body: { position: 'SOL_ON', installedAt: daysFromNow(-400), installedMeterValue: 5000, expectedLifespanKm: 3000, treadDepthMm: 8 }
    });
    const r4b = await call('POST', `/vehicles/${V_TIRE}/tires`, {
      // AYNI konum ('SOL_ON') → r4a otomatik DEĞİŞTİRİLDİ olmalı, bu YAKINDA senaryosu için kalıcı lastik.
      token: owner, body: { position: 'SOL_ON', installedAt: daysFromNow(-100), installedMeterValue: 10000, expectedLifespanKm: 5000, treadDepthMm: 6 }
    });
    const r4list = await call('GET', `/vehicles/${V_TIRE}/tires?includeReplaced=true`, { token: owner });
    const oldTire = r4list.body.data?.find((t: any) => t.id === r4a.body.data.id);
    const newTire = r4list.body.data?.find((t: any) => t.id === r4b.body.data.id);
    check('Test 4: aynı konuma ikinci lastik takılınca eskisi otomatik DEĞİŞTİRİLDİ, yenisi AKTİF olur',
      r4a.status === 201 && r4b.status === 201 && oldTire?.status === 'DEĞİŞTİRİLDİ' && newTire?.status === 'AKTİF',
      `eski=${oldTire?.status}, yeni=${newTire?.status}`);

    // ── Test 5: diğer 3 konuma lastik + diş derinliği güncelleme ───────────
    const r5a = await call('POST', `/vehicles/${V_TIRE}/tires`, { token: owner, body: { position: 'SAG_ON', installedAt: daysFromNow(-100), installedMeterValue: 10900, expectedLifespanKm: 4000, treadDepthMm: 6 } }); // remainingKm = 4000-4000=0 → KRİTİK (km)
    const r5b = await call('POST', `/vehicles/${V_TIRE}/tires`, { token: owner, body: { position: 'SOL_ARKA', installedAt: daysFromNow(-100), installedMeterValue: 10000, expectedLifespanKm: 10000, treadDepthMm: 5 } }); // tread NORMAL şimdilik
    await call('POST', `/vehicles/${V_TIRE}/tires`, { token: owner, body: { position: 'SAG_ARKA', installedAt: daysFromNow(-100), installedMeterValue: 10000, expectedLifespanKm: 20000, treadDepthMm: 7 } }); // NORMAL — dashboard'da GÖRÜNMEMELİ
    const r5tread = await call('PATCH', `/tires/${r5b.body.data.id}/tread-depth`, { token: owner, body: { treadDepthMm: 1.2, measuredAt: daysFromNow(0) } }); // yasal sınırın altına düşür → KRİTİK (diş)
    check('Test 5: diş derinliği güncellemesi kayıt üzerine işler (1.2mm)',
      r5a.status === 201 && r5b.status === 201 && r5tread.status === 200 && r5tread.body.data.treadDepthMm === 1.2,
      `sagOn=${r5a.status}, solArka=${r5b.status}, tread=${r5tread.body.data?.treadDepthMm}`);

    // ── Test 6: lastik durumu — km bazlı YAKINDA/KRİTİK + diş bazlı KRİTİK ──
    const statSolOn = await call('GET', `/tires/${r4b.body.data.id}/status`, { token: owner }); // remainingKm=5000-4900=100 → YAKINDA
    const statSagOn = await call('GET', `/tires/${r5a.body.data.id}/status`, { token: owner }); // remainingKm=4000-4000=0 → KRİTİK
    const statSolArka = await call('GET', `/tires/${r5b.body.data.id}/status`, { token: owner }); // tread=1.2 → KRİTİK
    check('Test 6: SOL_ON=YAKINDA (100km kaldı), SAG_ON=KRİTİK (0km), SOL_ARKA=KRİTİK (1.2mm diş)',
      statSolOn.body.data.severity === 'YAKINDA' && statSolOn.body.data.remainingKm === 100 &&
      statSagOn.body.data.severity === 'KRİTİK' && statSagOn.body.data.remainingKm === 0 &&
      statSolArka.body.data.severity === 'KRİTİK' && statSolArka.body.data.treadDepthMm === 1.2,
      `solOn=${statSolOn.body.data?.severity}/${statSolOn.body.data?.remainingKm}km, sagOn=${statSagOn.body.data?.severity}/${statSagOn.body.data?.remainingKm}km, solArka=${statSolArka.body.data?.severity}/${statSolArka.body.data?.treadDepthMm}mm`);

    // ── Test 7: filo uygunluk panosu — geciken KRİTİK, NORMAL lastik listede yok ─
    const r7 = await call('GET', '/fleet/compliance/dashboard', { token: owner });
    const items: any[] = r7.body.data ?? [];
    const sigortaItem = items.find((i) => i.vehicleId === V_DEADLINE && i.subKey === 'SİGORTA');
    const egzozItem = items.find((i) => i.vehicleId === V_DEADLINE && i.subKey === 'EGZOZ');
    const muayeneItem = items.find((i) => i.vehicleId === V_DEADLINE && i.subKey === 'MUAYENE');
    const sagArkaItem = items.find((i) => i.vehicleId === V_TIRE && i.subKey === 'SAG_ARKA');
    check('Test 7: dashboard — geciken SİGORTA critical=true, yaklaşan EGZOZ critical=false, 365 gün sonraki MUAYENE listede YOK, NORMAL lastik (SAG_ARKA) listede YOK',
      sigortaItem?.critical === true && egzozItem?.critical === false && !muayeneItem && !sagArkaItem,
      `sigorta=${sigortaItem?.critical}, egzoz=${egzozItem?.critical}, muayeneVar=${!!muayeneItem}, sagArkaVar=${!!sagArkaItem}`);

    // ── Test 8: manuel tarama → AI-507 alarmları ────────────────────────────
    const r8 = await call('POST', '/fleet/compliance/scan', { token: owner });
    const deadlineAlarms = await q(
      `SELECT a.subject_id, a.severity, e.detail->>'subKey' AS sub_key FROM alarms a
         JOIN alarm_events e ON e.alarm_id = a.id
        WHERE a.tenant_id='comp-camsa' AND a.category='COMPLIANCE_DEADLINE' AND a.subject_id=$1
        ORDER BY e.occurred_at DESC`,
      [V_DEADLINE]
    );
    const tireAlarms = await q(
      `SELECT a.subject_id, a.severity, e.detail->>'subKey' AS sub_key FROM alarms a
         JOIN alarm_events e ON e.alarm_id = a.id
        WHERE a.tenant_id='comp-camsa' AND a.category='TIRE_REPLACEMENT_DUE' AND a.subject_id=$1
        ORDER BY e.occurred_at DESC`,
      [V_TIRE]
    );
    const sigortaAlarm = deadlineAlarms.find((a) => a.sub_key === 'SİGORTA');
    const egzozAlarm = deadlineAlarms.find((a) => a.sub_key === 'EGZOZ');
    const sagOnAlarm = tireAlarms.find((a) => a.sub_key === 'SAG_ON');
    check('Test 8: POST .../scan → geciken sigorta CRITICAL, yaklaşan egzoz WARNING, kritik lastik CRITICAL alarmı üretir',
      r8.status === 200 && r8.body.data.alarmsRaised >= 4 && sigortaAlarm?.severity === 'CRITICAL' && egzozAlarm?.severity === 'WARNING' && sagOnAlarm?.severity === 'CRITICAL',
      `alarmsRaised=${r8.body.data?.alarmsRaised}, sigorta=${sigortaAlarm?.severity}, egzoz=${egzozAlarm?.severity}, sagOn=${sagOnAlarm?.severity}`);

    // ── Test 9: Zod validasyonu ──────────────────────────────────────────────
    const r9a = await call('POST', `/vehicles/${V_DEADLINE}/compliance-deadlines`, { token: owner, body: { deadlineType: 'GEÇERSİZ', issuedAt: daysFromNow(-10), dueDate: daysFromNow(10) } });
    const r9b = await call('POST', `/vehicles/${V_TIRE}/tires`, { token: owner, body: { position: 'GEÇERSİZ_KONUM', installedAt: daysFromNow(-10), installedMeterValue: 100, expectedLifespanKm: 1000, treadDepthMm: 8 } });
    const r9c = await call('PATCH', `/tires/${r4b.body.data.id}/tread-depth`, { token: owner, body: { treadDepthMm: -1, measuredAt: daysFromNow(0) } });
    check('Test 9: Zod — geçersiz deadlineType / geçersiz position / negatif treadDepthMm → 400',
      r9a.status === 400 && r9b.status === 400 && r9c.status === 400,
      `deadline=${r9a.status}, tire=${r9b.status}, tread=${r9c.status}`);

    // ── Test 10: RBAC ────────────────────────────────────────────────────────
    const r10a = await call('POST', `/vehicles/${V_DEADLINE}/compliance-deadlines`, { token: pumpOp, body: { deadlineType: 'DİĞER', issuedAt: daysFromNow(-10), dueDate: daysFromNow(10) } });
    const r10b = await call('POST', '/fleet/compliance/scan', { token: siteMgr });
    const r10c = await call('GET', '/fleet/compliance/dashboard', {});
    check('Test 10: RBAC — PUMP_OPERATOR son tarih ekleyemez → 403, SITE_MANAGER tarama başlatamaz → 403, tokensiz → 401',
      r10a.status === 403 && r10b.status === 403 && r10c.status === 401,
      `pumpOp=${r10a.status}, siteMgrScan=${r10b.status}, tokensiz=${r10c.status}`);

    // ── Test 11: 404 ─────────────────────────────────────────────────────────
    const r11a = await call('POST', `/vehicles/nonexistent-veh/compliance-deadlines`, { token: owner, body: { deadlineType: 'DİĞER', issuedAt: daysFromNow(-10), dueDate: daysFromNow(10) } });
    const r11b = await call('PATCH', `/tires/nonexistent-tire-id/tread-depth`, { token: owner, body: { treadDepthMm: 5, measuredAt: daysFromNow(0) } });
    check('Test 11: olmayan araç (404 VEHICLE_NOT_FOUND) / olmayan lastik (404 TIRE_NOT_FOUND)',
      r11a.status === 404 && r11a.body.details?.error === 'VEHICLE_NOT_FOUND' && r11b.status === 404 && r11b.body.details?.error === 'TIRE_NOT_FOUND',
      `araç=${r11a.status}/${r11a.body.details?.error}, lastik=${r11b.status}/${r11b.body.details?.error}`);

    // ── Test 12: audit_logs ───────────────────────────────────────────────────
    const auditDeadline = await q("SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action='VEHICLE_COMPLIANCE_DEADLINE_RECORDED' AND created_at > NOW() - INTERVAL '10 minutes'");
    const auditTire = await q("SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action IN ('VEHICLE_TIRE_REGISTERED','VEHICLE_TIRE_TREAD_DEPTH_RECORDED') AND created_at > NOW() - INTERVAL '10 minutes'");
    check('Test 12: audit_logs — VEHICLE_COMPLIANCE_DEADLINE_RECORDED (≥4), lastik olayları (≥5) yazıldı',
      auditDeadline[0].c >= 4 && auditTire[0].c >= 5, `deadline=${auditDeadline[0].c}, tire=${auditTire[0].c}`);

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
