/**
 * TEST_PLAN.md §5.1 / §5.2 — Canlı güvenlik başlığı + CORS davranışı testi.
 *
 * scripts/check-security-headers.mjs YAPILANDIRMAYI statik olarak denetler
 * (CI'da nginx olmadığı için orada canlı test çalışamaz). Bu dosya ise
 * ÇALIŞAN sunucunun gerçekten ne döndürdüğünü doğrular — ikisi birbirinin
 * yerine geçmez: yapılandırma doğru görünüp ara katman sırası yüzünden
 * başlık düşebilir ya da tersi olabilir.
 *
 * Test edilen davranışlar:
 *   1. Backend artık X-Powered-By sızdırmıyor (yığın parmak izi).
 *   2. CORS VARSAYILAN OLARAK KAPALI: yabancı bir Origin'e
 *      Access-Control-Allow-Origin verilmiyor (eskiden `*` veriliyordu).
 *   3. Preflight (OPTIONS) isteği de yabancı origin'e izin vermiyor.
 *   4. nginx üzerinden gelen yanıtlarda güvenlik başlıkları + CSP mevcut
 *      ve CSP'nin script-src'si gevşetilmemiş.
 *
 * ÇALIŞTIRMA BAĞLAMI: 2 ve 3 doğrudan backend'e (5000) bakar — CI'da da
 * çalışır. 4 ise nginx'e (3000) ihtiyaç duyar; CI'da nginx olmadığı için o
 * bölüm erişilemezse ATLANIR (skipped) ve testi kırmaz — statik guard zaten
 * o katmanı CI'da denetliyor.
 */

const API_URL = process.env.API_URL || 'http://localhost:5000/api/v1';
const NGINX_URL = process.env.NGINX_URL || 'http://localhost:3000';
const EVIL_ORIGIN = 'https://saldirgan.example.com';

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN §5.1/§5.2] GÜVENLİK BAŞLIKLARI + CORS DAVRANIŞI');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;
  let skipped = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}\n   ${detail}\n`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${name}\n   ${detail}\n`);
    }
  };
  const skip = (name: string, reason: string) => {
    skipped++;
    console.log(`⏭️  [SKIP] ${name}\n   ${reason}\n`);
  };

  // ── 1) Backend: X-Powered-By sızmamalı ─────────────────────────────────
  const health = await fetch(`${API_URL}/health`);
  check(
    'Test 1: Backend X-Powered-By başlığı sızdırmıyor (yığın parmak izi kapalı)',
    health.headers.get('x-powered-by') === null,
    `x-powered-by=${health.headers.get('x-powered-by') ?? '(yok)'}`
  );

  // ── 2) CORS: yabancı origin'e izin verilmemeli ─────────────────────────
  const crossOrigin = await fetch(`${API_URL}/health`, {
    headers: { Origin: EVIL_ORIGIN }
  });
  const acao = crossOrigin.headers.get('access-control-allow-origin');
  check(
    'Test 2: Yabancı Origin\'e Access-Control-Allow-Origin VERİLMİYOR (eskiden "*" idi)',
    acao === null,
    `Origin: ${EVIL_ORIGIN} → access-control-allow-origin=${acao ?? '(yok — doğru)'}`
  );

  check(
    'Test 3: Wildcard "*" hiçbir koşulda dönmüyor',
    acao !== '*',
    `access-control-allow-origin=${acao ?? '(yok)'}`
  );

  // ── 3) Preflight (OPTIONS) de reddedilmeli ─────────────────────────────
  const preflight = await fetch(`${API_URL}/vehicles`, {
    method: 'OPTIONS',
    headers: {
      Origin: EVIL_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  });
  const preflightAcao = preflight.headers.get('access-control-allow-origin');
  check(
    'Test 4: Preflight (OPTIONS) isteği de yabancı origin\'e izin vermiyor',
    preflightAcao === null,
    `status=${preflight.status}, access-control-allow-origin=${preflightAcao ?? '(yok — doğru)'}`
  );

  // ── 4) nginx katmanı: güvenlik başlıkları + CSP ────────────────────────
  let nginxRes: Response | null = null;
  try {
    nginxRes = await fetch(`${NGINX_URL}/`, { signal: AbortSignal.timeout(3000) });
  } catch {
    nginxRes = null;
  }

  if (!nginxRes) {
    skip(
      'Test 5-8: nginx güvenlik başlıkları',
      `nginx (${NGINX_URL}) erişilemiyor — CI'da beklenen durum (orada backend çıplak çalışır). ` +
        'Bu katman scripts/check-security-headers.mjs ile statik olarak denetleniyor.'
    );
  } else {
    const csp = nginxRes.headers.get('content-security-policy');
    check(
      'Test 5: Content-Security-Policy başlığı dönüyor',
      !!csp,
      `csp=${csp ? csp.slice(0, 60) + '...' : '(yok)'}`
    );

    // En kritik nokta: script-src gevşetilmiş olmamalı, yoksa CSP'nin XSS
    // koruması büyük ölçüde anlamsızlaşır.
    const scriptSrc = csp ? /script-src([^;]*)/i.exec(csp)?.[1] ?? '' : '';
    check(
      'Test 6: CSP script-src\'de \'unsafe-inline\'/\'unsafe-eval\' YOK (koruma etkisiz değil)',
      !!csp && !scriptSrc.includes('unsafe-inline') && !scriptSrc.includes('unsafe-eval'),
      `script-src=${scriptSrc.trim() || '(yok)'}`
    );

    const missing = ['x-frame-options', 'x-content-type-options', 'referrer-policy'].filter(
      (h) => !nginxRes!.headers.get(h)
    );
    check(
      'Test 7: Diğer güvenlik başlıkları (X-Frame-Options, nosniff, Referrer-Policy) mevcut',
      missing.length === 0,
      missing.length === 0 ? 'üçü de mevcut' : `eksik: ${missing.join(', ')}`
    );

    check(
      'Test 8: CSP eklendikten SONRA uygulama hâlâ servis ediliyor (200)',
      nginxRes.status === 200,
      `status=${nginxRes.status}`
    );
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti${skipped > 0 ? ` (${skipped} grup atlandı)` : ''}.`);
  console.log('===========================================================');

  if (passed !== total) process.exit(1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
