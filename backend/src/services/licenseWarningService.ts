import { runWithTenant } from '../context/tenantContext';
import { raiseAlarmForCurrentTenant, AlarmSeverity } from '../db/tenantDb';
import { getCompaniesNearingExpiry } from '../db/adminDb';
import { broadcastToTenant } from '../socket/socketServer';
import { logger } from '../utils/logger';

/**
 * BILL-1702 — Lisans Süresi Bitiş Uyarıları (30/15/7 gün kala).
 *
 * Ticket "NOTIF-1601" (ayrı bir bildirim servisi) öneriyor — bu kod
 * tabanında öyle bir servis yok. Bunun yerine mevcut iki kanal kullanılıyor:
 *  1. AI-507 birleşik alarm sistemi (raiseAlarmForCurrentTenant) — kalıcı,
 *     panelde görülebilir, dedupe/eskalasyon zaten var.
 *  2. Socket.io `license:warning` yayını — açık panel varsa ANINDA görünür.
 *
 * index.ts'teki diğer süpürücülerle (FUEL-402.1 kota sıfırlama, AI-502
 * haftalık anomali) AYNI çağrı deseni: bu fonksiyon periyodik bir
 * setInterval'dan VE `POST /admin/license-expiry-sweep` (SUPER_ADMIN, manuel
 * tetik — testler ve operasyon için, 30/15/7 günlük periyodu beklemeden)
 * ucundan çağrılabilir.
 */
export async function runLicenseExpiryWarningSweep(): Promise<{ checked: number; warned: number }> {
  const companies = await getCompaniesNearingExpiry(30);
  let warned = 0;

  for (const company of companies) {
    try {
      const severity: AlarmSeverity = company.daysRemaining <= 7 ? 'CRITICAL' : company.daysRemaining <= 15 ? 'WARNING' : 'INFO';

      await runWithTenant({ tenantId: company.id }, () =>
        raiseAlarmForCurrentTenant({
          alarmKey: `LICENSE_EXPIRY:${company.id}`,
          category: 'LICENSE_EXPIRY',
          severity,
          title: `Lisans süresi ${company.daysRemaining} gün içinde doluyor (${company.licenseExpiry})`,
          subjectType: 'COMPANY',
          subjectId: company.id,
          detail: { licenseExpiry: company.licenseExpiry, daysRemaining: company.daysRemaining }
        })
      );

      try {
        broadcastToTenant(company.id, 'license:warning', {
          licenseExpiry: company.licenseExpiry,
          daysRemaining: company.daysRemaining
        });
      } catch (err) {
        logger.warn({ err, companyId: company.id }, '⚠️ [BILL-1702] license:warning Socket.io yayını başarısız.');
      }

      warned++;
    } catch (err) {
      // Bir firmanın uyarısının başarısız olması DİĞERLERİNİN turunu
      // ENGELLEMEMELİ (index.ts'teki diğer süpürücülerle aynı gerekçe).
      logger.error({ err, companyId: company.id }, '🚨 [BILL-1702] Lisans süresi uyarısı oluşturulamadı.');
    }
  }

  return { checked: companies.length, warned };
}
