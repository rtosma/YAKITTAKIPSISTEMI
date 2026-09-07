import { pool } from './postgresPool';

/**
 * Raw `users` row needed to rebuild a JWT identity.
 * snake_case on purpose: mirrors the row shapes used across tenantDb.ts.
 * This module deliberately does NOT import JwtUserPayload from the service
 * layer - the dependency only goes services -> db, never the other way around.
 */
export interface AuthUserRecord {
  id: string;
  tenant_id: string;
  username: string;
  role: string;
  site_name: string | null;
}

/**
 * Load a single user by id, constrained to a tenant.
 *
 * Unlike the helpers in tenantDb.ts, tenantId is an explicit parameter: this
 * runs on an unauthenticated route (POST /auth/refresh) where the
 * AsyncLocalStorage tenant context does not exist yet, so getTenantId() would
 * throw TENANT_CONTEXT_MISSING.
 *
 * CONTRACT: the caller MUST pass a server-derived tenantId (the one stored in
 * the refresh token record at login time) - NEVER a client supplied value.
 *
 * Defence in depth: the RLS session context (app_user + app.current_tenant_id)
 * is applied on top of the explicit WHERE predicate, so a userId/tenantId
 * mismatch fails closed twice. `pool` connects as the `postgres` superuser,
 * which bypasses RLS, so `SET LOCAL ROLE app_user` is what actually enforces
 * it - do not remove either guard.
 */
export async function findAuthUserById(
  userId: string,
  tenantId: string
): Promise<AuthUserRecord | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user;');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

    const result = await client.query(
      'SELECT id, tenant_id, username, role, site_name FROM users WHERE id = $1 AND tenant_id = $2',
      [userId, tenantId]
    );

    await client.query('COMMIT');
    return result.rows.length > 0 ? (result.rows[0] as AuthUserRecord) : null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
