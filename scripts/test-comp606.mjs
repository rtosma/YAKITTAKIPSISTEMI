#!/usr/bin/env node
// ==============================================================================
// COMP-606 (#132) — KVKK statik/sözleşme testleri (sıfır npm bağımlılığı; docker gerekmez).
//   node scripts/test-comp606.mjs
// Davranış testleri (maskeleme, anonimleştirme, başvuru akışı, log çıktı taraması): backend/test/test_comp606_kvkk.ts
// ==============================================================================
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { findViolations, extractLoggerCalls } from './check-no-pii-logging.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (ok) passed++;
  console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`);
};

// ── 1. Statik log taraması (guard) ─────────────────────────────────────────────
const bad = [
  "logger.info({ tcNo: driver.tc_no }, 'kayıt');",
  "logger.warn({ phone }, 'aranıyor');",
  "logger.error(\n  { err, email: user.email },\n  'hata'\n);",
  "logger.debug(`sürücü ${driver.tc_no} bulundu`);",
  "logger.info({ password }, 'x');"
];
const good = [
  "logger.info({ driverId: d.id, tenantId }, 'e-posta gönderildi');",
  "logger.info({ sessionId }, 'oturum açıldı');",
  "logger.info({ tcNo }, 'kasıtlı'); // pii-log:allow test fixture gerekçesi",
  "console.log('tcNo'); const phone = 1;"
];
const badHits = bad.map((c) => findViolations(c).length);
const goodHits = good.map((c) => findViolations(c).length);
check('Guard fixture: tcNo/tc_no/phone/email/password içeren logger çağrıları (tek satır, çok satır, şablon metin) YAKALANIR; kişisel veri içermeyen, `pii-log:allow` işaretli ve logger dışı çağrılar geçer',
  badHits.every((n) => n === 1) && goodHits.every((n) => n === 0), `kötü=${badHits}, iyi=${goodHits}`);
check('Guard: çok satırlı çağrının başlangıç satırı doğru raporlanır; iç içe parantezli çağrı doğru kapatılır',
  findViolations("\n\nlogger.error(\n  { err: fn(a, (b)), phone },\n  'x'\n);")[0]?.line === 3 && extractLoggerCalls("logger.info(a(b(c)), 'm'); logger.warn('n');").length === 2, '');
const repo = spawnSync('node', [path.join(ROOT, 'scripts/check-no-pii-logging.mjs')], { encoding: 'utf8' });
check('Guard (gerçek kod): backend/src altındaki hiçbir logger çağrısında kişisel veri anahtarı yok', repo.status === 0, repo.stdout.trim() + repo.stderr.trim());

// ── 2. Envanter belgesi ↔ kod ─────────────────────────────────────────────────
const inv = read('backend/src/privacy/piiInventory.ts');
const entries = [...inv.matchAll(/\{ table: '(\w+)', column: '(\w+)'/g)].map((m) => `${m[1]}.${m[2]}`);
const doc = read('docs/KVKK_ENVANTER.md');
const undocumented = entries.filter((e) => !doc.includes(`| ${e} |`));
check(`Doküman (AC: envanter dokümante edilmiş): docs/KVKK_ENVANTER.md, koddaki ${entries.length} envanter satırının HEPSİNİ tablo.sütun olarak listeler (drift koruması)`, entries.length >= 18 && undocumented.length === 0, `belgesiz=[${undocumented}]`);
const terms = ['30 gün', 'KVKK m.13', 'hash_signature', 'Ad çakışması', 'nameBasedDataWithheld', 'Yarı-tanımlayıcı', 'fail-closed', 'DRIVER_PII', 'PERSONNEL_PII', 'COLD_ARCHIVE', 'check-no-pii-logging', 'Sürücü-1', 'access-export', 'erase', 'reject', 'hukuk müşaviri', 'Kapsam uyarlaması', 'no-store'];
const missing = terms.filter((t) => !doc.includes(t));
check('Doküman: maskeleme rol tablosu, log/dış servis minimizasyonu, saklama-anonimleştirme, mali bütünlük, ad çakışması, başvuru akışı (30 gün), hukuki not ve kapsam uyarlaması yer alır', missing.length === 0, `eksik=[${missing}]`);
check('Doküman: ARCH-107 belgesi soğuk arşivlerin artık süresiz tutulmadığını söyler ve KVKK belgesine bağlanır', /süresiz tutulmaz/.test(read('docs/DATA_RETENTION.md')) && read('docs/DATA_RETENTION.md').includes('KVKK_ENVANTER.md'), '');

// ── 3. Kod bağlantıları ───────────────────────────────────────────────────────
const routes = read('backend/src/routes/routes.ts');
check('Maskeleme tek noktada: routes.ts eski yerel maskTcNoForRole yerine piiPolicy kullanır (GET /drivers → maskDriverForRole, GET /personnel → maskPersonnelForRole)',
  !/function maskTcNoForRole/.test(routes) && /maskDriverForRole\(d, req\.user!\.role\)/.test(routes) && (routes.match(/maskPersonnelForRole\(/g) ?? []).length >= 2, '');
const logger = read('backend/src/utils/logger.ts');
check('Log katmanı: logger.ts her çağrıyı scrubLogArgs ile temizler (hooks.logMethod); seçenekler testte aynen kurulabilir (buildLoggerOptions dışa açık)',
  /hooks:\s*\{[\s\S]*logMethod[\s\S]*scrubLogArgs/.test(logger) && /export function buildLoggerOptions/.test(logger), '');
const gem = read('backend/src/services/consumptionAnomalyService.ts');
check('Dış servis: Gemini prompt\'u pseudonymizeDriversForExternalService çıktısından kurulur (ham stats doğrudan buildAnomalyPrompt\'a verilmez)',
  /pseudonymizeDriversForExternalService\(stats\)/.test(gem) && /buildAnomalyPrompt\(safeStats, periodDays\)/.test(gem) && !/buildAnomalyPrompt\(stats, periodDays\)/.test(gem), '');
const ci = read('.github/workflows/ci-cd.yml');
check('CI: check-no-pii-logging, test-comp606 (statik) ve test_comp606_kvkk (davranış) pipeline\'da',
  /node scripts\/check-no-pii-logging\.mjs/.test(ci) && /node scripts\/test-comp606\.mjs/.test(ci) && /test\/test_comp606_kvkk\.ts/.test(ci), '');
const schema = read('backend/src/db/schema.sql');
check('Şema: deactivated_at/anonymized_at + tetikleyiciler (sürücü/personel), data_subject_requests (30 gün due_at, RLS, kişisel veri sütunu YOK)',
  /ADD COLUMN IF NOT EXISTS deactivated_at/.test(schema) && /drivers_deactivated_at_trg/.test(schema) && /personnel_deactivated_at_trg/.test(schema) && /CREATE TABLE IF NOT EXISTS data_subject_requests/.test(schema) &&
    /data_subject_requests_tenant_isolation_policy/.test(schema) && !/data_subject_requests[\s\S]{0,900}(tc_no|phone|full_name)/.test(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS data_subject_requests'), schema.indexOf('CREATE TABLE IF NOT EXISTS data_subject_requests') + 1300)), '');

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
