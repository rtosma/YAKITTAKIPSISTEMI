/**
 * TEST-1002 — k6 özeti + event-loop-lag örneklerinden birleşik AC hükmü.
 *
 * Kullanım:
 *   node scripts/load-test/verdict.mjs <k6-summary.json> <eventloop-lag.jsonl> <k6StartMs> <k6EndMs>
 *
 * AC: HTTP P95 < 200ms  VE  event loop p99 lag < 50ms (k6 koşusu penceresinde).
 * Çıkış kodu: 0 = PASS, 1 = FAIL.
 */
import { readFileSync } from 'node:fs';

const [summaryPath, lagPath, startArg, endArg] = process.argv.slice(2);
const startMs = Number(startArg) || 0;
const endMs = Number(endArg) || Number.MAX_SAFE_INTEGER;

function num(v) {
  return v == null || Number.isNaN(Number(v)) ? null : Number(v);
}
function fmt(v) {
  return v == null ? '—' : Number(v).toFixed(2);
}

// --- k6 özeti ---
let p95 = null;
let failRate = null;
let checksRate = null;
let httpReqs = null;
try {
  const s = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const m = s.metrics || {};
  const dur = m.http_req_duration || {};
  p95 = num(dur['p(95)'] ?? dur.values?.['p(95)']);
  const failed = m.http_req_failed || {};
  failRate = num(failed.rate ?? failed.values?.rate);
  const checks = m.checks || {};
  checksRate = num(checks.rate ?? checks.values?.rate);
  const reqs = m.http_reqs || {};
  httpReqs = num(reqs.count ?? reqs.values?.count);
} catch (e) {
  console.error(`  (k6 özeti okunamadı: ${e.message})`);
}

// --- event loop lag (yalnızca k6 penceresi) ---
let lagP99 = null;
let lagSamples = 0;
try {
  const lines = readFileSync(lagPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((x) => {
      const t = Date.parse(x.t);
      return t >= startMs && t <= endMs;
    });
  lagSamples = lines.length;
  if (lines.length) lagP99 = Math.max(...lines.map((x) => Number(x.p99_ms)));
} catch (e) {
  console.error(`  (lag örnekleri okunamadı: ${e.message})`);
}

const passP95 = p95 != null && p95 < 200;
const passLag = lagP99 != null && lagP99 < 50;
const passErr = failRate == null || failRate < 0.01;

console.log(`  Toplam HTTP isteği     : ${httpReqs ?? '—'}`);
console.log(`  HTTP P95 yanıt süresi  : ${fmt(p95)} ms      (AC < 200)   ${passP95 ? '✅' : '❌'}`);
console.log(`  HTTP hata oranı        : ${fmt(failRate == null ? null : failRate * 100)} %       (< 1)        ${passErr ? '✅' : '❌'}`);
console.log(`  check başarı oranı     : ${fmt(checksRate == null ? null : checksRate * 100)} %`);
console.log(`  Event loop p99 lag     : ${fmt(lagP99)} ms      (AC < 50)    ${passLag ? '✅' : '❌'}   [${lagSamples} örnek]`);
console.log('────────────────────────────────────────────────────────');

const pass = passP95 && passLag && passErr;
console.log(`  TEST-1002 : ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(pass ? 0 : 1);
