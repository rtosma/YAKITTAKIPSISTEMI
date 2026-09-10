import { Client } from 'pg';
import Redis from 'ioredis';

/**
 * AI-507 — birleşik alarm yaşam döngüsü (gruplama, durum, atama, susturma,
 * eskalasyon, yanlış-pozitif geri beslemesi).
 *
 * Alarm kaynakları: AI-504 mesai dışı tespiti (POST /anomaly-flags/scan) ve
 * FUEL-409 stok mutabakatı (POST /tanks/:id/reconciliations). CANLI HTTP +
 * doğrudan PG. Test SONUNDA yaratılan alarm/olay/işlem/işaret/mutabakat +
 * audit satırları temizlenir.
 */

const API_URL = 'http://localhost:5000/api/v1';
const SITE = 'Silivri Tesisleri';
const VEH = 'AI507-VEH';
const RECON_TANK = 'tank-silivri-1';
const OFFHOURS_KEY = `OFFHOURS_DISPENSE:${VEH}`;
const STOCK_KEY = `STOCK_RECON:${RECON_TANK}`;

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
  return { status: res.status, body: await res.json().catch(() => ({})) };
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
  await q("DELETE FROM audit_logs WHERE tenant_id='comp-camsa' AND target_type='alarm' AND created_at > NOW() - INTERVAL '30 minutes'");
  await q("DELETE FROM alarm_events WHERE alarm_id IN (SELECT id FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key IN ($1,$2))", [OFFHOURS_KEY, STOCK_KEY]);
  await q("DELETE FROM alarms WHERE tenant_id='comp-camsa' AND alarm_key IN ($1,$2)", [OFFHOURS_KEY, STOCK_KEY]);
  await q("DELETE FROM transaction_anomaly_flags WHERE transaction_id LIKE 'ai507-tx-%'");
  await q("DELETE FROM transactions WHERE id LIKE 'ai507-tx-%'");
  await q("DELETE FROM stock_reconciliations WHERE tank_id=$1 AND created_by IN ('usr-camsa-owner','usr-super-admin')", [RECON_TANK]);
  await q("DELETE FROM site_working_hours WHERE tenant_id='comp-camsa' AND site_name=$1", [SITE]);
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [AI-507] BİRLEŞİK ALARM YAŞAM DÖNGÜSÜ');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();
  {
    const c = pg(); await c.connect();
    const ins = (id: string, at: string) => c.query(
      `INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, created_at)
       VALUES ($1,'comp-camsa',$2,$3,'Test Şoför',70,$4)`, [id, SITE, VEH, at]
    );
    // 3 gece alımı, 3 ayrı gün (aralarında 24 sa → "kısa aralıklı" değil).
    await ins('ai507-tx-1', '2026-09-07T00:00:00.000Z'); // Ist Pzt 03:00
    await ins('ai507-tx-2', '2026-09-08T00:00:00.000Z'); // Ist Sal 03:00
    await ins('ai507-tx-3', '2026-09-09T00:00:00.000Z'); // Ist Çar 03:00
    await c.end();
  }

  try {
    const owner = await login('camsa');       // COMPANY_OWNER
    const admin = await login('admin');       // SUPER_ADMIN
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR

    // ── Test 1: tarama → gruplanmış TEK alarm + 3 olay ────────────
    const scan = await call('POST', '/anomaly-flags/scan', { token: owner, body: { sinceHours: 400 } });
    const list1 = await call('GET', `/alarms?category=OFFHOURS_DISPENSE`, { token: owner });
    const alarm = (list1.body.data || []).find((a: any) => a.alarm_key === OFFHOURS_KEY);
    check('Test 1: 3 gece alımı → TEK alarm (event_count=3), status OPEN, severity WARNING (gruplama)',
      scan.status === 200 && !!alarm && alarm.event_count === 3 && alarm.status === 'OPEN' && alarm.severity === 'WARNING',
      `alarm=${!!alarm}, event_count=${alarm?.event_count}, status=${alarm?.status}`);
    const alarmId = alarm?.id;

    // ── Test 2: alarm detayında olaylar ─────────────────────────
    const det2 = await call('GET', `/alarms/${alarmId}`, { token: owner });
    check('Test 2: GET /alarms/:id → events dizisi 3 öğe, sourceRef dolu',
      det2.status === 200 && Array.isArray(det2.body.data?.events) && det2.body.data.events.length === 3 &&
      det2.body.data?.source_ref?.table === 'transaction_anomaly_flags',
      `events=${det2.body.data?.events?.length}, sourceRef=${JSON.stringify(det2.body.data?.source_ref)}`);

    // ── Test 3: tekrar tarama → yeni olay eklenmez (işaret idempotent) ─
    await call('POST', '/anomaly-flags/scan', { token: owner, body: { sinceHours: 400 } });
    const det3 = await call('GET', `/alarms/${alarmId}`, { token: owner });
    check('Test 3: tekrar tarama → event_count HÂLÂ 3 (aynı işaretler yeniden alarm üretmez)',
      det3.body.data?.event_count === 3, `event_count=${det3.body.data?.event_count}`);

    // ── Test 4: FUEL-409 stok mutabakatı → CRITICAL alarm ────────
    const recon = await call('POST', `/tanks/${RECON_TANK}/reconciliations`, { token: owner, body: {
      periodType: 'AD_HOC', periodStart: '2025-05-01T00:00:00.000Z', periodEnd: '2025-05-02T00:00:00.000Z',
      openingBookLiters: 5000, physicalLiters: 4750 // -%5 → AÇIKLANAMAYAN → CRITICAL
    }});
    const critList = await call('GET', '/alarms?severity=CRITICAL', { token: owner });
    const stockAlarm = (critList.body.data || []).find((a: any) => a.alarm_key === STOCK_KEY);
    check('Test 4: AÇIKLANAMAYAN mutabakat farkı → CRITICAL STOCK_RECONCILIATION alarmı (OPEN)',
      recon.status === 201 && !!stockAlarm && stockAlarm.severity === 'CRITICAL' && stockAlarm.status === 'OPEN' &&
      stockAlarm.subject_type === 'TANK',
      `recon=${recon.status}, alarm=${!!stockAlarm}, severity=${stockAlarm?.severity}`);
    const stockAlarmId = stockAlarm?.id;

    // ── Test 5: RESOLVED — varsayılan listeden çıkar ─────────────
    const res5bad = await call('PATCH', `/alarms/${alarmId}`, { token: owner, body: { status: 'RESOLVED' } });
    const res5 = await call('PATCH', `/alarms/${alarmId}`, { token: owner, body: { status: 'RESOLVED', resolutionNote: 'İncelendi, şoför gece vardiyasındaymış' } });
    const listDef = await call('GET', '/alarms', { token: owner });
    const listResolved = await call('GET', '/alarms?status=RESOLVED', { token: owner });
    check('Test 5: RESOLVED notsuz → 400; notlu → 200 resolved_by set; varsayılan listede YOK, ?status=RESOLVED\'de VAR',
      res5bad.status === 400 && res5bad.body.details?.error === 'RESOLUTION_NOTE_REQUIRED' &&
      res5.status === 200 && res5.body.data?.status === 'RESOLVED' && !!res5.body.data?.resolved_by &&
      !(listDef.body.data || []).some((a: any) => a.id === alarmId) &&
      (listResolved.body.data || []).some((a: any) => a.id === alarmId),
      `bad=${res5bad.status}, ok=${res5.status}, defHidden=${!(listDef.body.data || []).some((a: any) => a.id === alarmId)}`);

    // ── Test 6: tekrar oluşan alarm YENİDEN AÇILIR ──────────────
    await q(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, created_at)
             VALUES ('ai507-tx-4','comp-camsa',$1,$2,'Test Şoför',70,'2026-09-05T00:00:00.000Z')`, [SITE, VEH]);
    await call('POST', '/anomaly-flags/scan', { token: owner, body: { sinceHours: 400 } });
    const det6 = await call('GET', `/alarms/${alarmId}`, { token: owner });
    check('Test 6: kapatılmış alarm yeni bir olayla YENİDEN AÇILIR (status OPEN, event_count 4, resolved_by temizlendi)',
      det6.body.data?.status === 'OPEN' && det6.body.data?.event_count === 4 && !det6.body.data?.resolved_by,
      `status=${det6.body.data?.status}, count=${det6.body.data?.event_count}, resolvedBy=${det6.body.data?.resolved_by}`);

    // ── Test 7: atama ─────────────────────────────────────────
    const a7bad = await call('PATCH', `/alarms/${alarmId}`, { token: owner, body: { assigneeId: 'yok-boyle-kullanici' } });
    const a7 = await call('PATCH', `/alarms/${alarmId}`, { token: owner, body: { assigneeId: 'usr-silivri-mgr', status: 'INVESTIGATING' } });
    check('Test 7: geçersiz assignee → 400; geçerli → 200 assignee_id + status INVESTIGATING',
      a7bad.status === 400 && a7bad.body.details?.error === 'ASSIGNEE_NOT_FOUND' &&
      a7.status === 200 && a7.body.data?.assignee_id === 'usr-silivri-mgr' && a7.body.data?.status === 'INVESTIGATING',
      `bad=${a7bad.status}, ok=${a7.status}/${a7.body.data?.assignee_id}`);

    // ── Test 8: susturma ─────────────────────────────────────
    const sn8 = await call('POST', `/alarms/${stockAlarmId}/snooze`, { token: owner, body: { minutes: 120 } });
    const listAfterSnooze = await call('GET', '/alarms?severity=CRITICAL', { token: owner });
    const listInclSnoozed = await call('GET', '/alarms?severity=CRITICAL&includeSnoozed=true', { token: owner });
    check('Test 8: snooze → snoozed_until set; varsayılan listede YOK; includeSnoozed=true ile VAR',
      sn8.status === 200 && !!sn8.body.data?.snoozed_until &&
      !(listAfterSnooze.body.data || []).some((a: any) => a.id === stockAlarmId) &&
      (listInclSnoozed.body.data || []).some((a: any) => a.id === stockAlarmId),
      `snooze=${sn8.status}, hidden=${!(listAfterSnooze.body.data || []).some((a: any) => a.id === stockAlarmId)}`);

    // ── Test 9: eskalasyon ───────────────────────────────────
    // Stok alarmının susturmasını kaldır + eskiye çek + atamasız bırak.
    await q("UPDATE alarms SET snoozed_until = NULL, assignee_id = NULL, first_seen_at = NOW() - INTERVAL '3 hours', escalated_at = NULL WHERE id = $1", [stockAlarmId]);
    const esc1 = await call('POST', '/alarms/run-escalation', { token: admin });
    const esc2 = await call('POST', '/alarms/run-escalation', { token: admin }); // hemen tekrar → aynı alarm YİNE eskale olmaz
    const det9 = await call('GET', `/alarms/${stockAlarmId}`, { token: owner });
    check('Test 9: run-escalation → CRITICAL/OPEN/atanmamış/eski alarm escalation_level 1; hemen tekrar çalıştır → tekrar artmaz',
      esc1.status === 200 && esc1.body.data.escalated.some((a: any) => a.id === stockAlarmId) &&
      det9.body.data?.escalation_level === 1 && !!det9.body.data?.escalated_at &&
      !esc2.body.data.escalated.some((a: any) => a.id === stockAlarmId),
      `esc1=${esc1.body.data?.escalatedCount}, level=${det9.body.data?.escalation_level}, esc2Has=${esc2.body.data.escalated.some((a: any) => a.id === stockAlarmId)}`);

    // ── Test 10: yanlış-pozitif geri beslemesi ───────────────
    await call('PATCH', `/alarms/${stockAlarmId}`, { token: owner, body: { status: 'FALSE_POSITIVE', resolutionNote: 'Sensör kalibrasyonu bozuktu, gerçek kayıp yok' } });
    const fp = await call('GET', '/alarms/false-positive-feedback', { token: owner });
    const stockCat = (fp.body.data?.byCategory || []).find((c: any) => c.category === 'STOCK_RECONCILIATION');
    check('Test 10: FALSE_POSITIVE → false-positive-feedback byCategory\'de sayılır, recent listesinde görünür',
      fp.status === 200 && stockCat && stockCat.falsePositives >= 1 &&
      (fp.body.data?.recent || []).some((r: any) => r.id === stockAlarmId),
      `cat=${JSON.stringify(stockCat)}, recentHas=${(fp.body.data?.recent || []).some((r: any) => r.id === stockAlarmId)}`);

    // ── Test 11: Zod ─────────────────────────────────────────
    const z1 = await call('PATCH', `/alarms/${alarmId}`, { token: owner, body: {} });
    const z2 = await call('POST', `/alarms/${alarmId}/snooze`, { token: owner, body: { minutes: 0 } });
    const z3 = await call('POST', `/alarms/${alarmId}/snooze`, { token: owner, body: { minutes: 999999 } });
    check('Test 11: Zod — boş PATCH / snooze 0 dk / snooze 999999 dk → 400',
      z1.status === 400 && z2.status === 400 && z3.status === 400, `patch=${z1.status}, snz0=${z2.status}, snzBig=${z3.status}`);

    // ── Test 12: RBAC ───────────────────────────────────────
    const r12a = await call('GET', '/alarms', { token: pumpOp });
    const r12b = await call('GET', '/alarms');
    const r12c = await call('POST', '/alarms/run-escalation', { token: owner }); // SUPER_ADMIN gerekir
    check('Test 12: RBAC — PUMP_OPERATOR list → 403, tokensiz → 401, run-escalation COMPANY_OWNER → 403',
      r12a.status === 403 && r12b.status === 401 && r12c.status === 403,
      `pumpOp=${r12a.status}, tokensiz=${r12b.status}, ownerEsc=${r12c.status}`);

    // ── Test 13: audit log ──────────────────────────────────
    {
      const rows = await q(
        `SELECT action, count(*)::int AS n FROM audit_logs
          WHERE tenant_id='comp-camsa' AND target_type='alarm' AND created_at > NOW() - INTERVAL '10 minutes'
          GROUP BY action`
      );
      const m = Object.fromEntries(rows.map((x: any) => [x.action, x.n]));
      check('Test 13: audit_logs — ALARM_UPDATED (≥3) ve ALARM_SNOOZED (≥1) yazıldı',
        (m['ALARM_UPDATED'] || 0) >= 3 && (m['ALARM_SNOOZED'] || 0) >= 1, JSON.stringify(m));
    }

  } finally {
    await q("DELETE FROM transactions WHERE id LIKE 'ai507-tx-%'");
    await cleanup();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  await redis.quit();
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => { console.error('💥', err); process.exit(1); });
