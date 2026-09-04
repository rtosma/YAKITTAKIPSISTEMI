#!/usr/bin/env node
// ==============================================================================
// ARCH-101.2 AC — "Sarmalayıcı dışında ham pool.query kullanımını yasaklayan
// bir kontrol." Repoda proje genelinde bir ESLint kurulumu yok (backend'in
// `lint` script'i kasıtlı olarak yalnızca `tsc --noEmit`) — bir tek kural
// için tüm bir ESLint zincirini projeye eklemek yerine aynı denetimi burada,
// mevcut araç setiyle tutarlı şekilde uyguluyoruz.
//
// `pool.query(...)` (withTenant.ts'in DIŞINDA) her zaman backend'in bağlandığı
// POSTGRES_USER (varsayılan: superuser `postgres`) ile çalışır ve RLS'i
// tamamen bypass eder — bkz. withTenant.ts. Bu yüzden `backend/src` içinde
// `pool.query(` kullanımı yalnızca bilinçli, dokümante edilmiş, denetimli
// istisnalarda serbesttir:
//   - db/withTenant.ts   : sarmalayıcının kendisi (pool.connect kullanır, ama
//                          burada yine de allowlist'te tutuyoruz)
//   - db/adminDb.ts       : SUPER_ADMIN'e özel, kasıtlı çapraz-tenant sorgular
//                          (routes.ts'te authorizeRoles('SUPER_ADMIN') ile kilitli)
//   - routes/routes.ts    : yalnızca pre-auth login/refresh — henüz bir tenant
//                          context'i yokken kullanıcıyı bulmak için
//
// Kullanım: node scripts/check-no-raw-pool-query.mjs
// ==============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(__dirname, '..', 'backend', 'src');

const ALLOWLIST = new Set([
  path.join(SRC_ROOT, 'db', 'withTenant.ts'),
  path.join(SRC_ROOT, 'db', 'adminDb.ts'),
  path.join(SRC_ROOT, 'routes', 'routes.ts')
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
    if (/\bpool\.query\s*\(/.test(line)) {
      violations.push({ file: path.relative(path.join(__dirname, '..'), file), line: idx + 1, text: line.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error('[check-no-raw-pool-query] HATA: allowlist dışında ham pool.query() kullanımı bulundu (RLS bypass edilir):\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
  }
  console.error(
    '\nTenant\'a özel bir sorguysa backend/src/db/withTenant.ts üzerinden geçirin ' +
    "(bkz. tenantDb.ts örnekleri). Kasıtlı bir SUPER_ADMIN/pre-auth istisnasıysa " +
    'scripts/check-no-raw-pool-query.mjs içindeki ALLOWLIST\'e ekleyip nedenini yorum satırında açıklayın.'
  );
  process.exit(1);
}

console.log('[check-no-raw-pool-query] OK — allowlist dışında ham pool.query() kullanımı yok.');
