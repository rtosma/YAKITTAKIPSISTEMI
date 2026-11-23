import Redis from 'ioredis';
import { Client } from 'pg';

/**
 * TEST_PLAN.md §2.2 — Eşzamanlılık / race-condition testleri.
 *
 * Kod tabanında 24 yerde `FOR UPDATE` satır kilidi var ve tenantDb.ts
 * createTransaction'ın yorumu açıkça şunu İDDİA ediyor:
 *   "aynı anda gelen iki ikmal isteği tank seviyesini birbirinin üzerine
 *    yazamaz"
 * Ama bu iddia bugüne kadar HİÇ eşzamanlı yükle sınanmamıştı — 59 test
 * dosyasının tamamı istekleri SIRAYLA atıyor. Sıralı bir test, kilitleri
 * tamamen kaldırsanız bile geçer.
 *
 * Burada test edilen şey "kilit var mı" değil, kaybolan güncelleme
 * (lost update) ve stok aşımı GERÇEKTEN oluşuyor mu:
 *   - read-modify-write arasında başka bir transaction araya girebiliyor mu?
 *   - yetersiz stok kontrolü eşzamanlı isteklerde aşılabiliyor mu?
 *
 * Neden bu senaryolar: ikisi de doğrudan PARAYA dokunuyor — envanterde
 * negatif stok sayım tutarsızlığı, tankta ise kayıp yakıt demek.
 *
 * ÇALIŞTIRMA BAĞLAMI (TEST_PLAN §2.3, kategori 1): backend konteynerinin
 * ağ ad alanından:
 *   docker run --rm --network "container:$(docker compose ps -q backend)" \
 *     --env-file .env -e POSTGRES_HOST=postgres -e REDIS_HOST=redis \
 *     -v "$PWD/backend/test:/app/test:ro" \
 *     yakittakipsistemi-backend:test-runner npx tsx test/test_race_conditions.ts
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN_ID = Date.now();

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

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: any } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10)
});

/**
 * loginRateLimiter IP bazlıdır (10 deneme / 15 dk) ve TÜM testler CI'da aynı
 * IP'den gelir — bir test paketi sırayla koştuğunda, önceki testlerin
 * girişleri sonrakileri 429'a düşürüp YANLIŞ başarısızlık üretir. Mevcut
 * testlerin (test_fuel410, test_arch108, ...) kullandığı temizlik deseni.
 */
async function resetLoginRateLimit(): Promise<void> {
  try {
    const keys = await redis.keys('rl:auth-login:*');
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // Redis erişilemezse test yine de denesin — bu bir fail-fast noktası değil.
  }
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const r = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §2.2] EŞZAMANLILIK / RACE CONDITION TESTLERİ');
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

  const createdItemIds: string[] = [];
  const tankName = `RACE-Tank-${RUN_ID}`;
  const siteName = 'Gebze Ana Şantiye';

  try {
    const token = await login('camsa'); // COMPANY_OWNER

    // ═══ A) ENVANTER: eşzamanlı ÇIKIŞ, yetersiz stok aşılabiliyor mu? ═══

    // Stok 10; iki istek AYNI ANDA 7'şer birim çıkış istiyor (toplam 14).
    // Doğru davranış: biri 201, diğeri 409 INSUFFICIENT_STOCK; stok 3.
    // Kilit çalışmazsa: ikisi de 201 ve stok -4 (negatif!).
    const itemA = await call('POST', '/inventory-items', {
      token,
      body: {
        code: `RACE-A-${RUN_ID}`,
        name: 'Race Testi Filtre',
        unit: 'adet',
        criticalStockLevel: 0,
        initialStock: 10
      }
    });
    check('Hazırlık: envanter kartı oluşturuldu (stok=10)', itemA.status === 201, `status=${itemA.status}`);
    const itemAId = itemA.body?.data?.id;
    if (itemAId) createdItemIds.push(itemAId);

    const [outA1, outA2] = await Promise.all([
      call('POST', `/inventory-items/${itemAId}/movements`, {
        token,
        body: { movementType: 'ÇIKIŞ', quantity: 7, note: 'race-1' }
      }),
      call('POST', `/inventory-items/${itemAId}/movements`, {
        token,
        body: { movementType: 'ÇIKIŞ', quantity: 7, note: 'race-2' }
      })
    ]);

    const successCount = [outA1, outA2].filter((r) => r.status === 201).length;
    const rejectedCount = [outA1, outA2].filter((r) => r.status === 409).length;

    check(
      'Test 1: Eşzamanlı 2 çıkış (7+7 > stok 10) — tam olarak BİRİ kabul, diğeri 409 reddedilir',
      successCount === 1 && rejectedCount === 1,
      `kabul=${successCount}, 409=${rejectedCount}, durumlar=[${outA1.status}, ${outA2.status}]`
    );

    const stockAfterA = Number(
      (await q('SELECT current_stock FROM inventory_items WHERE id = $1', [itemAId]))[0]?.current_stock
    );
    check(
      'Test 2: Stok NEGATİFE düşmedi ve doğru değerde (10 - 7 = 3)',
      stockAfterA === 3,
      `current_stock=${stockAfterA} (beklenen 3)`
    );

    // Aynı senaryo, daha yüksek çekişme: stok 10, AYNI ANDA 6 istek × 3 birim.
    // En fazla 3 tanesi geçebilir (3×3=9 ≤ 10); 4. istek stoku 12'ye çıkarırdı.
    const itemB = await call('POST', '/inventory-items', {
      token,
      body: {
        code: `RACE-B-${RUN_ID}`,
        name: 'Race Testi Conta',
        unit: 'adet',
        criticalStockLevel: 0,
        initialStock: 10
      }
    });
    const itemBId = itemB.body?.data?.id;
    if (itemBId) createdItemIds.push(itemBId);

    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call('POST', `/inventory-items/${itemBId}/movements`, {
          token,
          body: { movementType: 'ÇIKIŞ', quantity: 3, note: `burst-${i}` }
        })
      )
    );
    const burstOk = burst.filter((r) => r.status === 201).length;
    const stockAfterB = Number(
      (await q('SELECT current_stock FROM inventory_items WHERE id = $1', [itemBId]))[0]?.current_stock
    );

    check(
      'Test 3: 6 eşzamanlı çıkış (6×3 birim, stok 10) — en fazla 3 tanesi kabul edilir',
      burstOk === 3,
      `kabul=${burstOk} (beklenen 3), durumlar=[${burst.map((r) => r.status).join(', ')}]`
    );
    check(
      'Test 4: Yoğun çekişme altında da stok negatife düşmez ve aritmetik tutarlı (10 - 3×3 = 1)',
      stockAfterB === 1 && stockAfterB >= 0,
      `current_stock=${stockAfterB} (beklenen 1)`
    );

    // Hareket kayıtları ile stok mutabık mı? (Kayıp/çift yazılmış hareket var mı?)
    // quantity her zaman POZİTİF; yön movement_type'ta tutuluyor.
    const movementSum = Number(
      (
        await q(
          `SELECT COALESCE(SUM(CASE WHEN movement_type = 'ÇIKIŞ' THEN -quantity ELSE quantity END), 0) AS toplam
             FROM inventory_movements WHERE item_id = $1`,
          [itemBId]
        )
      )[0]?.toplam
    );
    check(
      'Test 5: Hareket kayıtlarının toplamı stok değeriyle MUTABIK (çift yazım/kayıp hareket yok)',
      10 + movementSum === stockAfterB,
      `başlangıç 10 + hareketler ${movementSum} = ${10 + movementSum}, stok=${stockAfterB}`
    );

    // KAYBOLAN GÜNCELLEMENİN EN KESİN KANITI: her hareket, o hareketten
    // SONRAKİ bakiyeyi (balance_after) yazıyor. İki transaction aynı anda
    // aynı `current_stock` değerini okuyup üzerine yazsaydı, ikisi de AYNI
    // balance_after'ı kaydederdi. Değerlerin benzersiz olması, hareketlerin
    // gerçekten SIRAYA girdiğini (serialize edildiğini) kanıtlar.
    const balances = (
      await q('SELECT balance_after FROM inventory_movements WHERE item_id = $1', [itemBId])
    ).map((r) => Number(r.balance_after));
    const uniqueBalances = new Set(balances);
    check(
      'Test 6 (LOST UPDATE KANITI): Eşzamanlı hareketlerin balance_after değerleri BENZERSİZ',
      balances.length > 0 && uniqueBalances.size === balances.length,
      `balance_after değerleri=[${balances.join(', ')}], benzersiz=${uniqueBalances.size}/${balances.length}`
    );

    // ═══ B) TANK: eşzamanlı ikmal, kaybolan güncelleme var mı? ═══
    //
    // tenantDb.ts createTransaction'ın iddiası: "aynı anda gelen iki ikmal
    // isteği tank seviyesini birbirinin üzerine yazamaz". Sınıyoruz.

    await q(
      `INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type)
       VALUES ($1, 'comp-camsa', $2, $3, 1000, 500, 'Motorin')`,
      [`tank-race-${RUN_ID}`, tankName, siteName]
    );

    const DISPENSE_COUNT = 8;
    const LITERS_EACH = 10;
    const dispenses = await Promise.all(
      Array.from({ length: DISPENSE_COUNT }, () =>
        call('POST', '/dispense', {
          token,
          body: {
            siteName,
            vehiclePlate: '34 CTP 82',
            tankName,
            amountLiters: LITERS_EACH,
            type: 'Manuel'
          }
        })
      )
    );
    const dispenseOk = dispenses.filter((r) => r.status === 200 || r.status === 201).length;
    const levelAfter = Number(
      (await q('SELECT current_level_liters FROM tanks WHERE name = $1', [tankName]))[0]?.current_level_liters
    );
    const expectedLevel = 500 - dispenseOk * LITERS_EACH;

    check(
      `Test 7: ${DISPENSE_COUNT} eşzamanlı ikmalin HEPSİ işlendi (stok yeterliyken hiçbiri kaybolmadı)`,
      dispenseOk === DISPENSE_COUNT,
      `başarılı=${dispenseOk}/${DISPENSE_COUNT}, durumlar=[${dispenses.map((r) => r.status).join(', ')}]`
    );
    check(
      'Test 8 (KAYBOLAN GÜNCELLEME): Tank seviyesi tam olarak başarılı ikmal sayısı kadar düştü',
      levelAfter === expectedLevel,
      `seviye=${levelAfter}, beklenen=${expectedLevel} (500 - ${dispenseOk}×${LITERS_EACH}). ` +
        'Eşit değilse iki transaction birbirinin yazımını EZMİŞ demektir.'
    );

    const txSum = Number(
      (
        await q(
          `SELECT COALESCE(SUM(amount_liters), 0) AS toplam FROM transactions
             WHERE tank_name = $1 AND tenant_id = 'comp-camsa'`,
          [tankName]
        )
      )[0]?.toplam
    );
    check(
      'Test 9: Yazılan ikmal kayıtlarının toplamı, tanktan düşen miktarla MUTABIK',
      txSum === 500 - levelAfter,
      `ikmal kayıtları toplamı=${txSum}, tanktan düşen=${500 - levelAfter}`
    );
  } finally {
    // Temizlik: testin ürettiği her şey silinir (paylaşılan geliştirme
    // veritabanı kirletilmez — TEST_PLAN §1 test veri hijyeni ilkesi).
    for (const id of createdItemIds) {
      await q('DELETE FROM inventory_movements WHERE item_id = $1', [id]);
      await q('DELETE FROM inventory_items WHERE id = $1', [id]);
    }
    await q('DELETE FROM transactions WHERE tank_name = $1', [tankName]);
    await q('DELETE FROM tanks WHERE name = $1', [tankName]);
    console.log('🧹 Test fixture verisi temizlendi.\n');
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');

  await redis.quit(); // açık bağlantı kalırsa süreç sonlanmaz
  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
