import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * FLEET-1407 — bakım-servis kaydı + yakıt maliyeti ilişkisi.
 * "Gecikmiş bakımı olan araçların artan tüketimini SAYISAL olarak
 * göstermek" (ticket) — burada TERSİ senaryo kurulur (bakım SONRASI
 * tüketim DÜŞER) çünkü bu, bakımın gerçekten işe yaradığını kanıtlayan
 * daha güçlü/pozitif bir test senaryosudur; hesap AYNI (before/after L/100km).
 *
 * Kullanılan hazır veriler (COMP-605/FLEET-1406 testleriyle AYNI tenant):
 *   tenant: comp-camsa | şantiye: Gebze Ana Şantiye | tank: Gebze Ana Tank (T-1)
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

const V_IMPACT = 'fleet1407-veh-impact'; // önce/sonra tüketim karşılaştırması
const V_NODATA = 'fleet1407-veh-nodata'; // yetersiz veri senaryosu
const V_DATESOON = 'fleet1407-veh-datesoon'; // tarih bazlı yaklaşan hatırlatma
const V_DATEOVER = 'fleet1407-veh-dateover'; // tarih bazlı geciken hatırlatma
const V_METERSOON = 'fleet1407-veh-metersoon'; // sayaç bazlı yaklaşan hatırlatma
const VEHICLE_IDS = [V_IMPACT, V_NODATA, V_DATESOON, V_DATEOVER, V_METERSOON];
const TX_PLATES: Record<string, string> = {
  [V_IMPACT]: 'F1407-IMPACT', [V_NODATA]: 'F1407-NODATA', [V_DATESOON]: 'F1407-DATESOON',
  [V_DATEOVER]: 'F1407-DATEOVER', [V_METERSOON]: 'F1407-METERSOON'
};

async function cleanup(): Promise<void> {
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action='VEHICLE_MAINTENANCE_RECORDED' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q("DELETE FROM alarms WHERE tenant_id='comp-camsa' AND category='MAINTENANCE_DUE' AND alarm_key LIKE 'maintenance-due:fleet1407-%'");
  await q('DELETE FROM vehicle_maintenance_records WHERE tenant_id=$1 AND vehicle_id = ANY($2::text[])', ['comp-camsa', VEHICLE_IDS]);
  await q('DELETE FROM vehicle_meter_readings WHERE tenant_id=$1 AND vehicle_id = ANY($2::text[])', ['comp-camsa', VEHICLE_IDS]);
  await q('DELETE FROM transactions WHERE tenant_id=$1 AND vehicle_plate = ANY($2::text[])', ['comp-camsa', Object.values(TX_PLATES)]);
  await q('DELETE FROM fuel_intake_receipts WHERE tenant_id=$1 AND waybill_no LIKE $2', ['comp-camsa', 'F1407-%']);
  await q('DELETE FROM vehicles WHERE tenant_id=$1 AND id = ANY($2::text[])', ['comp-camsa', VEHICLE_IDS]);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [FLEET-1407] BAKIM-SERVİS KAYDI + YAKIT MALİYETİ İLİŞKİSİ');
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
    for (const id of VEHICLE_IDS) await insV(id, TX_PLATES[id]);

    // ── V_IMPACT: bakım öncesi 600km/90L (15 L/100km), sonrası 800km/88L (11 L/100km) ──
    await c.query(
      `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
       VALUES ('f1407-mr-1','comp-camsa',$1,$2,'KM',10000,'2026-05-10T08:00:00.000Z','2026-05','MANUEL','usr-super-admin'),
              ('f1407-mr-2','comp-camsa',$1,$2,'KM',10600,'2026-06-10T08:00:00.000Z','2026-06','MANUEL','usr-super-admin'),
              ('f1407-mr-3','comp-camsa',$1,$2,'KM',11400,'2026-06-20T08:00:00.000Z','2026-06','MANUEL','usr-super-admin')`,
      [V_IMPACT, TX_PLATES[V_IMPACT]]
    );
    const insTx = (id: string, plate: string, liters: number, at: string) => c.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, tank_name, amount_liters, created_at)
       VALUES ($1,'comp-camsa','Gebze Ana Şantiye',$2,'Ahmet Yılmaz','Gebze Ana Tank (T-1)',$3,$4)`,
      [id, plate, liters, at]
    );
    await insTx('f1407-tx-1', TX_PLATES[V_IMPACT], 50, '2026-05-20T09:00:00.000Z');
    await insTx('f1407-tx-2', TX_PLATES[V_IMPACT], 40, '2026-06-05T09:00:00.000Z'); // önce toplam 90L
    await insTx('f1407-tx-3', TX_PLATES[V_IMPACT], 48, '2026-06-16T09:00:00.000Z');
    await insTx('f1407-tx-4', TX_PLATES[V_IMPACT], 40, '2026-06-25T09:00:00.000Z'); // sonra toplam 88L

    // fuel_intake_receipts — TCO tahmini için birim fiyat (Gebze Ana Tank).
    await c.query(
      `INSERT INTO fuel_intake_receipts
         (id, tenant_id, tank_id, tank_name, site_name, supplier_name, waybill_no, delivery_date, declared_liters, unit_price, declared_liters_15c, added_liters, created_by)
       VALUES ('f1407-fir-1','comp-camsa','tank-gebze-1','Gebze Ana Tank (T-1)','Gebze Ana Şantiye','Test Tedarikçi','F1407-001','2026-05-01',1000,42.50,1000,1000,'usr-super-admin'),
              ('f1407-fir-2','comp-camsa','tank-gebze-1','Gebze Ana Tank (T-1)','Gebze Ana Şantiye','Test Tedarikçi','F1407-002','2026-06-01',1000,43.50,1000,1000,'usr-super-admin')`
    );

    // V_DATESOON / V_DATEOVER: tarih bazlı hatırlatma (bugüne göre).
    // V_METERSOON: sayaç bazlı — son okuma 9800, eşik 10000 (200 km kaldı → SAYAC_YAKLASTI).
    await c.query(
      `INSERT INTO vehicle_meter_readings (id, tenant_id, vehicle_id, vehicle_plate, meter_type, reading_value, reading_at, period_label, source, entered_by)
       VALUES ('f1407-mr-4','comp-camsa',$1,$2,'KM',9800,'2026-08-01T08:00:00.000Z','2026-08','MANUEL','usr-super-admin')`,
      [V_METERSOON, TX_PLATES[V_METERSOON]]
    );
  } finally {
    await c.end();
  }

  try {
    const owner = await login('camsa'); // COMPANY_OWNER
    const siteMgr = await login('gebze-santiye'); // SITE_MANAGER
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR

    // ── Test 1: bakım kaydı ekleme ────────────────────────────────
    const r1 = await call('POST', `/vehicles/${V_IMPACT}/maintenance-records`, {
      token: siteMgr,
      body: { maintenanceType: 'PERİYODİK_BAKIM', performedAt: '2026-06-15', odometerValue: 10600, costAmount: 2500, operationsDescription: 'Yağ + filtre değişimi, fren balata kontrolü.' }
    });
    check('Test 1: POST .../maintenance-records → 201, plaka otomatik dolduruldu',
      r1.status === 201 && r1.body.data.vehiclePlate === TX_PLATES[V_IMPACT] && r1.body.data.costAmount === 2500,
      `status=${r1.status}, plate=${r1.body.data?.vehiclePlate}, cost=${r1.body.data?.costAmount}`);
    const impactRecordId = r1.body.data.id;

    // ── Test 2: liste + tekil sorgu ──────────────────────────────
    const r2list = await call('GET', `/vehicles/${V_IMPACT}/maintenance-records`, { token: owner });
    const r2get = await call('GET', `/maintenance-records/${impactRecordId}`, { token: owner });
    check('Test 2: GET liste 1 kayıt döner; GET tekil AYNI kaydı döner',
      r2list.status === 200 && r2list.body.data.length === 1 && r2get.status === 200 && r2get.body.data.id === impactRecordId,
      `liste=${r2list.body.data?.length}, tekil=${r2get.body.data?.id === impactRecordId}`);

    // ── Test 3: bakım öncesi/sonrası tüketim karşılaştırması ─────
    const r3 = await call('GET', `/maintenance-records/${impactRecordId}/consumption-impact`, { token: owner });
    check('Test 3: önce 15 L/100km → sonra 11 L/100km, %26.67 iyileşme, verdict=İYİLEŞTİ',
      r3.status === 200 && r3.body.data.before.consumptionPer100Unit === 15 && r3.body.data.after.consumptionPer100Unit === 11 &&
      r3.body.data.changePct === -26.67 && r3.body.data.verdict === 'İYİLEŞTİ',
      `önce=${r3.body.data?.before?.consumptionPer100Unit}, sonra=${r3.body.data?.after?.consumptionPer100Unit}, değişim=${r3.body.data?.changePct}%, verdict=${r3.body.data?.verdict}`);

    // ── Test 4: yetersiz veri (sayaç okuması yok) → YETERSİZ_VERİ ─
    const r4create = await call('POST', `/vehicles/${V_NODATA}/maintenance-records`, {
      token: owner, body: { maintenanceType: 'DİĞER', performedAt: '2026-06-15', costAmount: 100, operationsDescription: 'Sayaç verisi olmayan araç testi.' }
    });
    const r4 = await call('GET', `/maintenance-records/${r4create.body.data.id}/consumption-impact`, { token: owner });
    check('Test 4: hiç sayaç okuması olmayan araç → verdict=YETERSİZ_VERİ',
      r4.status === 200 && r4.body.data.verdict === 'YETERSİZ_VERİ' && r4.body.data.changePct === null,
      `verdict=${r4.body.data?.verdict}, değişim=${r4.body.data?.changePct}`);

    // ── Test 5: toplam sahip olma maliyeti (gerçek bakım + tahmini yakıt) ─
    const r5 = await call('GET', `/vehicles/${V_IMPACT}/total-cost-of-ownership`, { token: owner });
    // toplam yakıt = 90+48+40 = 178 L (tx-1..4); ortalama birim fiyat = (1000*42.5+1000*43.5)/2000 = 43.0
    check('Test 5: bakım maliyeti=2500, toplam yakıt=178L, ortalama birim fiyat=43.0, tahmini yakıt maliyeti=7654',
      r5.status === 200 && r5.body.data.totalMaintenanceCost === 2500 && r5.body.data.totalFuelLiters === 178 &&
      r5.body.data.averageFuelUnitPrice === 43 && r5.body.data.estimatedFuelCost === 7654 && r5.body.data.estimatedTotalCost === 10154,
      `bakım=${r5.body.data?.totalMaintenanceCost}, yakıt=${r5.body.data?.totalFuelLiters}L, birimFiyat=${r5.body.data?.averageFuelUnitPrice}, tahminiYakıt=${r5.body.data?.estimatedFuelCost}, toplam=${r5.body.data?.estimatedTotalCost}`);

    // ── Test 6: tarih bazlı hatırlatmalar (yaklaşan + geciken) ────
    const in3days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const ago5days = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    await call('POST', `/vehicles/${V_DATESOON}/maintenance-records`, { token: owner, body: { maintenanceType: 'LASTİK', performedAt: '2026-01-01', costAmount: 500, operationsDescription: 'Yaklaşan bakım testi.', nextDueDate: in3days } });
    await call('POST', `/vehicles/${V_DATEOVER}/maintenance-records`, { token: owner, body: { maintenanceType: 'LASTİK', performedAt: '2026-01-01', costAmount: 500, operationsDescription: 'Geciken bakım testi.', nextDueDate: ago5days } });
    const r6 = await call('GET', '/fleet/maintenance/upcoming', { token: owner });
    const soonRow = r6.body.data?.find((x: any) => x.vehicleId === V_DATESOON);
    const overRow = r6.body.data?.find((x: any) => x.vehicleId === V_DATEOVER);
    check('Test 6: yaklaşan (3 gün, TARIH_YAKLASTI) ve geciken (-5 gün, TARIH_GECTI) doğru sınıflandırılıyor',
      r6.status === 200 && soonRow?.reason === 'TARIH_YAKLASTI' && overRow?.reason === 'TARIH_GECTI',
      `soon=${soonRow?.reason}, over=${overRow?.reason}`);

    // ── Test 7: sayaç bazlı hatırlatma (200 km kaldı → SAYAC_YAKLASTI) ─
    await call('POST', `/vehicles/${V_METERSOON}/maintenance-records`, { token: owner, body: { maintenanceType: 'PERİYODİK_BAKIM', performedAt: '2026-01-01', costAmount: 500, operationsDescription: 'Sayaç bazlı hatırlatma testi.', nextDueMeterValue: 10000 } });
    const r7 = await call('GET', '/fleet/maintenance/upcoming', { token: owner });
    const meterRow = r7.body.data?.find((x: any) => x.vehicleId === V_METERSOON);
    check('Test 7: sayaç eşiğine 200 birim kaldığında → SAYAC_YAKLASTI',
      r7.status === 200 && meterRow?.reason === 'SAYAC_YAKLASTI' && meterRow?.meterUnitsUntilDue === 200,
      `reason=${meterRow?.reason}, kalan=${meterRow?.meterUnitsUntilDue}`);

    // ── Test 8: manuel tarama → AI-507 alarmı üretir ──────────────
    const r8 = await call('POST', '/fleet/maintenance/reminder-scan', { token: owner });
    const alarmRows = await q("SELECT subject_id, severity, status FROM alarms WHERE tenant_id='comp-camsa' AND category='MAINTENANCE_DUE' AND subject_id = ANY($1::text[])", [[V_DATESOON, V_DATEOVER, V_METERSOON]]);
    const overAlarm = alarmRows.find((a) => a.subject_id === V_DATEOVER);
    const soonAlarm = alarmRows.find((a) => a.subject_id === V_DATESOON);
    check('Test 8: POST .../reminder-scan → geciken CRITICAL, yaklaşan WARNING alarm (MAINTENANCE_DUE)',
      r8.status === 200 && r8.body.data.alarmsRaised >= 3 && overAlarm?.severity === 'CRITICAL' && soonAlarm?.severity === 'WARNING' &&
      overAlarm?.status === 'OPEN' && soonAlarm?.status === 'OPEN',
      `alarmsRaised=${r8.body.data?.alarmsRaised}, over=${overAlarm?.severity}/${overAlarm?.status}, soon=${soonAlarm?.severity}/${soonAlarm?.status}`);

    // ── Test 9: Zod validasyonu ────────────────────────────────────
    const r9a = await call('POST', `/vehicles/${V_IMPACT}/maintenance-records`, { token: owner, body: { maintenanceType: 'GEÇERSİZ_TİP', performedAt: '2026-06-15', costAmount: 100, operationsDescription: 'yeterli açıklama' } });
    const r9b = await call('POST', `/vehicles/${V_IMPACT}/maintenance-records`, { token: owner, body: { maintenanceType: 'DİĞER', performedAt: '2026-06-15', costAmount: -5, operationsDescription: 'yeterli açıklama' } });
    const r9c = await call('POST', `/vehicles/${V_IMPACT}/maintenance-records`, { token: owner, body: { maintenanceType: 'DİĞER', performedAt: '2026-06-15', costAmount: 100, operationsDescription: 'ab' } });
    check('Test 9: Zod — geçersiz tip / negatif maliyet / kısa açıklama → 400',
      r9a.status === 400 && r9b.status === 400 && r9c.status === 400,
      `tip=${r9a.status}, maliyet=${r9b.status}, açıklama=${r9c.status}`);

    // ── Test 10: RBAC — PUMP_OPERATOR yazamaz, reminder-scan SITE_MANAGER'a kapalı ─
    const r10a = await call('POST', `/vehicles/${V_IMPACT}/maintenance-records`, { token: pumpOp, body: { maintenanceType: 'DİĞER', performedAt: '2026-06-15', costAmount: 100, operationsDescription: 'yeterli açıklama metni' } });
    const r10b = await call('POST', '/fleet/maintenance/reminder-scan', { token: siteMgr });
    const r10c = await call('GET', `/vehicles/${V_IMPACT}/maintenance-records`, {});
    check('Test 10: RBAC — PUMP_OPERATOR ekleyemez → 403, SITE_MANAGER tarama başlatamaz → 403, tokensiz → 401',
      r10a.status === 403 && r10b.status === 403 && r10c.status === 401,
      `pumpOp=${r10a.status}, siteMgrScan=${r10b.status}, tokensiz=${r10c.status}`);

    // ── Test 11: olmayan araç/kayıt → 404 ──────────────────────────
    const r11a = await call('POST', `/vehicles/nonexistent-veh/maintenance-records`, { token: owner, body: { maintenanceType: 'DİĞER', performedAt: '2026-06-15', costAmount: 100, operationsDescription: 'yeterli açıklama metni' } });
    const r11b = await call('GET', '/maintenance-records/nonexistent-record-id', { token: owner });
    check('Test 11: olmayan araç (404 VEHICLE_NOT_FOUND) / olmayan kayıt (404)',
      r11a.status === 404 && r11a.body.details?.error === 'VEHICLE_NOT_FOUND' && r11b.status === 404,
      `araç=${r11a.status}/${r11a.body.details?.error}, kayıt=${r11b.status}`);

    // ── Test 12: audit_logs ─────────────────────────────────────────
    const auditCount = await q("SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action='VEHICLE_MAINTENANCE_RECORDED' AND created_at > NOW() - INTERVAL '10 minutes'");
    check('Test 12: audit_logs — VEHICLE_MAINTENANCE_RECORDED (≥5) yazıldı',
      auditCount[0].c >= 5, `audit=${auditCount[0].c}`);

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
