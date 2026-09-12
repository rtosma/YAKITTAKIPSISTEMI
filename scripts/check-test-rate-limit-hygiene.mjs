#!/usr/bin/env node
// ==============================================================================
// TEST_PLAN.md §0.3 — Test paketi genelinde login rate-limit hijyeni.
//
// SORUN (gerçek bir olaydan doğdu): `loginRateLimiter` IP bazlıdır
// (10 deneme / 15 dk) ve test paketindeki TÜM dosyalar aynı IP'den gelir.
// CI'da ~50 test adımı arka arkaya koşuyor; her biri birkaç giriş yapınca
// limit tükeniyor ve SONRAKİ testler 429 alıp YANLIŞLIKLA kırılıyor.
//
// Bu, en sinsi test hatası türüdür: test dosyasında hiçbir sorun yoktur,
// TEK BAŞINA çalıştırıldığında %100 geçer, ama pakette kırılır. Sonuç ya
// "flaky test" diye görmezden gelinen bir CI ya da gerçek bir hatayı
// maskeleyen gürültüdür. Canlı gözlem: test_auth201 (%100 tek başına) ve
// test_195_tenant_isolation paket içinde 429 ile kırıldı.
//
// KURAL: `/auth/login` çağıran her test dosyası, giriş yapmadan önce
// `rl:auth-login:*` anahtarlarını temizlemek ZORUNDADIR — tercihen ortak
// yardımcıyla: `import { resetLoginRateLimit } from './helpers/loginRateLimit'`
//
// NEDEN rate limiter'ı test ortamında kapatmıyoruz: o zaman production'da
// aktif olan bir güvenlik kontrolü test ortamında hiç çalışmaz ve testlerin
// ürettiği güvence gerçeği yansıtmazdı.
//
// Kullanım: node scripts/check-test-rate-limit-hygiene.mjs
// ==============================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(REPO_ROOT, 'backend', 'test');

if (!existsSync(TEST_DIR)) {
  console.log('[check-test-rate-limit-hygiene] backend/test yok — atlanıyor.');
  process.exit(0);
}

/**
 * Temizliğin KABUL EDİLEN biçimleri:
 *   - ortak yardımcı (tercih edilen)
 *   - dosyanın kendi içinde `rl:auth-login:*` anahtarlarını silmesi
 *     (40 mevcut test bunu yapıyordu; geriye dönük kabul ediliyor)
 */
const ACCEPTED_PATTERNS = [/resetLoginRateLimit/, /rl:auth-login/];

const violations = [];

for (const entry of readdirSync(TEST_DIR)) {
  if (!entry.endsWith('.ts')) continue;
  const full = path.join(TEST_DIR, entry);
  const content = readFileSync(full, 'utf-8');

  // Giriş yapmayan testleri ilgilendirmez.
  if (!content.includes('auth/login')) continue;

  if (!ACCEPTED_PATTERNS.some((re) => re.test(content))) {
    violations.push(`backend/test/${entry}`);
  }
}

if (violations.length > 0) {
  console.error(
    '[check-test-rate-limit-hygiene] HATA: /auth/login çağıran ama login ' +
    'rate-limit temizliği YAPMAYAN test dosyaları:\n'
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    '\nBu testler TEK BAŞINA geçer ama paket içinde (CI\'da) 429 alıp\n' +
    'YANLIŞLIKLA kırılır — ve daha kötüsü, başka testleri de kırar.\n\n' +
    'Çözüm — giriş yapan fonksiyonun başına ekleyin:\n' +
    "  import { resetLoginRateLimit } from './helpers/loginRateLimit';\n" +
    '  ...\n' +
    '  await resetLoginRateLimit();'
  );
  process.exit(1);
}

console.log(
  '[check-test-rate-limit-hygiene] OK — /auth/login çağıran tüm test ' +
  'dosyaları login rate-limit temizliği yapıyor.'
);
