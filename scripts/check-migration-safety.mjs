#!/usr/bin/env node
// ==============================================================================
// OPS-1104 AC — "Migration'lar dağıtımın parçası olarak güvenli uygulanmalıdır."
//
// backend/src/db/schema.sql'in TABAN sürümüne (varsayılan: origin/main) göre YENİ
// eklenen ifadelerini expand/contract kuralları için tarar (ayrıntı ve onay işareti:
// scripts/lib/migrationSafety.mjs). Onaysız geriye uyumsuz ifade → exit 1.
//
// Kullanım:
//   node scripts/check-migration-safety.mjs                    # taban: origin/main (yoksa main, yoksa HEAD~1)
//   node scripts/check-migration-safety.mjs --base <git-ref>
//   node scripts/check-migration-safety.mjs --old a.sql --new b.sql   # dosya modu (testler için)
//
// Taban sürüm bulunamazsa (ilk commit / sığ klon) UYARIYLA çıkar (exit 0) — CI'da
// fetch-depth: 0 kullanın; sessizce geçmesi güvenliği düşürür, bu yüzden açıkça loglanır.
// ==============================================================================

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyzeMigration, APPROVAL_MARKER, MIN_REASON_LENGTH } from './lib/migrationSafety.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_REL = 'backend/src/db/schema.sql';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function gitShow(ref) {
  try {
    return execFileSync('git', ['show', `${ref}:${SCHEMA_REL}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

let oldSql;
let newSql;
let baseLabel;
if (arg('--old') && arg('--new')) {
  oldSql = readFileSync(arg('--old'), 'utf8');
  newSql = readFileSync(arg('--new'), 'utf8');
  baseLabel = arg('--old');
} else {
  newSql = readFileSync(path.join(ROOT, SCHEMA_REL), 'utf8');
  const candidates = arg('--base') ? [arg('--base')] : ['origin/main', 'main', 'HEAD~1'];
  baseLabel = candidates.find((c) => gitShow(c) !== null);
  oldSql = baseLabel ? gitShow(baseLabel) : null;
  if (oldSql === null) {
    console.warn(`[check-migration-safety] UYARI: taban şema sürümü bulunamadı (${candidates.join(', ')}) — kontrol ATLANDI. CI'da actions/checkout fetch-depth: 0 kullanın.`);
    process.exit(0);
  }
}

const { violations, approved, added } = analyzeMigration(oldSql, newSql);
console.log(`[check-migration-safety] taban: ${baseLabel} — ${added} yeni/değişen SQL ifadesi tarandı.`);

for (const a of approved) {
  console.log(`  ✔ ONAYLI contract adımı: ${a.sql}\n      gerekçe: ${a.reason}`);
}
if (violations.length > 0) {
  console.error(`\n[check-migration-safety] HATA: ${violations.length} geriye uyumsuz (contract) ifade onaysız:\n`);
  for (const v of violations) {
    console.error(`  ✖ ${v.sql}`);
    for (const i of v.issues) console.error(`      [${i.rule}] ${i.why}`);
  }
  console.error(
    `\nBu adımlar sıfır kesintili dağıtımda eski replikayı kırar. Önerilen yol: expand (yeni yapıyı ekle) → kodu geçir → AYRI bir dağıtımda contract.\n` +
    `Bilinçli bir contract adımıysa ifadenin hemen üstüne şunu ekleyin (gerekçe en az ${MIN_REASON_LENGTH} karakter):\n` +
    `  -- ${APPROVAL_MARKER} <gerekçe / ilgili issue>`
  );
  process.exit(1);
}
console.log('[check-migration-safety] OK — yeni ifadelerin hepsi geriye uyumlu (expand) veya onaylı contract.');
