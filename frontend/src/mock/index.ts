import { Company } from '../types';

// ==============================================================================
// NOT: Araç, şoför, tank, şantiye ve firma verileri artık PostgreSQL backend'inden
// çekiliyor. Oturum açan kullanıcının firması: GET /companies/me (yalnızca kendi
// tenant'ı; şantiye kullanıcısı için tek şantiye).
//
// `INITIAL_COMPANIES` sadece iki yerde kullanılıyor:
//   1) Giriş yapılmadan önceki ilk React state değeri,
//   2) Henüz gerçek kimlik doğrulaması olmayan /admin (Süper Admin) paneli.
// Bu panele de bir kimlik doğrulama + firma listesi endpoint'i eklendiğinde
// bu dosya tamamen silinebilir.
// ==============================================================================

export const INITIAL_COMPANIES: Company[] = [
  {
    id: 'comp-camsa',
    name: 'ÇamSA Pelet & Enerji A.Ş.',
    code: 'CAMSA-01',
    username: 'camsa',
    password: '123456',
    taxNumber: '2381092831',
    city: 'Kocaeli / Gebze',
    licenseStatus: 'AKTİF',
    licenseExpiry: '2027-12-31',
    sites: [
      { id: 'site-gebze', name: 'Gebze Ana Şantiye', username: 'gebze-santiye', password: '123456', location: 'Gebze OIZ 4. Cadde', activeTanksCount: 2, activeVehiclesCount: 18 },
      { id: 'site-orman', name: 'Orman Şantiyesi', username: 'orman-santiye', password: '123456', location: 'Karasu Orman Bölgesi', activeTanksCount: 1, activeVehiclesCount: 9 },
      { id: 'site-silivri', name: 'Silivri Tesisleri', username: 'silivri-santiye', password: '123456', location: 'Silivri Sanayi Bölgesi', activeTanksCount: 1, activeVehiclesCount: 7 }
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
    username: 'kusak',
    password: '123456',
    taxNumber: '4820193841',
    city: 'İstanbul / Maltepe',
    licenseStatus: 'AKTİF',
    licenseExpiry: '2026-11-15',
    sites: [
      { id: 'site-maltepe', name: 'Maltepe Santral', username: 'maltepe-santiye', password: '123456', location: 'Maltepe E5 Yanal', activeTanksCount: 1, activeVehiclesCount: 22 },
      { id: 'site-pendik', name: 'Pendik Taş Ocağı', username: 'pendik-santiye', password: '123456', location: 'Pendik Kurtköy', activeTanksCount: 2, activeVehiclesCount: 15 }
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
    username: 'avrasya',
    password: '123456',
    taxNumber: '9182301928',
    city: 'Bursa / İnegöl',
    licenseStatus: 'AKTİF',
    licenseExpiry: '2027-06-30',
    sites: [
      { id: 'site-inegol', name: 'İnegöl Mermer Ocağı', username: 'inegol-santiye', password: '123456', location: 'Oylat Yolu Mevkii', activeTanksCount: 2, activeVehiclesCount: 14 }
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
