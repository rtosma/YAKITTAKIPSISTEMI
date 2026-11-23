import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * INV-1505 (#155) — Fire/kayıp kaydı ve sınıflandırması.
 *
 * Kapsanan AC'ler: FUEL-409 mutabakat farkından otomatik fire adayı üretimi,
 * fire kaydı (tarih/tank/miktar/sınıflandırma/açıklama), yüksek değerli
 * kayıtlar için çift onay (FUEL-405 ile AYNI rol kuralı), onayda stok
 * bakiyesinin düzeltilmesi (geçmiş dolum kayıtları DEĞİŞMEDEN), fire oranı
 * şantiye karşılaştırması.
 */

const API_URL = 'http://localhost:5000/api/v1';
const RUN = Date.now();
const SITE_A = 'Gebze Ana Şantiye';
const SITE_B = 'İzmit Şantiyesi';

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
  console.log('🔥 [INV-1505] FİRE/KAYIP KAYDI VE SINIFLANDIRMASI TESTİ');
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
  const reconTankId = `tank-inv1505-recon-${RUN}`;
  const reconTankName = `INV1505-Recon-Tank-${RUN}`;
  const highValueTankId = `tank-inv1505-hv-${RUN}`;
  const highValueTankName = `INV1505-HV-Tank-${RUN}`;
  const rejectTankId = `tank-inv1505-rej-${RUN}`;
  const rejectTankName = `INV1505-Reject-Tank-${RUN}`;
  const siteBTankId = `tank-inv1505-siteb-${RUN}`;
  const siteBTankName = `INV1505-SiteB-Tank-${RUN}`;

  const allTankIds = [reconTankId, highValueTankId, rejectTankId, siteBTankId];

  try {
    await q(`INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type) VALUES ($1,'comp-camsa',$2,$3,10000,950,'Motorin')`, [reconTankId, reconTankName, SITE_A]);
    await q(`INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type) VALUES ($1,'comp-camsa',$2,$3,10000,5000,'Motorin')`, [highValueTankId, highValueTankName, SITE_A]);
    await q(`INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type) VALUES ($1,'comp-camsa',$2,$3,10000,5000,'Motorin')`, [rejectTankId, rejectTankName, SITE_A]);
    await q(`INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type) VALUES ($1,'comp-camsa',$2,$3,10000,5000,'Motorin')`, [siteBTankId, siteBTankName, SITE_B]);

    // === Test 1 (ASIL AC — "mutabakat farkları otomatik fire adayı üretmelidir"):
    // AÇIKLANAMAYAN sınıflandırmalı bir mutabakat (1000L defter, 950L fiziksel,
    // 1 günlük AD_HOC dönem → buharlaşma payı ~0.0067%, %1 toleransın ÇOK ötesinde
    // bir %5 kayıp) fire_records'a BEKLIYOR durumunda bir aday yazmalı. ===
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);
    const reconRes = await call('POST', `/tanks/${reconTankId}/reconciliations`, {
      token: owner,
      body: {
        periodType: 'AD_HOC',
        physicalLiters: 950,
        openingBookLiters: 1000,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString()
      }
    });
    const reconciliationId = reconRes.body?.data?.reconciliation?.id;
    const candidates = await q(`SELECT * FROM fire_records WHERE reconciliation_id = $1`, [reconciliationId]);
    check(
      "Test 1 (ASIL AC — otomatik fire adayı): mutabakat AÇIKLANAMAYAN üretti VE fire_records'a BEKLIYOR aday yazıldı",
      reconRes.status === 201 && reconRes.body?.data?.reconciliation?.classification === 'AÇIKLANAMAYAN' && candidates.length === 1 && candidates[0].status === 'BEKLIYOR' && Number(candidates[0].quantity_liters) === 50 && candidates[0].variance_direction === 'KAYIP',
      `reconClassification=${reconRes.body?.data?.reconciliation?.classification}, candidates=${JSON.stringify(candidates.map((c) => ({ status: c.status, qty: c.quantity_liters, dir: c.variance_direction })))}`
    );
    const fireRecordId = candidates[0]?.id;

    // === Test 2: bu aday düşük değerli (50L / 10000L = %0.5 < %5) → tek onay hemen kesinleşir,
    // AC: "stok bakiyesini düzeltmeli" — tank current_level_liters 950 - 50 = 900'e düşmeli. ===
    const approve1 = await call('POST', `/fire-records/${fireRecordId}/approve`, { token: owner, body: { reclassify: 'KAÇAK' } });
    const tankAfterApprove1 = await q('SELECT current_level_liters FROM tanks WHERE id = $1', [reconTankId]);
    check(
      'Test 2: Düşük değerli aday TEK onayla ONAYLANDI + reclassify=KAÇAK uygulandı + tank stoğu 950→900 düzeltildi',
      approve1.status === 200 && approve1.body?.data?.finalized === true && approve1.body?.data?.record?.classification === 'KAÇAK' && approve1.body?.data?.record?.status === 'ONAYLANDI' && Number(tankAfterApprove1[0].current_level_liters) === 900,
      `finalized=${approve1.body?.data?.finalized}, classification=${approve1.body?.data?.record?.classification}, tankLevel=${tankAfterApprove1[0]?.current_level_liters}`
    );

    // === Test 3: RBAC — PUMP_OPERATOR fire kaydı OLUŞTURAMAZ (403) ===
    const pumpOpUsername = `inv1505-pump-${RUN}`;
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) SELECT $1, 'comp-camsa', $2, password_hash, 'PUMP_OPERATOR' FROM users WHERE username = 'camsa'`, [`usr-${pumpOpUsername}`, pumpOpUsername]);
    const pumpOpToken = await login(pumpOpUsername);
    const createDenied = await call('POST', '/fire-records', {
      token: pumpOpToken,
      body: { tankId: highValueTankId, recordDate: '2026-01-10', quantityLiters: 10, varianceDirection: 'KAYIP', classification: 'BUHARLAŞMA' }
    });
    check('Test 3: PUMP_OPERATOR fire kaydı oluşturamaz (403)', createDenied.status === 403, `status=${createDenied.status}`);

    // === Test 4: yüksek değerli manuel kayıt (600L / 10000L = %6 >= %5 eşiği) → requires_dual_approval=true ===
    const createHv = await call('POST', '/fire-records', {
      token: owner,
      body: { tankId: highValueTankId, recordDate: '2026-01-10', quantityLiters: 600, varianceDirection: 'KAYIP', classification: 'AÇIKLANAMAYAN', description: 'Yüksek kayıp — inceleniyor' }
    });
    check(
      'Test 4: Yüksek değerli manuel kayıt requires_dual_approval=true ile BEKLIYOR açıldı',
      createHv.status === 201 && createHv.body?.data?.requires_dual_approval === true && createHv.body?.data?.status === 'BEKLIYOR',
      `status=${createHv.status}, data=${JSON.stringify(createHv.body?.data)}`
    );
    const hvId = createHv.body?.data?.id;

    // === Test 5: BİRİNCİ onay (SITE_MANAGER) — henüz KESİNLEŞMEZ, stok DEĞİŞMEZ. ===
    const siteManagerRow = (await q(`SELECT username FROM users WHERE tenant_id = 'comp-camsa' AND role = 'SITE_MANAGER' LIMIT 1`))[0];
    const smToken = siteManagerRow ? await login(siteManagerRow.username) : owner;
    const firstApprove = await call('POST', `/fire-records/${hvId}/approve`, { token: smToken });
    const tankAfterFirst = await q('SELECT current_level_liters FROM tanks WHERE id = $1', [highValueTankId]);
    check(
      'Test 5: Çift onaylı kaydın BİRİNCİ onayı finalized=false bırakır, tank stoğu HENÜZ değişmez (5000L)',
      firstApprove.status === 200 && firstApprove.body?.data?.finalized === false && Number(tankAfterFirst[0].current_level_liters) === 5000,
      `finalized=${firstApprove.body?.data?.finalized}, tankLevel=${tankAfterFirst[0]?.current_level_liters}`
    );

    // === Test 6: AYNI onaylayıcı İKİNCİ kez onaylamaya çalışırsa 409 DUPLICATE_APPROVER. ===
    const dupApprove = await call('POST', `/fire-records/${hvId}/approve`, { token: smToken });
    check('Test 6: Aynı onaylayıcı ikinci kez onaylayamaz (409)', dupApprove.status === 409, `status=${dupApprove.status}, body=${JSON.stringify(dupApprove.body)}`);

    // === Test 7 (ASIL AC — çift onay rol kuralı): İKİNCİ onay FARKLI bir kullanıcıdan
    // ama YİNE SITE_MANAGER rolünden gelirse (SITE_MANAGER+SITE_MANAGER, OWNER YOK) 403. ===
    const secondSiteManagerUsername = `inv1505-sm2-${RUN}`;
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) SELECT $1, 'comp-camsa', $2, password_hash, 'SITE_MANAGER' FROM users WHERE username = 'camsa'`, [`usr-${secondSiteManagerUsername}`, secondSiteManagerUsername]);
    const secondSmToken = await login(secondSiteManagerUsername);
    const wrongRoleApprove = await call('POST', `/fire-records/${hvId}/approve`, { token: secondSmToken });
    check(
      "Test 7 (ASIL AC — rol kuralı): İki SITE_MANAGER birlikte YETERSİZ (COMPANY_OWNER/SUPER_ADMIN gerekli) → 403",
      wrongRoleApprove.status === 403,
      `status=${wrongRoleApprove.status}, body=${JSON.stringify(wrongRoleApprove.body)}`
    );

    // === Test 8: İKİNCİ onay COMPANY_OWNER'dan gelirse (SITE_MANAGER + COMPANY_OWNER) KESİNLEŞİR,
    // stok GÖRELİ olarak düzeltilir (5000 - 600 = 4400). ===
    const secondApprove = await call('POST', `/fire-records/${hvId}/approve`, { token: owner });
    const tankAfterSecond = await q('SELECT current_level_liters FROM tanks WHERE id = $1', [highValueTankId]);
    check(
      'Test 8: SITE_MANAGER + COMPANY_OWNER onayı kaydı ONAYLANDI yapar, tank stoğu 5000→4400 düzeltilir',
      secondApprove.status === 200 && secondApprove.body?.data?.finalized === true && secondApprove.body?.data?.record?.status === 'ONAYLANDI' && Number(tankAfterSecond[0].current_level_liters) === 4400,
      `finalized=${secondApprove.body?.data?.finalized}, tankLevel=${tankAfterSecond[0]?.current_level_liters}`
    );

    // === Test 9: reddedilen bir kayıt stoğu DEĞİŞTİRMEZ. ===
    const createReject = await call('POST', '/fire-records', {
      token: owner,
      body: { tankId: rejectTankId, recordDate: '2026-01-10', quantityLiters: 30, varianceDirection: 'KAYIP', classification: 'BUHARLAŞMA' }
    });
    const rejectId = createReject.body?.data?.id;
    const rejectRes = await call('POST', `/fire-records/${rejectId}/reject`, { token: owner, body: { reason: 'Test amaçlı reddedildi, gerçek bir kayıp değil.' } });
    const tankAfterReject = await q('SELECT current_level_liters FROM tanks WHERE id = $1', [rejectTankId]);
    check(
      'Test 9: Reddedilen kayıt REDDEDİLDİ durumuna geçer, tank stoğu DEĞİŞMEZ (5000L)',
      rejectRes.status === 200 && rejectRes.body?.data?.status === 'REDDEDİLDİ' && Number(tankAfterReject[0].current_level_liters) === 5000,
      `status=${rejectRes.body?.data?.status}, tankLevel=${tankAfterReject[0]?.current_level_liters}`
    );

    // === Test 10 (ASIL AC — fire oranı şantiye karşılaştırması): SITE_A (900+600=1500L KAYIP onaylı,
    // reject hariç), SITE_B'de bir FAZLA kaydı (KAYIP DEĞİL, karşılaştırmaya GİRMEMELİ). ===
    await q(
      `INSERT INTO fire_records (id, tenant_id, tank_id, tank_name, site_name, record_date, quantity_liters, variance_direction, classification, status, requires_dual_approval, created_by)
       VALUES ($1,'comp-camsa',$2,$3,$4,'2026-01-10',80,'FAZLA','ÖLÇÜM_HATASI','ONAYLANDI',false,'test-fixture')`,
      [`fire-inv1505-fazla-${RUN}`, siteBTankId, siteBTankName, SITE_B]
    );
    const comparison = await call('GET', '/fire-records/site-comparison?periodDays=365', { token: owner });
    const siteARow = comparison.body?.data?.find((r: any) => r.siteName === SITE_A);
    const siteBRow = comparison.body?.data?.find((r: any) => r.siteName === SITE_B);
    check(
      'Test 10 (ASIL AC — şantiye karşılaştırması): SITE_A toplam KAYIP=650L (900+... bekle, sadece bu run içindeki 2 ONAYLANDI kayıt), SITE_B FAZLA kaydı hiç GÖRÜNMEZ',
      comparison.status === 200 && !!siteARow && Number(siteARow.approvedLossLiters) === 650 && !siteBRow,
      `status=${comparison.status}, siteA=${JSON.stringify(siteARow)}, siteB=${JSON.stringify(siteBRow)}`
    );
  } finally {
    await q('DELETE FROM fire_records WHERE tank_id = ANY($1) OR tank_id = $2', [allTankIds, siteBTankId]);
    await q('DELETE FROM stock_reconciliations WHERE tank_id = ANY($1)', [allTankIds]);
    await q('DELETE FROM tanks WHERE id = ANY($1)', [allTankIds]);
    await q('DELETE FROM users WHERE username = ANY($1)', [[`inv1505-pump-${RUN}`, `inv1505-sm2-${RUN}`]]);
    await resetLoginRateLimit();
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
