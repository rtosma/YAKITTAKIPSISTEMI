import http from 'http';
import crypto from 'crypto';
import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { sendTestNotification } from '../src/services/notificationService';

/**
 * NOTIF-1604 (#161) — Telegram ve webhook kanalları.
 *
 * Ticket'ın kendi Test Notu: "mock Telegram/webhook uçlarıyla gönderim,
 * imza doğrulama, timeout davranışı." Node'un yerleşik `http` modülüyle
 * GERÇEK yerel dinleyiciler (SMS/e-posta testlerindeki AYNI felsefe);
 * Telegram API taban URL'i TELEGRAM_API_BASE_URL ile bu mock'a yönlendirilir
 * (config/env.ts, gerçek api.telegram.org'a HİÇ gidilmez).
 *
 * Kanal YAPILANDIRMASI (PUT/GET /notifications/channels) gerçek HTTP API
 * üzerinden (login gerektirir, salt DB okuma/yazma — dışa çıkış YOK). Asıl
 * GÖNDERİM (test-send) ise `sendTestNotification()`'ın DOĞRUDAN import
 * edilip çağrılmasıyla (test_notif1602/1603 ile AYNI desen) — bu, mock
 * Telegram/webhook sunucularının test-runner CONTAINER'ının KENDİ süreç
 * içinde (aynı network namespace, `docker run --network container:...`)
 * çalışmasını, TELEGRAM_API_BASE_URL'in doğrudan bu sürece -e ile
 * verilebilmesini sağlar — RUNNING backend container'ının docker-compose.yml
 * env allowlist'ini test amaçlı değiştirmeye GEREK KALMADAN.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TELEGRAM_MOCK_PORT = 4001;
const WEBHOOK_MOCK_PORT = 4002;

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

async function run() {
  console.log('===========================================================');
  console.log('📢 [NOTIF-1604] TELEGRAM VE WEBHOOK KANALLARI TESTİ');
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

  const telegramReceived: { path: string; body: any }[] = [];
  let telegramShouldFail = false;
  const telegramMock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (telegramShouldFail) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
        return;
      }
      telegramReceived.push({ path: req.url!, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => telegramMock.listen(TELEGRAM_MOCK_PORT, resolve));

  const webhookReceived: { body: string; signature: string | undefined }[] = [];
  let webhookShouldFail = false;
  let webhookDelayMs = 0;
  const webhookMock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const respond = () => {
        if (webhookShouldFail) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'webhook target error' }));
          return;
        }
        webhookReceived.push({ body: raw, signature: req.headers['x-webhook-signature'] as string | undefined });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      };
      if (webhookDelayMs > 0) setTimeout(respond, webhookDelayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => webhookMock.listen(WEBHOOK_MOCK_PORT, resolve));

  const owner = await login('camsa');
  const botToken = `mock-bot-token-${RUN}`;
  const chatId = `-100${RUN}`;
  const webhookSecret = `mock-webhook-secret-${RUN}-0123456789`;
  const webhookUrl = `http://localhost:${WEBHOOK_MOCK_PORT}/hook`;
  const createdNotificationIds: string[] = [];

  try {
    await q(`DELETE FROM tenant_notification_channels WHERE tenant_id = 'comp-camsa'`);
    await q(`DELETE FROM alarms WHERE tenant_id = 'comp-camsa' AND category = 'WEBHOOK_AUTO_DISABLED'`);

    // === Test 1 (ön koşul): PUT /notifications/channels ile Telegram + webhook yapılandırılır. ===
    const configRes = await call('PUT', '/notifications/channels', {
      token: owner,
      body: { telegramBotToken: botToken, telegramChatId: chatId, webhookUrl, webhookSecret }
    });
    check(
      'Test 1 (ön koşul): kanal yapılandırması kaydedilir, YANIT sırların KENDİSİNİ döndürmez',
      configRes.status === 200 && configRes.body?.data?.telegramConfigured === true && configRes.body?.data?.webhookConfigured === true && !JSON.stringify(configRes.body).includes(botToken),
      `status=${configRes.status}, data=${JSON.stringify(configRes.body?.data)}`
    );

    // === Test 1b (ASIL AC — token şifreli saklanır): DB'deki ham değer düz metin token İLE AYNI DEĞİL. ===
    const dbChannelRow = await q(`SELECT telegram_bot_token_encrypted, webhook_secret_encrypted FROM tenant_notification_channels WHERE tenant_id = 'comp-camsa'`);
    check(
      'Test 1b (ASIL AC — şifreleme): DB\'deki ham sütun değeri düz metin token/sır İLE AYNI DEĞİL',
      dbChannelRow[0]?.telegram_bot_token_encrypted !== botToken && dbChannelRow[0]?.webhook_secret_encrypted !== webhookSecret && !!dbChannelRow[0]?.telegram_bot_token_encrypted,
      `encryptedToken=${dbChannelRow[0]?.telegram_bot_token_encrypted?.slice(0, 20)}...`
    );

    // === Test 2 (ASIL AC — Telegram grubuna bildirim): test-send ile GERÇEK bir mesaj mock sunucuya ulaşır. ===
    telegramShouldFail = false;
    const telegramTest = await sendTestNotification('comp-camsa', 'TELEGRAM');
    check(
      'Test 2 (ASIL AC — Telegram grubuna bildirim): test-send başarılı, mock Telegram sunucusu doğru chat_id ile mesaj aldı',
      telegramTest.success === true && telegramReceived.length === 1 && telegramReceived[0].body.chat_id === chatId,
      `success=${telegramTest.success}, received=${JSON.stringify(telegramReceived[0]?.body)}`
    );

    // === Test 3 (ASIL AC — webhook imzalı): test-send ile giden HMAC imzası, AYNI sırla BEKLENEN imzayla EŞLEŞİR. ===
    webhookShouldFail = false;
    webhookDelayMs = 0;
    const webhookTest = await sendTestNotification('comp-camsa', 'WEBHOOK');
    const lastWebhook = webhookReceived[webhookReceived.length - 1];
    const expectedSignature = lastWebhook ? crypto.createHmac('sha256', webhookSecret).update(lastWebhook.body).digest('hex') : null;
    check(
      'Test 3 (ASIL AC — webhook imzalı): test-send başarılı, gelen X-Webhook-Signature BEKLENEN HMAC ile EŞLEŞİYOR',
      webhookTest.success === true && !!lastWebhook && lastWebhook.signature === expectedSignature,
      `success=${webhookTest.success}, signatureMatch=${lastWebhook?.signature === expectedSignature}`
    );

    // === Test 4 (ASIL AC — zaman aşımı korumalı): webhook hedefi 6 SANİYE geciktirilince
    // (timeout eşiği 5sn) çağrı TAKILI KALMADAN zaman aşımı hatasıyla BAŞARISIZ olur. ===
    webhookDelayMs = 6000;
    const startTime = Date.now();
    const timeoutTest = await sendTestNotification('comp-camsa', 'WEBHOOK');
    const elapsedMs = Date.now() - startTime;
    webhookDelayMs = 0;
    check(
      'Test 4 (ASIL AC — zaman aşımı korumalı): 6sn geciken hedef ~5sn içinde ZAMAN AŞIMI hatasıyla başarısız olur (sonsuza kadar beklemez)',
      timeoutTest.success === false && elapsedMs < 5900 && /zaman aşımı|timeout/i.test(timeoutTest.error ?? ''),
      `success=${timeoutTest.success}, elapsedMs=${elapsedMs}, error=${timeoutTest.error}`
    );

    // === Test 5 (ASIL AC — sürekli hata → otomatik devre dışı): webhook 5 ARDIŞIK kez
    // başarısız olunca otomatik devre dışı bırakılır, TEK bir alarm üretir, 6. deneme
    // sunucuya HİÇ ulaşmadan reddedilir. ===
    webhookShouldFail = true;
    for (let i = 0; i < 5; i++) {
      await sendTestNotification('comp-camsa', 'WEBHOOK');
    }
    const channelsAfter5 = await call('GET', '/notifications/channels', { token: owner });
    const countAfterFiveFailures = webhookReceived.length;
    const sixthAttempt = await sendTestNotification('comp-camsa', 'WEBHOOK');
    const disableAlarms = await q(`SELECT id, event_count FROM alarms WHERE tenant_id = 'comp-camsa' AND category = 'WEBHOOK_AUTO_DISABLED'`);
    check(
      'Test 5 (ASIL AC — otomatik devre dışı): 5 ardışık başarısızlık sonrası webhookDisabled=true, TEK alarm üretildi, 6. deneme sunucuya HİÇ ULAŞMADAN reddedildi',
      channelsAfter5.body?.data?.webhookDisabled === true &&
        disableAlarms.length === 1 &&
        sixthAttempt.success === false &&
        webhookReceived.length === countAfterFiveFailures, // 6. deneme sunucuya hiç istek göndermedi
      `webhookDisabled=${channelsAfter5.body?.data?.webhookDisabled}, alarmRows=${disableAlarms.length}, sixthSuccess=${sixthAttempt.success}, requestsAfter5th=${countAfterFiveFailures}, requestsAfter6th=${webhookReceived.length}`
    );

    // === Test 6 (ASIL AC — manuel düzeltme devreye alır): webhook'u YENİDEN yapılandırmak
    // (aynı URL/secret ile bile) devre kesiciyi SIFIRLAR, sonraki gönderim BAŞARILI olur. ===
    webhookShouldFail = false;
    const reconfigRes = await call('PUT', '/notifications/channels', { token: owner, body: { webhookUrl, webhookSecret } });
    const afterReconfigSend = await sendTestNotification('comp-camsa', 'WEBHOOK');
    check(
      'Test 6 (AC — manuel düzeltme devreye alır): webhook yeniden yapılandırılınca devre kesici sıfırlanır, gönderim yeniden BAŞARILI olur',
      reconfigRes.body?.data?.webhookDisabled === false && afterReconfigSend.success === true,
      `webhookDisabledAfterReconfig=${reconfigRes.body?.data?.webhookDisabled}, sendSuccess=${afterReconfigSend.success}`
    );

    // === Test 7: RBAC — PUMP_OPERATOR kanal yapılandıramaz. ===
    const pumpUsername = `notif1604-pump-${RUN}`;
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) SELECT $1, 'comp-camsa', $2, password_hash, 'PUMP_OPERATOR' FROM users WHERE username = 'camsa'`, [`usr-${pumpUsername}`, pumpUsername]);
    const pumpToken = await login(pumpUsername);
    const pumpDenied = await call('PUT', '/notifications/channels', { token: pumpToken, body: { webhookUrl } });
    check('Test 7: PUMP_OPERATOR kanal yapılandıramaz (403)', pumpDenied.status === 403, `status=${pumpDenied.status}`);
    await q(`DELETE FROM users WHERE username = $1`, [pumpUsername]);
  } finally {
    await new Promise<void>((resolve) => telegramMock.close(() => resolve()));
    await new Promise<void>((resolve) => webhookMock.close(() => resolve()));
    await q('DELETE FROM notifications WHERE id = ANY($1)', [createdNotificationIds]);
    await q(`DELETE FROM tenant_notification_channels WHERE tenant_id = 'comp-camsa'`);
    await q(`DELETE FROM alarms WHERE tenant_id = 'comp-camsa' AND category = 'WEBHOOK_AUTO_DISABLED'`);
    await q(`DELETE FROM users WHERE username = $1`, [`notif1604-pump-${RUN}`]);
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
