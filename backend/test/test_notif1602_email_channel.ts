import { SMTPServer } from 'smtp-server';
import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { notifyEvent, runNotificationRetrySweepForCurrentTenant } from '../src/services/notificationService';
import { redisPool } from '../src/db/redisPool';
import { runWithTenant } from '../src/context/tenantContext';

/**
 * NOTIF-1602 (#159) — E-posta kanalı ve teslim takibi.
 *
 * Ticket'ın kendi Test Notu: "mock SMTP ile gönderim, bounce simülasyonu."
 * `smtp-server` ile GERÇEK, yerel bir SMTP dinleyicisi başlatılır (dış ağa
 * hiç çıkmadan) — bir alıcı adresi (`bounce@`) RCPT TO'da 550 ile
 * reddedilerek gerçek bir SMTP bounce simüle edilir; nodemailer bu hatayı
 * `err.responseCode=550` ile client'a taşır (emailChannel.ts'in
 * isPermanentSmtpFailure'ının doğrulandığı gerçek uçtan-uca yol).
 *
 * NOT: config/env.ts SMTP_HOST'u process başlarken OKUR (cachedConfig) —
 * bu yüzden test process'i SMTP_HOST/SMTP_PORT ortam değişkenlerini
 * import'lardan ÖNCE ayarlamalıdır (bkz. docker run -e bayrakları).
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();
const SMTP_TEST_PORT = 2525;

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

interface ReceivedMail {
  to: string;
  raw: string;
}

async function run() {
  console.log('===========================================================');
  console.log('📧 [NOTIF-1602] E-POSTA KANALI VE TESLİM TAKİBİ TESTİ');
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

  const received: ReceivedMail[] = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onRcptTo(address, _session, callback) {
      if (address.address.startsWith('bounce')) {
        const err: any = new Error('550 5.1.1 Kullanıcı bilinmiyor');
        err.responseCode = 550;
        return callback(err);
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        received.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), raw: Buffer.concat(chunks).toString('utf-8') });
        callback();
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    smtp.listen(SMTP_TEST_PORT, resolve);
    smtp.on('error', reject);
  });

  const owner = await login('camsa');
  const successUserId = `usr-notif1602-ok-${RUN}`;
  const bounceUserId = `usr-notif1602-bounce-${RUN}`;
  const noEmailUserId = `usr-notif1602-noemail-${RUN}`;
  const successEmail = `success-${RUN}@test.local`;
  const bounceEmail = `bounce-${RUN}@test.local`;
  const createdNotificationIds: string[] = [];

  try {
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role, email) SELECT $1, 'comp-camsa', $2, password_hash, 'PUMP_OPERATOR', $3 FROM users WHERE username = 'camsa'`, [successUserId, `notif1602-ok-${RUN}`, successEmail]);
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role, email) SELECT $1, 'comp-camsa', $2, password_hash, 'PUMP_OPERATOR', $3 FROM users WHERE username = 'camsa'`, [bounceUserId, `notif1602-bounce-${RUN}`, bounceEmail]);
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) SELECT $1, 'comp-camsa', $2, password_hash, 'PUMP_OPERATOR' FROM users WHERE username = 'camsa'`, [noEmailUserId, `notif1602-noemail-${RUN}`]);

    // === Test 1 (ASIL AC — HTML ve düz metin): başarılı EMAIL teslimi GÖNDERILDI'ye düşer
    // VE mock SMTP sunucusu HEM text/plain HEM text/html içeren bir mesaj alır. ===
    const result1 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: `E-posta-Tank-${RUN}`, estimatedDaysRemaining: 3 }, { userId: successUserId, channel: 'EMAIL', idempotencyKey: `notif1602-t1-${RUN}` });
    if (result1.notificationId) createdNotificationIds.push(result1.notificationId);
    const dbAfter1 = await q('SELECT status FROM notifications WHERE id = $1', [result1.notificationId]);
    const mail1 = received.find((m) => m.to === successEmail);
    check(
      "Test 1 (ASIL AC — HTML+düz metin): EMAIL kanalı GÖNDERILDI'ye düşer, mock SMTP mesajı text/plain VE text/html olarak alır",
      dbAfter1[0]?.status === 'GÖNDERILDI' && !!mail1 && mail1.raw.includes('Content-Type: text/plain') && mail1.raw.includes('Content-Type: text/html') && mail1.raw.includes('<p>'),
      `status=${dbAfter1[0]?.status}, mailReceived=${!!mail1}, hasPlain=${mail1?.raw.includes('text/plain')}, hasHtml=${mail1?.raw.includes('text/html')}`
    );

    // === Test 2 (ASIL AC — bounce işaretleme): bounce@ adresine gönderim 550 ile reddedilir,
    // notification ANINDA KALICI_BAŞARISIZ'a düşer VE kullanıcının email_bounced_at'i dolar. ===
    const result2 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'X', estimatedDaysRemaining: 1 }, { userId: bounceUserId, channel: 'EMAIL', idempotencyKey: `notif1602-t2-${RUN}` });
    if (result2.notificationId) createdNotificationIds.push(result2.notificationId);
    const dbAfter2 = await q('SELECT status FROM notifications WHERE id = $1', [result2.notificationId]);
    const bouncedUser = await q('SELECT email_bounced_at FROM users WHERE id = $1', [bounceUserId]);
    check(
      'Test 2 (ASIL AC — bounce işaretleme): 550 reddi notification\'ı ANINDA KALICI_BAŞARISIZ yapar, kullanıcı email_bounced_at doldu',
      dbAfter2[0]?.status === 'KALICI_BAŞARISIZ' && !!bouncedUser[0]?.email_bounced_at,
      `status=${dbAfter2[0]?.status}, email_bounced_at=${bouncedUser[0]?.email_bounced_at}`
    );

    // === Test 3 (ASIL AC — bounce eden adrese TEKRAR denenmez): AYNI (bounce) kullanıcıya
    // İKİNCİ bir bildirim denemesi SMTP sunucusuna HİÇ ULAŞMADAN reddedilir. ===
    const mailCountBefore = received.filter((m) => m.to === bounceEmail).length;
    const result3 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Y', estimatedDaysRemaining: 1 }, { userId: bounceUserId, channel: 'EMAIL', idempotencyKey: `notif1602-t3-${RUN}` });
    if (result3.notificationId) createdNotificationIds.push(result3.notificationId);
    const mailCountAfter = received.filter((m) => m.to === bounceEmail).length;
    const dbAfter3 = await q('SELECT status FROM notifications WHERE id = $1', [result3.notificationId]);
    check(
      "Test 3 (ASIL AC — bounce eden adrese tekrar denenmez): 2. deneme SMTP'ye HİÇ ulaşmadan (mail sayısı DEĞİŞMEDİ) ANINDA KALICI_BAŞARISIZ",
      mailCountBefore === mailCountAfter && dbAfter3[0]?.status === 'KALICI_BAŞARISIZ',
      `mailCountBefore=${mailCountBefore}, mailCountAfter=${mailCountAfter}, status=${dbAfter3[0]?.status}`
    );

    // === Test 4: e-postası olmayan bir kullanıcıya EMAIL kanalı denemesi de ANINDA KALICI_BAŞARISIZ. ===
    const result4 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Z', estimatedDaysRemaining: 1 }, { userId: noEmailUserId, channel: 'EMAIL', idempotencyKey: `notif1602-t4-${RUN}` });
    if (result4.notificationId) createdNotificationIds.push(result4.notificationId);
    const dbAfter4 = await q('SELECT status FROM notifications WHERE id = $1', [result4.notificationId]);
    check('Test 4: e-postası olmayan kullanıcıya EMAIL denemesi ANINDA KALICI_BAŞARISIZ', dbAfter4[0]?.status === 'KALICI_BAŞARISIZ', `status=${dbAfter4[0]?.status}`);

    // === Test 5 (ASIL AC — gönderim hızı sınırı): sayaç sınırı zaten aşmış gibi elle
    // ayarlanınca NORMAL öncelik reddedilir, CRITICAL öncelik ise sınırı ATLAR ve gönderilir. ===
    const rateLimitKey = `notif:email:ratelimit:comp-camsa`;
    await redisPool.client.set(rateLimitKey, '999', 'EX', 60);
    const result5Normal = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'RL-Normal', estimatedDaysRemaining: 1 }, { userId: successUserId, channel: 'EMAIL', priority: 'NORMAL', idempotencyKey: `notif1602-t5n-${RUN}` });
    const result5Critical = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'RL-Critical', estimatedDaysRemaining: 1 }, { userId: successUserId, channel: 'EMAIL', priority: 'CRITICAL', idempotencyKey: `notif1602-t5c-${RUN}` });
    if (result5Normal.notificationId) createdNotificationIds.push(result5Normal.notificationId);
    if (result5Critical.notificationId) createdNotificationIds.push(result5Critical.notificationId);
    const dbNormal = await q('SELECT status FROM notifications WHERE id = $1', [result5Normal.notificationId]);
    const dbCritical = await q('SELECT status FROM notifications WHERE id = $1', [result5Critical.notificationId]);
    check(
      'Test 5 (ASIL AC — gönderim hızı sınırı): sınır aşılmışken NORMAL öncelik BAŞARISIZ, CRITICAL öncelik sınırı ATLAYIP GÖNDERILDI',
      dbNormal[0]?.status === 'BAŞARISIZ' && dbCritical[0]?.status === 'GÖNDERILDI',
      `normalStatus=${dbNormal[0]?.status}, criticalStatus=${dbCritical[0]?.status}`
    );
    await redisPool.client.del(rateLimitKey);

    // === Test 6 (ASIL AC — yeniden deneme): rate-limit yüzünden BAŞARISIZ kalan Test 5'in
    // NORMAL bildirimi, sınır sıfırlandıktan SONRA süpürücüyle başarıyla yeniden denenir. ===
    const sweepResult = await runWithTenant({ tenantId: 'comp-camsa' }, () => runNotificationRetrySweepForCurrentTenant());
    const dbNormalAfterSweep = await q('SELECT status FROM notifications WHERE id = $1', [result5Normal.notificationId]);
    check(
      'Test 6 (ASIL AC — yeniden deneme): rate-limit sıfırlandıktan sonra süpürücü BAŞARISIZ e-postayı başarıyla yeniden dener',
      sweepResult.retried >= 1 && dbNormalAfterSweep[0]?.status === 'GÖNDERILDI',
      `retried=${sweepResult.retried}, status=${dbNormalAfterSweep[0]?.status}`
    );
  } finally {
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
    await q('DELETE FROM notifications WHERE id = ANY($1)', [createdNotificationIds]);
    await q('DELETE FROM users WHERE id = ANY($1)', [[successUserId, bounceUserId, noEmailUserId]]);
    await redisPool.client.del(`notif:email:ratelimit:comp-camsa`);
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
