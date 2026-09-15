import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md / GitHub #79 [FLEET-1403] — Sürücü tanımı, RFID kartı ve
 * şantiye ataması.
 *
 * BİLİNÇLİ KAPSAM DIŞI (ticket'ın kendi notunda "opsiyonel" — burada
 * UYGULANMADI): "kart–araç çift doğrulama seçeneği" (yüksek güvenlik
 * isteyen şantiyeler için hem araç hem sürücü kartının birlikte okutulması)
 * — ayrı, kendi başına bir dispense-authorization akışı değişikliği/ayarı
 * gerektiren daha büyük bir özellik; ayrı bir ticket'ın konusu olmalı.
 *
 * Burada test edilen, GERÇEKTEN eklenen üç parça:
 *  1. AC: "TC kimlik no algoritmik olarak doğrulanmalıdır." Önceden yalnızca
 *     BİÇİM (11 haneli rakam) kontrol ediliyordu — kontrol hanesi tutmayan
 *     bir değer de kabul ediliyordu. Artık COMP-605'in GERÇEK TCKN
 *     algoritması (compliance/taxIdValidation.ts, mevcut/yeniden
 *     kullanıldı) driverSchema.ts'e bağlı.
 *  2. AC: "İşten ayrılan sürücünün kartı otomatik bloke olmalıdır." Önceden
 *     BU HİÇ YAPILMIYORDU. Artık bir şoför PASİF'e alındığında (İZİNLİ'ye
 *     DEĞİL — o geçici) kartı AUTH-210 kara listesine otomatik giriyor.
 *  3. AC: "Kişisel veriler yetkisiz rollere maskelenmiş gösterilmelidir."
 *     TC No önceden GET /drivers'tan TÜM rollere (PUMP_OPERATOR dahil) ham
 *     dönüyordu. Artık yalnızca şoför kaydı yönetebilen roller (SUPER_ADMIN/
 *     COMPANY_OWNER/SITE_MANAGER) tam değeri görür; PUMP_OPERATOR maskelenmiş
 *     görür (123******01 biçimi).
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();

// Gerçek TCKN algoritmasıyla (d10/d11 kontrol haneleri) üretilmiş GEÇERLİ bir test değeri.
const VALID_TCKN = '12345678950';
const INVALID_TCKN = '12345678901'; // aynı biçimde ama kontrol haneleri TUTMUYOR

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

async function api(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN / GitHub #79] FLEET-1403 SÜRÜCÜ YÖNETİMİ');
  console.log('===========================================================\n');
  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };

  const db = pg();
  await db.connect();
  const driverIds: string[] = [];
  const blacklistUids: string[] = [];

  try {
    const owner = await login('camsa'); // COMPANY_OWNER, comp-camsa
    const siteManager = await login('gebze-santiye'); // SITE_MANAGER, comp-camsa
    const pumpOp = await login('pompa-op-01'); // PUMP_OPERATOR, comp-camsa

    // --- AC: "TC kimlik no algoritmik olarak doğrulanmalıdır." -------------
    const invalidTcknRes = await api('POST', '/drivers', owner, {
      name: `RFID Test Şoförü ${RUN}`, tcNo: INVALID_TCKN, phone: '5551234567', rfidCardId: `DRV-CARD-INV-${RUN}`, siteName: 'Gebze Ana Şantiye'
    });
    check(
      'Test 1: Biçimi doğru ama kontrol haneleri TUTMAYAN bir TC No 400 ile reddedilir',
      invalidTcknRes.status === 400,
      `status=${invalidTcknRes.status}, body=${JSON.stringify(invalidTcknRes.body)}`
    );

    const driverCardA = `DRV-CARD-A-${RUN}`;
    const driverA = await api('POST', '/drivers', owner, {
      name: `RFID Test Şoförü A ${RUN}`, tcNo: VALID_TCKN, phone: '5551234567', rfidCardId: driverCardA, siteName: 'Gebze Ana Şantiye', status: 'AKTİF'
    });
    check('Test 2: GEÇERLİ (kontrol haneleri TUTAN) bir TC No kabul edilir', driverA.status === 200, `status=${driverA.status}, body=${JSON.stringify(driverA.body)}`);
    const driverAId: string = driverA.body?.data?.id;
    if (driverAId) driverIds.push(driverAId);

    // --- AC: "Kişisel veriler yetkisiz rollere maskelenmiş gösterilmelidir." ---
    const listAsOwner = await api('GET', '/drivers', owner);
    const foundAsOwner = listAsOwner.body?.data?.find((d: any) => d.id === driverAId);
    check('Test 3: COMPANY_OWNER TAM TC No görür (maskelenmemiş)', foundAsOwner?.tc_no === VALID_TCKN, `tc_no=${foundAsOwner?.tc_no}`);

    const listAsSiteManager = await api('GET', '/drivers', siteManager);
    const foundAsSiteManager = listAsSiteManager.body?.data?.find((d: any) => d.id === driverAId);
    check('Test 4: SITE_MANAGER TAM TC No görür (kayıt yönetebildiği için)', foundAsSiteManager?.tc_no === VALID_TCKN, `tc_no=${foundAsSiteManager?.tc_no}`);

    const listAsPumpOp = await api('GET', '/drivers', pumpOp);
    const foundAsPumpOp = listAsPumpOp.body?.data?.find((d: any) => d.id === driverAId);
    check(
      'Test 5: PUMP_OPERATOR MASKELENMİŞ TC No görür (123******50) — önceden ham dönüyordu',
      foundAsPumpOp?.tc_no === `${VALID_TCKN.slice(0, 3)}******${VALID_TCKN.slice(9)}`,
      `tc_no=${foundAsPumpOp?.tc_no}`
    );

    // --- AC: "İşten ayrılan sürücünün kartı otomatik bloke olmalıdır." -----
    const driverCardB = `DRV-CARD-B-${RUN}`;
    const driverB = await api('POST', '/drivers', owner, {
      name: `RFID Test Şoförü B ${RUN}`, tcNo: VALID_TCKN, phone: '5551234567', rfidCardId: driverCardB, siteName: 'Gebze Ana Şantiye', status: 'AKTİF'
    });
    const driverBId: string = driverB.body?.data?.id;
    if (driverBId) driverIds.push(driverBId);

    const onLeave = await api('PUT', `/drivers/${driverBId}`, owner, { status: 'İZİNLİ' });
    const blacklistAfterLeave = await db.query('SELECT status FROM rfid_card_blacklist WHERE card_uid = $1', [driverCardB]);
    check(
      'Test 6: Geçici İZİNLİ durumu kartı BLOKE ETMEZ (kontrol grubu — yalnızca PASİF tetikler)',
      onLeave.status === 200 && blacklistAfterLeave.rows.length === 0,
      `status=${onLeave.status}, blacklist satırı=${blacklistAfterLeave.rows.length}`
    );

    const departed = await api('PUT', `/drivers/${driverBId}`, owner, { status: 'PASİF' });
    blacklistUids.push(driverCardB);
    const blacklistAfterDeparture = await db.query('SELECT status, reason FROM rfid_card_blacklist WHERE card_uid = $1', [driverCardB]);
    check(
      'Test 7: PASİF\'e alınca (işten ayrılma) kart OTOMATİK bloke olur — önceden HİÇ yapılmıyordu',
      departed.status === 200 && blacklistAfterDeparture.rows.length === 1 && blacklistAfterDeparture.rows[0].status === 'BLOCKED',
      `status=${departed.status}, blacklist=${JSON.stringify(blacklistAfterDeparture.rows)}`
    );

    const auditAfterDeparture = await db.query(
      `SELECT id FROM audit_logs WHERE action = 'RFID_CARD_AUTO_BLOCKED_DRIVER_DEPARTURE' AND target_id = $1`,
      [driverCardB]
    );
    check('Test 8: Otomatik blokaj audit_logs\'a yazılır', auditAfterDeparture.rows.length === 1, `satır sayısı=${auditAfterDeparture.rows.length}`);

    const departedAgain = await api('PUT', `/drivers/${driverBId}`, owner, { status: 'PASİF' });
    const auditAfterNoopDeparture = await db.query(
      `SELECT id FROM audit_logs WHERE action = 'RFID_CARD_AUTO_BLOCKED_DRIVER_DEPARTURE' AND target_id = $1`,
      [driverCardB]
    );
    check(
      'Test 9: ZATEN PASİF olan bir şoförü tekrar PASİF yapmak YENİ bir blokaj/audit satırı YARATMAZ',
      departedAgain.status === 200 && auditAfterNoopDeparture.rows.length === 1,
      `satır sayısı=${auditAfterNoopDeparture.rows.length}`
    );
  } finally {
    for (const dId of driverIds) {
      await db.query('DELETE FROM drivers WHERE id = $1', [dId]);
    }
    for (const uid of blacklistUids) {
      await db.query(`DELETE FROM rfid_card_blacklist WHERE card_uid = $1`, [uid]);
      await db.query(`DELETE FROM audit_logs WHERE action = 'RFID_CARD_AUTO_BLOCKED_DRIVER_DEPARTURE' AND target_id = $1`, [uid]);
    }
    await db.end();
    await resetLoginRateLimit();
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
