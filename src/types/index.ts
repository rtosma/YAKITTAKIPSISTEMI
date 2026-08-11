export interface Site {
  id: string;
  name: string;
  location: string;
  activeTanksCount: number;
  activeVehiclesCount: number;
}

export interface CompanyModule {
  aiAnomaly: boolean;       // AI Hırsızlık Tespiti
  eInvoice: boolean;        // e-İrsaliye Entegrasyonu
  smartWarehouse: boolean;  // Akıllı Ambar & Depo
  maintenanceTrack: boolean; // Bakım & Arıza Takibi
  driverScore: boolean;     // Şoför Performans Skoru
  crossSiteAuth: boolean;   // Çapraz Şantiye İkmal Yetkisi
}

export interface Company {
  id: string;
  name: string;
  code: string;
  taxNumber: string;
  city: string;
  licenseStatus: 'AKTİF' | 'ASKIDA' | 'DENEME';
  licenseExpiry: string;
  sites: Site[];
  modules: CompanyModule;
  activeVehiclesCount: number;
  totalFuelThisMonth: number; // Litres
}

export interface Vehicle {
  id: string;
  plate: string;
  brandModel: string;
  type: 'Kamyon' | 'Ekskavatör' | 'Dozer' | 'Silindir' | 'Beton Mikseri' | 'Binek Hizmet';
  rfidTag: string;
  assignedDriver: string;
  siteName: string;
  fuelCapacityLiters: number;
  lastRefuelDate: string;
  lastRefuelLiters: number;
  totalRefuelsCount: number;
  status: 'AKTİF' | 'BAKIMDA' | 'PASİF';
}

export interface Driver {
  id: string;
  name: string;
  tcNo: string;
  phone: string;
  licenseType: string;
  assignedVehiclePlate: string;
  rfidCardId: string;
  siteName: string;
  performanceScore: number; // 0 - 100
  totalFuelPumpedLiters: number;
  status: 'AKTİF' | 'SAHADA' | 'İZİNLİ' | 'PASİF';
}

export interface FuelTransaction {
  id: string;
  timestamp: string;
  siteName: string;
  vehiclePlate: string;
  driverName: string;
  tankName: string;
  amountLiters: number;
  flowRateLpm: number;
  pumpStatus: 'TAMAMLANTI' | 'DURDURULDU' | 'ANOMALİ';
  type: 'Otomatik' | 'Manuel' | 'Çapraz Şantiye';
  rfidAuth: boolean;
}

export interface Tank {
  id: string;
  name: string;
  siteName: string;
  capacityLiters: number;
  currentLevelLiters: number;
  fuelType: 'Motorin (Euro Diesel)' | 'Benzin (95)';
  temperatureC: number;
  lastRefillDate: string;
  sensorId: string;
  status: 'GÜVENLİ' | 'UYARI' | 'KRİTİK';
}

export interface CrossSitePermission {
  id: string;
  vehiclePlate: string;
  driverName: string;
  homeSite: string;
  targetSite: string;
  allowedLiters: number;
  usedLiters: number;
  expiryDate: string;
  status: 'AKTİF' | 'SÜRESİ_DOLDU' | 'KULLANILDI';
}

export interface HardwareDevice {
  id: string;
  deviceCode: string;
  name: string;
  type: 'Debimetre & Solenoid' | 'Ultrasonik Tank Sensörü' | 'RFID Okuyucu' | 'Master Gateway';
  companyName: string;
  siteName: string;
  firmwareVersion: string;
  ipAddress: string;
  signalRssi: number;
  status: 'ONLINE' | 'OFFLINE' | 'SİNYAL_ZAYIF';
  lastPing: string;
}

export interface HardwareLog {
  id: string;
  timestamp: string;
  deviceCode: string;
  tag: 'MQTT' | 'RFID' | 'PUMP' | 'SENSOR' | 'WARN' | 'ERR' | string;
  message: string;
  siteName?: string;
}

export interface SystemMetric {
  activeCompanies: number;
  activeDevices: number;
  latencyMs: number;
  mqttBrokerStatus: 'ONLINE' | 'DEGRADED';
  totalTransactionsToday: number;
}
