import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { raiseAlarmForCurrentTenant, runAlarmEscalationForCurrentTenant } from '../src/db/tenantDb';
import { notifyAlarmEscalationRecipients } from '../src/services/notificationService';
import { runWithTenant } from '../src/context/tenantContext';

/**
 * NOTIF-1606 (#163) — Eskalasyon kuralları (yanıtsız alarm → üst kademe).
 *
 * Ticket'ın BullMQ delayed job önerisi bu kod tabanında YOK — AI-507'nin
 * var olan saatlik setInterval süpürücüsü (index.ts) üzerine kurulu. Kademe
 * artık salt bir sayaç değil, TANIMLI bir role karşılık gelir (bkz.
 * tenantDb.ts ALARM_ESCALATION_CHAINS): CRITICAL → SITE_MANAGER (15dk) →
 * COMPANY_OWNER (+30dk) → SUPER_ADMIN (+60dk); WARNING → SITE_MANAGER
 * (120dk) → COMPANY_OWNER (+240dk).
 *
 * Kapsam (AC):
 *  1) Yanıtsız kritik alarm tanımlı süre sonra üst kademeye iletilmelidir.
 *  2) Yanıt alındığında (assignee atanınca) bekleyen eskalasyonlar iptal
 *     edilmelidir.
 *  3) Eskalasyon geçmişi alarm kaydında (alarm_events) görünmelidir.
 * + Teknik Not: zincir bir kademede alıcısızsa (ör. o şantiyede
 *   SITE_MANAGER yok) alarm SESSİZCE KAYBOLMAZ — bir sonraki kademeye
 *   beklemeden düşülür; zincirin TAMAMI alıcısız kalırsa bu durum
 *   alarm_events'e ve loga kalıcı olarak yazılır.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();
const CAMSA_TENANT = 'comp-camsa';
const GEBZE_SITE = 'Gebze Ana Şantiye';

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

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!res.body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

async function backdateAlarm(id: string, firstSeenMinutesAgo: number, escalatedAtMinutesAgo: number | null): Promise<void> {
  await q(
    `UPDATE alarms SET first_seen_at = NOW() - ($2 || ' minutes')::interval,
                        escalated_at = CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - ($3 || ' minutes')::interval END
      WHERE id = $1`,
    [id, String(firstSeenMinutesAgo), escalatedAtMinutesAgo]
  );
}

async function run() {
  console.log('===========================================================');
  console.log('⛰️  [NOTIF-1606] ALARM ESKALASYONU (YANITSIZ → ÜST KADEME) TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}\n   ${detail}\n`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${name}\n   ${detail}\n`);
    }
  };

  const admin = await login('admin');
  const gebzeMgrId = (await q(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'SITE_MANAGER' AND site_name = $2`, [CAMSA_TENANT, GEBZE_SITE]))[0].id;
  const camsaOwnerId = (await q(`SELECT id FROM users WHERE username = 'camsa'`))[0].id;
  const alarmIds: string[] = [];
  const emptyCompanyId = `comp-notif1606-empty-${RUN}`;

  try {
    // === Test 1 (ASIL AC — yanıtsız kritik alarm üst kademeye iletilir + eskalasyon
    // geçmişi alarm kaydında görünür): CRITICAL alarm, Gebze şantiyesinde SITE_MANAGER
    // VAR, 20 dk önce görülmüş (CRITICAL kademe 1 eşiği 15 dk) → escalation_level=1,
    // notify_role=SITE_MANAGER, gebzeMgr'a bildirim GÖNDERILDI, alarm_events'e yazılır. ===
    const alarm1Key = `NOTIF1606-TEST-${RUN}-1`;
    const raise1 = await runWithTenant({ tenantId: CAMSA_TENANT }, () =>
      raiseAlarmForCurrentTenant({ alarmKey: alarm1Key, category: 'OTHER', severity: 'CRITICAL', title: `Test Alarm 1 (${RUN})`, siteName: GEBZE_SITE })
    );
    alarmIds.push(raise1.alarmId);
    await backdateAlarm(raise1.alarmId, 20, null);

    const esc1 = await call('POST', '/alarms/run-escalation', { token: admin });
    const escalated1 = (esc1.body?.data?.escalated || []).find((a: any) => a.id === raise1.alarmId);
    const notif1 = await q(`SELECT status FROM notifications WHERE idempotency_key = $1`, [`alarm-escalation-${raise1.alarmId}-1-${gebzeMgrId}`]);
    const events1 = await q(`SELECT detail FROM alarm_events WHERE alarm_id = $1 AND (detail->>'type') = 'ESCALATION'`, [raise1.alarmId]);
    check(
      'Test 1 (ASIL AC — üst kademeye iletim + eskalasyon geçmişi): 20dk yanıtsız CRITICAL alarm SITE_MANAGER kademesine düşer, bildirim GÖNDERILDI, alarm_events kaydı oluşur',
      esc1.status === 200 &&
        !!escalated1 && escalated1.escalation_level === 1 && escalated1.notify_role === 'SITE_MANAGER' &&
        notif1[0]?.status === 'GÖNDERILDI' &&
        events1.length === 1 && events1[0].detail.notifyRole === 'SITE_MANAGER' && events1[0].detail.recipientUserIds.includes(gebzeMgrId),
      `escStatus=${esc1.status}, level=${escalated1?.escalation_level}, role=${escalated1?.notify_role}, notifStatus=${notif1[0]?.status}, eventCount=${events1.length}`
    );

    // === Test 2 (ASIL AC — yanıt alındığında bekleyen eskalasyon iptal edilir):
    // AYNI alarm bir kullanıcıya ATANIR (yanıt/ack), kademe-2 eşiği (30dk) geçecek
    // şekilde escalated_at geriye alınır, süpürücü TEKRAR çalıştırılır — atanmış
    // olduğu için HİÇ eşleşmez, kademe-2 bildirimi ASLA gönderilmez. ===
    await call('PATCH', `/alarms/${raise1.alarmId}`, { token: admin, body: { assigneeId: gebzeMgrId } });
    await backdateAlarm(raise1.alarmId, 20, 40);
    const esc2 = await call('POST', '/alarms/run-escalation', { token: admin });
    const escalated2 = (esc2.body?.data?.escalated || []).find((a: any) => a.id === raise1.alarmId);
    const notif2 = await q(`SELECT 1 FROM notifications WHERE idempotency_key = $1`, [`alarm-escalation-${raise1.alarmId}-2-${camsaOwnerId}`]);
    check(
      "Test 2 (ASIL AC — yanıt alındığında bekleyen eskalasyon iptal edilir): assignee atanmış alarm süpürücüde HİÇ eşleşmez, kademe-2 (COMPANY_OWNER) bildirimi HİÇ gönderilmez",
      esc2.status === 200 && !escalated2 && notif2.length === 0,
      `escStatus=${esc2.status}, foundInEscalated=${!!escalated2}, level2NotifExists=${notif2.length > 0}`
    );

    // === Test 3 (ASIL AC + Teknik Not — zincir doğrulaması, sessizce kaybolmama):
    // CRITICAL alarm, alıcısı OLMAYAN sahte bir şantiyede → SITE_MANAGER kademesi
    // ATLANIR (alıcı yok), BEKLEMEDEN COMPANY_OWNER kademesine düşülür. ===
    const fakeSite = `Test-Şantiye-Alıcısız-${RUN}`;
    const alarm3Key = `NOTIF1606-TEST-${RUN}-3`;
    const raise3 = await runWithTenant({ tenantId: CAMSA_TENANT }, () =>
      raiseAlarmForCurrentTenant({ alarmKey: alarm3Key, category: 'OTHER', severity: 'CRITICAL', title: `Test Alarm 3 (${RUN})`, siteName: fakeSite })
    );
    alarmIds.push(raise3.alarmId);
    await backdateAlarm(raise3.alarmId, 20, null);
    const esc3 = await call('POST', '/alarms/run-escalation', { token: admin });
    const escalated3 = (esc3.body?.data?.escalated || []).find((a: any) => a.id === raise3.alarmId);
    const events3 = await q(`SELECT detail FROM alarm_events WHERE alarm_id = $1 AND (detail->>'type') = 'ESCALATION'`, [raise3.alarmId]);
    check(
      "Test 3 (ASIL AC/Teknik Not — zincir doğrulaması): SITE_MANAGER'ı olmayan şantiyede kademe ATLANIR, alarm sessizce kaybolmadan COMPANY_OWNER'a (kademe 2) düşer",
      esc3.status === 200 &&
        !!escalated3 && escalated3.escalation_level === 2 && escalated3.notify_role === 'COMPANY_OWNER' && escalated3.chain_exhausted === false &&
        events3[0]?.detail.skippedRoles?.includes('SITE_MANAGER'),
      `level=${escalated3?.escalation_level}, role=${escalated3?.notify_role}, chainExhausted=${escalated3?.chain_exhausted}, skippedRoles=${JSON.stringify(events3[0]?.detail.skippedRoles)}`
    );

    // === Test 4 (ASIL AC — olay şiddetine göre farklı zincir/süre): WARNING alarm
    // 20 dk önce görülmüş — WARNING'in kademe-1 eşiği (120dk) HENÜZ dolmadı, HİÇ
    // eskale olmaz. Sonra first_seen_at 150 dk öncesine çekilince eskale olur. ===
    const alarm4Key = `NOTIF1606-TEST-${RUN}-4`;
    const raise4 = await runWithTenant({ tenantId: CAMSA_TENANT }, () =>
      raiseAlarmForCurrentTenant({ alarmKey: alarm4Key, category: 'OTHER', severity: 'WARNING', title: `Test Alarm 4 (${RUN})`, siteName: GEBZE_SITE })
    );
    alarmIds.push(raise4.alarmId);
    await backdateAlarm(raise4.alarmId, 20, null);
    const esc4a = await call('POST', '/alarms/run-escalation', { token: admin });
    const notYetDue = (esc4a.body?.data?.escalated || []).some((a: any) => a.id === raise4.alarmId);
    await backdateAlarm(raise4.alarmId, 150, null);
    const esc4b = await call('POST', '/alarms/run-escalation', { token: admin });
    const nowDue = (esc4b.body?.data?.escalated || []).find((a: any) => a.id === raise4.alarmId);
    check(
      'Test 4 (ASIL AC — şiddete göre farklı zincir/süre): WARNING alarm 20dk\'da eskale OLMAZ (CRITICAL\'den daha uzun eşik), 150dk\'da eskale OLUR',
      esc4a.status === 200 && !notYetDue && esc4b.status === 200 && !!nowDue && nowDue.escalation_level === 1 && nowDue.notify_role === 'SITE_MANAGER',
      `notYetDue=${notYetDue}, nowDueLevel=${nowDue?.escalation_level}, nowDueRole=${nowDue?.notify_role}`
    );

    // === Test 5 (Teknik Not — zincirin TAMAMI alıcısız kalırsa sessizce kaybolmaz):
    // Hiç kullanıcısı OLMAYAN taze bir fixture tenant'ta CRITICAL alarm — HİÇBİR
    // kademede (SITE_MANAGER/COMPANY_OWNER/SUPER_ADMIN) alıcı yok → zincir TÜKENİR,
    // escalation_level chain.length'e sabitlenir, alarm_events'e kalıcı iz kalır. ===
    await q(`INSERT INTO companies (id, name, tax_number) VALUES ($1, 'Test Boş Firma (NOTIF-1606)', '0000000000')`, [emptyCompanyId]);
    const alarm5Key = `NOTIF1606-TEST-${RUN}-5`;
    const raise5 = await runWithTenant({ tenantId: emptyCompanyId }, () =>
      raiseAlarmForCurrentTenant({ alarmKey: alarm5Key, category: 'OTHER', severity: 'CRITICAL', title: `Test Alarm 5 (${RUN})` })
    );
    await backdateAlarm(raise5.alarmId, 20, null);
    const escalated5 = await runWithTenant({ tenantId: emptyCompanyId }, () => runAlarmEscalationForCurrentTenant());
    await notifyAlarmEscalationRecipients(emptyCompanyId, escalated5); // alıcısız → hiçbir şey göndermemeli, patlamamalı
    const events5 = await q(`SELECT detail FROM alarm_events WHERE alarm_id = $1 AND (detail->>'type') = 'ESCALATION_CHAIN_EXHAUSTED'`, [raise5.alarmId]);
    const alarmAfter5 = await q(`SELECT escalation_level FROM alarms WHERE id = $1`, [raise5.alarmId]);
    check(
      'Test 5 (Teknik Not — zincir tükenirse sessizce kaybolmaz): hiç kullanıcısı olmayan tenant\'ta zincir TÜKENİR, chain_exhausted=true, escalation_level=3\'e sabitlenir, alarm_events\'e kalıcı iz kalır',
      escalated5.length === 1 && escalated5[0].chain_exhausted === true && escalated5[0].notify_role === null &&
        alarmAfter5[0]?.escalation_level === 3 && events5.length === 1,
      `chainExhausted=${escalated5[0]?.chain_exhausted}, level=${alarmAfter5[0]?.escalation_level}, eventCount=${events5.length}`
    );
  } finally {
    if (alarmIds.length > 0) {
      await q('DELETE FROM notifications WHERE idempotency_key LIKE ANY($1)', [alarmIds.map((id) => `alarm-escalation-${id}-%`)]);
      await q('DELETE FROM alarm_events WHERE alarm_id = ANY($1)', [alarmIds]);
      await q('DELETE FROM alarms WHERE id = ANY($1)', [alarmIds]);
    }
    await q('DELETE FROM companies WHERE id = $1', [emptyCompanyId]); // CASCADE → o tenant'ın alarm/alarm_events'i de silinir
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
