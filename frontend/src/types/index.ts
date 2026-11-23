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
  // FE-814 — FUEL-404.1'in GERÇEKTEN uygulanmış (ack'lenmiş) k_factor'ü;
  // önceden bu listede hiç yoktu.
  kFactor: number | null;
}

// FE-814 Kapsam: "Cihaz kalibrasyon ekranı." FUEL-404.1 — APPEND-ONLY komut
// geçmişi. `status`: IKINCI_ONAY_BEKLIYOR (±%20 eşiği aşıldı, cihaza HENÜZ
// gönderilmedi) | BEKLIYOR (gönderildi, ack bekleniyor) | ONAYLANDI (cihaz
// ack'ledi, k_factor GERÇEKTEN uygulandı) | REDDEDILDI (cihaz NACK) |
// ZAMAN_ASIMI (5 dk içinde ack gelmedi — "ulaşmadı", BAŞARI DEĞİL).
export type CalibrationCommandStatus = 'IKINCI_ONAY_BEKLIYOR' | 'BEKLIYOR' | 'ONAYLANDI' | 'REDDEDILDI' | 'ZAMAN_ASIMI';

export interface CalibrationCommand {
  id: string;
  deviceId: string;
  previousKFactor: number | null;
  newKFactor: number;
  reason: string;
  referenceMeasurement: { referenceVolumeLiters?: number; measuredLiters?: number; ambientTemperatureCelsius?: number } | null;
  requestedBy: string;
  requiresSecondApproval: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  status: CalibrationCommandStatus;
  sentAt: string | null;
  ackedAt: string | null;
  isRollback: boolean;
  createdAt: string;
}

// FE-814 Kapsam: "Test alım sihirbazı ... sapma ... önerilen K-factor."
// FUEL-404.2 — referans kap ölçümünün backend'de sapma/öneri hesabı.
export interface CalibrationTestIntake {
  id: string;
  deviceId: string;
  tankName: string;
  referenceVolumeLiters: number;
  measuredLiters: number;
  ambientTemperatureCelsius: number | null;
  kFactorAtTest: number;
  deviationRatio: number;
  proposedKFactor: number;
  verifiesCalibrationCommandId: string | null;
  requestedBy: string;
  createdAt: string;
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

// FE-815 Kapsam: "Alarm/anomali merkezi." AI-507'nin zaten tam olan birleşik
// alarm yaşam döngüsü (gruplama/durum/atama/susturma/eskalasyon) — önceden
// frontend'de hiç arayüzü yoktu (NotificationsPage.tsx tanks'tan TÜRETİLMİŞ
// bir mock'tu, gerçek /alarms ucunu hiç kullanmıyordu).
export type AlarmSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlarmStatus = 'OPEN' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'RESOLVED' | 'FALSE_POSITIVE';

export interface AlarmEvent {
  id: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

export interface Alarm {
  id: string;
  alarmKey: string;
  category: string;
  severity: AlarmSeverity;
  title: string;
  siteName: string | null;
  subjectType: string | null;
  subjectId: string | null;
  status: AlarmStatus;
  assigneeId: string | null;
  eventCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  snoozedUntil: string | null;
  escalationLevel: number;
  escalatedAt: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  sourceRef: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  /** Yalnızca GET /alarms/:id — bkz. useAlarms.ts fetchAlarm. */
  events?: AlarmEvent[];
}

/** FE-815 — alarm atama dropdown'u (GET /users, bu PR'da eklenen küçük bir uç). */
export interface TenantUser {
  id: string;
  username: string;
  role: string;
  siteName: string | null;
}

/** NOTIF-1605 — kullanıcının kendi tercihi (event tipi × kanal). */
export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'SMS' | 'TELEGRAM' | 'WEBHOOK';
export interface UserNotificationPreference {
  id: string;
  eventType: string;
  channel: NotificationChannel;
  enabled: boolean;
  updatedAt: string;
}

export interface UserNotificationMute {
  id: string;
  eventType: string | null;
  mutedUntil: string;
  createdAt: string;
}

// Backend Socket.io 'alarm:raised' olayının payload'ı (bkz. tenantDb.ts raiseAlarm).
export interface AlarmRaisedEvent {
  id: string;
  category: string;
  severity: AlarmSeverity;
  title: string;
  siteName: string | null;
  status: AlarmStatus;
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

// FE-813 Kapsam: "Km/motor-saat giriş ekranı." Backend (FLEET-1404 +
// RES-903, vehicle_meter_readings) zaten tamdı — APPEND-ONLY (bir düzeltme
// eski satırı SİLMEZ, correctsReadingId ile yeni bir satır ekler).
export type MeterType = 'KM' | 'MOTOR_SAAT';

export interface MeterReading {
  id: string;
  vehicleId: string;
  vehiclePlate: string;
  meterType: MeterType;
  value: number;
  readingAt: string;
  periodLabel: string;
  source: 'MANUEL' | 'TOPLU' | 'IKMAL';
  isSuspicious: boolean;
  suspicionReasons: string[];
  overrideApproved: boolean;
  overrideReason: string | null;
  approvedBy: string | null;
  correctsReadingId: string | null;
  note: string | null;
  enteredBy: string;
  createdAt: string;
}

/**
 * RES-903 AC: "Doğrulama uyarısı girişi engellememeli, onay isteyerek
 * geçişe izin vermelidir." Backend şüpheli bir girişi `overrideReason`
 * olmadan 409 METER_READING_SUSPICIOUS ile reddeder — bu, apiFetch'in
 * err.details'inde taşınan payload'ın şekli (bkz. useMeterReadings.ts).
 */
export interface MeterReadingSuspicionDetail {
  error: 'METER_READING_SUSPICIOUS';
  reasons: ('BACKWARD' | 'ABSURD_JUMP' | 'DUPLICATE_PERIOD')[];
  // backend/src/fleet/meterValidation.ts MeterCheckResult['detail'] — bir
  // metin DEĞİL, yapılandırılmış bir ölçüm nesnesi (doğrudan JSX child
  // olarak render edilemez — bkz. useMeterReadings.ts formatSuspicionDetail).
  detail: { dailyMax: number; elapsedDays?: number; deltaValue?: number; impliedDaily?: number };
  requiresOverride: true;
}

export interface BulkMeterResultRow {
  vehiclePlate: string;
  ok: boolean;
  readingId?: string;
  suspicious?: boolean;
  reasons?: string[];
  error?: string;
  message?: string;
}

export interface MissingMeterReadings {
  periodLabel: string;
  missingCount: number;
  bySite: Array<{ siteName: string; plates: string[] }>;
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

// FE-812 Kapsam: "Satır detayında ... e-İrsaliye durumu." GET
// /transactions/:id/e-irsaliye/status — önceden hiçbir frontend sayfası bu
// ucu KULLANMIYORDU. Bu ikmal için henüz üretilmiş bir e-İrsaliye yoksa
// backend 404 döner (status endpoint'i, üretim ucu DEĞİL) — frontend bunu
// hata göstermeden "Henüz oluşturulmadı" olarak ele alır.
export interface DespatchAdviceStatus {
  despatchAdviceDocumentId: string;
  transactionId: string;
  documentNumber: string;
  status: 'ISSUED' | 'REJECTED' | 'CANCELLED' | 'SUPERSEDED';
  rejectReason: string | null;
  rejectedAt: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  supersededByDocumentNumber: string | null;
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

// FE-816 — REP-703 ortak rapor çatısı + REP-705 zamanlanmış gönderim + REP-723
// yönetici özet dashboard'unun backend'i zaten tamdı; bu tipler o backend'in
// JSON sözleşmesinin birebir frontend karşılığı (bkz. reports/reportTypes.ts).
export type ReportFilterType = 'exact' | 'ilike' | 'dateFrom' | 'dateToExclusiveNextDay' | 'in' | 'numberGte' | 'numberLte';

export interface ReportFilterDef {
  key: string;
  type: ReportFilterType;
  label: string;
}

export interface ReportColumnDef {
  key: string;
  header: string;
  width?: number;
}

/** GET /reports — kullanıcının rolüne göre görebileceği rapor tanımları. */
export interface ReportCatalogEntry {
  id: string;
  title: string;
  description: string;
  filters: ReportFilterDef[];
  columns: ReportColumnDef[];
}

export interface ReportRunResult {
  data: Record<string, unknown>[];
  pagination: { page: number; pageSize: number; totalCount: number; totalPages: number };
  aggregates: Record<string, number>;
  sort: { column: string; direction: 'ASC' | 'DESC' };
}

export interface DashboardDrilldown {
  reportId: string;
  query: Record<string, string>;
  path: string;
}

export interface DashboardKpi {
  value: number;
  unit: string;
  label: string;
  drilldown: DashboardDrilldown;
}

export interface ExecutiveDashboard {
  generatedAt: string;
  windowDays: number;
  scope: { siteName: string | null };
  kpis: Record<string, DashboardKpi>;
  trends: {
    dailyConsumption: Array<{ date: string; liters: number; transactions: number }>;
    dailyCost: Array<{ date: string; cost: number }>;
    stockLevel: Array<{ date: string; liters: number }>;
    currentStockLiters: number;
  };
  topVehicles: Array<{ vehiclePlate: string; liters: number; cost: number; transactions: number; drilldown: DashboardDrilldown }>;
  topSites: Array<{ siteName: string; monthLiters: number; monthCost: number; todayLiters: number; drilldown: DashboardDrilldown }>;
  tanks: Array<{ id: string; siteName: string; tankName: string; fuelType: string; capacityLiters: number; levelLiters: number; fillPct: number | null; isCritical: boolean }>;
  exports: { csv: string; pdf: string; tanksCsv: string };
}

export type ReportSchedulePeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type ReportDeliveryStatus = 'BEKLIYOR' | 'GÖNDERILDI' | 'BAŞARISIZ' | 'KALICI_BAŞARISIZ' | 'ATLANDI_BOŞ';

export interface ReportSchedule {
  id: string;
  reportId: string;
  filters: Record<string, string>;
  format: string;
  periodType: ReportSchedulePeriod;
  sendHourLocal: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  recipientUserIds: string[];
  skipIfEmpty: boolean;
  siteScope: string | null;
  enabled: boolean;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportDelivery {
  id: string;
  status: ReportDeliveryStatus;
  attempts: number;
  rowCount: number | null;
  deliveryMode: 'ATTACHMENT' | 'LINK' | null;
  fileSizeBytes: number | null;
  expiresAt: string | null;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}
