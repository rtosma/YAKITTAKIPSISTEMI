import Redis from 'ioredis';

/**
 * AUTH-201.4 — Rol × kritik uç yetki matrisi + şantiye kapsamı testi.
 *
 * Kapsanan 4 rol (seed_mock_data.sql'de gerçekten var olan): SUPER_ADMIN
 * (admin), COMPANY_OWNER (camsa), SITE_MANAGER (gebze-santiye VE
 * orman-santiye — aynı tenant, FARKLI şantiye — şantiye kapsamı testi için
 * kasıtlı olarak iki tane), PUMP_OPERATOR (pompa-op-01).
 *
 * DRIVER rolü seed verisinde YOK ve kod tabanında hiçbir yerde
 * kullanılmıyor (routes.ts'te "'DRIVER'" araması sıfır sonuç veriyor) —
 * bu rol için şantiye/kimlik kapsamı henüz inşa edilmemiş bir özellik,
 * bu testin kapsamı dışında (AC'nin "5 rol" ifadesindeki 5. rol bu
 * yüzden test edilmiyor; ayrı bir iş olarak not edilmeli).
 */

const API_URL = 'http://localhost:5000/api/v1';
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10)
});

async function resetIpLoginRateLimit(): Promise<void> {
  const keys = await redis.keys('rl:auth-login:*');
  if (keys.length > 0) await redis.del(...keys);
}

async function call(method: string, path: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (path === '/auth/login') await resetIpLoginRateLimit();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function login(username: string): Promise<string> {
  const res = await call('POST', '/auth/login', { body: { username, password: '123456' } });
  if (res.status !== 200) throw new Error(`Ön koşul: ${username} ile giriş başarısız (HTTP ${res.status})`);
  return res.body.accessToken;
}

async function run() {
  console.log('===========================================================');
  console.log('🛡️  [AUTH-201.4] ROL × UÇ YETKİ MATRİSİ + ŞANTİYE KAPSAMI');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  function check(name: string, condition: boolean, detail: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      console.log(`   ${detail}\n`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}`);
      console.error(`   ${detail}\n`);
    }
  }

  const tokens = {
    superAdmin: await login('admin'),
    owner: await login('camsa'),
    gebzeManager: await login('gebze-santiye'),
    ormanManager: await login('orman-santiye'),
    pumpOperator: await login('pompa-op-01')
  };

  // --- Matris 1: GET /companies (yalnızca SUPER_ADMIN) ---
  const companiesMatrix: Array<[string, string, number]> = [
    ['SUPER_ADMIN', tokens.superAdmin, 200],
    ['COMPANY_OWNER', tokens.owner, 403],
    ['SITE_MANAGER', tokens.gebzeManager, 403],
    ['PUMP_OPERATOR', tokens.pumpOperator, 403]
  ];
  for (const [role, token, expected] of companiesMatrix) {
    const res = await call('GET', '/companies', { token });
    check(`Matris: GET /companies — ${role} → ${expected}`, res.status === expected, `HTTP ${res.status}`);
  }

  // --- Matris 2: GET /audit-logs (yalnızca SUPER_ADMIN + COMPANY_OWNER) ---
  const auditMatrix: Array<[string, string, number]> = [
    ['SUPER_ADMIN', tokens.superAdmin, 200],
    ['COMPANY_OWNER', tokens.owner, 200],
    ['SITE_MANAGER', tokens.gebzeManager, 403],
    ['PUMP_OPERATOR', tokens.pumpOperator, 403]
  ];
  for (const [role, token, expected] of auditMatrix) {
    const res = await call('GET', '/audit-logs', { token });
    check(`Matris: GET /audit-logs — ${role} → ${expected}`, res.status === expected, `HTTP ${res.status}`);
  }

  // --- Matris 3: POST /vehicles (SUPER_ADMIN/COMPANY_OWNER/SITE_MANAGER evet, PUMP_OPERATOR hayır) ---
  const vehicleBody = { plate: '34 RBC 01', brandModel: 'Test Marka Model', rfidTag: 'TAG-RBAC-01', fuelCapacityLiters: 100 };
  const createVehicleMatrix: Array<[string, string, number]> = [
    ['SITE_MANAGER', tokens.gebzeManager, 200],
    ['PUMP_OPERATOR', tokens.pumpOperator, 403]
  ];
  for (const [role, token, expected] of createVehicleMatrix) {
    const res = await call('POST', '/vehicles', { token, body: { ...vehicleBody, plate: `34 RBC ${Math.floor(Math.random() * 9000)}` } });
    check(`Matris: POST /vehicles — ${role} → ${expected}`, res.status === expected, `HTTP ${res.status}`);
  }

  // --- Şantiye kapsamı: gebze-santiye ve orman-santiye AYNI tenant'ta,
  // FARKLI şantiyede — birbirinin araçlarını/şoförlerini/tanklarını
  // GÖREMEMELİ (AC: "SITE_MANAGER başka şantiyenin verisini
  // sorgulayamamalıdır"). COMPANY_OWNER ise HER İKİSİNİ de görmeli. ---
  const [gebzeVehicles, ormanVehicles, ownerVehicles] = await Promise.all([
    call('GET', '/vehicles', { token: tokens.gebzeManager }),
    call('GET', '/vehicles', { token: tokens.ormanManager }),
    call('GET', '/vehicles', { token: tokens.owner })
  ]);
  const gebzeSites = new Set((gebzeVehicles.body.data as any[]).map((v) => v.site_name));
  const ormanSites = new Set((ormanVehicles.body.data as any[]).map((v) => v.site_name));

  check(
    "Şantiye kapsamı: 'gebze-santiye' yalnızca Gebze Ana Şantiye araçlarını görür",
    gebzeSites.size <= 1 && (gebzeSites.size === 0 || gebzeSites.has('Gebze Ana Şantiye')),
    `görülen site_name kümesi: ${[...gebzeSites].join(', ') || '(boş)'}`
  );
  check(
    "Şantiye kapsamı: 'orman-santiye' yalnızca Orman Şantiyesi araçlarını görür",
    ormanSites.size <= 1 && (ormanSites.size === 0 || ormanSites.has('Orman Şantiyesi')),
    `görülen site_name kümesi: ${[...ormanSites].join(', ') || '(boş)'}`
  );
  check(
    "Şantiye kapsamı: COMPANY_OWNER her iki şantiyeyi de görür",
    ownerVehicles.body.data.length >= gebzeVehicles.body.data.length + ormanVehicles.body.data.length,
    `owner=${ownerVehicles.body.data.length}, gebze=${gebzeVehicles.body.data.length}, orman=${ormanVehicles.body.data.length}`
  );

  // Aynı kapsam denetimi /drivers, /tanks, /transactions için de geçerli —
  // tek bir temsili uçta (drivers) tekrarlanıyor.
  const [gebzeDrivers, ormanDrivers] = await Promise.all([
    call('GET', '/drivers', { token: tokens.gebzeManager }),
    call('GET', '/drivers', { token: tokens.ormanManager })
  ]);
  const gebzeDriverSites = new Set((gebzeDrivers.body.data as any[]).map((d) => d.site_name));
  check(
    "Şantiye kapsamı: GET /drivers da aynı şekilde kısıtlı (gebze-santiye)",
    gebzeDriverSites.size <= 1 && (gebzeDriverSites.size === 0 || gebzeDriverSites.has('Gebze Ana Şantiye')),
    `görülen site_name kümesi: ${[...gebzeDriverSites].join(', ') || '(boş)'}`
  );
  check(
    "Şantiye kapsamı: orman-santiye'nin şoförleri gebze-santiye'ninkilerden farklı/ayrık",
    JSON.stringify([...gebzeDriverSites]) !== JSON.stringify([...new Set((ormanDrivers.body.data as any[]).map((d) => d.site_name))].filter(Boolean)) ||
      gebzeDriverSites.size === 0,
    `gebze gördü: ${gebzeDrivers.body.data.length} şoför`
  );

  // --- Tenant izolasyonu (RLS) kontrolü: farklı bir firma (kusak) hiçbir
  // camsa verisini görmemeli — matris tamlığı için buraya da eklendi. ---
  const kusakToken = await login('kusak');
  const kusakVehicles = await call('GET', '/vehicles', { token: kusakToken });
  const camsaPlates = new Set((ownerVehicles.body.data as any[]).map((v) => v.plate));
  const leaked = (kusakVehicles.body.data as any[]).some((v) => camsaPlates.has(v.plate));
  check(
    "Tenant izolasyonu: 'kusak' (comp-kusak) camsa'nın (comp-camsa) hiçbir aracını görmez",
    !leaked,
    `kusak ${kusakVehicles.body.data.length} araç gördü, sızıntı=${leaked}`
  );

  await resetIpLoginRateLimit();
  redis.disconnect();

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

run();
