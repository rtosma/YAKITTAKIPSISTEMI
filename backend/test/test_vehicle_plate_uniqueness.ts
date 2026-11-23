import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md §2.2 — araç plakası tenant içinde tekil.
 *
 * NEDEN: plaka aracın iş anahtarı (transactions, cross_site_permissions ve
 * tüketim motoru araca plakayla bağlanır; FUEL-402 çapraz şantiye kontrolü
 * ev şantiyesini `WHERE plate = $1` ile okur). Kopya plaka engellenmiyordu —
 * aynı plaka + aynı RFID ile iki araç kaydı canlı doğrulandı; yerel DB'de
 * testlerin bıraktığı 23 adet '34 CTP 82' kopyası vardı.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const SUFFIX = String(1000 + Math.floor(Math.random() * 9000));
const PLATE = `34 UNQ ${SUFFIX}`;
const OTHER_PLATE = `34 UNQ ${Number(SUFFIX) === 9999 ? 1000 : Number(SUFFIX) + 1}`;
const RACE_PLATE = `06 RCE ${SUFFIX}`;

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
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
  const body = await res.json();
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}
const vehicle = (plate: string) => ({ plate, brandModel: 'Tekillik Testi', rfidTag: `TAG-UNQ-${plate.replace(/\s/g, '')}`, fuelCapacityLiters: 300 });

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §2.2] ARAÇ PLAKASI TENANT İÇİNDE TEKİL');
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
  const plates = [PLATE, OTHER_PLATE, RACE_PLATE];
  try {
    const owner = await login('camsa');
    const kusak = await login('kusak');

    const first = await call('POST', '/vehicles', owner, vehicle(PLATE));
    check('Test 1: yeni plakayla araç kaydı kabul edilir', first.status === 200 && !!first.body.data?.id, `status=${first.status}`);

    const dup = await call('POST', '/vehicles', owner, { ...vehicle(PLATE), rfidTag: 'TAG-FARKLI' });
    check('Test 2: aynı plaka → 409 DUPLICATE_PLATE, mevcut aracın id\'si döner',
      dup.status === 409 && dup.body.details?.error === 'DUPLICATE_PLATE' && dup.body.details?.existingVehicleId === first.body.data?.id,
      `status=${dup.status} body=${JSON.stringify(dup.body).slice(0, 160)}`);

    // Şema regex'i boşlukları isteğe bağlı ve harfleri büyük/küçük duyarsız
    // kabul ediyor → bu varyantlar GEÇERLİ plaka; tekillik de onları aynı saymalı.
    const variants = await Promise.all([PLATE.replace(/\s/g, '').toLowerCase(), PLATE.replace(' UNQ ', ' unq')]
      .map((p) => call('POST', '/vehicles', owner, vehicle(p))));
    check('Test 3: boşluksuz/küçük harf varyantları da aynı plaka sayılır → 409',
      variants.every((v) => v.status === 409), `statüler=${variants.map((v) => v.status).join(',')}`);

    const second = await call('POST', '/vehicles', owner, vehicle(OTHER_PLATE));
    const renameToDup = await call('PUT', `/vehicles/${second.body.data?.id}`, owner, { plate: PLATE });
    check('Test 4: başka bir aracın plakası mevcut plakaya GÜNCELLENEMEZ → 409', renameToDup.status === 409, `status=${renameToDup.status}`);

    const selfUpdate = await call('PUT', `/vehicles/${first.body.data?.id}`, owner, { plate: PLATE, brandModel: 'Güncellendi' });
    check('Test 5: aracın KENDİ plakasıyla güncellenmesi engellenmez', selfUpdate.status === 200, `status=${selfUpdate.status}`);

    const otherTenant = await call('POST', '/vehicles', kusak, vehicle(PLATE));
    check('Test 6: aynı plaka BAŞKA tenant\'ta serbest (tekillik tenant kapsamlı)', otherTenant.status === 200, `status=${otherTenant.status}`);

    const race = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/vehicles', owner, vehicle(RACE_PLATE))));
    const raceRows = Number((await db.query("SELECT count(*) FROM vehicles WHERE tenant_id = 'comp-camsa' AND plate = $1", [RACE_PLATE])).rows[0].count);
    check('Test 7: aynı plakayla 5 EŞZAMANLI kayıt → tam 1 kabul, DB\'de tek satır',
      race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.status === 409).length === 4 && raceRows === 1,
      `statüler=${race.map((r) => r.status).join(',')}, satır=${raceRows}`);
  } finally {
    await db.query("DELETE FROM vehicles WHERE upper(regexp_replace(plate, '\\s', '', 'g')) = ANY($1)", [plates.map((p) => p.replace(/\s/g, ''))]);
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
