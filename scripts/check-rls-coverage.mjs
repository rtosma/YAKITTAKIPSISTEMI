#!/usr/bin/env node
// ==============================================================================
// ARCH-101.3 AC — "Tenant sütunu olan her tabloda RLS etkin olmalıdır ve bu
// CI tarafından doğrulanmalıdır." Bu script backend/src/db/schema.sql'i
// tarayıp bir `tenant_id` kolonu olan her tabloyu bulur ve o tablo için hem
// `ENABLE ROW LEVEL SECURITY` hem de `FORCE ROW LEVEL SECURITY` satırlarının
// var olduğunu doğrular (FORCE olmadan tablo sahibi/superuser rolü — burada
// backend'in bağlandığı POSTGRES_USER — politikaları sessizce atlar, bkz.
// withTenant.ts). Yeni bir tenant tablosu RLS'siz eklenirse CI bu adımda
// kırmızı yanar.
//
// Kullanım: node scripts/check-rls-coverage.mjs
// ==============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'backend', 'src', 'db', 'schema.sql');

// Tablonun kendisi tenant kaydı (companies) veya tenant izolasyonu gerektirmeyen
// global/sistem tabloları için bilinçli muafiyet listesi.
const EXEMPT_TABLES = new Set(['companies']);

const sql = readFileSync(SCHEMA_PATH, 'utf-8');

// `CREATE TABLE IF NOT EXISTS <name> ( ... );` bloklarını isim + gövde olarak çıkar.
const tableBlockRegex = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g;

const tenantTables = [];
let match;
while ((match = tableBlockRegex.exec(sql)) !== null) {
  const [, tableName, body] = match;
  if (EXEMPT_TABLES.has(tableName)) continue;
  if (/\btenant_id\b/.test(body)) {
    tenantTables.push(tableName);
  }
}

if (tenantTables.length === 0) {
  console.error('[check-rls-coverage] HATA: schema.sql içinde tenant_id kolonlu hiçbir tablo bulunamadı — regex bozulmuş olabilir.');
  process.exit(1);
}

const missing = [];
for (const table of tenantTables) {
  const hasEnable = new RegExp(`ALTER TABLE\\s+${table}\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(sql);
  const hasForce = new RegExp(`ALTER TABLE\\s+${table}\\s+FORCE ROW LEVEL SECURITY`, 'i').test(sql);
  const hasPolicy = new RegExp(`CREATE POLICY\\s+\\w+\\s+ON\\s+${table}\\b`, 'i').test(sql);

  if (!hasEnable || !hasForce || !hasPolicy) {
    missing.push({ table, hasEnable, hasForce, hasPolicy });
  }
}

if (missing.length > 0) {
  console.error('[check-rls-coverage] HATA: aşağıdaki tenant_id kolonlu tablolarda RLS eksik:\n');
  for (const m of missing) {
    console.error(
      `  - ${m.table}: ENABLE=${m.hasEnable ? 'OK' : 'EKSİK'} FORCE=${m.hasForce ? 'OK' : 'EKSİK'} POLICY=${m.hasPolicy ? 'OK' : 'EKSİK'}`
    );
  }
  console.error(
    '\nYeni bir tenant tablosu eklediyseniz schema.sql\'e şunları eklemeniz gerekir:\n' +
    '  ALTER TABLE <tablo> ENABLE ROW LEVEL SECURITY;\n' +
    '  ALTER TABLE <tablo> FORCE ROW LEVEL SECURITY;\n' +
    '  CREATE POLICY <tablo>_tenant_isolation_policy ON <tablo>\n' +
    "    FOR ALL USING (tenant_id = current_setting('app.current_tenant_id', true))\n" +
    "    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));\n" +
    '\nGerçekten tenant izolasyonu gerektirmeyen global bir tabloysa EXEMPT_TABLES\'a ekleyip nedenini yorum satırında açıklayın (scripts/check-rls-coverage.mjs).'
  );
  process.exit(1);
}

console.log(`[check-rls-coverage] OK — ${tenantTables.length} tenant tablosunun hepsinde RLS (ENABLE + FORCE + POLICY) mevcut: ${tenantTables.join(', ')}`);
