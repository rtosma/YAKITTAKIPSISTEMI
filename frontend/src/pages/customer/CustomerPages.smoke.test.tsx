import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_COMPANIES } from '../../mock';
import type { CrossSitePermission, CrossSiteSettlementSummaryRow, Driver, FuelQuota, FuelTransaction, QuotaBalance, Tank, Vehicle } from '../../types';

/**
 * Müşteri paneli ekranları için DUMAN testleri.
 *
 * FE-805…818 (29 Eyl–2 Eki) bu ekranları birim testi olmadan ekledi; CI o
 * tarihte koşmadığı için frontend coverage tabanının (%20 satır, TEST-1006)
 * altına düşüldüğü fark edilmedi. Taban "asla düşürülmez" kuralıyla
 * korunuyor; bu dosya onu, her ekranın gerçek bir API yanıt şekliyle
 * ÇÖKMEDEN açıldığını ve başlığını gösterdiğini doğrulayarak geri kazandırır.
 *
 * Ayrıntılı etkileşim akışları Playwright e2e'de (TEST-1004); burada amaç
 * "sayfa render oluyor, veriyi istiyor, boş/dolu durumda patlamıyor".
 */

const vehicles: Vehicle[] = [
  { id: 'veh-1', plate: '34 CTP 82', brandModel: 'Volvo FMX', type: 'Kamyon', rfidTag: 'TAG-1', assignedDriver: 'Ahmet Yılmaz', siteName: 'Gebze Ana Şantiye', fuelCapacityLiters: 400, lastRefuelDate: '2026-11-20T08:00:00Z', lastRefuelLiters: 120, totalRefuelsCount: 14, status: 'AKTİF' },
  { id: 'veh-2', plate: '34 BKT 19', brandModel: 'CAT 320', type: 'Ekskavatör', rfidTag: 'TAG-2', assignedDriver: '', siteName: 'Gebze Ana Şantiye', fuelCapacityLiters: 300, lastRefuelDate: '2026-11-18T08:00:00Z', lastRefuelLiters: 90, totalRefuelsCount: 3, status: 'BAKIMDA' }
];
const drivers: Driver[] = [
  { id: 'drv-1', name: 'Ahmet Yılmaz', tcNo: '10000000146', phone: '5551112233', licenseType: 'C', assignedVehiclePlate: '34 CTP 82', rfidCardId: 'CARD-1', siteName: 'Gebze Ana Şantiye', performanceScore: 82, totalFuelPumpedLiters: 1800, status: 'AKTİF' }
];
const tanks: Tank[] = [
  { id: 'tank-1', name: 'Gebze Ana Tank (T-1)', siteName: 'Gebze Ana Şantiye', capacityLiters: 20000, currentLevelLiters: 2500, fuelType: 'Motorin (Euro Diesel)', temperatureC: 14, lastRefillDate: '2026-11-10T08:00:00Z', sensorId: 'SNS-1', status: 'UYARI' }
];

const transactions: FuelTransaction[] = [
  { id: 'tx-1', timestamp: '2026-11-22T09:15:00Z', siteName: 'Gebze Ana Şantiye', vehiclePlate: '34 CTP 82', driverName: 'Ahmet Yılmaz', tankName: 'Gebze Ana Tank (T-1)', amountLiters: 120, flowRateLpm: 40, pumpStatus: 'TAMAMLANTI', type: 'Otomatik', rfidAuth: true },
  { id: 'tx-2', timestamp: '2026-11-22T02:40:00Z', siteName: 'Gebze Ana Şantiye', vehiclePlate: '34 BKT 19', driverName: 'Ahmet Yılmaz', tankName: 'Gebze Ana Tank (T-1)', amountLiters: 60, flowRateLpm: 35, pumpStatus: 'ANOMALİ', type: 'Manuel', rfidAuth: false }
];
const crossSitePermissions: CrossSitePermission[] = [
  { id: 'csp-1', vehiclePlate: '34 CTP 82', driverName: 'Ahmet Yılmaz', homeSite: 'Gebze Ana Şantiye', targetSite: 'Silivri Tesisleri', allowedLiters: 500, usedLiters: 120, expiryDate: '2026-12-31', status: 'AKTİF' }
];
const fuelQuotas: FuelQuota[] = [
  { id: 'q-1', vehiclePlate: '34 CTP 82', siteName: null, periodType: 'MONTHLY', limitLiters: 1000, carryoverPolicy: 'CAPPED', periodStart: '2026-11-01', periodEnd: '2026-11-30', carriedOverLiters: 50, validFrom: '2026-01-01', validUntil: null, status: 'AKTİF', createdBy: 'camsa' }
];
const quotaBalances: Record<string, QuotaBalance> = {
  'q-1': { quotaId: 'q-1', periodType: 'MONTHLY', periodStart: '2026-11-01', periodEnd: '2026-11-30', baseLimitLiters: 1000, carriedOverLiters: 50, effectiveLimitLiters: 1050, consumedLiters: 980, reservedLiters: 0, remainingLiters: 70, computedAt: '2026-11-22T10:00:00Z' }
};
const crossSiteSettlementSummary: CrossSiteSettlementSummaryRow[] = [
  { id: 's-1', siteA: 'Gebze Ana Şantiye', siteB: 'Silivri Tesisleri', monthLabel: '2026-11', movementCount: 4, netCost: 3200, debtor: 'Silivri Tesisleri', creditor: 'Gebze Ana Şantiye', netAmount: 3200 }
];

const appState: Record<string, unknown> = {};
function resetAppState(): void {
  const noop = vi.fn().mockResolvedValue(undefined);
  Object.assign(appState, {
    currentUser: { username: 'camsa', companyName: INITIAL_COMPANIES[0].name, role: 'COMPANY_OWNER' },
    currentCompany: INITIAL_COMPANIES[0],
    isManagerMode: false,
    selectedSiteFilter: 'Tümü',
    setSelectedSiteFilter: vi.fn(),
    sites: ['Gebze Ana Şantiye', 'Silivri Tesisleri'],
    siteDetails: [{ id: 'site-gebze', name: 'Gebze Ana Şantiye', location: 'Gebze' }],
    vehicles, drivers, tanks, transactions, crossSitePermissions, fuelQuotas, quotaBalances, crossSiteSettlementSummary,
    rfidDenylist: [],
    tankRefreshKey: 0,
    isSocketConnected: true,
    showToast: vi.fn(),
    clearUnreadAlarmCount: vi.fn(),
    triggerTankRefresh: vi.fn(),
    fetchTransactionDespatchStatus: vi.fn().mockResolvedValue(null),
    addVehicle: noop, updateVehicle: noop, deleteVehicle: noop,
    addDriver: noop, updateDriver: noop, deleteDriver: noop,
    addTank: noop, updateTank: noop, deleteTank: noop, uploadTankStrappingTable: noop,
    addSite: noop, deleteSite: noop,
    addFuelTransaction: noop, toggleCrossSiteStatus: noop, addCrossSitePermission: noop,
    createFuelQuota: noop, setFuelQuotaStatus: noop, fetchQuotaBalance: noop
  });
}
vi.mock('../../context/AppContext', () => ({ useApp: () => appState }));

/** Uç noktaya göre gerçekçi yanıt; bilinmeyenler boş sayfalı liste döner. */
function apiResponse(url: string): unknown {
  const empty = { success: true, data: [], pagination: { page: 1, pageSize: 25, totalCount: 0, totalPages: 0 } };
  if (url.includes('/dashboard/executive')) return { success: true, data: null };
  return empty;
}

beforeEach(() => {
  resetAppState();
  localStorage.setItem('YAKIT_ACCESS_TOKEN', 'test-token');
  // recharts ResponsiveContainer jsdom'da ResizeObserver ister.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return new Response(JSON.stringify(apiResponse(url)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

function renderPage(Page: React.ComponentType): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// fetches=false: ekran verisini API'den değil AppContext'ten alır (bağlam yükler).
const PAGES: Array<{ name: string; load: () => Promise<React.ComponentType>; heading: RegExp; fetches?: boolean }> = [
  { name: 'ReportsPage', load: async () => (await import('./ReportsPage')).ReportsPage, heading: /rapor/i },
  { name: 'NotificationsPage', load: async () => (await import('./NotificationsPage')).NotificationsPage, heading: /alarm|bildirim/i },
  { name: 'TransactionsPage', load: async () => (await import('./TransactionsPage')).TransactionsPage, heading: /ikmal/i },
  { name: 'MeterReadingsPage', load: async () => (await import('./MeterReadingsPage')).MeterReadingsPage, heading: /km|motor/i },
  { name: 'VehiclesPage', load: async () => (await import('./VehiclesPage')).VehiclesPage, heading: /araç/i, fetches: false },
  { name: 'TankStatusPage', load: async () => (await import('./TankStatusPage')).TankStatusPage, heading: /tank/i, fetches: false },
  { name: 'DriversPage', load: async () => (await import('./DriversPage')).DriversPage, heading: /şoför|sürücü/i, fetches: false },
  { name: 'CrossSitePage', load: async () => (await import('./CrossSitePage')).CrossSitePage, heading: /çapraz/i, fetches: false },
  { name: 'SitesPage', load: async () => (await import('./SitesPage')).SitesPage, heading: /şantiye/i, fetches: false },
  { name: 'OverviewPage', load: async () => (await import('./OverviewPage')).OverviewPage, heading: /genel|özet/i, fetches: false }
];

describe.each(PAGES)('$name', ({ load, heading, fetches = true }) => {
  it('örnek veriyle çökmeden açılır ve başlığını gösterir', async () => {
    const Page = await load();
    renderPage(Page);
    expect(screen.getAllByText(heading).length).toBeGreaterThan(0);
    if (fetches) await waitFor(() => expect(fetch).toHaveBeenCalled());
  });
});

// ARCH-106: paket dışı modülün ekranına doğrudan URL ile gelinirse tablo yerine nedeni gösterilir.
describe('CrossSitePage — crossSiteAuth modülü kapalı', () => {
  it('"modül etkin değil" bildirimini gösterir, çapraz yetki tablosunu göstermez', async () => {
    appState.currentCompany = { ...INITIAL_COMPANIES[0], modules: { ...INITIAL_COMPANIES[0].modules, crossSiteAuth: false } };
    const { CrossSitePage } = await import('./CrossSitePage');
    renderPage(CrossSitePage);
    expect(screen.getByTestId('module-disabled-notice')).toBeInTheDocument();
    expect(screen.getByText(/Çapraz Şantiye İkmal Yetkisi/)).toBeInTheDocument();
    expect(screen.queryByText('34 CTP 82')).toBeNull();
  });
});
