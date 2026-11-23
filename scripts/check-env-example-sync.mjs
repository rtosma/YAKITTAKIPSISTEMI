#!/usr/bin/env node
// ==============================================================================
// ARCH-110 AC — ".env.example şemadaki tüm değişkenleri açıklamalarıyla
// içermelidir." Bu script backend/src/config/env.ts'teki Zod şemasından
// (envSchema) alan adlarını regex ile çıkarır ve her birinin
// backend/.env.example'da bir `KEY=...` satırı olarak var olduğunu doğrular.
// Şemaya yeni bir zorunlu/opsiyonel değişken eklenip .env.example
// güncellenmezse CI bu adımda kırmızı yanar.
//
// Kullanım: node scripts/check-env-example-sync.mjs
// ==============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_TS_PATH = path.join(__dirname, '..', 'backend', 'src', 'config', 'env.ts');
const ENV_EXAMPLE_PATH = path.join(__dirname, '..', 'backend', '.env.example');

const envTs = readFileSync(ENV_TS_PATH, 'utf-8');
const envExample = readFileSync(ENV_EXAMPLE_PATH, 'utf-8');

// `const envSchema = z.object({ ... });` bloğunun içeriğini al.
const schemaMatch = envTs.match(/const envSchema = z\.object\(\{([\s\S]*?)\n\}\);/);
if (!schemaMatch) {
  console.error('[check-env-example-sync] HATA: backend/src/config/env.ts içinde envSchema bulunamadı — regex bozulmuş olabilir.');
  process.exit(1);
}

// Satır başında `  KEY: z...` şeklindeki alan adlarını çıkar.
const fieldRegex = /^\s{2}([A-Z][A-Z0-9_]*):\s*z\./gm;
const schemaKeys = [...schemaMatch[1].matchAll(fieldRegex)].map((m) => m[1]);

if (schemaKeys.length === 0) {
  console.error('[check-env-example-sync] HATA: envSchema içinde hiç alan bulunamadı — regex bozulmuş olabilir.');
  process.exit(1);
}

const missing = schemaKeys.filter((key) => !new RegExp(`^${key}=`, 'm').test(envExample));

if (missing.length > 0) {
  console.error(`[check-env-example-sync] HATA: backend/.env.example şu değişkenleri içermiyor: ${missing.join(', ')}`);
  console.error('backend/src/config/env.ts (envSchema) ile backend/.env.example birbirinden ayrıştı — .env.example\'a eksik satırları ekleyin.');
  process.exit(1);
}

console.log(`[check-env-example-sync] OK — envSchema'daki ${schemaKeys.length} değişkenin hepsi backend/.env.example'da mevcut: ${schemaKeys.join(', ')}`);
