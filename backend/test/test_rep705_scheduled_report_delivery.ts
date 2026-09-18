import { SMTPServer } from 'smtp-server';
import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';
import { computeNextRunAt, runReportScheduleSweepForCurrentTenant } from '../src/services/reportScheduleService';
import { runWithTenant } from '../src/context/tenantContext';

/**
 * REP-705 (#167) — Zamanlanmış rapor gönderimi (cron → e-posta).
 *
 * NOTIF-1602 test dosyasıyla AYNI gerekçe: gerçek bir SMTP sunucusu YOK —
 * `smtp-server` ile GERÇEK, yerel bir dinleyici (2525 portu) başlatılır;
 * `bounce@` alıcısı 550 ile reddedilerek geçici/kalıcı gönderim hatası
 * simüle edilir.
 *
 * Kapsam (AC):
 *  1) Zamanlanan rapor belirlenen periyotta üretilip gönderilmelidir
 *     (computeNextRunAt birim testleri + süpürücü entegrasyon testi).
 *  2) 10MB üzeri raporlar bağlantı olarak gönderilmelidir (LINK modu +
 *     presigned indirme rotası; gerçek 10MB veri üretmek pratik olmadığından
 *     karar noktası mutation testing ile doğrulanır — bkz. konuşma).
 *  3) Gönderim hataları kayıt altına alınıp yeniden denenmelidir.
 * + Kapsam: boş rapor durumunda gönderim yapılmaması seçeneği, alıcı
 *   listesinin kullanıcı silindiğinde güncellenmesi.
 */

const API_URL = 'http://localhost:5000/api/v1';
const SMTP_TEST_PORT = 2525;
const RUN = Date.now();
const TENANT = 'comp-camsa';

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

interface ReceivedMail {
  to: string;
  raw: string;
}

/** nodemailer ekleri MIME'de base64 kodlar — raw metinde aramadan ÖNCE çözülmesi gerekir. */
function extractAttachmentText(raw: string): string {
  const match = raw.match(/Content-Disposition: attachment[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/);
  if (!match) return '';
  return Buffer.from(match[1].replace(/\r?\n/g, ''), 'base64').toString('utf-8');
}

async function run() {
  console.log('===========================================================');
  console.log('📅 [REP-705] ZAMANLANMIŞ RAPOR GÖNDERİMİ TESTİ');
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
  const pumpOp = await login('pompa-op-01');
  const scheduleIds: string[] = [];
  const txIds: string[] = [];
  const userIds: string[] = [];

  try {
    // === Test 1 (ASIL AC — periyoda göre üretim, birim testi): DAILY — hedef saat
    // henüz GEÇMEMİŞSE bugün, GEÇMİŞSE yarın döner. ===
    const beforeHour = computeNextRunAt('DAILY', 10, null, null, new Date('2026-01-05T05:00:00.000Z')); // 05:00 UTC = 08:00 İstanbul, hedef 10:00 henüz gelmedi
    const afterHour = computeNextRunAt('DAILY', 10, null, null, new Date('2026-01-05T09:00:00.000Z')); // 09:00 UTC = 12:00 İstanbul, hedef 10:00 geçti
    check(
      'Test 1 (ASIL AC — DAILY periyot hesabı): hedef saat henüz gelmediyse BUGÜN (07:00Z=10:00 İstanbul), geçtiyse YARIN döner',
      beforeHour.toISOString() === '2026-01-05T07:00:00.000Z' && afterHour.toISOString() === '2026-01-06T07:00:00.000Z',
      `beforeHour=${beforeHour.toISOString()}, afterHour=${afterHour.toISOString()}`
    );

    // === Test 2 (ASIL AC — WEEKLY periyot hesabı): Pazartesi(1) hedefi, Çarşamba'dan
    // bakınca bir sonraki Pazartesi'ye düşer. ===
    const weekly = computeNextRunAt('WEEKLY', 8, 1, null, new Date('2026-01-07T04:00:00.000Z')); // 2026-01-07 Çarşamba
    check(
      "Test 2 (ASIL AC — WEEKLY periyot hesabı): Çarşamba'dan bakınca hedef Pazartesi'ye (2026-01-12) düşer",
      weekly.toISOString() === '2026-01-12T05:00:00.000Z',
      `weekly=${weekly.toISOString()}`
    );

    // === Test 3 (ASIL AC — MONTHLY periyot hesabı): ayın 1'i hedefi, ay ortasından
    // bakınca bir sonraki ayın 1'ine düşer. ===
    const monthly = computeNextRunAt('MONTHLY', 6, null, 1, new Date('2026-01-15T04:00:00.000Z'));
    check(
      "Test 3 (ASIL AC — MONTHLY periyot hesabı): ay ortasından bakınca bir sonraki ayın 1'ine (2026-02-01) düşer",
      monthly.toISOString() === '2026-02-01T03:00:00.000Z',
      `monthly=${monthly.toISOString()}`
    );

    // === Fixture: tek, tekilleştirilebilir bir ikmal hareketi (rep-711'in tek satır döndürmesi için). ===
    const markerPlate = `REP705-${RUN}`;
    const txId = `tx-rep705-${RUN}`;
    txIds.push(txId);
    await q(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, amount_liters, created_at) VALUES ($1, $2, 'Gebze Ana Şantiye', $3, 150.5, NOW())`, [txId, TENANT, markerPlate]);

    const goodUserId = `usr-rep705-good-${RUN}`;
    const bounceUserId = `usr-rep705-bounce-${RUN}`;
    const noEmailUserId = `usr-rep705-noemail-${RUN}`;
    const deletedLaterUserId = `usr-rep705-dellater-${RUN}`;
    userIds.push(goodUserId, bounceUserId, noEmailUserId, deletedLaterUserId);
    const goodEmail = `good-${RUN}@test.local`;
    const bounceEmail = `bounce-${RUN}@test.local`;
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role, email) SELECT $1, $2, $3, password_hash, 'PUMP_OPERATOR', $4 FROM users WHERE username = 'camsa'`, [goodUserId, TENANT, `rep705-good-${RUN}`, goodEmail]);
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role, email) SELECT $1, $2, $3, password_hash, 'PUMP_OPERATOR', $4 FROM users WHERE username = 'camsa'`, [bounceUserId, TENANT, `rep705-bounce-${RUN}`, bounceEmail]);
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) SELECT $1, $2, $3, password_hash, 'PUMP_OPERATOR' FROM users WHERE username = 'camsa'`, [noEmailUserId, TENANT, `rep705-noemail-${RUN}`]);
    // AC/Kapsam: "Alıcı listesi kullanıcı silindiğinde güncellenmelidir" — bu
    // kullanıcı OLUŞTURMA anında geçerli bir e-postaya sahiptir (create
    // reddedilmez), Test 5'te zamanlama oluşturulduktan SONRA silinir.
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role, email) SELECT $1, $2, $3, password_hash, 'PUMP_OPERATOR', $4 FROM users WHERE username = 'camsa'`, [deletedLaterUserId, TENANT, `rep705-dellater-${RUN}`, `dellater-${RUN}@test.local`]);

    // === Test 4: bilinmeyen reportId → 404; PUMP_OPERATOR → 403; e-postasız alıcı → 400. ===
    const badReport = await call('POST', '/report-schedules', { token: owner, body: { reportId: `bilinmeyen-${RUN}`, periodType: 'DAILY', recipientUserIds: [goodUserId] } });
    const forbiddenRole = await call('POST', '/report-schedules', { token: pumpOp, body: { reportId: 'rep-711', periodType: 'DAILY', recipientUserIds: [goodUserId] } });
    const noEmailRecipient = await call('POST', '/report-schedules', { token: owner, body: { reportId: 'rep-711', periodType: 'DAILY', recipientUserIds: [noEmailUserId] } });
    check(
      'Test 4: bilinmeyen reportId 404, yetkisiz rol 403, e-postasız alıcı 400 döner',
      badReport.status === 404 && forbiddenRole.status === 403 && noEmailRecipient.status === 400,
      `badReport=${badReport.status}, forbiddenRole=${forbiddenRole.status}, noEmailRecipient=${noEmailRecipient.status}`
    );

    // === Test 5 (ASIL AC — üretim + gönderim, ATTACHMENT modu + Kapsam — silinen
    // alıcı otomatik dışlanır): tek satırlık rapor 10MB'ın ÇOK altında → CSV EK
    // olarak gönderilir, GÖNDERILDI. deletedLaterUserId OLUŞTURMA anında geçerli bir
    // alıcıyken, zamanlama oluşturulduktan SONRA (gönderim ÖNCESİ) SİLİNİR — canlı
    // e-posta çözümlemesi onu KENDİLİĞİNDEN dışlar, gönderim BAŞARISIZ OLMAZ. ===
    const createRes = await call('POST', '/report-schedules', {
      token: owner,
      body: { reportId: 'rep-711', filters: { vehiclePlate: markerPlate }, periodType: 'DAILY', sendHourLocal: 7, recipientUserIds: [goodUserId, deletedLaterUserId], skipIfEmpty: false }
    });
    const scheduleId = createRes.body?.data?.id;
    if (scheduleId) scheduleIds.push(scheduleId);
    await q(`DELETE FROM users WHERE id = $1`, [deletedLaterUserId]);
    await q(`UPDATE report_schedules SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [scheduleId]);

    const sweep1 = await runWithTenant({ tenantId: TENANT }, () => runReportScheduleSweepForCurrentTenant());
    const delivery1 = await q(`SELECT * FROM report_deliveries WHERE schedule_id = $1`, [scheduleId]);
    const mailToGood = received.find((m) => m.to === goodEmail);
    const attachmentText = mailToGood ? extractAttachmentText(mailToGood.raw) : '';
    const scheduleAfter1 = await q(`SELECT next_run_at FROM report_schedules WHERE id = $1`, [scheduleId]);
    check(
      "Test 5 (ASIL AC — üretim+gönderim, ATTACHMENT modu; Kapsam — silinen alıcı otomatik dışlanır): sweep GÖNDERILDI'ye düşürür, CSV EK olarak gönderilir (SİLİNMİŞ deletedLaterUserId'e GİTMEZ, sadece goodUserId'e gider, gönderim BAŞARISIZ OLMAZ), next_run_at İLERLER",
      createRes.status === 201 && sweep1.sent === 1 &&
        delivery1[0]?.status === 'GÖNDERILDI' && delivery1[0]?.delivery_mode === 'ATTACHMENT' && delivery1[0]?.row_count === 1 &&
        !!mailToGood && mailToGood.raw.includes('Content-Type: text/csv') && attachmentText.includes(markerPlate) &&
        received.filter((m) => m.to !== goodEmail).length === 0 &&
        new Date(scheduleAfter1[0].next_run_at).getTime() > Date.now(),
      `createStatus=${createRes.status}, sent=${sweep1.sent}, status=${delivery1[0]?.status}, mode=${delivery1[0]?.delivery_mode}, hasMail=${!!mailToGood}, attachmentHasMarker=${attachmentText.includes(markerPlate)}, totalMails=${received.length}`
    );

    // === Test 6 (Kapsam — boş rapor: skip_if_empty=true → HİÇ gönderilmez). ===
    const emptySkipRes = await call('POST', '/report-schedules', {
      token: owner,
      body: { reportId: 'rep-711', filters: { vehiclePlate: `YOK-${RUN}` }, periodType: 'DAILY', recipientUserIds: [goodUserId], skipIfEmpty: true }
    });
    const emptySkipId = emptySkipRes.body?.data?.id;
    if (emptySkipId) scheduleIds.push(emptySkipId);
    await q(`UPDATE report_schedules SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [emptySkipId]);
    const mailCountBeforeSkip = received.length;
    const sweep2 = await runWithTenant({ tenantId: TENANT }, () => runReportScheduleSweepForCurrentTenant());
    const delivery2 = await q(`SELECT status, row_count FROM report_deliveries WHERE schedule_id = $1`, [emptySkipId]);
    check(
      "Test 6 (Kapsam — boş rapor atlama): skipIfEmpty=true + 0 satır → ATLANDI_BOŞ, HİÇ e-posta gönderilmez",
      sweep2.skippedEmpty === 1 && delivery2[0]?.status === 'ATLANDI_BOŞ' && delivery2[0]?.row_count === 0 && received.length === mailCountBeforeSkip,
      `skippedEmpty=${sweep2.skippedEmpty}, status=${delivery2[0]?.status}, mailCountChanged=${received.length !== mailCountBeforeSkip}`
    );

    // === Test 7 (Kapsam — boş rapor: skipIfEmpty=false → yine de gönderilir, sadece başlık satırlı CSV). ===
    const emptySendRes = await call('POST', '/report-schedules', {
      token: owner,
      body: { reportId: 'rep-711', filters: { vehiclePlate: `YOK2-${RUN}` }, periodType: 'DAILY', recipientUserIds: [goodUserId], skipIfEmpty: false }
    });
    const emptySendId = emptySendRes.body?.data?.id;
    if (emptySendId) scheduleIds.push(emptySendId);
    await q(`UPDATE report_schedules SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [emptySendId]);
    const sweep3 = await runWithTenant({ tenantId: TENANT }, () => runReportScheduleSweepForCurrentTenant());
    const delivery3 = await q(`SELECT status, row_count FROM report_deliveries WHERE schedule_id = $1`, [emptySendId]);
    check(
      "Test 7 (Kapsam — skipIfEmpty=false varsayılanı): 0 satır olsa da GÖNDERILDI (opsiyon AÇIKÇA istenmedikçe rapor hep gönderilir)",
      sweep3.sent === 1 && delivery3[0]?.status === 'GÖNDERILDI' && delivery3[0]?.row_count === 0,
      `sent=${sweep3.sent}, status=${delivery3[0]?.status}, rowCount=${delivery3[0]?.row_count}`
    );

    // === Test 8 (ASIL AC — gönderim hatası kayıt + yeniden deneme): bounce eden alıcı,
    // AYNI dönem için TEKRAR TEKRAR denenir (yeni satır YARATILMAZ), MAX deneme sonrası
    // KALICI_BAŞARISIZ'a düşer VE ancak O ZAMAN next_run_at İLERLER. ===
    const bounceScheduleRes = await call('POST', '/report-schedules', {
      token: owner,
      body: { reportId: 'rep-711', filters: { vehiclePlate: markerPlate }, periodType: 'DAILY', recipientUserIds: [bounceUserId] }
    });
    const bounceScheduleId = bounceScheduleRes.body?.data?.id;
    if (bounceScheduleId) scheduleIds.push(bounceScheduleId);
    await q(`UPDATE report_schedules SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [bounceScheduleId]);

    let lastStatus = '';
    let lastAttempts = -1;
    for (let i = 0; i < 5; i++) {
      await runWithTenant({ tenantId: TENANT }, () => runReportScheduleSweepForCurrentTenant());
      const d = await q(`SELECT status, attempts FROM report_deliveries WHERE schedule_id = $1`, [bounceScheduleId]);
      lastStatus = d[0]?.status;
      lastAttempts = d[0]?.attempts;
      if (lastStatus === 'KALICI_BAŞARISIZ') break;
    }
    const deliveryRowCount = await q(`SELECT COUNT(*) FROM report_deliveries WHERE schedule_id = $1`, [bounceScheduleId]);
    const bounceScheduleAfter = await q(`SELECT next_run_at FROM report_schedules WHERE id = $1`, [bounceScheduleId]);
    check(
      'Test 8 (ASIL AC — hata kaydı + yeniden deneme): bounce eden alıcı için AYNI dönem tekrar tekrar denenir (TEK satır kalır, mükerrer YOK), sonunda KALICI_BAŞARISIZ, ancak O ZAMAN next_run_at ilerler',
      lastStatus === 'KALICI_BAŞARISIZ' && lastAttempts >= 3 && deliveryRowCount[0].count === '1' && new Date(bounceScheduleAfter[0].next_run_at).getTime() > Date.now(),
      `lastStatus=${lastStatus}, attempts=${lastAttempts}, rowCount=${deliveryRowCount[0].count}`
    );

    // === Test 9 (ASIL AC — 10MB üzeri raporlar bağlantı olarak gönderilir; presigned
    // indirme mekanizması): gerçek 10MB veri üretmek yerine, süpürücünün ZATEN LINK
    // moduna karar verdiği durumu simüle eden bir report_deliveries satırı elle
    // yaratılır (küçük bir CSV buffer ile) — indirme ROTASININ KENDİSİ test edilir:
    // doğru token indirir, YANLIŞ token 404, SÜRESİ DOLMUŞ token 404. ===
    const linkDeliveryId = `repdel-link-${RUN}`;
    const linkContent = Buffer.from('ID,Tarih\r\n1,2026-01-01\r\n', 'utf-8');
    const crypto = await import('crypto');
    const goodToken = crypto.randomBytes(32).toString('hex');
    const goodTokenHash = crypto.createHash('sha256').update(goodToken).digest('hex');
    await q(
      `INSERT INTO report_deliveries (id, tenant_id, schedule_id, period_key, status, delivery_mode, file_data, file_size_bytes, download_token_hash, expires_at, sent_at)
       VALUES ($1,$2,$3,$4,'GÖNDERILDI','LINK',$5,$6,$7, NOW() + INTERVAL '1 hour', NOW())`,
      [linkDeliveryId, TENANT, scheduleId, `link-period-${RUN}`, linkContent, linkContent.length, goodTokenHash]
    );
    const expiredDeliveryId = `repdel-expired-${RUN}`;
    await q(
      `INSERT INTO report_deliveries (id, tenant_id, schedule_id, period_key, status, delivery_mode, file_data, file_size_bytes, download_token_hash, expires_at, sent_at)
       VALUES ($1,$2,$3,$4,'GÖNDERILDI','LINK',$5,$6,$7, NOW() - INTERVAL '1 hour', NOW())`,
      [expiredDeliveryId, TENANT, scheduleId, `expired-period-${RUN}`, linkContent, linkContent.length, goodTokenHash]
    );

    const goodDownload = await call('GET', `/report-deliveries/${linkDeliveryId}/download/${goodToken}`);
    const wrongTokenDownload = await call('GET', `/report-deliveries/${linkDeliveryId}/download/${'0'.repeat(64)}`);
    const expiredDownload = await call('GET', `/report-deliveries/${expiredDeliveryId}/download/${goodToken}`);
    check(
      'Test 9 (ASIL AC — 10MB üzeri → bağlantı, presigned indirme): doğru token 200 ile içerik döner, YANLIŞ token 404, SÜRESİ DOLMUŞ token 404',
      goodDownload.status === 200 && wrongTokenDownload.status === 404 && expiredDownload.status === 404,
      `good=${goodDownload.status}, wrong=${wrongTokenDownload.status}, expired=${expiredDownload.status}`
    );

    // === Test 10: CRUD — devre dışı bırakma sweep'te ATLANIR; gönderim geçmişi listelenir; silme kaskad temizler. ===
    const disableRes = await call('PATCH', `/report-schedules/${emptySendId}`, { token: owner, body: { enabled: false } });
    await q(`UPDATE report_schedules SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [emptySendId]);
    const sweepAfterDisable = await runWithTenant({ tenantId: TENANT }, () => runReportScheduleSweepForCurrentTenant());
    const deliveriesForSchedule = await call('GET', `/report-schedules/${scheduleId}/deliveries`, { token: owner });
    const deleteRes = await call('DELETE', `/report-schedules/${scheduleId}`, { token: owner });
    const deliveriesAfterDelete = await q(`SELECT COUNT(*) FROM report_deliveries WHERE schedule_id = $1`, [scheduleId]);
    check(
      'Test 10 (CRUD): devre dışı zamanlama sweepte İŞLENMEZ, gönderim geçmişi listelenir, silme deliveries\'i KASKAD temizler',
      disableRes.status === 200 && sweepAfterDisable.processed === 0 &&
        deliveriesForSchedule.status === 200 && deliveriesForSchedule.body.data.length >= 1 &&
        deleteRes.status === 200 && deliveriesAfterDelete[0].count === '0',
      `disable=${disableRes.status}, processedAfterDisable=${sweepAfterDisable.processed}, deliveriesCount=${deliveriesForSchedule.body?.data?.length}, deleteStatus=${deleteRes.status}, remainingDeliveries=${deliveriesAfterDelete[0].count}`
    );
  } finally {
    await q('DELETE FROM report_deliveries WHERE schedule_id = ANY($1)', [scheduleIds]);
    await q('DELETE FROM report_schedules WHERE id = ANY($1)', [scheduleIds]);
    await q('DELETE FROM transactions WHERE id = ANY($1)', [txIds]);
    await q('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    await resetLoginRateLimit();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
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
