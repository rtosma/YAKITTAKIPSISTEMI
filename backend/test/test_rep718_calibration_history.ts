import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * REP-718 (#175) — Kalibrasyon Geçmişi Raporu.
 *
 * Komutlar SQL ile kontrollü zaman damgalarıyla kurulur (2022-01), beklenen
 * değişim yüzdeleri ELLE hesaplanmıştır.
 *  DA (Gebze):  c1 01-05  1.0000→1.0500  +5.00%   camsa   ONAYLANDI  (doğrulama alımı: eski %5.00, EN SON %1.23)
 *               c2 01-10  1.0500→1.2000  +14.29%  admin   ONAYLANDI
 *               c3 01-20  1.2000→0.9600  −20.00%  camsa   ONAYLANDI, 2. onay (admin) — 30 günde 3. komut ⇒ SIK
 *  DB (Silivri): d1 01-08 1.0000→1.0100 +1.00% gebze-santiye BEKLIYOR;  d2 01-09 GERİ ALMA 1.0100→1.0000 −0.99% ZAMAN_ASIMI
 *  DC (Silivri): e1 01-12 1.0000→2.0000 +100.00% camsa REDDEDILDI (NACK)
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TENANT = 'comp-camsa';
const GEBZE = 'Gebze Ana Şantiye';
const SILIVRI = 'Silivri Tesisleri';
const JAN_QS = 'startDate=2022-01-01&endDate=2022-01-31&pageSize=50';

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
async function call(method: string, path: string, token: string, body?: any): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const raw = await res.text();
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* CSV gövdesi */
  }
  return { status: res.status, body: parsed, raw };
}
async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: '123456' }) });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

async function run() {
  console.log('===========================================================');
  console.log('🎚️  [REP-718] KALİBRASYON GEÇMİŞİ RAPORU TESTİ');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };
  const n = (v: any) => Number(v);
  const near = (a: any, b: number, eps = 0.005) => a !== null && a !== undefined && Math.abs(n(a) - b) <= eps;

  const owner = await login('camsa');
  const gebzeMgr = await login('gebze-santiye');
  const pumpOp = await login('pompa-op-01');
  const uid = async (name: string) => (await q(`SELECT id FROM users WHERE username = $1`, [name]))[0].id;
  const camsaId = await uid('camsa');
  const adminId = await uid('admin');
  const gebzeMgrId = await uid('gebze-santiye');

  const dev = {
    DA: { id: `R718-DA-${RUN}`, site: GEBZE },
    DB: { id: `R718-DB-${RUN}`, site: SILIVRI },
    DC: { id: `R718-DC-${RUN}`, site: SILIVRI }
  };
  const devIds = Object.values(dev).map((d) => d.id);
  const DEV_QS = `deviceId=-${RUN}`;
  const cmdIds: Record<string, string> = {};
  const intakeIds: string[] = [];

  async function cmd(tag: string, d: { id: string }, o: { at: string; prev: number | null; next: number; user: string; reason: string; status: string; acked?: boolean; rollback?: boolean; second?: string }) {
    const id = `cal-r718-${RUN}-${tag}`;
    cmdIds[tag] = id;
    await q(
      `INSERT INTO calibration_commands (id, tenant_id, device_id, previous_k_factor, new_k_factor, reason, requested_by, requires_second_approval, approved_by, approved_at, status, acked_at, is_rollback, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, TENANT, d.id, o.prev, o.next, o.reason, o.user, !!o.second, o.second ?? null, o.second ? o.at : null, o.status, o.acked ? o.at : null, !!o.rollback, o.at]
    );
  }
  async function intake(tag: string, d: { id: string }, verifies: string, ratio: number, at: string) {
    const id = `tin-r718-${RUN}-${tag}`;
    intakeIds.push(id);
    await q(
      `INSERT INTO calibration_test_intakes (id, tenant_id, device_id, tank_name, reference_volume_liters, measured_liters, k_factor_at_test, deviation_ratio, proposed_k_factor, verifies_calibration_command_id, requested_by, created_at)
       VALUES ($1,$2,$3,'Test Tank',20,20,1.05,$4,1.05,$5,$6,$7)`,
      [id, TENANT, d.id, ratio, verifies, camsaId, at]
    );
  }

  try {
    for (const d of Object.values(dev)) {
      await q(`INSERT INTO hardware_devices (id, tenant_id, device_id, name, site_name, encrypted_secret, status) VALUES ($1,$2,$3,$4,$5,'x','AKTİF')`, [`hwd-${d.id}`, TENANT, d.id, `Test ${d.id}`, d.site]);
    }
    await cmd('c1', dev.DA, { at: '2022-01-05T10:00:00Z', prev: 1.0, next: 1.05, user: camsaId, reason: 'Rutin kalibrasyon', status: 'ONAYLANDI', acked: true });
    await cmd('c2', dev.DA, { at: '2022-01-10T10:00:00Z', prev: 1.05, next: 1.2, user: adminId, reason: 'Sapma düzeltme', status: 'ONAYLANDI', acked: true });
    await cmd('c3', dev.DA, { at: '2022-01-20T10:00:00Z', prev: 1.2, next: 0.96, user: camsaId, reason: 'Büyük düzeltme', status: 'ONAYLANDI', acked: true, second: adminId });
    await cmd('d1', dev.DB, { at: '2022-01-08T10:00:00Z', prev: 1.0, next: 1.01, user: gebzeMgrId, reason: 'Küçük ayar', status: 'BEKLIYOR' });
    await cmd('d2', dev.DB, { at: '2022-01-09T10:00:00Z', prev: 1.01, next: 1.0, user: camsaId, reason: 'Geri alma', status: 'ZAMAN_ASIMI', rollback: true });
    await cmd('e1', dev.DC, { at: '2022-01-12T10:00:00Z', prev: 1.0, next: 2.0, user: camsaId, reason: 'Şüpheli çift', status: 'REDDEDILDI' });
    await intake('old', dev.DA, cmdIds.c1, 0.05, '2022-01-06T10:00:00Z');
    await intake('new', dev.DA, cmdIds.c1, 0.0123, '2022-01-07T10:00:00Z');

    const rep = await call('GET', `/reports/rep-718?${JAN_QS}&${DEV_QS}`, owner);
    const row: Record<string, any> = {};
    for (const x of rep.body?.data || []) row[Object.entries(cmdIds).find(([, id]) => id === x.id)![0]] = x;

    // === Test 1 (AC — tüm değişiklikler kullanıcı ve gerekçeyle): 6 komut; kullanıcı adları, gerekçe, ikinci onay ===
    check(
      'Test 1 (AC — kullanıcı/gerekçe): 6 kalibrasyon komutu listelenir; kullanıcı adları camsa/admin/gebze-santiye, gerekçeler ve ikinci onaylayan (c3 → admin) görünür; geri alma işaretli',
      rep.status === 200 && rep.body.data.length === 6 &&
        row.c1?.requested_by_name === 'camsa' && row.c2?.requested_by_name === 'admin' && row.d1?.requested_by_name === 'gebze-santiye' &&
        row.c1?.reason === 'Rutin kalibrasyon' && row.c3?.approved_by_name === 'admin' && row.c1?.approved_by_name === null && row.d2?.is_rollback === true && row.c1?.is_rollback === false,
      `count=${rep.body?.data?.length}, c1=${row.c1?.requested_by_name}/${row.c1?.reason}, c3approver=${row.c3?.approved_by_name}, d2rollback=${row.d2?.is_rollback}`
    );

    // === Test 2 (AC — değişim yüzdesi): elle hesaplı ===
    check(
      'Test 2 (AC — değişim %): c1 +5.00, c2 +14.29, c3 −20.00, d1 +1.00, d2 (geri alma) −0.99, e1 +100.00; ilk komutta (eski K yok) NULL',
      near(row.c1?.change_pct, 5) && near(row.c2?.change_pct, 14.29) && near(row.c3?.change_pct, -20) && near(row.d1?.change_pct, 1) && near(row.d2?.change_pct, -0.99) && near(row.e1?.change_pct, 100),
      `pct=${['c1', 'c2', 'c3', 'd1', 'd2', 'e1'].map((k) => row[k]?.change_pct).join(',')}`
    );
    // eski K'si olmayan (ilk) komut
    await cmd('first', dev.DC, { at: '2022-01-02T10:00:00Z', prev: null, next: 1.0, user: camsaId, reason: 'İlk kalibrasyon', status: 'ONAYLANDI', acked: true });
    const withFirst = await call('GET', `/reports/rep-718?${JAN_QS}&${DEV_QS}`, owner);
    const first = (withFirst.body?.data || []).find((x: any) => x.id === cmdIds.first);
    const csvAll = await call('GET', `/reports/rep-718/export?format=csv&${JAN_QS}&${DEV_QS}`, owner);
    const line = (tag: string) => (csvAll.raw.split('\r\n').find((l) => l.includes(cmdIds[tag])) || '').split(',');
    check(
      "Test 2b (AC — değişim %, uç durum): eski K-factor'ü olmayan İLK komutta change_pct NULL (uydurma/sıfıra bölme yok), CSV'de 'İLK'; c2 hücresi '+14.29', c3 '-20.00'",
      first?.change_pct === null && line('first')[6] === 'İLK' && line('c2')[6] === '+14.29' && line('c3')[6] === '-20.00',
      `first=${first?.change_pct}, csvFirst=${line('first')[6]}, c2=${line('c2')[6]}, c3=${line('c3')[6]}`
    );

    // === Test 3 (AC — sık kalibre edilen cihazlar vurgulanır): DA'da 30 günde 3. komut (c3) SIK; c1/c2 değil; frequentOnly filtresi ===
    const freq = await call('GET', `/reports/rep-718?${JAN_QS}&${DEV_QS}&frequentOnly=true`, owner);
    check(
      'Test 3 (AC — sık kalibrasyon): kayan 30g sayaçları c1=1, c2=2, c3=3 → yalnız c3 SIK; CSV c3 "SIK", c1 "-"; frequentOnly=true yalnız c3; aggregate frequent_count=1',
      n(row.c1?.calibrations_30d) === 1 && n(row.c2?.calibrations_30d) === 2 && n(row.c3?.calibrations_30d) === 3 &&
        row.c3?.is_frequent === true && row.c1?.is_frequent === false && row.c2?.is_frequent === false && line('c3')[14] === 'SIK' && line('c1')[14] === '-' &&
        freq.body?.data?.length === 1 && freq.body.data[0].id === cmdIds.c3 && n(rep.body?.aggregates?.frequent_count) === 1,
      `counts=${row.c1?.calibrations_30d}/${row.c2?.calibrations_30d}/${row.c3?.calibrations_30d}, frequentOnly=${freq.body?.data?.length}, agg=${rep.body?.aggregates?.frequent_count}`
    );

    // === Test 4 (Kapsam — kayan pencere filtreden ÖNCE): c3'ü yalnız tarih filtresiyle tek başına listelesek de sayaç 3 kalır ===
    const onlyC3 = await call('GET', `/reports/rep-718?startDate=2022-01-20&endDate=2022-01-20&${DEV_QS}`, owner);
    check(
      'Test 4 (Kapsam — pencere filtreden ÖNCE): tarih filtresiyle yalnız c3 döndürülse de calibrations_30d = 3 ve SIK (sayı, filtrelenmiş görünümden DEĞİL gerçek geçmişten)',
      onlyC3.body?.data?.length === 1 && onlyC3.body.data[0].id === cmdIds.c3 && n(onlyC3.body.data[0].calibrations_30d) === 3 && onlyC3.body.data[0].is_frequent === true,
      `rows=${onlyC3.body?.data?.length}, count=${onlyC3.body?.data?.[0]?.calibrations_30d}`
    );

    // === Test 5 (Kapsam — test alımı sapması + ack durumu): c1 için EN SON doğrulama alımı %1.23 (eski %5.00 değil); bağlantısızlar '-'; ack durumları okunur ===
    check(
      "Test 5 (Kapsam — test alımı sapması/ack): c1 sapması EN SON doğrulamadan %1.23 (eski %5.00 değil), diğerleri NULL ('-'); ack durumu: ONAYLANDI→ACK ALINDI, BEKLIYOR→ACK BEKLİYOR, ZAMAN_ASIMI→ACK GELMEDİ, REDDEDILDI→CİHAZ REDDETTİ (NACK)",
      near(row.c1?.verification_deviation_pct, 1.23) && row.c2?.verification_deviation_pct === null && line('c1')[10] === '1.23' && line('c2')[10] === '-' &&
        line('c1')[11] === 'ACK ALINDI' && line('d1')[11] === 'ACK BEKLİYOR' && line('d2')[11] === 'ACK GELMEDİ' && line('e1')[11] === 'CİHAZ REDDETTİ (NACK)',
      `c1dev=${row.c1?.verification_deviation_pct}, csv=[${line('c1')[10]}|${line('c1')[11]}|${line('d1')[11]}|${line('d2')[11]}|${line('e1')[11]}]`
    );

    // === Test 6 (Kapsam — filtreler): cihaz, şantiye, kullanıcı, tarih, değişim büyüklüğü, durum ===
    const q1 = async (qs: string) => (await call('GET', `/reports/rep-718?${qs}`, owner)).body;
    const byDev = await q1(`${JAN_QS}&deviceId=${dev.DB.id}`);
    const bySite = await q1(`${JAN_QS}&${DEV_QS}&siteName=${encodeURIComponent(GEBZE)}`);
    const byUser = await q1(`${JAN_QS}&${DEV_QS}&requestedBy=admin`);
    const byRange = await q1(`startDate=2022-01-06&endDate=2022-01-10&${DEV_QS}`);
    const byMag = await q1(`${JAN_QS}&${DEV_QS}&minChangePct=10`);
    const byStatus = await q1(`${JAN_QS}&${DEV_QS}&status=REDDEDILDI`);
    check(
      'Test 6 (Kapsam — filtreler): cihaz=DB → 2; şantiye=Gebze → 3 (DA); kullanıcı=admin → 1 (c2); tarih 01-06..01-10 → 3 (c2,d1,d2); minChangePct=10 → 3 (c2 14.29, c3 20, e1 100); status=REDDEDILDI → 1',
      byDev.data?.length === 2 && bySite.data?.length === 3 && byUser.data?.length === 1 && byUser.data[0].id === cmdIds.c2 && byRange.data?.length === 3 && byMag.data?.length === 3 && byStatus.data?.length === 1,
      `dev=${byDev.data?.length}, site=${bySite.data?.length}, user=${byUser.data?.length}, range=${byRange.data?.length}, mag=${byMag.data?.length}, status=${byStatus.data?.length}`
    );

    // === Test 7 (AC — rol bazlı görünürlük): Gebze yöneticisi yalnız Gebze cihazı DA'nın 3 komutunu görür; PUMP_OPERATOR 403 ===
    const gRep = await call('GET', `/reports/rep-718?${JAN_QS}&${DEV_QS}`, gebzeMgr);
    const pump = await call('GET', `/reports/rep-718?${JAN_QS}`, pumpOp);
    const catO = await call('GET', '/reports', owner);
    const catP = await call('GET', '/reports', pumpOp);
    const catIds = (c: any) => new Set((c.body?.data || []).map((x: any) => x.id));
    check(
      'Test 7 (AC — rol bazlı görünürlük): Gebze SITE_MANAGER yalnız DA (Gebze) komutlarını görür (3; Silivri cihazları YOK); PUMP_OPERATOR 403 ve katalogda YOK; COMPANY_OWNER katalogda VAR',
      gRep.body?.data?.length === 3 && gRep.body.data.every((x: any) => x.site_name === GEBZE) && pump.status === 403 && !catIds(catP).has('rep-718') && catIds(catO).has('rep-718'),
      `gebze=${gRep.body?.data?.length}, pump=${pump.status}`
    );

    // === Test 8 (AC — CSV/PDF tutarlılığı) ===
    const rows = csvAll.raw.split('\r\n').filter((l) => l.includes('cal-r718-')).length;
    const pdf = await fetch(`${API_URL}/reports/rep-718/export?format=pdf&${JAN_QS}&${DEV_QS}`, { headers: { Authorization: `Bearer ${owner}` } });
    const buf = Buffer.from(await pdf.arrayBuffer());
    const c3 = line('c3');
    check(
      "Test 8 (AC — CSV/PDF tutarlılığı): CSV satır sayısı JSON'la AYNI (7 = 6 + İLK komut); c3 satırı camsa/admin(2. onay)/-20.00/ACK ALINDI/3/SIK; başlıklar; PDF 200 + %PDF-",
      rows === withFirst.body?.pagination?.totalCount && rows === 7 &&
        c3[6] === '-20.00' && c3[7] === 'camsa' && c3[8] === 'admin' && c3[11] === 'ACK ALINDI' && c3[13] === '3' && c3[14] === 'SIK' &&
        csvAll.raw.includes('Değişim %') && csvAll.raw.includes('Test Alımı Sapması %') && csvAll.raw.includes('Sık Kalibrasyon') &&
        pdf.status === 200 && buf.subarray(0, 5).toString('latin1') === '%PDF-',
      `csv=${rows}/${withFirst.body?.pagination?.totalCount}, c3=[${c3.slice(6, 15).join('|')}], pdf=${pdf.status}`
    );
  } finally {
    await q('DELETE FROM calibration_test_intakes WHERE id = ANY($1)', [intakeIds]);
    await q('DELETE FROM calibration_commands WHERE device_id = ANY($1)', [devIds]);
    await q('DELETE FROM hardware_devices WHERE device_id = ANY($1)', [devIds]);
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
