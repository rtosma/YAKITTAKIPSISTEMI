/**
 * TEST-1002 — Yük testi cihazlarını temizler.
 *
 * `hardware_devices` için silme uç noktası yok (yalnızca block/unblock), bu
 * yüzden doğrudan SQL kullanılır (postgres superuser, docker exec ile). Yalnızca
 * `LOADTEST-` önekli cihazlar + onların claim kodları silinir. `audit_logs`'a
 * DOKUNULMAZ (append-only tasarım — bkz. schema.sql).
 *
 * Çalıştırma (repo kökünden):
 *   node scripts/load-test/cleanup-devices.mjs
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PG_CONTAINER = process.env.LOADTEST_PG_CONTAINER || 'yakittakip_postgres';
const PG_USER = process.env.POSTGRES_USER || 'postgres';
const PG_DB = process.env.POSTGRES_DB || 'yakittakip_db';

const SQL = `
BEGIN;
  DELETE FROM device_claim_codes
   WHERE device_name LIKE 'loadtest-%'
      OR redeemed_device_id LIKE 'LOADTEST-%';
  DELETE FROM hardware_devices WHERE device_id LIKE 'LOADTEST-%';
COMMIT;
SELECT
  (SELECT COUNT(*) FROM hardware_devices  WHERE device_id LIKE 'LOADTEST-%')     AS remaining_devices,
  (SELECT COUNT(*) FROM device_claim_codes WHERE device_name LIKE 'loadtest-%')  AS remaining_codes;
`;

try {
  const out = execFileSync(
    'docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-v', 'ON_ERROR_STOP=1'],
    { input: SQL, encoding: 'utf8' }
  );
  console.log(out.trim());
  try {
    rmSync(resolve(__dirname, '.devices.json'));
    console.log('[cleanup] .devices.json silindi.');
  } catch {
    /* zaten yok */
  }
  console.log('[cleanup] Tamamlandı. (audit_logs kasıtlı olarak korundu.)');
} catch (err) {
  console.error('[cleanup] HATA:', err.message);
  process.exit(1);
}
