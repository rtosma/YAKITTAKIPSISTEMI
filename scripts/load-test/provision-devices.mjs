/**
 * TEST-1002 — Yük testi için geçici donanım cihazı sağlama (provisioning).
 *
 * AC'nin 1.000 istek/sn hedefine ulaşmak için ~250-300 cihaz gerekir
 * (hardwareRateLimiter cihaz başına 300/dk = 5/sn). IOT-304 claim akışıyla
 * `LOADTEST-0001..NNNN` adlı cihazları oluşturur.
 *
 * ÇIKTI: { id, secret } dizisi **stdout'a JSON** olarak yazılır (ilerleme
 * stderr'e). Bind-mount kullanılamadığı için (NFS) dosyaya yazmaz — run.sh
 * stdout'u `.devices.json`'a yönlendirir.
 *
 * Bu makinede compose backend imajının içinde çalışır:
 *   docker run --rm --network <net> -e BASE_URL=http://backend:5000/api/v1 \
 *     -e DEVICE_COUNT=300 loadtest-sidecar:latest node /provision-devices.mjs
 *
 * Temizlik: `node scripts/load-test/cleanup-devices.mjs` (doğrudan SQL —
 * silme uç noktası yok). audit_logs'a dokunulmaz (append-only).
 */
const BASE_URL = process.env.BASE_URL || 'http://backend:5000/api/v1';
const ADMIN_USER = process.env.LOADTEST_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.LOADTEST_ADMIN_PASS || '123456';
const SITE_NAME = process.env.LOADTEST_SITE || 'Gebze Ana Şantiye';
const DEVICE_COUNT = Number(process.env.DEVICE_COUNT || 30);
const PREFIX = 'LOADTEST-';

const log = (...a) => process.stderr.write('[provision] ' + a.join(' ') + '\n');

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  log(`${DEVICE_COUNT} cihaz sağlanıyor (${BASE_URL}, şantiye: ${SITE_NAME})...`);

  const login = await api('/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  if (!login.json.accessToken) {
    throw new Error(`admin girişi başarısız (${login.status}): ${JSON.stringify(login.json)}`);
  }
  const token = login.json.accessToken;

  const devices = [];
  let failed = 0;
  for (let i = 1; i <= DEVICE_COUNT; i++) {
    const deviceId = `${PREFIX}${String(i).padStart(4, '0')}`;

    const codeRes = await api('/devices/claim-codes', {
      method: 'POST', token,
      body: { siteName: SITE_NAME, deviceName: `loadtest-${i}`, expiresInMinutes: 60 },
    });
    const code = codeRes.json?.data?.code;
    if (!code) { failed++; log(`${deviceId}: claim kodu yok (${codeRes.status})`); continue; }

    const claimRes = await api('/devices/claim', {
      method: 'POST',
      body: { code, deviceId, model: 'LOADTEST', hardwareRevision: 'k6' },
    });
    const secret = claimRes.json?.data?.secret;
    if (!secret) { failed++; log(`${deviceId}: claim başarısız (${claimRes.status})`); continue; }
    devices.push({ id: deviceId, secret });
    if (i % 25 === 0) log(`  ${i}/${DEVICE_COUNT}...`);
  }

  log(`Bitti: ${devices.length} hazır, ${failed} başarısız.`);
  process.stdout.write(JSON.stringify(devices));
  if (devices.length === 0) process.exit(1);
}

main().catch((err) => {
  log('HATA: ' + err.message);
  process.exit(1);
});
