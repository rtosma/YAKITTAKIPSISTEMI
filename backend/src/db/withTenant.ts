import { PoolClient } from 'pg';
import { pool } from './postgresPool';
import { getTenantId } from '../context/tenantContext';
import { MissingTenantContextException } from '../utils/errors';

/**
 * ARCH-101.2 — Tenant'a özel her repository sorgusunun TEK giriş noktası.
 *
 * `pool` (bkz. postgresPool.ts) POSTGRES_USER'a (docker-compose'da varsayılan
 * `postgres`, yani bir SUPERUSER) bağlanır — ve Postgres'te superuser'lar RLS
 * politikalarını her zaman bypass eder (bkz. schema.sql'deki app_user rolü
 * yorumu). Bu yüzden RLS'in gerçekten devreye girmesi için HER sorgunun kendi
 * transaction'ı içinde oturumu `app_user` rolüne düşürüp
 * `app.current_tenant_id`'yi `SET LOCAL` ile (yalnızca bu transaction'a özel,
 * bağlantı pool'a geri dönünce bir sonraki kiracıya SIZMAZ) ayarlaması
 * gerekir — bu fonksiyon bunu garanti eder.
 *
 * Bu sarmalayıcının DIŞINDA doğrudan `pool.query` kullanmak (adminDb.ts'teki
 * bilinçli, route seviyesinde `authorizeRoles('SUPER_ADMIN')` ile kilitli
 * SUPER_ADMIN bypass'ı ve routes.ts'teki pre-auth login/refresh sorguları
 * hariç — o ikisi henüz bir tenant context'i olmadan çalışır) RLS'i sessizce
 * bypass eder ve yalnızca elle yazılmış WHERE tenant_id=$1 şartına güvenir;
 * bu tam olarak ARCH-101 epic'inin önlemeye çalıştığı sızıntı sınıfıdır. CI,
 * scripts/check-no-raw-pool-query.mjs ile bu kuralı denetler.
 */
export async function withTenant<T>(
  fn: (client: PoolClient, tenantId: string) => Promise<T>
): Promise<T> {
  const tenantId = getTenantId();
  if (!tenantId) {
    throw new MissingTenantContextException();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const result = await fn(client, tenantId);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
