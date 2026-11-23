#!/usr/bin/env node
// ==============================================================================
// COMP-606 (#132) — "Loglara TC kimlik no ve telefon yazılmamalıdır; bu, en sık yapılan KVKK ihlalidir."
// Bu script backend/src altındaki her `logger.<seviye>(...)` çağrısını tarar; çağrının içinde kişisel veri
// anahtarı/değişkeni (tcNo, tc_no, tckn, phone, telefon, gsm, password, email) geçiyorsa CI'ı kırar.
// (Çalışma zamanında ayrıca logger.ts `hooks.logMethod` → privacy/piiScrub.ts her satırı temizler; bu tarama
// niyeti erken yakalar, o katman ise unutulanı.) Bilinçli istisna: aynı satıra `// pii-log:allow <gerekçe>`.
//
// Kullanım: node scripts/check-no-pii-logging.mjs
// ==============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'backend', 'src');
// Yorum/Türkçe düz metin yanlış pozitifini azaltmak için \b sınırları; "e-posta" eşleşmez.
const PII_IDENT = /\b(tc_?no|tckn|tc_?kimlik\w*|phone|phoneNumber|telefon\w*|gsm|password|passwd|e?mail(?:Address)?)\b/i;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (e.endsWith('.ts')) out.push(f);
  }
  return out;
}

/** `logger.x(` çağrısının kapanış parantezine kadar olan metni (naif parantez sayımı; metin/şablon içindeki parantezler dengeli varsayılır). */
export function extractLoggerCalls(text) {
  const calls = [];
  const re = /\blogger\.(?:trace|debug|info|warn|error|fatal)\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    const startLine = text.slice(0, m.index).split('\n').length;
    const eol = text.indexOf('\n', i);
    // `// pii-log:allow` çağrının KAPANIŞ satırının sonunda da olabilir.
    calls.push({ line: startLine, code: text.slice(m.index, i), allowed: /pii-log:allow/.test(text.slice(m.index, eol === -1 ? text.length : eol)) });
  }
  return calls;
}

export function findViolations(text) {
  const violations = [];
  for (const c of extractLoggerCalls(text)) {
    if (c.allowed) continue;
    const hit = PII_IDENT.exec(c.code);
    if (hit) violations.push({ line: c.line, ident: hit[1], code: c.code.replace(/\s+/g, ' ').slice(0, 140) });
  }
  return violations;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = [];
  for (const file of walk(SRC)) {
    for (const v of findViolations(readFileSync(file, 'utf8'))) all.push({ file: path.relative(ROOT, file), ...v });
  }
  if (all.length > 0) {
    console.error('[check-no-pii-logging] HATA: logger çağrısında kişisel veri anahtarı bulundu (KVKK):\n');
    for (const v of all) console.error(`  ${v.file}:${v.line}  [${v.ident}]  ${v.code}`);
    console.error('\nKişisel veriyi loglamayın (yalnızca kayıt id\'si). Bilinçli istisna: aynı satıra `// pii-log:allow <gerekçe>`.');
    process.exit(1);
  }
  console.log('[check-no-pii-logging] OK — logger çağrılarında kişisel veri anahtarı yok.');
}
