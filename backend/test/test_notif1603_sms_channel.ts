import http from 'http';
import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { notifyEvent, runNotificationRetrySweepForCurrentTenant } from '../src/services/notificationService';
import { runWithTenant } from '../src/context/tenantContext';
import { transliterateTurkish, computeSmsSegmentCount } from '../src/notifications/smsChannel';

/**
 * NOTIF-1603 (#160) — SMS kanalı entegrasyonu.
 *
 * Ticket'ın kendi Test Notu: "mock sağlayıcı ile gönderim, uzunluk hesabı,
 * limit aşımı davranışı." Node'un yerleşik `http` modülüyle GERÇEK bir
 * yerel REST dinleyicisi (mock SMS sağlayıcı) başlatılır — SMTP mock'u
 * (NOTIF-1602, `smtp-server`) ile AYNI felsefe: yeni bir mock kütüphanesi
 * YERİNE zaten var olan ilkellerle (burada: http.createServer) gerçek bir
 * uçtan-uca protokol egzersizi.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();
const SMS_MOCK_PORT = 3999;

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

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: '123456' }) });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

interface ReceivedSms {
  to: string;
  text: string;
  segments: number;
}

async function run() {
  console.log('===========================================================');
  console.log('📱 [NOTIF-1603] SMS KANALI ENTEGRASYONU TESTİ');
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

  const received: ReceivedSms[] = [];
  let forceProviderFailureOnce = false;
  const mockProvider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (forceProviderFailureOnce) {
        forceProviderFailureOnce = false;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'transient provider error' }));
        return;
      }
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>((resolve) => mockProvider.listen(SMS_MOCK_PORT, resolve));

  const owner = await login('camsa');
  const critUserId = `usr-notif1603-crit-${RUN}`;
  const noPhoneUserId = `usr-notif1603-nophone-${RUN}`;
  const critPhone = `+90555${String(RUN).slice(-7)}`;
  const createdNotificationIds: string[] = [];

  try {
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role, phone) SELECT $1, 'comp-camsa', $2, password_hash, 'SITE_MANAGER', $3 FROM users WHERE username = 'camsa'`, [critUserId, `notif1603-crit-${RUN}`, critPhone]);
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) SELECT $1, 'comp-camsa', $2, password_hash, 'SITE_MANAGER' FROM users WHERE username = 'camsa'`, [noPhoneUserId, `notif1603-nophone-${RUN}`]);
    await q(`DELETE FROM sms_monthly_usage WHERE tenant_id = 'comp-camsa'`);
    await q(`DELETE FROM alarms WHERE tenant_id = 'comp-camsa' AND category = 'SMS_MONTHLY_LIMIT_EXCEEDED'`);

    // === Test 1 (ASIL AC — yalnızca kritik olaylarda SMS): NORMAL öncelikli bir bildirim
    // SMS kanalıyla denenirse sağlayıcıya HİÇ ulaşmadan ANINDA KALICI_BAŞARISIZ. ===
    const result1 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'X', estimatedDaysRemaining: 5 }, { userId: critUserId, channel: 'SMS', priority: 'NORMAL', idempotencyKey: `notif1603-t1-${RUN}` });
    if (result1.notificationId) createdNotificationIds.push(result1.notificationId);
    const dbAfter1 = await q('SELECT status FROM notifications WHERE id = $1', [result1.notificationId]);
    check(
      "Test 1 (ASIL AC — yalnızca kritik): NORMAL öncelikli SMS denemesi sağlayıcıya ULAŞMADAN (0 mesaj) ANINDA KALICI_BAŞARISIZ",
      dbAfter1[0]?.status === 'KALICI_BAŞARISIZ' && received.length === 0,
      `status=${dbAfter1[0]?.status}, receivedCount=${received.length}`
    );

    // === Test 2 (ASIL AC — Türkçe karakter yönetimi): CRITICAL + Türkçe karakterli bir
    // gövde → sağlayıcıya GİDEN metinde HİÇ Türkçe karakter YOK (transliterate edilmiş). ===
    const result2 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Şantiye-Öğüt', estimatedDaysRemaining: 1, currentLevelLiters: 100 }, { userId: critUserId, channel: 'SMS', priority: 'CRITICAL', idempotencyKey: `notif1603-t2-${RUN}` });
    if (result2.notificationId) createdNotificationIds.push(result2.notificationId);
    const dbAfter2 = await q('SELECT status FROM notifications WHERE id = $1', [result2.notificationId]);
    const sms2 = received[received.length - 1];
    const turkishCharsRegex = /[çÇğĞıİöÖşŞüÜ]/;
    check(
      'Test 2 (ASIL AC — Türkçe karakter yönetimi): CRITICAL SMS gönderilir, sağlayıcıya giden metinde Türkçe karakter YOK',
      dbAfter2[0]?.status === 'GÖNDERILDI' && !!sms2 && sms2.to === critPhone && !turkishCharsRegex.test(sms2.text) && sms2.text.includes('Santiye-Ogut'),
      `status=${dbAfter2[0]?.status}, smsText=${sms2?.text}`
    );

    // === Test 2b: computeSmsSegmentCount doğru hesaplanır (birim, GSM-7 varsayımıyla). ===
    check(
      'Test 2b: computeSmsSegmentCount — 160 karakter 1 segment, 161 karakter 2 segment',
      computeSmsSegmentCount('a'.repeat(160)) === 1 && computeSmsSegmentCount('a'.repeat(161)) === 2,
      `160→${computeSmsSegmentCount('a'.repeat(160))}, 161→${computeSmsSegmentCount('a'.repeat(161))}`
    );
    check('Test 2c: transliterateTurkish tüm Türkçe karakterleri ASCII karşılığına çevirir', transliterateTurkish('çĞıİöŞüÜ') === 'cGiIoSuU', `sonuç=${transliterateTurkish('çĞıİöŞüÜ')}`);

    // === Test 3: telefonu olmayan bir kullanıcıya CRITICAL SMS denemesi de ANINDA KALICI_BAŞARISIZ. ===
    const result3 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Y', estimatedDaysRemaining: 1 }, { userId: noPhoneUserId, channel: 'SMS', priority: 'CRITICAL', idempotencyKey: `notif1603-t3-${RUN}` });
    if (result3.notificationId) createdNotificationIds.push(result3.notificationId);
    const dbAfter3 = await q('SELECT status FROM notifications WHERE id = $1', [result3.notificationId]);
    check('Test 3: telefonu olmayan kullanıcıya CRITICAL SMS denemesi ANINDA KALICI_BAŞARISIZ', dbAfter3[0]?.status === 'KALICI_BAŞARISIZ', `status=${dbAfter3[0]?.status}`);

    // === Test 4 (ASIL AC — aylık limit aşımı → uyarı): sayaç zaten limitte gibi elle ayarlanınca
    // CRITICAL SMS denemesi BAŞARISIZ olur VE tam olarak BİR AI-507 alarmı üretilir. ===
    const yearMonth = new Date().toISOString().slice(0, 7);
    await q(
      `INSERT INTO sms_monthly_usage (tenant_id, year_month, sent_count, monthly_limit) VALUES ('comp-camsa', $1, 100, 100)
       ON CONFLICT (tenant_id, year_month) DO UPDATE SET sent_count = 100, monthly_limit = 100, limit_alarm_raised = FALSE`,
      [yearMonth]
    );
    const result4a = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Limit-A', estimatedDaysRemaining: 1 }, { userId: critUserId, channel: 'SMS', priority: 'CRITICAL', idempotencyKey: `notif1603-t4a-${RUN}` });
    const result4b = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Limit-B', estimatedDaysRemaining: 1 }, { userId: critUserId, channel: 'SMS', priority: 'CRITICAL', idempotencyKey: `notif1603-t4b-${RUN}` });
    if (result4a.notificationId) createdNotificationIds.push(result4a.notificationId);
    if (result4b.notificationId) createdNotificationIds.push(result4b.notificationId);
    const db4a = await q('SELECT status FROM notifications WHERE id = $1', [result4a.notificationId]);
    const db4b = await q('SELECT status FROM notifications WHERE id = $1', [result4b.notificationId]);
    const limitAlarms = await q(`SELECT id, event_count FROM alarms WHERE tenant_id = 'comp-camsa' AND category = 'SMS_MONTHLY_LIMIT_EXCEEDED'`);
    check(
      'Test 4 (ASIL AC — aylık limit aşımı → uyarı): limit dolunca CRITICAL SMS denemeleri BAŞARISIZ olur, İKİ ayrı deneme TEK bir alarm satırı üretir (event_count arttı)',
      db4a[0]?.status === 'BAŞARISIZ' && db4b[0]?.status === 'BAŞARISIZ' && limitAlarms.length === 1,
      `status4a=${db4a[0]?.status}, status4b=${db4b[0]?.status}, alarmRows=${limitAlarms.length}, eventCount=${limitAlarms[0]?.event_count}`
    );

    // === Test 5 (ASIL AC — süpürücü retry'da priority'yi KORUR): limit sıfırlanınca (ayı
    // sıfırlayıp) süpürücü Test 4'ün BAŞARISIZ CRITICAL SMS'ini BAŞARIYLA yeniden dener —
    // eğer retry priority'yi kaybedip 'NORMAL'e düşürseydi bu KALICI_BAŞARISIZ olurdu. ===
    await q(`UPDATE sms_monthly_usage SET sent_count = 0 WHERE tenant_id = 'comp-camsa' AND year_month = $1`, [yearMonth]);
    const sweepResult = await runWithTenant({ tenantId: 'comp-camsa' }, () => runNotificationRetrySweepForCurrentTenant());
    const db4aAfterSweep = await q('SELECT status FROM notifications WHERE id = $1', [result4a.notificationId]);
    check(
      "Test 5 (ASIL AC — süpürücü CRITICAL önceliği korur): limit sıfırlanınca süpürücü BAŞARISIZ CRITICAL SMS'i BAŞARIYLA yeniden dener (GÖNDERILDI, KALICI_BAŞARISIZ DEĞİL)",
      sweepResult.retried >= 1 && db4aAfterSweep[0]?.status === 'GÖNDERILDI',
      `retried=${sweepResult.retried}, status=${db4aAfterSweep[0]?.status}`
    );

    // === Test 6: geçici bir sağlayıcı hatası (500) sonrası süpürücü yeniden dener ve başarır. ===
    forceProviderFailureOnce = true;
    const result6 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Transient', estimatedDaysRemaining: 1 }, { userId: critUserId, channel: 'SMS', priority: 'CRITICAL', idempotencyKey: `notif1603-t6-${RUN}` });
    if (result6.notificationId) createdNotificationIds.push(result6.notificationId);
    const db6Before = await q('SELECT status FROM notifications WHERE id = $1', [result6.notificationId]);
    const sweepResult6 = await runWithTenant({ tenantId: 'comp-camsa' }, () => runNotificationRetrySweepForCurrentTenant());
    const db6After = await q('SELECT status FROM notifications WHERE id = $1', [result6.notificationId]);
    check(
      'Test 6 (yeniden deneme): geçici sağlayıcı hatası BAŞARISIZ\'a düşer, süpürücü sonraki turda başarıyla teslim eder',
      db6Before[0]?.status === 'BAŞARISIZ' && sweepResult6.retried >= 1 && db6After[0]?.status === 'GÖNDERILDI',
      `before=${db6Before[0]?.status}, retried=${sweepResult6.retried}, after=${db6After[0]?.status}`
    );
  } finally {
    await new Promise<void>((resolve) => mockProvider.close(() => resolve()));
    await q('DELETE FROM notifications WHERE id = ANY($1)', [createdNotificationIds]);
    await q('DELETE FROM users WHERE id = ANY($1)', [[critUserId, noPhoneUserId]]);
    await q(`DELETE FROM sms_monthly_usage WHERE tenant_id = 'comp-camsa'`);
    await q(`DELETE FROM alarms WHERE tenant_id = 'comp-camsa' AND category = 'SMS_MONTHLY_LIMIT_EXCEEDED'`);
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
