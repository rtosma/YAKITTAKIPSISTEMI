import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md §2.2 — Idempotency: mükerrer yakıt alım irsaliyesi.
 *
 * BULGU (canlı ölçüldü, bu testle kilitleniyor): aynı tedarikçinin aynı
 * irsaliyesi aynı tanka iki kez girildiğinde iki kayıt oluşuyor ve tank stoğu
 * İKİ KEZ artıyordu — 5.000 L'lik irsaliye → tank 1.000'den 11.000'e.
 * Oluşan 5.000 L'lik hayali stok, FUEL-409 stok mutabakatında gerçek bir kaybı
 * (hırsızlığı) "fazlalık" ile örtebilir. Çift tıklama ya da ağ zaman aşımı
 * sonrası tekrar gönderme bunu kazara da tetikler.
 *
 * Kapsam kararları (testlerle belgelenmiş):
 *   - Tekrar kontrolü TANK BAŞINA: tek bir tanker teslimatı tek irsaliyeyle
 *     iki farklı tanka bölünebilir — bu meşru, engellenmemeli (Test 5).
 *   - Tedarikçi adı serbest metin: harf büyüklüğü/boşluk farkı aynı tedarikçi.
 *   - Eşzamanlı iki gönderimde tam biri kabul edilmeli (tank FOR UPDATE kilidi).
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
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

async function call(path: string, token: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
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

const level = async (tankId: string) =>
  Number((await q('SELECT current_level_liters FROM tanks WHERE id = $1', [tankId]))[0].current_level_liters);
const receiptCount = async (tankId: string) =>
  Number((await q('SELECT count(*) FROM fuel_intake_receipts WHERE tank_id = $1', [tankId]))[0].count);

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §2.2] IDEMPOTENCY — MÜKERRER YAKIT ALIM İRSALİYESİ');
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

  const tankA = `tank-idem-a-${RUN}`;
  const tankB = `tank-idem-b-${RUN}`;
  const tankC = `tank-idem-c-${RUN}`;
  const tanks = [tankA, tankB, tankC];

  try {
    for (const id of tanks) {
      await q(
        `INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type)
         VALUES ($1, 'comp-camsa', $2, 'Gebze Ana Şantiye', 100000, 1000, 'Motorin')`,
        [id, `IDEM-${id}`]
      );
    }
    const token = await login('camsa');
    const waybill = `IRS-${RUN}`;
    const base = { supplierName: 'Opet', waybillNo: waybill, deliveryDate: '2026-09-10', declaredLiters: 5000 };

    // ── 1) İlk kayıt normal çalışır ─────────────────────────────────────
    const first = await call(`/tanks/${tankA}/intakes`, token, base);
    check('Test 1: İlk irsaliye kaydı kabul edilir ve stok artar', first.status === 201 && (await level(tankA)) === 6000,
      `status=${first.status}, seviye=${await level(tankA)} (beklenen 6000)`);

    // ── 2) Aynı irsaliye aynı tanka → reddedilir, stok DEĞİŞMEZ ─────────
    const dup = await call(`/tanks/${tankA}/intakes`, token, base);
    check('Test 2: AYNI irsaliye AYNI tanka ikinci kez → 409 DUPLICATE_WAYBILL',
      dup.status === 409 && dup.body?.details?.error === 'DUPLICATE_WAYBILL',
      `status=${dup.status}, details=${JSON.stringify(dup.body?.details)}`);
    check('Test 3: Reddedilen tekrar stoğu ARTIRMADI ve ikinci kayıt oluşmadı (hayali stok yok)',
      (await level(tankA)) === 6000 && (await receiptCount(tankA)) === 1,
      `seviye=${await level(tankA)}, kayıt=${await receiptCount(tankA)}`);
    const storedId = (await q('SELECT id FROM fuel_intake_receipts WHERE tank_id = $1', [tankA]))[0]?.id;
    check('Test 4: Hata yanıtı MEVCUT kaydın kimliğini döndürür (istemci neyin tekrarlandığını görür)',
      !!storedId && dup.body?.details?.existingReceiptId === storedId,
      `existingReceiptId=${dup.body?.details?.existingReceiptId}, DB'deki kayıt=${storedId}`);

    // ── 3) Harf/boşluk varyantı da aynı tedarikçi sayılır ───────────────
    const variant = await call(`/tanks/${tankA}/intakes`, token, { ...base, supplierName: '  OPET ', waybillNo: ` ${waybill} ` });
    check('Test 5: Tedarikçi adı/irsaliye no harf-boşluk varyantı ("  OPET ", " IRS-… ") da tekrar sayılır',
      variant.status === 409 && (await level(tankA)) === 6000,
      `status=${variant.status}, seviye=${await level(tankA)}`);

    // ── 4) Meşru senaryolar engellenmemeli ──────────────────────────────
    const split = await call(`/tanks/${tankB}/intakes`, token, base);
    check('Test 6: Aynı irsaliye FARKLI tanka (bölünmüş tanker teslimatı) → kabul edilir',
      split.status === 201 && (await level(tankB)) === 6000,
      `status=${split.status}, tankB seviye=${await level(tankB)}`);

    const otherWaybill = await call(`/tanks/${tankA}/intakes`, token, { ...base, waybillNo: `${waybill}-2` });
    check('Test 7: Aynı tanka FARKLI irsaliye → kabul edilir',
      otherWaybill.status === 201 && (await level(tankA)) === 11000,
      `status=${otherWaybill.status}, seviye=${await level(tankA)} (beklenen 11000)`);

    const otherSupplier = await call(`/tanks/${tankA}/intakes`, token, { ...base, supplierName: 'Shell' });
    check('Test 8: Aynı irsaliye no FARKLI tedarikçiden → kabul edilir (numaralar tedarikçiler arası çakışabilir)',
      otherSupplier.status === 201,
      `status=${otherSupplier.status}`);

    // ── 5) Eşzamanlı çift gönderim (çift tıklama / retry yarışı) ────────
    const race = { ...base, waybillNo: `${waybill}-RACE` };
    const results = await Promise.all([
      call(`/tanks/${tankC}/intakes`, token, race),
      call(`/tanks/${tankC}/intakes`, token, race),
      call(`/tanks/${tankC}/intakes`, token, race)
    ]);
    const ok = results.filter((r) => r.status === 201).length;
    const conflict = results.filter((r) => r.status === 409).length;
    check('Test 9: AYNI ANDA 3 kez gönderilen irsaliyeden tam BİRİ kabul, ikisi 409',
      ok === 1 && conflict === 2,
      `durumlar=[${results.map((r) => r.status).join(', ')}]`);
    check('Test 10: Yarış sonrası stok yalnızca BİR KEZ arttı (1000 + 5000)',
      (await level(tankC)) === 6000 && (await receiptCount(tankC)) === 1,
      `seviye=${await level(tankC)}, kayıt=${await receiptCount(tankC)}`);
  } finally {
    for (const id of tanks) {
      await q('DELETE FROM fuel_intake_receipts WHERE tank_id = $1', [id]);
      await q('DELETE FROM tanks WHERE id = $1', [id]);
    }
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
