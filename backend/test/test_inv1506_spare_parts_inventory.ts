import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * INV-1506 — yedek parça/sarf malzeme envanteri (giriş/çıkış hareketleri,
 * envanter sayımı/düzeltme, kritik stok uyarısı). Yakıt tanklarından
 * (sensörlü, otomatik) KASITLI olarak ayrı bir mimari — burada stok
 * yalnızca KAYDEDİLEN hareketlerle değişir.
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

const V_INV = 'inv1506-veh-1';
const CODE_1 = 'INV1506-FILTER-01';
const CODE_2 = 'INV1506-BELT-01';

async function cleanup(): Promise<void> {
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND action LIKE 'INVENTORY_%' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q("DELETE FROM alarms WHERE tenant_id='comp-camsa' AND category='INVENTORY_LOW_STOCK' AND alarm_key LIKE 'inventory-low-stock:%' AND subject_id IN (SELECT id FROM inventory_items WHERE tenant_id='comp-camsa' AND code = ANY($1::text[]))", [[CODE_1, CODE_2]]);
  await q('DELETE FROM inventory_movements WHERE tenant_id=$1 AND item_id IN (SELECT id FROM inventory_items WHERE tenant_id=$1 AND code = ANY($2::text[]))', ['comp-camsa', [CODE_1, CODE_2]]);
  await q('DELETE FROM inventory_items WHERE tenant_id=$1 AND code = ANY($2::text[])', ['comp-camsa', [CODE_1, CODE_2]]);
  await q('DELETE FROM vehicle_maintenance_records WHERE tenant_id=$1 AND vehicle_id=$2', ['comp-camsa', V_INV]);
  await q('DELETE FROM vehicles WHERE tenant_id=$1 AND id=$2', ['comp-camsa', V_INV]);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [INV-1506] YEDEK PARÇA/SARF MALZEME ENVANTERİ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();
  let maintenanceRecordId = '';
  const c = pg(); await c.connect();
  try {
    await c.query(
      `INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status)
       VALUES ($1,'comp-camsa','INV1506-VEH','Test Kamyon','Kamyon',$1,'Gebze Ana Şantiye','AKTİF')`,
      [V_INV]
    );
    const mRes = await c.query(
      `INSERT INTO vehicle_maintenance_records (id, tenant_id, vehicle_id, vehicle_plate, maintenance_type, performed_at, cost_amount, operations_description, created_by)
       VALUES ('inv1506-maint-1','comp-camsa',$1,'INV1506-VEH','YAĞ_DEĞİŞİMİ','2026-06-01',500,'Filtre + yağ değişimi.','usr-super-admin') RETURNING id`,
      [V_INV]
    );
    maintenanceRecordId = mRes.rows[0].id;
  } finally {
    await c.end();
  }

  try {
    const owner = await login('camsa'); // COMPANY_OWNER
    const siteMgr = await login('gebze-santiye'); // SITE_MANAGER
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR

    // ── Test 1: malzeme kartı oluştur ────────────────────────────────
    const r1 = await call('POST', '/inventory-items', {
      token: siteMgr, body: { code: CODE_1, name: 'Yağ Filtresi', unit: 'adet', criticalStockLevel: 5, initialStock: 20, storageLocation: 'Depo A-3' }
    });
    check('Test 1: POST /inventory-items → 201, initialStock ile oluşturulur',
      r1.status === 201 && r1.body.data.currentStock === 20 && r1.body.data.criticalStockLevel === 5,
      `status=${r1.status}, stok=${r1.body.data?.currentStock}, kritikEşik=${r1.body.data?.criticalStockLevel}`);
    const itemId = r1.body.data.id;

    // ── Test 2: aynı kod tekrar oluşturulamaz ─────────────────────────
    const r2 = await call('POST', '/inventory-items', { token: owner, body: { code: CODE_1, name: 'Mükerrer', unit: 'adet', criticalStockLevel: 1 } });
    check('Test 2: aynı code tekrar oluşturulamaz → 409 DUPLICATE_ITEM_CODE',
      r2.status === 409 && r2.body.details?.error === 'DUPLICATE_ITEM_CODE', `status=${r2.status}, err=${r2.body.details?.error}`);

    // ── Test 3: liste + tekil sorgu ───────────────────────────────────
    const r3list = await call('GET', '/inventory-items', { token: owner });
    const r3get = await call('GET', `/inventory-items/${itemId}`, { token: owner });
    check('Test 3: GET liste kalemi içerir; GET tekil AYNI kaydı döner',
      r3list.status === 200 && r3list.body.data.some((i: any) => i.id === itemId) && r3get.status === 200 && r3get.body.data.code === CODE_1,
      `listede=${r3list.body.data?.some((i: any) => i.id === itemId)}, tekilKod=${r3get.body.data?.code}`);

    // ── Test 4: GİRİŞ hareketi → stok artar ────────────────────────────
    const r4 = await call('POST', `/inventory-items/${itemId}/movements`, { token: owner, body: { movementType: 'GİRİŞ', quantity: 10, note: 'Yeni sevkiyat.' } });
    check('Test 4: GİRİŞ 10 adet → stok 20→30',
      r4.status === 201 && r4.body.data.balanceAfter === 30, `status=${r4.status}, bakiye=${r4.body.data?.balanceAfter}`);

    // ── Test 5: araç + bakım kaydına bağlı ÇIKIŞ hareketi ──────────────
    const r5 = await call('POST', `/inventory-items/${itemId}/movements`, {
      token: owner, body: { movementType: 'ÇIKIŞ', quantity: 4, relatedVehicleId: V_INV, relatedMaintenanceRecordId: maintenanceRecordId, note: 'Bakımda kullanıldı.' }
    });
    check('Test 5: araç+bakım kaydına bağlı ÇIKIŞ 4 adet → stok 30→26',
      r5.status === 201 && r5.body.data.balanceAfter === 26,
      `status=${r5.status}, bakiye=${r5.body.data?.balanceAfter}`);

    // ── Test 6: yetersiz stokla ÇIKIŞ reddedilir ────────────────────────
    const r6 = await call('POST', `/inventory-items/${itemId}/movements`, { token: owner, body: { movementType: 'ÇIKIŞ', quantity: 999 } });
    check('Test 6: yetersiz stokla ÇIKIŞ → 409 INSUFFICIENT_STOCK',
      r6.status === 409 && r6.body.details?.error === 'INSUFFICIENT_STOCK', `status=${r6.status}, err=${r6.body.details?.error}`);

    // ── Test 7: stok kritik eşiğe düşünce anında alarm (WARNING) ────────
    const r7 = await call('POST', `/inventory-items/${itemId}/movements`, { token: owner, body: { movementType: 'ÇIKIŞ', quantity: 21 } }); // 26→5 = kritik eşik
    const alarm7 = await q("SELECT severity, status FROM alarms WHERE tenant_id='comp-camsa' AND category='INVENTORY_LOW_STOCK' AND subject_id=$1", [itemId]);
    check('Test 7: stok kritik eşiğe (5) düşünce ANINDA WARNING alarmı üretilir',
      r7.status === 201 && r7.body.data.balanceAfter === 5 && alarm7[0]?.severity === 'WARNING' && alarm7[0]?.status === 'OPEN',
      `bakiye=${r7.body.data?.balanceAfter}, alarm=${alarm7[0]?.severity}/${alarm7[0]?.status}`);

    // ── Test 8: sayım/düzeltme — stok 12'ye sayılırsa +7 delta kaydedilir ─
    const r8 = await call('POST', `/inventory-items/${itemId}/count`, { token: owner, body: { countedQuantity: 12, note: 'Fiziksel sayım.' } });
    check('Test 8: sayım (12) → SAYIM_DÜZELTME +7 delta, stok 5→12',
      r8.status === 201 && r8.body.data.movementType === 'SAYIM_DÜZELTME' && r8.body.data.quantity === 7 && r8.body.data.balanceAfter === 12,
      `tip=${r8.body.data?.movementType}, delta=${r8.body.data?.quantity}, bakiye=${r8.body.data?.balanceAfter}`);

    // ── Test 9: hareket geçmişi — 4 hareket, en yeni önce ────────────────
    const r9 = await call('GET', `/inventory-items/${itemId}/movements`, { token: owner });
    check('Test 9: hareket geçmişi 4 kayıt (GİRİŞ, ÇIKIŞ, ÇIKIŞ, SAYIM_DÜZELTME), en yeni önce',
      r9.status === 200 && r9.body.data.length === 4 && r9.body.data[0].movementType === 'SAYIM_DÜZELTME',
      `sayı=${r9.body.data?.length}, ilk=${r9.body.data?.[0]?.movementType}`);

    // ── Test 10: kritik stok listesi + manuel tarama ─────────────────────
    // İkinci kalem: kritik eşiğin ALTINDA (0 stok) → CRITICAL alarm testi.
    const r10item = await call('POST', '/inventory-items', { token: owner, body: { code: CODE_2, name: 'Alternatör Kayışı', unit: 'adet', criticalStockLevel: 2, initialStock: 0 } });
    const r10critList = await call('GET', '/inventory/critical-stock', { token: owner });
    const r10scan = await call('POST', '/inventory/critical-stock-scan', { token: owner });
    const alarm10 = await q("SELECT severity FROM alarms WHERE tenant_id='comp-camsa' AND category='INVENTORY_LOW_STOCK' AND subject_id=$1", [r10item.body.data.id]);
    check('Test 10: 0 stoklu kalem kritik listede + tarama sonrası CRITICAL alarm',
      r10critList.status === 200 && r10critList.body.data.some((i: any) => i.id === r10item.body.data.id) &&
      r10scan.status === 200 && r10scan.body.data.alarmsRaised >= 1 && alarm10[0]?.severity === 'CRITICAL',
      `kritikListede=${r10critList.body.data?.some((i: any) => i.id === r10item.body.data.id)}, tarama=${r10scan.body.data?.alarmsRaised}, severity=${alarm10[0]?.severity}`);

    // ── Test 11: Zod validasyonu ────────────────────────────────────────
    const r11a = await call('POST', '/inventory-items', { token: owner, body: { code: '', name: 'Geçersiz', unit: 'adet', criticalStockLevel: 1 } });
    const r11b = await call('POST', `/inventory-items/${itemId}/movements`, { token: owner, body: { movementType: 'GEÇERSİZ', quantity: 5 } });
    const r11c = await call('POST', `/inventory-items/${itemId}/movements`, { token: owner, body: { movementType: 'GİRİŞ', quantity: -3 } });
    check('Test 11: Zod — boş code / geçersiz movementType / negatif quantity → 400',
      r11a.status === 400 && r11b.status === 400 && r11c.status === 400,
      `code=${r11a.status}, tip=${r11b.status}, miktar=${r11c.status}`);

    // ── Test 12: RBAC ────────────────────────────────────────────────────
    const r12a = await call('POST', '/inventory-items', { token: pumpOp, body: { code: 'X', name: 'X', unit: 'adet', criticalStockLevel: 1 } });
    const r12b = await call('POST', '/inventory/critical-stock-scan', { token: siteMgr });
    const r12c = await call('GET', '/inventory-items', {});
    check('Test 12: RBAC — PUMP_OPERATOR kart oluşturamaz → 403, SITE_MANAGER tarama başlatamaz → 403, tokensiz → 401',
      r12a.status === 403 && r12b.status === 403 && r12c.status === 401,
      `pumpOp=${r12a.status}, siteMgrScan=${r12b.status}, tokensiz=${r12c.status}`);

    // ── Test 13: olmayan kalem → 404 ──────────────────────────────────────
    const r13a = await call('GET', '/inventory-items/nonexistent-item-id', { token: owner });
    const r13b = await call('POST', `/inventory-items/nonexistent-item-id/movements`, { token: owner, body: { movementType: 'GİRİŞ', quantity: 1 } });
    check('Test 13: olmayan kalem — GET/POST movements → 404 ITEM_NOT_FOUND',
      r13a.status === 404 && r13a.body.details?.error === 'ITEM_NOT_FOUND' && r13b.status === 404 && r13b.body.details?.error === 'ITEM_NOT_FOUND',
      `get=${r13a.status}/${r13a.body.details?.error}, post=${r13b.status}/${r13b.body.details?.error}`);

    // ── Test 14: audit_logs ────────────────────────────────────────────────
    const auditItem = await q("SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action='INVENTORY_ITEM_CREATED' AND created_at > NOW() - INTERVAL '10 minutes'");
    const auditMove = await q("SELECT COUNT(*)::int AS c FROM audit_logs WHERE tenant_id='comp-camsa' AND action IN ('INVENTORY_MOVEMENT_RECORDED','INVENTORY_COUNT_RECORDED') AND created_at > NOW() - INTERVAL '10 minutes'");
    check('Test 14: audit_logs — INVENTORY_ITEM_CREATED (≥2), hareket kayıtları (≥4)',
      auditItem[0].c >= 2 && auditMove[0].c >= 4, `item=${auditItem[0].c}, move=${auditMove[0].c}`);

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
