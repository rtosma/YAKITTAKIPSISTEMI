#!/usr/bin/env node
// ==============================================================================
// OPS-1104 AC — "Dağıtım sonrası duman testleri otomatik çalışmalıdır."
//
// Bir dağıtımdan HEMEN sonra çalışan hızlı (~saniyeler), YAN ETKİSİZ doğrulama:
// "sistem ayakta mı, doğru yapılandırılmış mı, güvenlik kapıları yerinde mi".
// Ayrıntılı işlevsellik entegrasyon testlerinin işidir; buradaki amaç bozuk bir
// dağıtımı (kalıcı 5xx, DB'ye bağlanamayan backend, açık kalmış yetkilendirme)
// KULLANICI fark etmeden yakalayıp dağıtım adımını başarısız yapmaktır.
//
// Kontroller (üretimde de güvenli — hiçbiri veri yazmaz):
//   1. GET /health          → 200 + status UP
//   2. GET /health/ready    → 200 (DB+Redis+MQTT hazır) — sıcınma için yeniden denenir
//   3. GET /reports (token yok) → 401  (yetkilendirme kapısı açık kalmamış)
//   4. GET /api-docs benzeri yok; bunun yerine frontend kökü 200 + HTML (SMOKE_CHECK_FRONTEND=1)
//   5. Güvenlik başlığı: X-Content-Type-Options: nosniff (nginx üzerinden; SMOKE_CHECK_HEADERS=1)
//   6. (isteğe bağlı) SMOKE_USERNAME/SMOKE_PASSWORD verilirse: giriş → 200 + accessToken,
//      GET /reports 200 (katalog), GET /dashboard/executive 200 — yalnızca OKUMA.
//      Üretimde parola bir GitHub environment secret'ıdır (log'a asla yazılmaz).
//
// Ortam değişkenleri:
//   SMOKE_BASE_URL   zorunlu, API kökü (örn. https://staging.ornek.com/api/v1)
//   SMOKE_WEB_URL    frontend kökü (varsayılan: SMOKE_BASE_URL'den /api/v1 çıkarılmış)
//   SMOKE_USERNAME / SMOKE_PASSWORD   isteğe bağlı oturumlu kontroller
//   SMOKE_READY_TIMEOUT_SECONDS  hazır olma bekleme süresi (varsayılan 60)
//   SMOKE_CHECK_FRONTEND=1, SMOKE_CHECK_HEADERS=1
//
// Sıfır bağımlılık (Node 20 fetch). Çıkış kodu: 0 hepsi geçti, 1 en az biri başarısız.
// ==============================================================================

const BASE = (process.env.SMOKE_BASE_URL || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('[smoke] HATA: SMOKE_BASE_URL tanımlı değil.');
  process.exit(2);
}
const WEB = (process.env.SMOKE_WEB_URL || BASE.replace(/\/api\/v1$/, '')).replace(/\/+$/, '');
const READY_TIMEOUT_MS = Number(process.env.SMOKE_READY_TIMEOUT_SECONDS || 60) * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function get(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ctl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

async function check(name, fn) {
  try {
    const out = await fn();
    record(name, out.ok, out.detail);
  } catch (err) {
    record(name, false, `istek başarısız: ${err?.cause?.code || err?.name || err?.message}`);
  }
}

async function waitReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'yanıt yok';
  while (Date.now() < deadline) {
    try {
      const res = await get(`${BASE}/health/ready`);
      if (res.status === 200) return { ok: true, detail: `HTTP 200 (${Math.round(READY_TIMEOUT_MS - (deadline - Date.now()))} ms içinde)` };
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err?.cause?.code || err?.name || 'bağlantı hatası';
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, detail: `${READY_TIMEOUT_MS / 1000} sn içinde hazır olmadı (son: ${last})` };
}

async function main() {
  console.log(`[smoke] hedef: ${BASE}`);

  await check('GET /health → 200 ve status=UP', async () => {
    const res = await get(`${BASE}/health`);
    const body = await res.json().catch(() => ({}));
    return { ok: res.status === 200 && body.status === 'UP', detail: `HTTP ${res.status}, status=${body.status}` };
  });

  await check('GET /health/ready → 200 (DB + Redis + MQTT hazır)', waitReady);

  await check('GET /reports (token yok) → 401 (yetkilendirme kapısı kapalı)', async () => {
    const res = await get(`${BASE}/reports`);
    return { ok: res.status === 401, detail: `HTTP ${res.status}` };
  });

  await check('GET /dashboard/executive (token yok) → 401', async () => {
    const res = await get(`${BASE}/dashboard/executive`);
    return { ok: res.status === 401, detail: `HTTP ${res.status}` };
  });

  if (process.env.SMOKE_CHECK_FRONTEND === '1') {
    await check('Frontend kökü → 200 ve HTML', async () => {
      const res = await get(`${WEB}/`);
      const ct = res.headers.get('content-type') || '';
      return { ok: res.status === 200 && ct.includes('text/html'), detail: `HTTP ${res.status}, ${ct}` };
    });
  }

  if (process.env.SMOKE_CHECK_HEADERS === '1') {
    await check('Güvenlik başlığı: X-Content-Type-Options=nosniff', async () => {
      const res = await get(`${WEB}/`);
      const v = res.headers.get('x-content-type-options');
      return { ok: v === 'nosniff', detail: `değer=${v}` };
    });
  }

  if (process.env.SMOKE_USERNAME && process.env.SMOKE_PASSWORD) {
    let token;
    await check('POST /auth/login (duman kullanıcısı) → 200 + accessToken', async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${BASE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: process.env.SMOKE_USERNAME, password: process.env.SMOKE_PASSWORD }),
          signal: ctl.signal
        });
        const body = await res.json().catch(() => ({}));
        token = body.accessToken;
        return { ok: res.status === 200 && !!token, detail: `HTTP ${res.status}` };
      } finally {
        clearTimeout(timer);
      }
    });
    if (token) {
      const auth = { Authorization: `Bearer ${token}` };
      await check('GET /reports (oturumlu) → 200 (rapor kataloğu)', async () => {
        const res = await get(`${BASE}/reports`, auth);
        const body = await res.json().catch(() => ({}));
        return { ok: res.status === 200 && Array.isArray(body.data) && body.data.length > 0, detail: `HTTP ${res.status}, ${body.data?.length ?? 0} rapor` };
      });
      await check('GET /dashboard/executive (oturumlu) → 200 ve KPI kartları', async () => {
        const res = await get(`${BASE}/dashboard/executive?days=7`, auth);
        const body = await res.json().catch(() => ({}));
        return { ok: res.status === 200 && !!body.data?.kpis?.openAlarms, detail: `HTTP ${res.status}` };
      });
    }
  } else {
    console.log('ℹ️  SMOKE_USERNAME/SMOKE_PASSWORD yok — oturumlu kontroller atlandı.');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`[smoke] BAŞARISIZ: ${failed.map((f) => f.name).join(' | ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[smoke] beklenmeyen hata:', err);
  process.exit(1);
});
