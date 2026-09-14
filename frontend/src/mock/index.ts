import { Company } from '../types';

// ==============================================================================
// NOT: Araç, şoför, tank, şantiye ve firma verileri artık PostgreSQL backend'inden
// çekiliyor. Oturum açan kullanıcının firması: GET /companies/me (yalnızca kendi
// tenant'ı; şantiye kullanıcısı için tek şantiye).
//
// `INITIAL_COMPANIES` yalnızca giriş yapılmadan önceki ilk React state değeri.
// Bu dosya prod bundle'ına GİRER: buraya asla kullanıcı adı/parola ya da başka
// bir kimlik bilgisi eklemeyin (bkz. scripts/check-frontend-bundle.mjs).
// ==============================================================================

export const INITIAL_COMPANIES: Company[] = [
  {
    id: 'comp-camsa',
    name: 'ÇamSA Pelet & Enerji A.Ş.',
    code: 'CAMSA-01',
    taxNumber: '2381092831',
    city: 'Kocaeli / Gebze',
    licenseStatus: 'AKTİF',
    licenseExpiry: '2027-12-31',
    sites: [
      { id: 'site-gebze', name: 'Gebze Ana Şantiye', location: 'Gebze OIZ 4. Cadde', activeTanksCount: 2, activeVehiclesCount: 18 },
      { id: 'site-orman', name: 'Orman Şantiyesi', location: 'Karasu Orman Bölgesi', activeTanksCount: 1, activeVehiclesCount: 9 },
      { id: 'site-silivri', name: 'Silivri Tesisleri', location: 'Silivri Sanayi Bölgesi', activeTanksCount: 1, activeVehiclesCount: 7 }
    ],
    modules: {
      aiAnomaly: true,
      eInvoice: true,
      smartWarehouse: true,
      maintenanceTrack: true,
      driverScore: true,
      crossSiteAuth: true
    },
    activeVehiclesCount: 34,
    totalFuelThisMonth: 124800
  },
  {
    id: 'comp-kusak',
    name: 'Kuşak Beton & İnşaat Ltd.',
    code: 'KUSAK-02',
    taxNumber: '4820193841',
    city: 'İstanbul / Maltepe',
    licenseStatus: 'AKTİF',
    licenseExpiry: '2026-11-15',
    sites: [
      { id: 'site-maltepe', name: 'Maltepe Santral', location: 'Maltepe E5 Yanal', activeTanksCount: 1, activeVehiclesCount: 22 },
      { id: 'site-pendik', name: 'Pendik Taş Ocağı', location: 'Pendik Kurtköy', activeTanksCount: 2, activeVehiclesCount: 15 }
    ],
    modules: {
      aiAnomaly: true,
      eInvoice: false,
      smartWarehouse: true,
      maintenanceTrack: false,
      driverScore: true,
      crossSiteAuth: false
    },
    activeVehiclesCount: 37,
    totalFuelThisMonth: 98400
  },
  {
    id: 'comp-avrasya',
    name: 'Avrasya Altyapı & Mermer A.Ş.',
    code: 'AVR-03',
    taxNumber: '9182301928',
    city: 'Bursa / İnegöl',
    licenseStatus: 'AKTİF',
    licenseExpiry: '2027-06-30',
    sites: [
      { id: 'site-inegol', name: 'İnegöl Mermer Ocağı', location: 'Oylat Yolu Mevkii', activeTanksCount: 2, activeVehiclesCount: 14 }
    ],
    modules: {
      aiAnomaly: false,
      eInvoice: true,
      smartWarehouse: false,
      maintenanceTrack: true,
      driverScore: false,
      crossSiteAuth: true
    },
    activeVehiclesCount: 14,
    totalFuelThisMonth: 62100
  }
];
