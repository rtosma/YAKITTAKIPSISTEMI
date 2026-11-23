import { withTenant } from '../db/withTenant';
import { generateId } from '../utils/id';
import { writeAuditLog } from '../utils/auditLog';
import { NotFoundError } from '../utils/errors';
import { SetFuelBudgetDTO } from '../schemas/fuelBudgetSchema';

/**
 * REP-719 — şantiye × ay yakıt bütçesi CRUD'u. Bütçe yalnızca RAPORLAMA
 * içindir (ikmali engellemez); aşım rep-719'da vurgulanır. tenantArchiveService/
 * reportScheduleService ile AYNI desen: withTenant doğrudan, tenantDb.ts'e dokunulmaz.
 */

export interface FuelBudgetRecord {
  id: string;
  site_name: string;
  month: string;
  amount_try: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** (site, ay) için bütçeyi yaratır ya da GÜNCELLER (PUT semantiği). */
export async function setFuelBudget(input: SetFuelBudgetDTO, byUserId: string): Promise<FuelBudgetRecord> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query(
      `INSERT INTO fuel_budgets (id, tenant_id, site_name, month, amount_try, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, site_name, month) DO UPDATE SET amount_try = EXCLUDED.amount_try, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [generateId('fbud'), tenantId, input.siteName, input.month, input.amountTry, byUserId]
    );
    await writeAuditLog(client, {
      action: 'FUEL_BUDGET_SET',
      targetType: 'fuel_budget',
      targetId: res.rows[0].id,
      afterValue: { siteName: input.siteName, month: input.month, amountTry: input.amountTry, by: byUserId }
    });
    return res.rows[0];
  });
}

export async function listFuelBudgets(filters: { month?: string; siteName?: string }): Promise<FuelBudgetRecord[]> {
  return withTenant(async (client) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.month) { params.push(filters.month); where.push(`month = $${params.length}`); }
    if (filters.siteName) { params.push(filters.siteName); where.push(`site_name = $${params.length}`); }
    const res = await client.query(`SELECT * FROM fuel_budgets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY month DESC, site_name`, params);
    return res.rows;
  });
}

export async function deleteFuelBudget(id: string, byUserId: string): Promise<void> {
  return withTenant(async (client) => {
    const res = await client.query('DELETE FROM fuel_budgets WHERE id = $1 RETURNING site_name, month', [id]);
    if (res.rows.length === 0) throw new NotFoundError('Bütçe bulunamadı.');
    await writeAuditLog(client, { action: 'FUEL_BUDGET_DELETED', targetType: 'fuel_budget', targetId: id, beforeValue: { siteName: res.rows[0].site_name, month: res.rows[0].month }, afterValue: { by: byUserId } });
  });
}
