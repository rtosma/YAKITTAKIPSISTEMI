import { withTenant } from '../db/withTenant';
import { writeAuditLog } from '../utils/auditLog';
import { generateId } from '../utils/id';
import { NotFoundError, BadRequestError, ConflictError, ForbiddenError } from '../utils/errors';

/**
 * HR-1801 — Personel İzin Takip Modülü.
 *
 * `db/withTenant.ts`'i DOĞRUDAN import ediyor — tenantDb.ts'e (bu oturumda
 * en çok eşzamanlı değişen dosya) hiç dokunmadan RLS'li sorgu yazabilmek için.
 *
 * Onay akışı İKİ AŞAMALI (AC: "şantiye müdürü → firma yöneticisi"):
 *   TALEP_EDILDI → (SITE_MANAGER) → SAHA_ONAYLANDI → (COMPANY_OWNER) → ONAYLANDI
 * COMPANY_OWNER üst rol olduğundan TALEP_EDILDI'den de doğrudan ONAYLANDI'ya
 * geçebilir (saha onayını atlayarak). Her iki aşamada da REDDEDILDI mümkün;
 * talep sahibi karar verilmeden İPTAL_EDILDI yapabilir.
 *
 * NOTIF-1601 (bildirim servisi) bu kod tabanında yok — onay ihtiyacı,
 * getPendingLeaveApprovals()'ın rol bazlı "bekleyenler" listesiyle +
 * mevcut append-only audit_logs ile karşılanıyor (ayrı bir bildirim
 * mekanizması KURULMADI).
 */

export type LeaveRequestStatus = 'TALEP_EDILDI' | 'SAHA_ONAYLANDI' | 'ONAYLANDI' | 'REDDEDILDI' | 'IPTAL_EDILDI';
const ACTIVE_STATUSES: LeaveRequestStatus[] = ['TALEP_EDILDI', 'SAHA_ONAYLANDI', 'ONAYLANDI'];

export interface PersonnelRecord {
  id: string;
  fullName: string;
  tcNo: string | null;
  roleTitle: string;
  siteName: string | null;
  driverId: string | null;
  annualLeaveEntitlementDays: number;
  hireDate: string | null;
  status: string;
  createdAt: string;
}

export interface LeaveRequestRecord {
  id: string;
  personnelId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  dayCount: number;
  reason: string | null;
  status: LeaveRequestStatus;
  requestedBy: string;
  siteApprovedBy: string | null;
  siteApprovedAt: string | null;
  companyApprovedBy: string | null;
  companyApprovedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  vehicleAssignmentConflict: { hasConflict: boolean; conflictingVehiclePlates: string[] };
}

function mapPersonnelRow(row: any): PersonnelRecord {
  return {
    id: row.id,
    fullName: row.full_name,
    tcNo: row.tc_no,
    roleTitle: row.role_title,
    siteName: row.site_name,
    driverId: row.driver_id,
    annualLeaveEntitlementDays: Number(row.annual_leave_entitlement_days),
    hireDate: row.hire_date instanceof Date ? row.hire_date.toISOString().slice(0, 10) : row.hire_date,
    status: row.status,
    createdAt: row.created_at
  };
}

function dateOnly(d: any): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

async function mapLeaveRow(client: any, tenantId: string, row: any): Promise<LeaveRequestRecord> {
  let conflict = { hasConflict: false, conflictingVehiclePlates: [] as string[] };
  const pRes = await client.query('SELECT driver_id FROM personnel WHERE tenant_id = $1 AND id = $2', [tenantId, row.personnel_id]);
  const driverId = pRes.rows[0]?.driver_id;
  if (driverId && (row.status === 'ONAYLANDI' || row.status === 'SAHA_ONAYLANDI' || row.status === 'TALEP_EDILDI')) {
    const dRes = await client.query('SELECT name FROM drivers WHERE tenant_id = $1 AND id = $2', [tenantId, driverId]);
    const driverName = dRes.rows[0]?.name;
    if (driverName) {
      const vRes = await client.query('SELECT plate FROM vehicles WHERE tenant_id = $1 AND assigned_driver_name = $2', [tenantId, driverName]);
      if (vRes.rows.length > 0) {
        conflict = { hasConflict: true, conflictingVehiclePlates: vRes.rows.map((r: any) => r.plate) };
      }
    }
  }

  return {
    id: row.id,
    personnelId: row.personnel_id,
    leaveType: row.leave_type,
    startDate: dateOnly(row.start_date),
    endDate: dateOnly(row.end_date),
    dayCount: Number(row.day_count),
    reason: row.reason,
    status: row.status,
    requestedBy: row.requested_by,
    siteApprovedBy: row.site_approved_by,
    siteApprovedAt: row.site_approved_at,
    companyApprovedBy: row.company_approved_by,
    companyApprovedAt: row.company_approved_at,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    vehicleAssignmentConflict: conflict
  };
}

export async function createPersonnel(
  data: {
    fullName: string;
    tcNo?: string;
    roleTitle?: string;
    siteName?: string;
    driverId?: string;
    annualLeaveEntitlementDays?: number;
    hireDate?: string;
  },
  byUserId: string
): Promise<PersonnelRecord> {
  return withTenant(async (client, tenantId) => {
    if (data.driverId) {
      const dRes = await client.query('SELECT id FROM drivers WHERE tenant_id = $1 AND id = $2', [tenantId, data.driverId]);
      if (dRes.rows.length === 0) throw new NotFoundError('Belirtilen şoför bulunamadı.', { error: 'DRIVER_NOT_FOUND' });
    }
    const id = generateId('pers');
    const inserted = await client.query(
      `INSERT INTO personnel (id, tenant_id, full_name, tc_no, role_title, site_name, driver_id, annual_leave_entitlement_days, hire_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        id, tenantId, data.fullName, data.tcNo ?? null, data.roleTitle ?? 'DİĞER', data.siteName ?? null,
        data.driverId ?? null, data.annualLeaveEntitlementDays ?? 14, data.hireDate ?? null
      ]
    );
    await writeAuditLog(client, { action: 'PERSONNEL_CREATED', targetType: 'personnel', targetId: id, afterValue: { fullName: data.fullName, roleTitle: data.roleTitle } });
    return mapPersonnelRow(inserted.rows[0]);
  });
}

export async function getPersonnelList(): Promise<PersonnelRecord[]> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query('SELECT * FROM personnel WHERE tenant_id = $1 ORDER BY full_name ASC', [tenantId]);
    return res.rows.map(mapPersonnelRow);
  });
}

export async function getPersonnel(id: string): Promise<PersonnelRecord> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query('SELECT * FROM personnel WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    if (res.rows.length === 0) throw new NotFoundError('Personel bulunamadı.');
    return mapPersonnelRow(res.rows[0]);
  });
}

function computeDayCount(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  return Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

export async function createLeaveRequest(
  personnelId: string,
  data: { leaveType: string; startDate: string; endDate: string; reason?: string },
  byUserId: string
): Promise<LeaveRequestRecord> {
  return withTenant(async (client, tenantId) => {
    const pRes = await client.query('SELECT id FROM personnel WHERE tenant_id = $1 AND id = $2', [tenantId, personnelId]);
    if (pRes.rows.length === 0) throw new NotFoundError('Personel bulunamadı.');

    const dayCount = computeDayCount(data.startDate, data.endDate);
    if (dayCount <= 0) throw new BadRequestError('endDate, startDate\'ten önce olamaz.');

    // AC: "çakışma tespiti" — aynı personelin AKTİF (karara bağlanmamış/onaylı)
    // bir izniyle tarih aralığı örtüşüyorsa REDDEDİLİR (sert engel — iki
    // izin talebi aynı günlere denk gelemez).
    const overlapRes = await client.query(
      `SELECT id FROM leave_requests
         WHERE tenant_id = $1 AND personnel_id = $2 AND status = ANY($3)
           AND start_date <= $4 AND end_date >= $5`,
      [tenantId, personnelId, ACTIVE_STATUSES, data.endDate, data.startDate]
    );
    if (overlapRes.rows.length > 0) {
      throw new ConflictError('Bu personelin belirtilen tarih aralığıyla ÇAKIŞAN başka bir izin talebi (bekleyen/onaylı) zaten var.');
    }

    const id = generateId('leave');
    const inserted = await client.query(
      `INSERT INTO leave_requests (id, tenant_id, personnel_id, leave_type, start_date, end_date, day_count, reason, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, tenantId, personnelId, data.leaveType, data.startDate, data.endDate, dayCount, data.reason ?? null, byUserId]
    );
    await writeAuditLog(client, {
      action: 'LEAVE_REQUEST_CREATED',
      targetType: 'leave_request',
      targetId: id,
      afterValue: { personnelId, leaveType: data.leaveType, startDate: data.startDate, endDate: data.endDate, dayCount }
    });
    return mapLeaveRow(client, tenantId, inserted.rows[0]);
  });
}

export async function getLeaveRequestsForPersonnel(personnelId: string): Promise<LeaveRequestRecord[]> {
  return withTenant(async (client, tenantId) => {
    const pRes = await client.query('SELECT id FROM personnel WHERE tenant_id = $1 AND id = $2', [tenantId, personnelId]);
    if (pRes.rows.length === 0) throw new NotFoundError('Personel bulunamadı.');
    const res = await client.query(
      'SELECT * FROM leave_requests WHERE tenant_id = $1 AND personnel_id = $2 ORDER BY start_date DESC',
      [tenantId, personnelId]
    );
    return Promise.all(res.rows.map((row: any) => mapLeaveRow(client, tenantId, row)));
  });
}

/** AC: "izin bakiyesi takibi." Verilen yıl için: hak - o yılki ONAYLANDI YILLIK izin günleri. */
export async function getLeaveBalance(personnelId: string, year: number): Promise<{ entitlementDays: number; usedDays: number; remainingDays: number }> {
  return withTenant(async (client, tenantId) => {
    const pRes = await client.query('SELECT annual_leave_entitlement_days FROM personnel WHERE tenant_id = $1 AND id = $2', [tenantId, personnelId]);
    if (pRes.rows.length === 0) throw new NotFoundError('Personel bulunamadı.');
    const entitlementDays = Number(pRes.rows[0].annual_leave_entitlement_days);

    const usedRes = await client.query(
      `SELECT COALESCE(SUM(day_count), 0)::numeric AS total FROM leave_requests
         WHERE tenant_id = $1 AND personnel_id = $2 AND leave_type = 'YILLIK' AND status = 'ONAYLANDI'
           AND EXTRACT(YEAR FROM start_date) = $3`,
      [tenantId, personnelId, year]
    );
    const usedDays = Number(usedRes.rows[0].total);
    return { entitlementDays, usedDays, remainingDays: Math.max(0, entitlementDays - usedDays) };
  });
}

export async function getLeaveCalendar(startDate: string, endDate: string): Promise<Array<LeaveRequestRecord & { personnelName: string }>> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query(
      `SELECT lr.*, p.full_name AS personnel_name FROM leave_requests lr
         JOIN personnel p ON p.id = lr.personnel_id
        WHERE lr.tenant_id = $1 AND lr.status = ANY($2)
          AND lr.start_date <= $3 AND lr.end_date >= $4
        ORDER BY lr.start_date ASC`,
      [tenantId, ACTIVE_STATUSES, endDate, startDate]
    );
    const mapped = await Promise.all(res.rows.map((row: any) => mapLeaveRow(client, tenantId, row)));
    return mapped.map((m, i) => ({ ...m, personnelName: res.rows[i].personnel_name }));
  });
}

/**
 * Rol bazlı "bekleyenler" listesi — NOTIF-1601 yokluğunda bildirim yerine
 * geçer. SITE_MANAGER: TALEP_EDILDI. COMPANY_OWNER/SUPER_ADMIN: hem
 * TALEP_EDILDI (kısayoldan onaylayabilir) hem SAHA_ONAYLANDI.
 */
export async function getPendingLeaveApprovals(role: string): Promise<Array<LeaveRequestRecord & { personnelName: string }>> {
  const statuses = role === 'SITE_MANAGER' ? ['TALEP_EDILDI'] : ['TALEP_EDILDI', 'SAHA_ONAYLANDI'];
  return withTenant(async (client, tenantId) => {
    const res = await client.query(
      `SELECT lr.*, p.full_name AS personnel_name FROM leave_requests lr
         JOIN personnel p ON p.id = lr.personnel_id
        WHERE lr.tenant_id = $1 AND lr.status = ANY($2)
        ORDER BY lr.created_at ASC`,
      [tenantId, statuses]
    );
    const mapped = await Promise.all(res.rows.map((row: any) => mapLeaveRow(client, tenantId, row)));
    return mapped.map((m, i) => ({ ...m, personnelName: res.rows[i].personnel_name }));
  });
}

async function loadLeaveForTransition(client: any, tenantId: string, id: string): Promise<any> {
  const res = await client.query('SELECT * FROM leave_requests WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (res.rows.length === 0) throw new NotFoundError('İzin talebi bulunamadı.');
  return res.rows[0];
}

export async function approveLeaveRequestAsSiteManager(id: string, byUserId: string): Promise<LeaveRequestRecord> {
  return withTenant(async (client, tenantId) => {
    const current = await loadLeaveForTransition(client, tenantId, id);
    if (current.status !== 'TALEP_EDILDI') {
      throw new ConflictError(`Bu talep "${current.status}" durumunda — saha onayı yalnızca TALEP_EDILDI durumundan yapılabilir.`);
    }
    const updated = await client.query(
      `UPDATE leave_requests SET status = 'SAHA_ONAYLANDI', site_approved_by = $1, site_approved_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [byUserId, id]
    );
    await writeAuditLog(client, { action: 'LEAVE_REQUEST_SITE_APPROVED', targetType: 'leave_request', targetId: id, beforeValue: { status: current.status }, afterValue: { status: 'SAHA_ONAYLANDI' } });
    return mapLeaveRow(client, tenantId, updated.rows[0]);
  });
}

export async function approveLeaveRequestAsCompanyOwner(id: string, byUserId: string): Promise<LeaveRequestRecord> {
  return withTenant(async (client, tenantId) => {
    const current = await loadLeaveForTransition(client, tenantId, id);
    if (current.status !== 'TALEP_EDILDI' && current.status !== 'SAHA_ONAYLANDI') {
      throw new ConflictError(`Bu talep "${current.status}" durumunda — firma onayı yalnızca TALEP_EDILDI/SAHA_ONAYLANDI durumundan yapılabilir.`);
    }
    const updated = await client.query(
      `UPDATE leave_requests SET status = 'ONAYLANDI', company_approved_by = $1, company_approved_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [byUserId, id]
    );
    await writeAuditLog(client, { action: 'LEAVE_REQUEST_COMPANY_APPROVED', targetType: 'leave_request', targetId: id, beforeValue: { status: current.status }, afterValue: { status: 'ONAYLANDI' } });
    return mapLeaveRow(client, tenantId, updated.rows[0]);
  });
}

export async function rejectLeaveRequest(id: string, rejectionReason: string, byUserId: string): Promise<LeaveRequestRecord> {
  return withTenant(async (client, tenantId) => {
    const current = await loadLeaveForTransition(client, tenantId, id);
    if (current.status !== 'TALEP_EDILDI' && current.status !== 'SAHA_ONAYLANDI') {
      throw new ConflictError(`Bu talep "${current.status}" durumunda — reddetme yalnızca bekleyen (TALEP_EDILDI/SAHA_ONAYLANDI) taleplerde mümkündür.`);
    }
    const updated = await client.query(
      `UPDATE leave_requests SET status = 'REDDEDILDI', rejection_reason = $1 WHERE id = $2 RETURNING *`,
      [rejectionReason, id]
    );
    await writeAuditLog(client, { action: 'LEAVE_REQUEST_REJECTED', targetType: 'leave_request', targetId: id, beforeValue: { status: current.status }, afterValue: { status: 'REDDEDILDI', rejectionReason } });
    return mapLeaveRow(client, tenantId, updated.rows[0]);
  });
}

export async function cancelLeaveRequest(id: string, byUserId: string): Promise<LeaveRequestRecord> {
  return withTenant(async (client, tenantId) => {
    const current = await loadLeaveForTransition(client, tenantId, id);
    if (current.requested_by !== byUserId) {
      throw new ForbiddenError('Yalnızca talebi oluşturan kişi iptal edebilir.');
    }
    if (current.status !== 'TALEP_EDILDI' && current.status !== 'SAHA_ONAYLANDI') {
      throw new ConflictError(`Bu talep "${current.status}" durumunda — iptal yalnızca karara bağlanmamış taleplerde mümkündür.`);
    }
    const updated = await client.query(`UPDATE leave_requests SET status = 'IPTAL_EDILDI' WHERE id = $1 RETURNING *`, [id]);
    await writeAuditLog(client, { action: 'LEAVE_REQUEST_CANCELLED', targetType: 'leave_request', targetId: id, beforeValue: { status: current.status }, afterValue: { status: 'IPTAL_EDILDI' } });
    return mapLeaveRow(client, tenantId, updated.rows[0]);
  });
}
