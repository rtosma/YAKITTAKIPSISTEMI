#!/usr/bin/env node
// ==============================================================================
// ARCH-110 AC — "Config'e yalnızca tipli servis üzerinden erişilmeli;
// kod tabanında process.env doğrudan kullanımı ESLint kuralıyla
// yasaklanmalıdır." Repoda proje genelinde bir ESLint kurulumu yok (backend'in
// `lint` script'i kasıtlı olarak yalnızca `tsc --noEmit`, bkz.
// scripts/check-no-raw-pool-query.mjs'teki aynı gerekçe) — bir tek kural için
// tüm bir ESLint zincirini projeye eklemek yerine aynı denetimi burada,
// mevcut araç setiyle tutarlı şekilde uyguluyoruz.
//
// backend/src içinde `process.env` kullanımı yalnızca
// backend/src/config/env.ts'te (doğrulamanın kendisi) serbesttir. Başka
// herhangi bir dosyada `process.env` görülürse CI kırmızı yanar — o
// değişkeni envSchema'ya ekleyip config.X üzerinden okuyun.
//
// Kullanım: node scripts/check-no-direct-process-env.mjs
// ==============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(__dirname, '..', 'backend', 'src');

const ALLOWLIST = new Set([
  path.join(SRC_ROOT, 'config', 'env.ts'),
  // bootstrap.ts'in tek "process.env" bahsi kendi üst-blok yorumunun içinde
  // (dotenv/config'in neden ilk sırada olması gerektiğini açıklıyor) — gerçek
  // kodu yalnızca `import 'dotenv/config'; import './index';`.
  path.join(SRC_ROOT, 'bootstrap.ts')
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(SRC_ROOT)) {
  if (ALLOWLIST.has(file)) continue;
  const content = readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    // Yorum satırlarındaki (örn. bootstrap.ts'in kendi geçmiş açıklaması)
    // bahisleri değil, gerçek kod kullanımını yakala.
    const codePart = line.split('//')[0];
    if (/\bprocess\.env\b/.test(codePart)) {
      violations.push({ file: path.relative(path.join(__dirname, '..'), file), line: idx + 1, text: line.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error('[check-no-direct-process-env] HATA: config/env.ts dışında doğrudan process.env kullanımı bulundu:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error(
    "\nBu değişkeni backend/src/config/env.ts içindeki envSchema'ya ekleyip " +
    "config.<DEĞİŞKEN_ADI> üzerinden okuyun (bkz. postgresPool.ts/redisPool.ts/mqttClient.ts örnekleri)."
  );
  process.exit(1);
}

console.log('[check-no-direct-process-env] OK — config/env.ts dışında doğrudan process.env kullanımı yok.');
