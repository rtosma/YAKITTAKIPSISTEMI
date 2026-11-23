import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { notifyEvent } from '../src/services/notificationService';

/**
 * NOTIF-1605 (#162) — Kullanıcı bazlı abonelik ve sessize alma.
 *
 * Ticket'ın ayrı bir "subscription service" önerisi bu kod tabanında YOK —
 * tercih/sessize-alma kontrolü notifyEvent() İÇİNE gömülü
 * (isDeliveryAllowedByPreference, bkz. notificationService.ts).
 *
 * Kapsam (AC):
 *  1) Kullanıcı, bildirim tiplerini kanal bazında açıp kapatabilmelidir.
 *  2) Güvenlik bildirimleri (isSecurityCritical) tamamen kapatılamamalıdır —
 *     en az bir kanal (IN_APP) her koşulda zorunlu kalır.
 *  3) Sessize alma zaman sınırlı olmalıdır; süre dolunca OTOMATİK kalkar
 *     (temizlik işi YOK — `muted_until > NOW()` karşılaştırması).
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();

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
  console.log('🔔 [NOTIF-1605] KULLANICI BAZLI ABONELİK VE SESSİZE ALMA TESTİ');
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

  const owner = await login('camsa');
  const camsaId = (await q(`SELECT id FROM users WHERE username = 'camsa'`))[0].id;
  const createdNotificationIds: string[] = [];

  try {
    // === Test 1 (ASIL AC — kanal bazlı açma/kapama): tercih kapatılınca notifyEvent
    // bildirim SATIRI DAHİ YARATMADAN skippedByPreference=true döner. ===
    const off1 = await call('PUT', '/notifications/preferences', { token: owner, body: { eventType: 'TANK_LOW_STOCK_FORECAST', channel: 'IN_APP', enabled: false } });
    const idem1 = `notif1605-t1-${RUN}`;
    const result1 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Kapalı-Tercih', estimatedDaysRemaining: 1 }, { userId: camsaId, channel: 'IN_APP', idempotencyKey: idem1 });
    const rowCount1 = (await q('SELECT COUNT(*) FROM notifications WHERE idempotency_key = $1', [idem1]))[0].count;
    check(
      'Test 1 (ASIL AC — kanal bazlı kapama): tercih kapalıyken notifyEvent skippedByPreference=true döner, HİÇ satır yaratmaz',
      off1.status === 200 && result1.skippedByPreference === true && result1.notificationId === null && rowCount1 === '0',
      `putStatus=${off1.status}, skippedByPreference=${result1.skippedByPreference}, notificationId=${result1.notificationId}, rowCount=${rowCount1}`
    );

    // === Test 2: tercih yeniden açılınca AYNI event tipi/kanal normal şekilde teslim edilir. ===
    const on1 = await call('PUT', '/notifications/preferences', { token: owner, body: { eventType: 'TANK_LOW_STOCK_FORECAST', channel: 'IN_APP', enabled: true } });
    const idem2 = `notif1605-t2-${RUN}`;
    const result2 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Açık-Tercih', estimatedDaysRemaining: 1 }, { userId: camsaId, channel: 'IN_APP', idempotencyKey: idem2 });
    if (result2.notificationId) createdNotificationIds.push(result2.notificationId);
    const db2 = await q('SELECT status FROM notifications WHERE id = $1', [result2.notificationId]);
    check(
      "Test 2: tercih yeniden açılınca notifyEvent skippedByPreference=false, bildirim GÖNDERILDI'ye düşer",
      on1.status === 200 && result2.skippedByPreference === false && db2[0]?.status === 'GÖNDERILDI',
      `putStatus=${on1.status}, skippedByPreference=${result2.skippedByPreference}, status=${db2[0]?.status}`
    );

    // === Test 3 (ASIL AC — güvenlik bildirimleri tamamen kapatılamaz): THEFT_DETECTED (isSecurityCritical)
    // IN_APP kanalı tercih AÇIKÇA KAPALI olsa BİLE her zaman teslim edilir. ===
    const offSecurity = await call('PUT', '/notifications/preferences', { token: owner, body: { eventType: 'THEFT_DETECTED', channel: 'IN_APP', enabled: false } });
    const idem3 = `notif1605-t3-${RUN}`;
    const result3 = await notifyEvent('comp-camsa', 'THEFT_DETECTED', { tankName: 'Güvenlik-Tank', siteName: 'Test-Şantiye' }, { userId: camsaId, channel: 'IN_APP', priority: 'CRITICAL', idempotencyKey: idem3 });
    if (result3.notificationId) createdNotificationIds.push(result3.notificationId);
    const db3 = await q('SELECT status FROM notifications WHERE id = $1', [result3.notificationId]);
    check(
      "Test 3 (ASIL AC — güvenlik bildirimi tamamen kapatılamaz): IN_APP tercihi KAPALI olsa da THEFT_DETECTED yine de teslim edilir",
      offSecurity.status === 200 && result3.skippedByPreference === false && !!result3.notificationId && db3[0]?.status === 'GÖNDERILDI',
      `putStatus=${offSecurity.status}, skippedByPreference=${result3.skippedByPreference}, notificationId=${result3.notificationId}, status=${db3[0]?.status}`
    );

    // === Test 4 (ASIL AC — zaman sınırlı sessize alma): mute aktifken NORMAL (güvenlik-dışı)
    // bildirim skippedByPreference=true döner. ===
    const muteRes = await call('POST', '/notifications/mute', { token: owner, body: { durationMinutes: 60 } });
    const idem4 = `notif1605-t4-${RUN}`;
    const result4 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Sessize-Alındı', estimatedDaysRemaining: 1 }, { userId: camsaId, channel: 'IN_APP', idempotencyKey: idem4 });
    check(
      'Test 4 (ASIL AC — sessize alma): aktif mute varken güvenlik-dışı bildirim skippedByPreference=true döner',
      muteRes.status === 200 && result4.skippedByPreference === true && result4.notificationId === null,
      `muteStatus=${muteRes.status}, skippedByPreference=${result4.skippedByPreference}, notificationId=${result4.notificationId}`
    );

    // === Test 5: aktif mute'lar GET /notifications/mute ile görülebilir. ===
    const muteList = await call('GET', '/notifications/mute', { token: owner });
    const foundMute = muteList.body?.data?.find((m: any) => m.id === muteRes.body?.data?.id);
    check('Test 5: GET /notifications/mute az önce oluşturulan sessize almayı listeler', muteList.status === 200 && !!foundMute, `status=${muteList.status}, found=${!!foundMute}`);

    // === Test 6 (ASIL AC — güvenlik bildirimleri sessize alınamaz): mute AKTİFKEN
    // THEFT_DETECTED IN_APP yine de teslim edilir. ===
    const idem6 = `notif1605-t6-${RUN}`;
    const result6 = await notifyEvent('comp-camsa', 'THEFT_DETECTED', { tankName: 'Güvenlik-Tank-2', siteName: 'Test-Şantiye' }, { userId: camsaId, channel: 'IN_APP', priority: 'CRITICAL', idempotencyKey: idem6 });
    if (result6.notificationId) createdNotificationIds.push(result6.notificationId);
    check(
      'Test 6 (ASIL AC — güvenlik bildirimi mute\'tan bağımsız): aktif mute varken THEFT_DETECTED IN_APP yine de teslim edilir',
      result6.skippedByPreference === false && !!result6.notificationId,
      `skippedByPreference=${result6.skippedByPreference}, notificationId=${result6.notificationId}`
    );

    // === Test 7 (ASIL AC — otomatik kalkma, temizlik işi YOK): muted_until GEÇMİŞTE olan
    // bir mute satırı elle yaratılırsa notifyEvent'i ARTIK ENGELLEMEZ (TTL karşılaştırmasıyla
    // kendiliğinden etkisiz). ===
    await q('DELETE FROM user_notification_mutes WHERE user_id = $1', [camsaId]);
    const expiredMuteId = `notifmute-expired-${RUN}`;
    await q(
      `INSERT INTO user_notification_mutes (id, tenant_id, user_id, event_type, muted_until) VALUES ($1, 'comp-camsa', $2, NULL, CURRENT_TIMESTAMP - INTERVAL '1 minute')`,
      [expiredMuteId, camsaId]
    );
    const idem7 = `notif1605-t7-${RUN}`;
    const result7 = await notifyEvent('comp-camsa', 'TANK_LOW_STOCK_FORECAST', { tankName: 'Süresi-Dolmuş-Mute', estimatedDaysRemaining: 1 }, { userId: camsaId, channel: 'IN_APP', idempotencyKey: idem7 });
    if (result7.notificationId) createdNotificationIds.push(result7.notificationId);
    check(
      'Test 7 (ASIL AC — otomatik kalkma): muted_until GEÇMİŞTE olan mute satırı notifyEvent\'i ENGELLEMEZ',
      result7.skippedByPreference === false && !!result7.notificationId,
      `skippedByPreference=${result7.skippedByPreference}, notificationId=${result7.notificationId}`
    );

    // === Test 8: GET /notifications/preferences kayıtlı tercihleri döndürür. ===
    const prefList = await call('GET', '/notifications/preferences', { token: owner });
    const foundPref = prefList.body?.data?.find((p: any) => p.event_type === 'THEFT_DETECTED' && p.channel === 'IN_APP');
    check(
      "Test 8: GET /notifications/preferences THEFT_DETECTED/IN_APP için enabled=false kaydını döndürür",
      prefList.status === 200 && !!foundPref && foundPref.enabled === false,
      `status=${prefList.status}, found=${!!foundPref}, enabled=${foundPref?.enabled}`
    );
  } finally {
    await q('DELETE FROM notifications WHERE id = ANY($1)', [createdNotificationIds]);
    await q('DELETE FROM user_notification_preferences WHERE user_id = $1', [camsaId]);
    await q('DELETE FROM user_notification_mutes WHERE user_id = $1', [camsaId]);
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
