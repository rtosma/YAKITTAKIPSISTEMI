import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md §7 — Postgres bağlantı havuzu doygunluğu.
 *
 * Senaryo: bir tenant'ın tank satırı başka bir işlem tarafından kilitli
 * tutulurken (uzun süren/asılı bir transaction) o tanka eşzamanlı ikmal
 * istekleri gelir. Her istek havuzdan bir bağlantı alıp kilit bekler.
 * Havuz (max 10) bu beklemelerle dolarsa, kilitle HİÇ ilgisi olmayan başka
 * bir tenant'ın istekleri de havuz bekler — tek bir tenant'taki kilit tüm
 * platformu durdurur.
 *
 * Beklenen: kilit bekleyen istekler sınırlı sürede, yeniden denenebilir bir
 * hatayla (503) düşer; başka tenant'ın isteği makul sürede yanıt alır; hiçbir
 * yarım yazma kalmaz; kilit kalkınca sistem normale döner.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const RUN = Date.now();
const TANK = `POOLTEST-${RUN}`;
const SITE = 'Gebze Ana Şantiye';
const PLATE = '34 PLT 01';
const CONCURRENT = 14;
const LOCK_HOLD_MS = 12_000;

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
async function timed(path: string, token: string, init: RequestInit = {}, timeoutMs = 30_000) {
  const started = Date.now();
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { status: res.status, ms: Date.now() - started, body: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, ms: Date.now() - started, body: { aborted: true } };
  }
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §7] POSTGRES HAVUZ DOYGUNLUĞU — KİLİT BEKLEYEN İSTEKLER');
  console.log('===========================================================\n');
  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };

  const db = pg();
  const holder = pg();
  await db.connect();
  await holder.connect();
  let lockReleased = false;
  try {
    await db.query(
      `INSERT INTO tanks (id, tenant_id, name, site_name, capacity_liters, current_level_liters, fuel_type) VALUES ($1, 'comp-camsa', $2, $3, 100000, 50000, 'Motorin')`,
      [`tank-${TANK}`, TANK, SITE]
    );
    const camsa = await login('camsa');
    const kusak = await login('kusak');

    await holder.query('BEGIN');
    await holder.query('SELECT id FROM tanks WHERE name = $1 FOR UPDATE', [TANK]);
    const lockStart = Date.now();

    const dispenses = Array.from({ length: CONCURRENT }, () =>
      timed('/dispense', camsa, {
        method: 'POST',
        body: JSON.stringify({ siteName: SITE, vehiclePlate: PLATE, tankName: TANK, amountLiters: 1, type: 'Manuel' })
      }).then((r) => ({ ...r, settledAtMs: Date.now() - lockStart }))
    );

    await new Promise((r) => setTimeout(r, 1500));
    const otherTenant = await timed('/vehicles', kusak, {}, 8_000);
    check(`Test 1: havuz kilit beklemeleriyle doluyken BAŞKA tenant'ın isteği 8 sn içinde yanıt alır`,
      otherTenant.status === 200, `kusak GET /vehicles → status=${otherTenant.status || 'ZAMAN AŞIMI'} (${otherTenant.ms} ms)`);

    const waitLeft = LOCK_HOLD_MS - (Date.now() - lockStart);
    if (waitLeft > 0) await new Promise((r) => setTimeout(r, waitLeft));
    await holder.query('ROLLBACK');
    lockReleased = true;

    const results = await Promise.all(dispenses);
    const statuses = results.map((r) => r.status);
    const busy = results.filter((r) => r.status === 503).length;
    const ok = results.filter((r) => r.status === 200).length;
    // Kilidi en baştan bekleyen ilk grup (havuz boyutu kadar) lock_timeout ile
    // düşmeli. Havuzdan geç bağlantı alıp kilidi 5 sn'den KISA bekleyen bir
    // istek kilit kalkınca meşru olarak 200 alabilir — "asılı kalmak" bu değil.
    check('Test 2: kilit bekleyenler yeniden denenebilir 503 ile düşer; kalanlar kilit kalkar kalkmaz tamamlanır (süresiz bekleme yok)',
      busy >= 10 && busy + ok === CONCURRENT && results.every((r) => r.settledAtMs < LOCK_HOLD_MS + 1_500) &&
        results.every((r) => r.status !== 503 || r.body.error === 'DB_BUSY'),
      `503=${busy}, 200=${ok}, statüler=${statuses.join(',')}; en geç=${Math.max(...results.map((r) => r.settledAtMs))} ms`);

    const tank = (await db.query('SELECT current_level_liters FROM tanks WHERE name = $1', [TANK])).rows[0];
    const txCount = Number((await db.query('SELECT count(*) FROM transactions WHERE tank_name = $1', [TANK])).rows[0].count);
    check('Test 3: düşen isteklerden yarım yazma kalmaz (stok ve işlem sayısı yalnızca başarılı isteklerle tutarlı)',
      Number(tank.current_level_liters) === 50000 - ok && txCount === ok, `stok=${tank.current_level_liters}, işlem=${txCount}, başarılı=${ok}`);

    const after = await timed('/dispense', camsa, {
      method: 'POST',
      body: JSON.stringify({ siteName: SITE, vehiclePlate: PLATE, tankName: TANK, amountLiters: 1, type: 'Manuel' })
    });
    const ready = await fetch(`${API_URL}/health/ready`);
    check('Test 4: kilit kalkınca ikmal başarılı ve /health/ready 200 (havuz toparlandı)',
      after.status === 200 && ready.status === 200, `ikmal=${after.status}, ready=${ready.status}`);
  } finally {
    if (!lockReleased) await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
    await db.query('DELETE FROM transactions WHERE tank_name = $1', [TANK]);
    await db.query('DELETE FROM tanks WHERE name = $1', [TANK]);
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
