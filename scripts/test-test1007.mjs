#!/usr/bin/env node
// ==============================================================================
// TEST-1007 (#198) — kaos test paketi sözleşme testleri (docker gerekmez; CI'da çalışır).
// Kaos senaryolarının kendisi (gerçek bağımlılık çökmeleri): backend/test/test_test1007_chaos.ts (host, docker gerekir).
// ==============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0; let total = 0;
const check = (name, ok, detail = '') => { total++; if (ok) passed++; console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`); };

const chaos = read('backend/test/test_test1007_chaos.ts');
check('Kaos paketi: A taban, B 72 saatlik kesinti (216 ikmal), C yavaş+kayıplı hat (gecikme+bant+kayıp, tohumlu), D senkron sırasında ikinci kesinti, E sunucu SIGKILL, F1/F2/F3 Redis/MQTT/Postgres çökmesi — hepsi mevcut',
  ['A-baseline', 'B-72h-outage', 'C-degraded-link', 'D-second-outage-mid-sync', 'E-backend-crash-mid-sync', 'F1-redis-down', 'F2-mqtt-down', 'F3-postgres-down'].every((n) => chaos.includes(`'${n}'`)) && /const N = 216/.test(chaos) && /rng\(20260921\)/.test(chaos) && /latencyMs = 250; proxy\.lossRate = 0\.35; proxy\.bytesPerSec = 12_000/.test(chaos), '');
check('Doğrulama sıkılığı: her senaryo DB kaydı + benzersiz (device_id, localSequenceId) + toplam litre + tank Δ birebir; "işlendi ama yanıt kayboldu" durumu zorunlu; bağımlılıklar finally ile HER KOŞULDA geri başlatılır',
  /distinct_n === N/.test(chaos) && /Math\.abs\(lvl0 - lvl1 - liters\) < 0\.01/.test(chaos) && /reset_after_forward/.test(chaos) && /restoreAllSafe\(\)/.test(chaos) && /docker start \$\{c\}/.test(chaos), '');
const ready = read('backend/src/services/readinessService.ts');
check('Düzeltme: readiness bağımlılık kontrolleri 2 sn ile sınırlı (Postgres çökünce 10 sn havuz zaman aşımına takılıp probe\'u asmaz)',
  /CHECK_TIMEOUT_MS = 2000/.test(ready) && /withTimeout\(pool\.query\('SELECT 1'\), 'postgres'\)/.test(ready) && /withTimeout\(redisPool\.client\.ping\(\), 'redis'\)/.test(ready), '');
const eh = read('backend/src/middleware/errorHandler.ts');
check('Düzeltme: veritabanına ulaşılamaması (ECONNREFUSED/ENOTFOUND/57P01/…) 503 DB_UNAVAILABLE + Retry-After; sorgu zaman aşımı 57014 ayrı DB_BUSY sınıfı olarak kalır',
  /error: 'DB_UNAVAILABLE'/.test(eh) && /'ECONNREFUSED', 'ENOTFOUND'/.test(eh) && /Retry-After', '5'/.test(eh) && /err\?\.code === '55P03' \|\| err\?\.code === '57014'/.test(eh), '');
const doc = existsSync(path.join(ROOT, 'docs/CHAOS_TESTING.md')) ? read('docs/CHAOS_TESTING.md') : '';
const terms = ['72 saat', 'toxiproxy', 'tohumlu', 'DUPLICATE_SKIPPED', 'fail-closed', 'DB_UNAVAILABLE', 'Retry-After', 'restart policy', 'nginx -s reload', 'chaos-reports', 'Kapsam uyarlaması', 'CI\'da çalışmaz', 'docker kill', 'exact'];
const missing = terms.filter((t) => !doc.includes(t));
check('Doküman: docs/CHAOS_TESTING.md yöntem, senaryo/AC tablosu, bağımlılık davranış matrisi, bulunan/düzeltilen boşluklar, operasyonel bulgular ve sürümler arası karşılaştırmayı kapsar', missing.length === 0 && existsSync(path.join(ROOT, 'docs/chaos-reports/README.md')), `eksik=[${missing}]`);
const ci = read('.github/workflows/ci-cd.yml');
check('CI: hata sınıflandırma testi (test_test1007_error_mapping) ve bu sözleşme testi pipeline\'da (kaos paketi docker gerektirdiği için CI dışı — belgede gerekçeli)',
  /test\/test_test1007_error_mapping\.ts/.test(ci) && /node scripts\/test-test1007\.mjs/.test(ci), '');
console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
