#!/usr/bin/env node
// ==============================================================================
// TEST_PLAN.md §3.4 / §5 — Frontend güvenlik guard'ı.
//
// Bu projede frontend'de ESLint YOK (frontend `lint` script'i kasıtlı olarak
// yalnızca `tsc --noEmit`) — birkaç kural için tüm bir ESLint zincirini
// eklemek yerine, backend'deki check-no-raw-pool-query.mjs / -no-direct-
// process-env.mjs ile AYNI desende, bağımlılıksız bir denetim uyguluyoruz.
//
// NEDEN bu kurallar (her biri gerçek, ölçülmüş bir riske karşılık gelir):
//
//  1) XSS → token hırsızlığı: access/refresh token'lar localStorage'da
//     tutuluyor (AppContext.tsx). Bearer-token tabanlı bir SPA'da bu yaygın
//     bir tercih, ama tek gerçek savunması uygulamada HİÇBİR YERDE ham HTML
//     render edilmemesidir — React varsayılan olarak kaçışlar, bu kilit de
//     o varsayılanın delinmesini engeller. Tarama sırasında repoda SIFIR
//     `dangerouslySetInnerHTML` bulundu; bu script o durumu KORUR.
//
//  2) xlsx@0.18.5 bilinen HIGH zafiyetleri (GHSA-4r6h-8v6p-xvw6 prototype
//     pollution, GHSA-5pgg-2g8v-p4x9 ReDoS) YALNIZCA okuma/parse yolunda
//     (XLSX.read / XLSX.readFile) tetiklenir. Bu kod tabanı xlsx'i sadece
//     YAZMA için kullanıyor (json_to_sheet/writeFile) ve hiç dosya yükleme
//     ucu yok → zafiyet fiilen istismar edilemez. Bu kural o varsayımı
//     kalıcı kılar: biri parse yolu eklerse CI kırılır ve karar yeniden
//     ele alınır (bkz. scripts/check-dependency-audit.mjs allowlist notu).
//
//  3) eval / new Function / innerHTML / document.write: klasik kod-enjeksiyon
//     ve XSS sink'leri.
//
// Kullanım: node scripts/check-frontend-security.mjs
// ==============================================================================

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const FRONTEND_SRC = path.join(REPO_ROOT, 'frontend', 'src');
const FRONTEND_INDEX_HTML = path.join(REPO_ROOT, 'frontend', 'index.html');

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.html'];

/**
 * Her kural: neden yasak olduğu + ihlal halinde ne yapılması gerektiği.
 * Yeni bir kural eklerken `reason` alanını MUTLAKA doldurun — bu script'in
 * çıktısı, hatayı gören kişinin tek bilgi kaynağıdır.
 */
const RULES = [
  {
    id: 'no-dangerously-set-inner-html',
    pattern: /dangerouslySetInnerHTML/,
    reason:
      "React'in XSS kaçışını devre dışı bırakır. Token'lar localStorage'da " +
      'tutulduğu için bir XSS doğrudan oturum ele geçirmeye dönüşür.',
    fix:
      'Ham HTML yerine metin olarak render edin. Gerçekten gerekiyorsa ' +
      'DOMPurify gibi bir sanitizer ekleyip bu dosyayı ALLOWLIST\'e alın.'
  },
  {
    id: 'no-xlsx-parse',
    pattern: /XLSX\s*\.\s*(read|readFile)\s*\(/,
    reason:
      'xlsx@0.18.5 bilinen HIGH zafiyetleri (prototype pollution + ReDoS) ' +
      'YALNIZCA parse yolunda tetiklenir; proje şu an xlsx\'i sadece yazma ' +
      'için kullandığı için bu zafiyetler istismar edilemez kabul edildi.',
    fix:
      'Excel OKUMA gerçekten gerekiyorsa önce bağımlılık kararı yeniden ' +
      'verilmelidir (SheetJS npm sürümü terk edilmiş durumda). ' +
      'scripts/check-dependency-audit.mjs içindeki xlsx allowlist gerekçesi ' +
      'de bu kurala dayanıyor — ikisi birlikte güncellenmelidir.'
  },
  {
    id: 'no-eval',
    pattern: /(^|[^.\w])eval\s*\(|new\s+Function\s*\(/,
    reason: 'Kod enjeksiyonu sink\'i.',
    fix: 'Dinamik kod yürütme yerine açık bir eşleme/switch kullanın.'
  },
  {
    id: 'no-inner-html-assignment',
    pattern: /\.innerHTML\s*=|\.outerHTML\s*=|document\s*\.\s*write\s*\(/,
    reason: 'Doğrudan DOM\'a ham HTML yazar — React dışı XSS sink\'i.',
    fix: 'textContent kullanın veya React render\'ına taşıyın.'
  }
];

/** Dosya bazlı, kural bazlı istisnalar. Format: 'göreli/yol.tsx' -> Set(kuralId) */
const ALLOWLIST = new Map([
  // Örnek (şu an boş — repo temiz):
  // ['frontend/src/components/RichText.tsx', new Set(['no-dangerously-set-inner-html'])]
]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCANNED_EXTENSIONS.includes(path.extname(entry))) out.push(full);
  }
  return out;
}

const files = walk(FRONTEND_SRC);
if (existsSync(FRONTEND_INDEX_HTML)) files.push(FRONTEND_INDEX_HTML);

const violations = [];
for (const file of files) {
  const relative = path.relative(REPO_ROOT, file);
  const allowedRules = ALLOWLIST.get(relative);
  const lines = readFileSync(file, 'utf-8').split('\n');

  lines.forEach((line, idx) => {
    // Yorum satırlarını atla — bu script'in kendi açıklamaları ve kod
    // içindeki "bunu YAPMAYIN" notları ihlal sayılmamalı.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    for (const rule of RULES) {
      if (allowedRules?.has(rule.id)) continue;
      if (rule.pattern.test(line)) {
        violations.push({ file: relative, line: idx + 1, rule, text: trimmed });
      }
    }
  });
}

if (violations.length > 0) {
  console.error('[check-frontend-security] HATA: frontend\'de yasaklı güvenlik deseni bulundu:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule.id}]`);
    console.error(`    ${v.text}`);
    console.error(`    Neden: ${v.rule.reason}`);
    console.error(`    Çözüm: ${v.rule.fix}\n`);
  }
  console.error(
    'Bilinçli ve dokümante bir istisnaysa scripts/check-frontend-security.mjs ' +
    'içindeki ALLOWLIST\'e dosya+kural olarak ekleyip gerekçesini yorum satırında yazın.'
  );
  process.exit(1);
}

console.log(
  `[check-frontend-security] OK — ${files.length} dosyada ${RULES.length} kuralın hiçbiri ihlal edilmemiş ` +
  `(${RULES.map((r) => r.id).join(', ')}).`
);
