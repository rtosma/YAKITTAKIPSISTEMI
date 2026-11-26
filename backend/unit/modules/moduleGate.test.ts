import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isModuleOn, MODULE_LABELS, MODULE_NAMES, moduleDisabledBody, moduleForPath, type ModuleName } from '../../src/modules/moduleGate';

/**
 * ARCH-106 — modül kapısının kural tablosu, routes.ts'teki GERÇEK yollara karşı.
 *
 * Beklenen eşleme aşağıda kurallardan BAĞIMSIZ, açık bir liste olarak tutulur:
 * yeni bir modül ucu eklenip kurala yazılmazsa ya da bir kural çekirdek bir
 * ucu (araç/tank/ikmal/rapor çatısı…) yanlışlıkla yakalarsa bu test kırılır.
 */
const EXPECTED: Record<string, ModuleName> = {
  'POST /transactions/:id/e-irsaliye/transmit': 'eInvoice',
  'GET /transactions/:id/e-irsaliye/status': 'eInvoice',
  'POST /transactions/:id/e-irsaliye/reject': 'eInvoice',
  'POST /transactions/:id/e-irsaliye/cancel': 'eInvoice',
  'POST /transactions/:id/e-irsaliye/resubmit': 'eInvoice',
  'GET /transactions/:id/e-irsaliye': 'eInvoice',
  'GET /despatch-advice-transmissions': 'eInvoice',
  'GET /despatch-advice-transmissions/circuit-status': 'eInvoice',
  'GET /despatch-advice-transmissions/:id': 'eInvoice',
  'POST /despatch-advice-transmissions/sweep': 'eInvoice',
  'POST /despatch-advice-transmissions/status-poll': 'eInvoice',
  'POST /despatch-advice-transmissions/bulk-resend': 'eInvoice',
  'POST /despatch-advice-transmissions/stuck-scan': 'eInvoice',
  'GET /despatch-advice-documents/:documentId/download': 'eInvoice',
  'POST /taxpayers/validate': 'eInvoice',
  'POST /recipients': 'eInvoice',
  'GET /recipients': 'eInvoice',
  'GET /recipients/:id': 'eInvoice',
  'POST /recipients/:id/refresh-obligation': 'eInvoice',
  'POST /ai/consumption-anomaly-reports': 'aiAnomaly',
  'GET /ai/consumption-anomaly-reports': 'aiAnomaly',
  'POST /anomaly-flags/scan': 'aiAnomaly',
  'GET /anomaly-flags': 'aiAnomaly',
  'GET /anomaly-flags/:id': 'aiAnomaly',
  'PATCH /anomaly-flags/:id': 'aiAnomaly',
  'GET /fleet/consumption/anomaly': 'aiAnomaly',
  'POST /fleet/consumption/anomaly-scan': 'aiAnomaly',
  'POST /inventory-items': 'smartWarehouse',
  'GET /inventory-items': 'smartWarehouse',
  'GET /inventory-items/:id': 'smartWarehouse',
  'POST /inventory-items/:id/movements': 'smartWarehouse',
  'GET /inventory-items/:id/movements': 'smartWarehouse',
  'POST /inventory-items/:id/count': 'smartWarehouse',
  'GET /inventory/critical-stock': 'smartWarehouse',
  'POST /inventory/critical-stock-scan': 'smartWarehouse',
  'POST /vehicles/:id/maintenance-records': 'maintenanceTrack',
  'GET /vehicles/:id/maintenance-records': 'maintenanceTrack',
  'GET /maintenance-records/:id': 'maintenanceTrack',
  'GET /maintenance-records/:id/consumption-impact': 'maintenanceTrack',
  'GET /fleet/maintenance/upcoming': 'maintenanceTrack',
  'POST /fleet/maintenance/reminder-scan': 'maintenanceTrack',
  'POST /vehicles/:id/compliance-deadlines': 'maintenanceTrack',
  'GET /vehicles/:id/compliance-deadlines': 'maintenanceTrack',
  'GET /vehicles/:id/compliance-deadlines/current': 'maintenanceTrack',
  'POST /vehicles/:id/tires': 'maintenanceTrack',
  'GET /vehicles/:id/tires': 'maintenanceTrack',
  'PATCH /tires/:id/tread-depth': 'maintenanceTrack',
  'GET /tires/:id/status': 'maintenanceTrack',
  'GET /fleet/compliance/dashboard': 'maintenanceTrack',
  'POST /fleet/compliance/scan': 'maintenanceTrack',
  'POST /drivers/behavior-scores/compute': 'driverScore',
  'GET /drivers/behavior-scores': 'driverScore',
  'GET /drivers/:driverName/behavior-scores/history': 'driverScore',
  'GET /cross-site-permissions': 'crossSiteAuth',
  'POST /cross-site-permissions': 'crossSiteAuth',
  'PATCH /cross-site-permissions/:id': 'crossSiteAuth'
};

/** routes.ts'teki tüm `router.<metot>('<yol>'` tanımları; :param'lar örnek değerle doldurulur. */
function realRoutes(): Array<{ key: string; samplePath: string }> {
  const src = readFileSync(path.join(__dirname, '../../src/routes/routes.ts'), 'utf8');
  return [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*['`]([^'`]+)['`]/g)].map((m) => ({
    key: `${m[1].toUpperCase()} ${m[2]}`,
    samplePath: m[2].replace(/:[A-Za-z]+/g, 'x1')
  }));
}

describe('moduleForPath — routes.ts\'teki gerçek uçlar', () => {
  const routes = realRoutes();

  it('rota listesi okunabiliyor (regex bozulmadı)', () => {
    expect(routes.length).toBeGreaterThan(250);
  });

  it('beklenen her modül ucu routes.ts\'te GERÇEKTEN var (liste eskimedi)', () => {
    const keys = new Set(routes.map((r) => r.key));
    expect(Object.keys(EXPECTED).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('her uç ya beklenen modüle kapılı ya da hiç kapılı değil (çekirdek uçlar yanlışlıkla kapanmıyor)', () => {
    const mismatches = routes
      .map((r) => ({ key: r.key, got: moduleForPath(r.samplePath), want: EXPECTED[r.key] ?? null }))
      .filter((x) => x.got !== x.want);
    expect(mismatches).toEqual([]);
  });

  it('rapor çatısında yalnızca modüle özgü raporlar kapılı (rep-721 e-İrsaliye, rep-715 çapraz mahsuplaşma)', () => {
    expect(moduleForPath('/reports/rep-721')).toBe('eInvoice');
    expect(moduleForPath('/reports/rep-721/export')).toBe('eInvoice');
    expect(moduleForPath('/reports/rep-715')).toBe('crossSiteAuth');
    expect(moduleForPath('/reports/rep-711')).toBeNull();
    expect(moduleForPath('/reports/rep-7210')).toBeNull(); // önek çakışması yok
    expect(moduleForPath('/reports')).toBeNull();
  });

  it('benzer adlı çekirdek yollar yakalanmaz', () => {
    for (const p of ['/fleet/consumption', '/fleet/consumption/trend', '/vehicles/x1', '/transactions', '/drivers', '/drivers/x1', '/inventory', '/airports']) {
      expect(moduleForPath(p)).toBeNull();
    }
  });
});

describe('isModuleOn', () => {
  it('yalnızca açıkça false olan modül kapalıdır; anahtar yoksa/null modül listesi açık sayılır', () => {
    expect(isModuleOn({ eInvoice: false }, 'eInvoice')).toBe(false);
    expect(isModuleOn({ eInvoice: true }, 'eInvoice')).toBe(true);
    expect(isModuleOn({}, 'eInvoice')).toBe(true);
    expect(isModuleOn(null, 'eInvoice')).toBe(true);
    expect(isModuleOn(undefined, 'aiAnomaly')).toBe(true);
    expect(isModuleOn({ eInvoice: 'false' }, 'eInvoice')).toBe(true); // yalnızca boolean false
  });
});

describe('moduleDisabledBody', () => {
  it('her modül için 403 gövdesi: makine kodu + modül + kullanıcıya gösterilebilir Türkçe mesaj', () => {
    for (const m of MODULE_NAMES) {
      const b = moduleDisabledBody(m);
      expect(b).toMatchObject({ success: false, error: 'MODULE_DISABLED', module: m });
      expect(b.message).toContain(MODULE_LABELS[m]);
    }
  });
});
