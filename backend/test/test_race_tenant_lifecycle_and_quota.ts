import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md §2.2 — Eşzamanlılık (2. tur): kalıcı tenant silme onayı ve
 * çapraz şantiye kotası.
 *
 * BULGU (eşzamanlı isteklerle, 15'er tur tekrarlanarak kanıtlandı): ARCH-108
 * yaşam döngüsü işlemleri kilitsiz check-then-act idi.
 *   - İPTAL ile ONAY yarışınca 15 turun 14'ünde iptal isteği 200 ("iptal
 *     edildi") döndü AMA firma ve TÜM verisi kalıcı olarak silindi.
 *   - İki farklı admin aynı anda son onayı verince 15/15 turda
 *     platform_audit_log'a ÇİFT "kalıcı silindi" kaydı düştü.
 *   - İptal edilmiş (AKTİF) bir firmada bayat bir onay satırı kalabiliyordu;
 *     silme yeniden planlanınca eski onay yeni "2 farklı onay" şartına sayılırdı.
 * Düzeltme: adminDb.ts withLockedCompany — firma satırı FOR UPDATE ile
 * kilitli TEK transaction.
 *
 * Yarış testleri kilit sırasından BAĞIMSIZ değişmezleri doğrular: hangi istek
 * kilidi önce alırsa alsın sonuç tutarlı olmalı (iptal kazanırsa firma aktif
 * + onay 409; onay kazanırsa firma silinmiş + iptal 404). Tek bir tur şansa
 * bağlı olabileceği için her senaryo ROUNDS kez tekrarlanır.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const ROUNDS = 10;
const ADMIN2 = `race-admin2-${RUN}`;
const ADMIN3 = `race-admin3-${RUN}`;

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
async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const body = await res.json().catch(() => ({}));
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §2.2] EŞZAMANLILIK — TENANT SİLME ONAYI + ÇAPRAZ ŞANTİYE KOTASI');
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

  const createdCompanies: string[] = [];
  const plate = `34 RC ${String(RUN).slice(-3)}`;
  const targetSite = 'Silivri Tesisleri';
  const tankName = `RACE-CS-Tank-${RUN}`;

  const adminHash = (await q("SELECT password_hash FROM users WHERE username = 'admin'"))[0].password_hash;
  const admin1Id = (await q("SELECT id FROM users WHERE username = 'admin'"))[0].id;
  for (const u of [ADMIN2, ADMIN3]) {
    await q(`INSERT INTO users (id, tenant_id, username, password_hash, role) VALUES ($1, 'comp-camsa', $2, $3, 'SUPER_ADMIN')`, [`usr-${u}`, u, adminHash]);
  }

  /** Silme planlanmış, 30 gün beklemesi dolmuş, İLK onayı verilmiş bir test firması. */
  async function scheduledCompany(token: string): Promise<string> {
    const created = await call('POST', '/companies', token, { name: `racetenant${RUN}${Math.floor(Math.random() * 1e6)}` });
    const id = created.body?.data?.id;
    if (!id) throw new Error(`firma oluşturulamadı: ${JSON.stringify(created.body)}`);
    createdCompanies.push(id);
    await call('POST', `/admin/companies/${id}/schedule-deletion`, token, { reason: 'Eşzamanlılık testi için planlanan silme.' });
    await q("UPDATE companies SET deletion_scheduled_at = NOW() - INTERVAL '31 days' WHERE id = $1", [id]);
    await q('INSERT INTO tenant_deletion_approvals (tenant_id, approved_by) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, admin1Id]);
    return id;
  }

  try {
    const t1 = await login('admin');
    const t2 = await login(ADMIN2);
    const t3 = await login(ADMIN3);

    // ═══ 1) İki admin aynı anda SON onayı veriyor ═══════════════════════
    let duplicateAudit = 0;
    let notExactlyOneExecuted = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const id = await scheduledCompany(t1);
      const [a, b] = await Promise.all([
        call('POST', `/admin/companies/${id}/approve-deletion`, t2),
        call('POST', `/admin/companies/${id}/approve-deletion`, t3)
      ]);
      const auditRows = Number((await q(
        "SELECT count(*) FROM platform_audit_log WHERE deleted_tenant_id = $1 AND action = 'TENANT_PERMANENTLY_DELETED'", [id]))[0].count);
      if (auditRows !== 1) duplicateAudit++;
      const executed = [a, b].filter((r) => r.status === 200 && r.body?.data?.executed === true).length;
      if (executed !== 1) notExactlyOneExecuted++;
    }
    check(`Test 1: Eşzamanlı iki son onayda ${ROUNDS}/${ROUNDS} turda TAM BİR "kalıcı silindi" denetim kaydı`,
      duplicateAudit === 0, `hatalı tur sayısı=${duplicateAudit} (önceden 15/15 turda çift kayıt)`);
    check(`Test 2: Eşzamanlı iki son onayda ${ROUNDS}/${ROUNDS} turda silmeyi TAM BİR istek yürütür`,
      notExactlyOneExecuted === 0, `hatalı tur sayısı=${notExactlyOneExecuted}`);

    // ═══ 2) İptal ile onay yarışıyor ═══════════════════════════════════
    let deletedDespiteCancel = 0;
    let staleApproval = 0;
    let inconsistent = 0;
    const outcomes: Record<string, number> = {};
    for (let i = 0; i < ROUNDS; i++) {
      const id = await scheduledCompany(t1);
      const [cancel, approve] = await Promise.all([
        call('POST', `/admin/companies/${id}/cancel-deletion`, t1),
        call('POST', `/admin/companies/${id}/approve-deletion`, t2)
      ]);
      const company = (await q('SELECT account_status FROM companies WHERE id = $1', [id]))[0];
      const approvals = Number((await q('SELECT count(*) FROM tenant_deletion_approvals WHERE tenant_id = $1', [id]))[0].count);
      const key = `iptal=${cancel.status}/onay=${approve.status}/firma=${company ? company.account_status : 'SİLİNDİ'}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;

      if (cancel.status === 200 && !company) deletedDespiteCancel++;
      if (company && company.account_status === 'AKTİF' && approvals > 0) staleApproval++;
      const cancelWon = cancel.status === 200 && company?.account_status === 'AKTİF' && approve.status === 409;
      const approveWon = !company && approve.body?.data?.executed === true && cancel.status === 404;
      if (!cancelWon && !approveWon) inconsistent++;
    }
    check(`Test 3 (VERİ KAYBI): ${ROUNDS} turda iptal "başarılı" dendiği halde firma HİÇ silinmedi`,
      deletedDespiteCancel === 0, `hatalı tur=${deletedDespiteCancel} (önceden 15 turun 14'ünde)`);
    check('Test 4: İptal edilmiş (AKTİF) firmada bayat onay satırı KALMADI',
      staleApproval === 0, `hatalı tur=${staleApproval}`);
    check('Test 5: Her turun sonucu iki tutarlı sonuçtan biri (iptal kazandı ↔ onay 409 | onay kazandı ↔ iptal 404)',
      inconsistent === 0, `sonuç dağılımı=${JSON.stringify(outcomes)}`);

    // ═══ 3) Yeniden planlama eski onayları taşımaz ══════════════════════
    const rid = await scheduledCompany(t1); // admin1 onayı var
    await call('POST', `/admin/companies/${rid}/cancel-deletion`, t1);
    // Yarış/eski kod kalıntısını simüle et: iptal sonrası kalmış bir onay satırı.
    await q('INSERT INTO tenant_deletion_approvals (tenant_id, approved_by) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rid, admin1Id]);
    await call('POST', `/admin/companies/${rid}/schedule-deletion`, t1, { reason: 'Yeniden planlanan silme (eski onay taşınmamalı).' });
    await q("UPDATE companies SET deletion_scheduled_at = NOW() - INTERVAL '31 days' WHERE id = $1", [rid]);
    const single = await call('POST', `/admin/companies/${rid}/approve-deletion`, t2);
    const stillExists = (await q('SELECT 1 FROM companies WHERE id = $1', [rid])).length === 1;
    check('Test 6: Silme yeniden planlanınca ÖNCEKİ döngünün onayı sayılmaz — tek yeni onay silmeyi YÜRÜTMEZ',
      single.status === 200 && single.body?.data?.executed === false && single.body?.data?.approvalsCount === 1 && stillExists,
      `yanıt=${JSON.stringify(single.body?.data)}, firma duruyor=${stillExists}`);

    // ═══ 4) Çapraz şantiye kotası (FUEL-402) eşzamanlı tüketim ═════════
    await q(`INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name)
             VALUES ($1, 'comp-camsa', $2, 'Test', 'Kamyon', $3, 'Gebze Ana Şantiye')`, [`veh-race-${RUN}`, plate, `RFID-RACE-${RUN}`]);
    await q(`INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type)
             VALUES ($1, 'comp-camsa', $2, $3, 10000, 5000, 'Motorin')`, [`tank-race-cs-${RUN}`, tankName, targetSite]);
    await q(`INSERT INTO cross_site_permissions (id, tenant_id, vehicle_plate, home_site, target_site, allowed_liters, expiry_date)
             VALUES ($1, 'comp-camsa', $2, 'Gebze Ana Şantiye', $3, 100, CURRENT_DATE + 7)`, [`csp-race-${RUN}`, plate, targetSite]);

    const ownerToken = await login('camsa');
    const dispenses = await Promise.all(
      Array.from({ length: 6 }, () =>
        call('POST', '/dispense', ownerToken, { siteName: targetSite, vehiclePlate: plate, tankName, amountLiters: 30, type: 'Çapraz Şantiye' })
      )
    );
    const ok = dispenses.filter((r) => r.status === 200 || r.status === 201).length;
    const used = Number((await q('SELECT used_liters FROM cross_site_permissions WHERE id = $1', [`csp-race-${RUN}`]))[0].used_liters);
    check('Test 7: Kota 100 L, 6 eşzamanlı 30 L çapraz şantiye ikmali → TAM 3 kabul (4. kotayı 120\'ye taşırdı)',
      ok === 3, `kabul=${ok}, durumlar=[${dispenses.map((r) => r.status).join(', ')}]`);
    check('Test 8: Kota kullanımı limiti AŞMADI ve kabul edilenlerle birebir tutarlı (3×30 = 90)',
      used === 90 && used <= 100, `used_liters=${used}`);
  } finally {
    for (const id of createdCompanies) {
      await q('DELETE FROM companies WHERE id = $1', [id]);
      await q('DELETE FROM platform_audit_log WHERE deleted_tenant_id = $1', [id]);
    }
    await q('DELETE FROM transactions WHERE tank_name = $1', [tankName]);
    await q('DELETE FROM cross_site_permissions WHERE id = $1', [`csp-race-${RUN}`]);
    await q('DELETE FROM tanks WHERE name = $1', [tankName]);
    await q('DELETE FROM vehicles WHERE id = $1', [`veh-race-${RUN}`]);
    await q('DELETE FROM users WHERE username = ANY($1)', [[ADMIN2, ADMIN3]]);
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
