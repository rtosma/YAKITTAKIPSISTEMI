#!/usr/bin/env node
// ==============================================================================
// TEST_PLAN.md §3.4 / §5 — Prod frontend bundle sızıntı guard'ı.
//
// check-frontend-security.mjs KAYNAĞA bakar; bu script ise kullanıcının
// tarayıcısına GERÇEKTEN giden build çıktısına (frontend/dist). İkisi farklı
// şeyleri yakalar: kaynakta masum görünen bir sabit (mock verisi, import.meta.env
// ile gömülen bir VITE_ değişkeni, .env.production) ancak build sonrası
// bundle'da görünür hale gelir.
//
// NEDEN (ölçülmüş bulgu): src/mock/index.ts tüm demo firma/şantiye hesaplarının
// kullanıcı adlarını `password:"123456"` ile birlikte prod bundle'ına gömüyordu
// — seed'deki gerçek hesaplarla birebir aynı kimlik bilgileri, herkesin
// indirebildiği bir JS dosyasında. Giriş formları da bu parolayla dolu geliyordu.
//
// Kullanım: node scripts/check-frontend-bundle.mjs [dist-dizini]
//           (varsayılan: frontend/dist — önce `npm run build` gerekir)
// ==============================================================================

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.argv[2] || path.join(__dirname, '..', 'frontend', 'dist'));

const RULES = [
  {
    id: 'hardcoded-credential',
    pattern: /\b(password|passwd|parola|sifre|şifre)\s*:\s*["'`][^"'`\s]{3,}["'`]/i,
    reason: 'Bundle\'da nesne alanı olarak gömülü bir parola var — bundle herkese açıktır.'
  },
  {
    id: 'seed-demo-password',
    pattern: /["'`]123456["'`]/,
    reason: 'Seed hesaplarının parolası ("123456") bundle\'a girmiş (form varsayılanı / mock verisi).'
  },
  {
    id: 'jwt-token',
    pattern: /eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    reason: 'Gömülü bir JWT bulundu.'
  },
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    reason: 'Gömülü bir özel anahtar bulundu.'
  },
  {
    id: 'backend-secret-name',
    pattern: /\b(JWT_SECRET|JWT_REFRESH_SECRET|HW_SECRET_[A-Z0-9_]+|TENANT_EXPORT_ENCRYPTION_KEY|TRANSACTION_HASH_SECRET|POSTGRES_PASSWORD|MQTT_PASSWORD)\b/,
    reason: 'Backend sır değişkeni adı bundle\'da — bir .env değeri istemci koduna sızmış olabilir.'
  },
  {
    id: 'source-map-reference',
    pattern: /sourceMappingURL=/,
    reason: 'Prod bundle kaynak haritasına işaret ediyor — orijinal kaynak kod (yorumlar dahil) indirilebilir olur.'
  }
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`❌ ${DIST}/index.html yok — önce frontend build alın (npm run build).`);
  process.exit(2);
}

const violations = [];
const files = walk(DIST);
for (const file of files) {
  const rel = path.relative(DIST, file);
  if (/\.map$/.test(file) || /(^|\/)\.env/.test(rel)) {
    violations.push({ rel, id: 'forbidden-file', reason: 'Kaynak haritası ya da .env dosyası prod çıktısında.', excerpt: '' });
    continue;
  }
  if (!/\.(js|mjs|css|html|json|txt|webmanifest)$/.test(file)) continue;
  const content = readFileSync(file, 'utf8');
  for (const rule of RULES) {
    const m = content.match(rule.pattern);
    if (m) {
      const start = Math.max(0, m.index - 60);
      violations.push({ rel, id: rule.id, reason: rule.reason, excerpt: content.slice(start, m.index + m[0].length + 40) });
    }
  }
}

if (violations.length === 0) {
  console.log(`✅ Frontend bundle temiz — ${files.length} dosya, ${RULES.length + 1} kural.`);
  process.exit(0);
}
console.error(`❌ Frontend bundle'da ${violations.length} sızıntı:\n`);
for (const v of violations) {
  console.error(`  [${v.id}] ${v.rel}\n    ${v.reason}${v.excerpt ? `\n    …${v.excerpt.replace(/\s+/g, ' ')}…` : ''}\n`);
}
process.exit(1);
