export interface Site {
  id: string;
  name: string;
  location: string;
  activeTanksCount: number;
  activeVehiclesCount: number;
}

/** FE-807: AUTH-204'ün POST /sites yanıtındaki tek seferlik SITE_MANAGER kimlik bilgileri — yalnızca oluşturma anında döner, bir daha üretilemez. */
export interface SiteProvisioningResult {
  username: string;
  temporaryPassword: string;
  passwordExpiresAt: string;
}

/** FE-807: GET /sites/details — yalnızca `sites` tablosunda GERÇEKTEN kaydı olan şantiyelerin id/ad/konumu (bkz. Site tipiyle ilişkisi için tenantDb.ts getTenantSiteDetails yorumu). */
export interface SiteDetail {
  id: string;
  name: string;
  location: string;
}

export interface CompanyModule {
  aiAnomaly: boolean;       // AI Hırsızlık Tespiti
  eInvoice: boolean;        // e-İrsaliye Entegrasyonu
  smartWarehouse: boolean;  // Akıllı Ambar & Depo
  maintenanceTrack: boolean; // Bakım & Arıza Takibi
  driverScore: boolean;     // Şoför Performans Skoru
  crossSiteAuth: boolean;   // Çapraz Şantiye İkmal Yetkisi
}

/** FE-805: ARCH-105'in POST /companies yanıtındaki tek seferlik kimlik bilgileri — yalnızca oluşturma anında döner, bir daha üretilemez. */
export interface TenantProvisioningResult {
  ownerUsername: string;
  temporaryPassword: string;
  passwordExpiresAt: string;
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
  lastActivityAt: string | null; // FE-805: en son ikmal işleminin zamanı (ISO), hiç ikmal yoksa null
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
  // FLEET-1401: BLOKE, PASİF'ten anlam olarak ayrı (PASİF: filodan çıkmış,
  // BLOKE: filoda aktif ama yakıt alımı geçici durdurulmuş) — backend'de
  // teknik etkisi aynı (AKTİF dışı = ikmal reddi), bkz. vehicleSchema.ts.
  status: 'AKTİF' | 'BAKIMDA' | 'PASİF' | 'BLOKE';
}

// FLEET-1402 — pompada okutulan, ne bir şoför kartına ne bir araç etiketine
// eşleşen RFID UID'si (backend Socket.io 'rfid:unmatched' olayının payload'ı).
export interface UnmatchedRfidAlert {
  cardUid: string;
  siteName: string;
  deviceId: string | null;
  detectedAt: string;
}

// FE-808 Kapsam: "Araç/sürücü bloke etme ve kart kayıp bildirimi." AUTH-210
// (backend rfid_card_blacklist) zaten tam bir kayıp/blokaj/değiştirme akışı
// sunuyordu — frontend'de HİÇ arayüzü yoktu.
export interface RfidBlacklistRecord {
  id: string;
  card_uid: string;
  status: 'LOST' | 'BLOCKED' | 'REPLACED';
  reason: string | null;
  replaced_by_card_uid: string | null;
  reported_by: string;
  created_at: string;
  updated_at: string;
}

// FE-809 Kapsam: "Pompa/tabanca tanımı ve tank ilişkisi" + "Cihaz durumu,
// son telemetri." Bu tenant'ın KENDİ GET /hardware-devices'ı — SUPER_ADMIN'in
// çapraz-tenant /devices'ından (FE-806, types.ts HardwareDevice) AYRI.
export interface TenantHardwareDevice {
  id: string;
  deviceId: string;
  name: string;
  siteName: string;
  status: string;
  tankName: string | null;
  firmwareVersion: string | null;
  lastSeenAt: string | null;
  lastReportedRssi: number | null;
}

/** FE-809 Kapsam: "Cihaz eşleştirme (provisioning) akışı ve QR/claim kodu gösterimi." IOT-304. */
export interface DeviceClaimCode {
  id: string;
  code: string;
  siteName: string;
  deviceName: string;
  status: string; // 'PENDING' | 'REDEEMED' | 'EXPIRED' (bkz. backend)
  expiresAt: string;
  redeemedDeviceId: string | null;
  redeemedAt: string | null;
  createdAt: string;
}

/** FE-809 AC: "Strapping table yüklemesi hata raporuyla birlikte çalışmalıdır." FUEL-403.1. */
export interface StrappingUploadError {
  row: number;
  message: string;
}

/** FE-811 AC: "Acil durdurma onay gerektirmeli ve audit'lenmelidir." */
export interface SiteEmergencyStatus {
  siteName: string;
  isStopped: boolean;
  blockedDeviceCount: number;
  totalDeviceCount: number;
}

// FLEET-1407 — bir aracın bakım/servis geçmişi (append-only, backend
// vehicle_maintenance_records tablosu).
export interface VehicleMaintenanceRecord {
  id: string;
  vehicleId: string;
  vehiclePlate: string;
  maintenanceType: string;
  performedAt: string;
  odometerValue: number | null;
  costAmount: number;
  operationsDescription: string;
  nextDueDate: string | null;
  nextDueMeterValue: number | null;
  createdBy: string;
  createdAt: string;
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

// FE-810 Kapsam: "Kota tanımı: litre, dönem, geçerlilik aralığı, devir
// politikası." FUEL-402.1'in zaten tam olan /quotas backend'i — GENEL,
// opsiyonel araç/şantiye kapsamlı, dönemsel kota (cross_site_permissions'ın
// kendi allowed_liters'ından AYRI bir kavram — bkz. AppContext yorumu).
export interface FuelQuota {
  id: string;
  vehiclePlate: string | null;
  siteName: string | null;
  periodType: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ONE_TIME';
  limitLiters: number;
  carryoverPolicy: 'NONE' | 'FULL' | 'CAPPED';
  periodStart: string;
  periodEnd: string;
  carriedOverLiters: number;
  validFrom: string;
  validUntil: string | null;
  status: 'AKTİF' | 'PASİF';
  createdBy: string;
}

/** FE-810 Kapsam: "Kota kullanım göstergeleri (kalan/kullanılan)." GET /quotas/:id/balance. */
export interface QuotaBalance {
  quotaId: string;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  baseLimitLiters: number;
  carriedOverLiters: number;
  effectiveLimitLiters: number;
  consumedLiters: number;
  reservedLiters: number;
  remainingLiters: number;
  computedAt: string;
}

// FE-810 AC: "Kota tükendiğinde ekrana anlık uyarı düşmelidir (FUEL-402.2)."
// Araştırıldı: GENEL fuel_quotas (yukarıdaki FuelQuota) ikmal yetkilendirmesinde
// HİÇ kontrol edilmiyor (yalnızca bakiye gösterimi için var) — gerçek zamanlı
// reddedilen TEK kota mekanizması çapraz şantiye izninin (cross_site_permissions)
// kendisidir. Bu yüzden bu uyarı o mekanizmanın backend 'quota:exhausted'
// Socket.io olayının payload'ıdır.
export interface QuotaExhaustedAlert {
  vehiclePlate: string;
  homeSite: string | null;
  targetSite: string;
  permissionId: string | null;
  allowedLiters: number | null;
  usedLiters: number | null;
  occurredAt: string;
}

/**
 * FE-810 Kapsam: "Mahsuplaşma özetine hızlı erişim (REP-715)." Zaten var olan
 * genel /reports/:reportId ucunun rep-715-mahsup tanımından (backend
 * rep715CrossSite.ts) dönen satırların, bu sayfadaki küçük özet widget'ı
 * için kullanılan alt kümesi — tam rapor görüntüleyici İCAT EDİLMEDİ.
 */
export interface CrossSiteSettlementSummaryRow {
  id: string;
  siteA: string;
  siteB: string;
  monthLabel: string;
  movementCount: number;
  netCost: number;
  debtor: string | null;
  creditor: string | null;
  netAmount: number;
}

export interface HardwareDevice {
  id: string;
  deviceCode: string;
  name: string;
  type: 'Debimetre & Solenoid' | 'Ultrasonik Tank Sensörü' | 'RFID Okuyucu' | 'Master Gateway';
  siteName: string;
  status: 'ONLINE' | 'OFFLINE' | 'SİNYAL_ZAYIF';
  // Bu alanlar yalnızca cihaz gerçekten MQTT üzerinden veri gönderdiğinde
  // dolar (IOT-302 binary payload'ından); hiç bağlanmamış bir cihaz için
  // bilinmez — sahte değer üretmek yerine undefined bırakılır.
  companyName?: string;
  firmwareVersion?: string;
  ipAddress?: string;
  signalRssi?: number;
  lastPing?: string;
  // FE-806: device_presence_events/device_health_scores'tan (GET /devices) — hiç veri yoksa null.
  lastHeartbeatAt: string | null;
  healthScore: number | null;
}

/** FE-806: GET /admin/system-metrics — OPS-1107'nin ZATEN var olan Prometheus registry'sinden okunan özet. */
export interface SystemMetricsSnapshot {
  mqtt: { messagesTotal: number; errorsTotal: number; rejectedTotal: number };
  devices: Record<string, number>; // state -> count (registered/active/offline/blocked)
  despatchQueue: Record<string, number> & { oldestQueuedAgeSeconds: number }; // status -> count + yaş
  notifications: { retryQueue: number; circuitOpenChannels: number };
  despatchIntegratorCircuitOpen: boolean;
  http: { totalRequests: number; errorRequests: number; errorRatePct: number };
  dbPool: Record<string, number>; // state -> count (total/idle/waiting)
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
