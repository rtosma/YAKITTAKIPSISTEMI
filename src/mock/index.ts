import { 
  Company, 
  Vehicle, 
  Driver, 
  Tank, 
  FuelTransaction, 
  CrossSitePermission, 
  HardwareDevice, 
  HardwareLog 
} from '../types';

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

export const INITIAL_VEHICLES: Vehicle[] = [
  {
    id: 'veh-1',
    plate: '34 CTP 82',
    brandModel: 'Volvo FMX 460 (Damperli)',
    type: 'Kamyon',
    rfidTag: 'TAG-882910',
    assignedDriver: 'Ahmet Yılmaz',
    siteName: 'Gebze Ana Şantiye',
    fuelCapacityLiters: 450,
    lastRefuelDate: '2026-08-05 08:30',
    lastRefuelLiters: 320,
    totalRefuelsCount: 48,
    status: 'AKTİF'
  },
  {
    id: 'veh-2',
    plate: '34 BKT 19',
    brandModel: 'CAT 349D Excavator',
    type: 'Ekskavatör',
    rfidTag: 'TAG-882911',
    assignedDriver: 'Mehmet Demir',
    siteName: 'Gebze Ana Şantiye',
    fuelCapacityLiters: 700,
    lastRefuelDate: '2026-08-05 07:15',
    lastRefuelLiters: 580,
    totalRefuelsCount: 62,
    status: 'AKTİF'
  },
  {
    id: 'veh-3',
    plate: '35 EGE 40',
    brandModel: 'Komatsu D275A Dozer',
    type: 'Dozer',
    rfidTag: 'TAG-882912',
    assignedDriver: 'Hasan Kaya',
    siteName: 'Orman Şantiyesi',
    fuelCapacityLiters: 850,
    lastRefuelDate: '2026-08-04 18:40',
    lastRefuelLiters: 710,
    totalRefuelsCount: 39,
    status: 'AKTİF'
  },
  {
    id: 'veh-4',
    plate: '41 KCL 05',
    brandModel: 'MAN TGS 33.420 Beton Mikseri',
    type: 'Beton Mikseri',
    rfidTag: 'TAG-882913',
    assignedDriver: 'Ibrahim Çelik',
    siteName: 'Silivri Tesisleri',
    fuelCapacityLiters: 400,
    lastRefuelDate: '2026-08-05 09:10',
    lastRefuelLiters: 290,
    totalRefuelsCount: 51,
    status: 'AKTİF'
  },
  {
    id: 'veh-5',
    plate: '34 SIL 99',
    brandModel: 'Hitachi ZX350LC',
    type: 'Ekskavatör',
    rfidTag: 'TAG-882914',
    assignedDriver: 'Süleyman Öztürk',
    siteName: 'Silivri Tesisleri',
    fuelCapacityLiters: 600,
    lastRefuelDate: '2026-08-03 16:20',
    lastRefuelLiters: 490,
    totalRefuelsCount: 31,
    status: 'AKTİF'
  },
  {
    id: 'veh-6',
    plate: '16 ORM 12',
    brandModel: 'Ford Transit Saha Hizmet',
    type: 'Binek Hizmet',
    rfidTag: 'TAG-882915',
    assignedDriver: 'Caner Şahin',
    siteName: 'Orman Şantiyesi',
    fuelCapacityLiters: 80,
    lastRefuelDate: '2026-08-04 11:00',
    lastRefuelLiters: 65,
    totalRefuelsCount: 22,
    status: 'BAKIMDA'
  }
];

export const INITIAL_DRIVERS: Driver[] = [
  {
    id: 'drv-1',
    name: 'Ahmet Yılmaz',
    tcNo: '10928374821',
    phone: '0532 998 12 34',
    licenseType: 'CE Sınıfı Ağır Vasıta',
    assignedVehiclePlate: '34 CTP 82',
    rfidCardId: 'CARD-881201',
    siteName: 'Gebze Ana Şantiye',
    performanceScore: 96,
    totalFuelPumpedLiters: 14200,
    status: 'SAHADA'
  },
  {
    id: 'drv-2',
    name: 'Mehmet Demir',
    tcNo: '29810293841',
    phone: '0533 112 33 44',
    licenseType: 'G Sınıfı İş Makinesi (Ekskavatör)',
    assignedVehiclePlate: '34 BKT 19',
    rfidCardId: 'CARD-881202',
    siteName: 'Gebze Ana Şantiye',
    performanceScore: 92,
    totalFuelPumpedLiters: 21800,
    status: 'SAHADA'
  },
  {
    id: 'drv-3',
    name: 'Hasan Kaya',
    tcNo: '30192837412',
    phone: '0535 443 22 11',
    licenseType: 'G Sınıfı İş Makinesi (Dozer)',
    assignedVehiclePlate: '35 EGE 40',
    rfidCardId: 'CARD-881203',
    siteName: 'Orman Şantiyesi',
    performanceScore: 88,
    totalFuelPumpedLiters: 18400,
    status: 'SAHADA'
  },
  {
    id: 'drv-4',
    name: 'Ibrahim Çelik',
    tcNo: '49201928371',
    phone: '0536 778 99 00',
    licenseType: 'C Sınıfı Kamyon',
    assignedVehiclePlate: '41 KCL 05',
    rfidCardId: 'CARD-881204',
    siteName: 'Silivri Tesisleri',
    performanceScore: 94,
    totalFuelPumpedLiters: 12900,
    status: 'SAHADA'
  },
  {
    id: 'drv-5',
    name: 'Caner Şahin',
    tcNo: '58291029381',
    phone: '0537 221 00 11',
    licenseType: 'B Sınıfı Binek',
    assignedVehiclePlate: '16 ORM 12',
    rfidCardId: 'CARD-881205',
    siteName: 'Orman Şantiyesi',
    performanceScore: 85,
    totalFuelPumpedLiters: 3200,
    status: 'İZİNLİ'
  }
];

export const INITIAL_TANKS: Tank[] = [
  {
    id: 'tank-gebze-1',
    name: 'Gebze Ana Tank (T-1)',
    siteName: 'Gebze Ana Şantiye',
    capacityLiters: 20000,
    currentLevelLiters: 14830,
    fuelType: 'Motorin (Euro Diesel)',
    temperatureC: 18.5,
    lastRefillDate: '2026-08-01',
    sensorId: 'ESP32_TANK_01',
    status: 'GÜVENLİ'
  },
  {
    id: 'tank-gebze-2',
    name: 'Gebze Yedek Depo (T-2)',
    siteName: 'Gebze Ana Şantiye',
    capacityLiters: 15000,
    currentLevelLiters: 4800,
    fuelType: 'Motorin (Euro Diesel)',
    temperatureC: 19.1,
    lastRefillDate: '2026-07-28',
    sensorId: 'ESP32_TANK_02',
    status: 'UYARI'
  },
  {
    id: 'tank-orman-1',
    name: 'Orman Depo Tankı (T-3)',
    siteName: 'Orman Şantiyesi',
    capacityLiters: 10000,
    currentLevelLiters: 8200,
    fuelType: 'Motorin (Euro Diesel)',
    temperatureC: 16.8,
    lastRefillDate: '2026-08-03',
    sensorId: 'ESP32_TANK_03',
    status: 'GÜVENLİ'
  },
  {
    id: 'tank-silivri-1',
    name: 'Silivri Tesis Tankı (T-4)',
    siteName: 'Silivri Tesisleri',
    capacityLiters: 12000,
    currentLevelLiters: 1900,
    fuelType: 'Motorin (Euro Diesel)',
    temperatureC: 21.0,
    lastRefillDate: '2026-07-20',
    sensorId: 'ESP32_TANK_04',
    status: 'KRİTİK'
  }
];

export const INITIAL_TRANSACTIONS: FuelTransaction[] = [
  {
    id: 'tx-101',
    timestamp: '2026-08-05 09:42:10',
    siteName: 'Gebze Ana Şantiye',
    vehiclePlate: '34 CTP 82',
    driverName: 'Ahmet Yılmaz',
    tankName: 'Gebze Ana Tank (T-1)',
    amountLiters: 320,
    flowRateLpm: 54.2,
    pumpStatus: 'TAMAMLANTI',
    type: 'Otomatik',
    rfidAuth: true
  },
  {
    id: 'tx-102',
    timestamp: '2026-08-05 09:15:33',
    siteName: 'Silivri Tesisleri',
    vehiclePlate: '41 KCL 05',
    driverName: 'Ibrahim Çelik',
    tankName: 'Silivri Tesis Tankı (T-4)',
    amountLiters: 290,
    flowRateLpm: 48.9,
    pumpStatus: 'TAMAMLANTI',
    type: 'Otomatik',
    rfidAuth: true
  },
  {
    id: 'tx-103',
    timestamp: '2026-08-05 08:30:00',
    siteName: 'Gebze Ana Şantiye',
    vehiclePlate: '34 BKT 19',
    driverName: 'Mehmet Demir',
    tankName: 'Gebze Ana Tank (T-1)',
    amountLiters: 580,
    flowRateLpm: 61.5,
    pumpStatus: 'TAMAMLANTI',
    type: 'Otomatik',
    rfidAuth: true
  },
  {
    id: 'tx-104',
    timestamp: '2026-08-04 18:40:12',
    siteName: 'Orman Şantiyesi',
    vehiclePlate: '35 EGE 40',
    driverName: 'Hasan Kaya',
    tankName: 'Orman Depo Tankı (T-3)',
    amountLiters: 710,
    flowRateLpm: 58.0,
    pumpStatus: 'TAMAMLANTI',
    type: 'Çapraz Şantiye',
    rfidAuth: true
  },
  {
    id: 'tx-105',
    timestamp: '2026-08-04 14:10:05',
    siteName: 'Silivri Tesisleri',
    vehiclePlate: '34 SIL 99',
    driverName: 'Süleyman Öztürk',
    tankName: 'Silivri Tesis Tankı (T-4)',
    amountLiters: 490,
    flowRateLpm: 50.1,
    pumpStatus: 'TAMAMLANTI',
    type: 'Otomatik',
    rfidAuth: true
  }
];

export const INITIAL_CROSS_SITE_PERMISSIONS: CrossSitePermission[] = [
  {
    id: 'perm-01',
    vehiclePlate: '35 EGE 40',
    driverName: 'Hasan Kaya',
    homeSite: 'Orman Şantiyesi',
    targetSite: 'Gebze Ana Şantiye',
    allowedLiters: 500,
    usedLiters: 350,
    expiryDate: '2026-08-10',
    status: 'AKTİF'
  },
  {
    id: 'perm-02',
    vehiclePlate: '34 SIL 99',
    driverName: 'Süleyman Öztürk',
    homeSite: 'Silivri Tesisleri',
    targetSite: 'Gebze Ana Şantiye',
    allowedLiters: 400,
    usedLiters: 0,
    expiryDate: '2026-08-15',
    status: 'AKTİF'
  }
];

export const INITIAL_HARDWARE_DEVICES: HardwareDevice[] = [
  {
    id: 'dev-1',
    deviceCode: 'ESP32_PUMP_01',
    name: 'Pompa #1 Debimetre Controller',
    type: 'Debimetre & Solenoid',
    companyName: 'ÇamSA Pelet & Enerji A.Ş.',
    siteName: 'Gebze Ana Şantiye',
    firmwareVersion: '2.4.12',
    ipAddress: '192.168.10.101',
    signalRssi: -65,
    status: 'ONLINE',
    lastPing: '2s önce'
  },
  {
    id: 'dev-2',
    deviceCode: 'ESP32_TANK_01',
    name: 'Tank #1 Ultrasonik Seviye Sensörü',
    type: 'Ultrasonik Tank Sensörü',
    companyName: 'ÇamSA Pelet & Enerji A.Ş.',
    siteName: 'Gebze Ana Şantiye',
    firmwareVersion: '2.4.12',
    ipAddress: '192.168.10.102',
    signalRssi: -58,
    status: 'ONLINE',
    lastPing: '1s önce'
  },
  {
    id: 'dev-3',
    deviceCode: 'ESP32_RFID_01',
    name: 'Saha RFID Araç Geçiş Terminali',
    type: 'RFID Okuyucu',
    companyName: 'ÇamSA Pelet & Enerji A.Ş.',
    siteName: 'Gebze Ana Şantiye',
    firmwareVersion: '2.3.8',
    ipAddress: '192.168.10.103',
    signalRssi: -71,
    status: 'ONLINE',
    lastPing: '5s önce'
  },
  {
    id: 'dev-4',
    deviceCode: 'ESP32_TANK_03',
    name: 'Orman Depo Ultrasonik Sensör',
    type: 'Ultrasonik Tank Sensörü',
    companyName: 'ÇamSA Pelet & Enerji A.Ş.',
    siteName: 'Orman Şantiyesi',
    firmwareVersion: '2.4.12',
    ipAddress: '10.0.4.15',
    signalRssi: -78,
    status: 'ONLINE',
    lastPing: '3s önce'
  },
  {
    id: 'dev-5',
    deviceCode: 'ESP32_PUMP_04',
    name: 'Silivri Pompa Controller',
    type: 'Debimetre & Solenoid',
    companyName: 'ÇamSA Pelet & Enerji A.Ş.',
    siteName: 'Silivri Tesisleri',
    firmwareVersion: '2.4.0',
    ipAddress: '10.0.8.22',
    signalRssi: -82,
    status: 'ONLINE',
    lastPing: '4s önce'
  }
];

export const INITIAL_HARDWARE_LOGS: HardwareLog[] = [
  {
    id: 'log-1',
    timestamp: '09:42:10',
    deviceCode: 'ESP32_PUMP_01',
    tag: 'MQTT',
    message: '[MQTT_PUB] Topic: camsa/gebze/telemetry Payload: {"flow_rate": 54.2, "rssi": -65}',
    siteName: 'Gebze Ana Şantiye'
  },
  {
    id: 'log-2',
    timestamp: '09:42:08',
    deviceCode: 'ESP32_RFID_01',
    tag: 'RFID',
    message: '[RFID] Plaka 34 CTP 82 Okundu → Auth: Başarılı (CARD-881201)',
    siteName: 'Gebze Ana Şantiye'
  },
  {
    id: 'log-3',
    timestamp: '09:42:00',
    deviceCode: 'ESP32_PUMP_01',
    tag: 'PUMP',
    message: '[PUMP] Pompa #1 Akış Başladı — 54.2 Litre/dk (Solenoid RÖLE: AÇIK)',
    siteName: 'Gebze Ana Şantiye'
  },
  {
    id: 'log-4',
    timestamp: '09:40:15',
    deviceCode: 'ESP32_TANK_01',
    tag: 'SENSOR',
    message: '[SENSOR] Tank-1 Ultrasonik Seviye: 14,830 Litre (%74.1) | 18.5°C',
    siteName: 'Gebze Ana Şantiye'
  },
  {
    id: 'log-5',
    timestamp: '09:35:22',
    deviceCode: 'ESP32_TANK_04',
    tag: 'WARN',
    message: '[WARN] Tank-4 (Silivri) Seviye %15.8 KRİTİK EŞİK DÜŞÜKLÜĞÜ',
    siteName: 'Silivri Tesisleri'
  }
];

export const HOURLY_CONSUMPTION_DATA = [
  { hour: '00:00', Gebze: 0, Orman: 0, Silivri: 0, Total: 0 },
  { hour: '02:00', Gebze: 0, Orman: 120, Silivri: 0, Total: 120 },
  { hour: '04:00', Gebze: 350, Orman: 0, Silivri: 0, Total: 350 },
  { hour: '06:00', Gebze: 820, Orman: 450, Silivri: 280, Total: 1550 },
  { hour: '08:00', Gebze: 1450, Orman: 910, Silivri: 620, Total: 2980 },
  { hour: '10:00', Gebze: 1200, Orman: 780, Silivri: 540, Total: 2520 },
  { hour: '12:00', Gebze: 650, Orman: 320, Silivri: 210, Total: 1180 },
  { hour: '14:00', Gebze: 1680, Orman: 1100, Silivri: 890, Total: 3670 },
  { hour: '16:00', Gebze: 1350, Orman: 840, Silivri: 710, Total: 2900 },
  { hour: '18:00', Gebze: 920, Orman: 510, Silivri: 390, Total: 1820 },
  { hour: '20:00', Gebze: 210, Orman: 180, Silivri: 0, Total: 390 },
  { hour: '22:00', Gebze: 0, Orman: 0, Silivri: 0, Total: 0 },
];
