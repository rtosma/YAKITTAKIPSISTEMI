/**
 * ARCH-107 (#123) — veri saklama (retention) KATALOĞU: schema.sql'deki HER tablo tam olarak bir sınıfa
 * atanır (test_arch107_retention.ts bunu schema.sql ile karşılaştırır — yeni bir tablo sınıflandırılmadan
 * eklenirse CI kırmızı yanar; "unutulan tablo" ya süresiz şişer ya da yanlışlıkla silinir).
 *
 *  - PURGEABLE : süresi dolunca (tenant bazında yapılandırılabilir) ARŞİVE ALINARAK silinir.
 *  - PROTECTED : mali/mevzuat kaydı — HİÇBİR koşulda otomatik silinmez (purge kodu bu tablolara erişemez:
 *                SQL yalnızca PURGEABLE girdilerinin sabit tablo/sütun adlarından üretilir).
 *  - MANAGED   : kendi yaşam döngüsü/süpürücüsü olan tablolar (tenant_archives → REP-702 expires_at).
 *  - MASTER    : ana veri, ayar ve operasyonel durum — tenant yaşadığı sürece tutulur; tenant silinince
 *                ARCH-108 ile gider. Kişisel veri barındıranların anonimleştirilmesi COMP-606'nın konusudur.
 *
 * KAPSAM UYARLAMASI: ticket TimescaleDB retention policy + BullMQ/@nestjs/schedule öneriyor — bu yığında
 * TimescaleDB, hypertable ve ham telemetri tablosu YOK (bkz. tenantArchiveService.ts "KAPSAM UYARLAMASI 2":
 * telemetri olay veri yolu + Redis presence; kalıcı günlük yok). "Ham telemetri" sınıfı bu yüzden EXTERNAL
 * olarak belgelenir; ilişkisel tablolar için index.ts'teki düz setInterval süpürücü deseni kullanılır.
 */

export type PurgeableClass =
  | 'AUDIT_LOG' | 'NOTIFICATION' | 'ALARM' | 'ALARM_EVENT' | 'DEVICE_PRESENCE'
  | 'REPORT_DELIVERY' | 'CROSS_SITE_DENIAL' | 'DRIVER_SCORE' | 'DEVICE_HEALTH_SCORE';

export interface PurgeableSpec {
  dataClass: PurgeableClass;
  label: string;
  /** SABİT kod sabitleri — SQL'e yalnızca buradan girer, asla istemci girdisi değil. */
  table: string;
  timestampColumn: string;
  /** Silinmeye uygun satır koşulu (ör. çözülmüş alarm, teslim edilmiş bildirim). Tablo takma adı: t. */
  predicate: string | null;
  defaultDays: number;
  /** Tenant'ın ayarlayabileceği EN KISA süre (taban). */
  minDays: number;
  /** Arşivde tutulmayan (yeniden üretilebilir, ağır) sütunlar. */
  archiveExcludeColumns: string[];
  rationale: string;
}

export const MAX_RETENTION_DAYS = 3650;

export const PURGEABLE_CLASSES: readonly PurgeableSpec[] = [
  { dataClass: 'AUDIT_LOG', label: 'Denetim günlüğü (audit_logs)', table: 'audit_logs', timestampColumn: 'created_at', predicate: null, defaultDays: 1825, minDays: 730, archiveExcludeColumns: [],
    rationale: 'Güvenlik/sorumluluk izi; uzun tutulur (5 yıl varsayılan, en az 2 yıl). Uygulama rolü DELETE yapamaz (AUTH-203) — yalnızca retention işi (yönetim bağlantısı) siler.' },
  { dataClass: 'NOTIFICATION', label: 'Bildirimler (notifications)', table: 'notifications', timestampColumn: 'created_at', predicate: "t.status NOT IN ('BEKLIYOR', 'BAŞARISIZ')", defaultDays: 180, minDays: 30, archiveExcludeColumns: [],
    rationale: 'Yalnızca sonuçlanmış (teslim edilmiş/kalıcı başarısız) bildirimler; bekleyen/yeniden denenecek olanlara dokunulmaz.' },
  { dataClass: 'ALARM', label: 'Çözülmüş alarmlar (alarms)', table: 'alarms', timestampColumn: 'resolved_at', predicate: "t.status = 'RESOLVED'", defaultDays: 730, minDays: 180, archiveExcludeColumns: [],
    rationale: 'Yalnızca ÇÖZÜLMÜŞ alarmlar (açık/ertelenmiş alarmlar yaşına bakılmaksızın korunur).' },
  { dataClass: 'ALARM_EVENT', label: 'Alarm olayları (alarm_events)', table: 'alarm_events', timestampColumn: 'occurred_at',
    predicate: "NOT EXISTS (SELECT 1 FROM alarms a WHERE a.id = t.alarm_id AND a.status <> 'RESOLVED')", defaultDays: 365, minDays: 90, archiveExcludeColumns: [],
    rationale: 'Açık bir alarma bağlı olaylar korunur; çözülmüş/artık var olmayan alarmların olayları yaşlanınca silinir.' },
  { dataClass: 'DEVICE_PRESENCE', label: 'Cihaz çevrimiçi/çevrimdışı olayları (device_presence_events)', table: 'device_presence_events', timestampColumn: 'occurred_at', predicate: null, defaultDays: 365, minDays: 90, archiveExcludeColumns: [],
    rationale: 'Cihaz sağlığı skorları (IOT-308) bu olaylardan hesaplanır; skor pencereleri ≤ 90 gün, dolayısıyla 90 gün taban.' },
  { dataClass: 'REPORT_DELIVERY', label: 'Zamanlanmış rapor teslim kayıtları (report_deliveries)', table: 'report_deliveries', timestampColumn: 'created_at', predicate: "t.status NOT IN ('BEKLIYOR', 'BAŞARISIZ')", defaultDays: 365, minDays: 30, archiveExcludeColumns: ['file_data'],
    rationale: 'Teslim edilmiş raporun ekli dosyası (file_data) rapor motorundan yeniden üretilebilir → arşive alınmaz (yalnızca meta kayıt).' },
  { dataClass: 'CROSS_SITE_DENIAL', label: 'Çapraz alım red kayıtları (cross_site_denials)', table: 'cross_site_denials', timestampColumn: 'occurred_at', predicate: null, defaultDays: 365, minDays: 90, archiveExcludeColumns: [],
    rationale: 'İhlal denemesi izi; 1 yıl.' },
  { dataClass: 'DRIVER_SCORE', label: 'Sürücü davranış skoru geçmişi (driver_behavior_scores)', table: 'driver_behavior_scores', timestampColumn: 'computed_at', predicate: null, defaultDays: 730, minDays: 90, archiveExcludeColumns: [],
    rationale: 'Kişiye ait türetilmiş veri (sürücü adı) — gereğinden uzun tutulmaz (KVKK veri minimizasyonu, COMP-606).' },
  { dataClass: 'DEVICE_HEALTH_SCORE', label: 'Cihaz sağlık skoru geçmişi (device_health_scores)', table: 'device_health_scores', timestampColumn: 'computed_at', predicate: null, defaultDays: 365, minDays: 90, archiveExcludeColumns: [],
    rationale: 'Türetilmiş metrik geçmişi.' }
] as const;

/**
 * COMP-606 (#132): süresi dolunca SİLİNMEZ, KİŞİSEL ALANLARI ANONİMLEŞTİRİLİR (kayıt, ilişkili işlem/ikmal ve tutarlar
 * korunur — mali bütünlük). Süre "aktif olmama" (deactivated_at) anından sayılır; aktif kayıtlar hiçbir zaman dolmaz.
 */
export interface ConfigurableSpec {
  dataClass: string;
  kind: 'PURGE' | 'ANONYMIZE' | 'COLD_ARCHIVE';
  label: string;
  table: string;
  defaultDays: number;
  minDays: number;
  rationale: string;
}

export const ANONYMIZABLE_CLASSES: readonly ConfigurableSpec[] = [
  { dataClass: 'DRIVER_PII', kind: 'ANONYMIZE', label: 'Aktif olmayan sürücünün kişisel verisi (drivers)', table: 'drivers', defaultDays: 1825, minDays: 365,
    rationale: 'Ad, TCKN, telefon, ehliyet, RFID kart no. Sürücü aktif olmaktan çıktıktan sonra amaç sona erer; işlem/ikmal kayıtları takma adla kalır (mali kayıt).' },
  { dataClass: 'PERSONNEL_PII', kind: 'ANONYMIZE', label: 'Pasif personelin kişisel verisi (personnel)', table: 'personnel', defaultDays: 3650, minDays: 1825,
    rationale: 'Personel özlük kayıtları için uzun yasal saklama süreleri olabilir (varsayılan 10 yıl, taban 5 yıl); hukuk müşaviri onayıyla ayarlayın.' }
] as const;

/** ARCH-107 soğuk arşivleri kişisel veri (ad, TCKN...) içerebilir → süresiz tutulamaz (KVKK). */
export const COLD_ARCHIVE_CLASS: ConfigurableSpec = {
  dataClass: 'COLD_ARCHIVE', kind: 'COLD_ARCHIVE', label: 'Retention soğuk arşivleri (retention_archives)', table: 'retention_archives', defaultDays: 1825, minDays: 365,
  rationale: 'Purge öncesi alınan arşivler silinen satırların (kişisel veri dahil) kopyasıdır; oluşturulmalarından itibaren bu süre sonra silinir. (Arşivin arşivi tutulmaz — silme audit log\'a yazılır.)'
};

/** Mali kayıt / mevzuat: ASLA otomatik silinmez. `minYears` bilgilendirici saklama önerisidir (uygulama silmez). */
export const PROTECTED_TABLES: Readonly<Record<string, { minYears: number; reason: string }>> = {
  transactions: { minYears: 10, reason: 'Mali kayıt (ikmal hareketi) — değişmezlik mührü (FUEL-401.4); önerilen saklama 10 yıl.' },
  despatch_advice_documents: { minYears: 10, reason: 'e-İrsaliye — belge numaralandırması boşluksuz olmalı (COMP-601); REVOKE ile append-only.' },
  despatch_advice_counters: { minYears: 10, reason: 'e-İrsaliye sıra sayacı.' },
  despatch_advice_transmissions: { minYears: 10, reason: 'e-İrsaliye iletim/durum kaydı (GİB kanıtı).' },
  despatch_advice_documents_status: { minYears: 10, reason: 'e-İrsaliye durum geçmişi.' },
  fuel_intake_receipts: { minYears: 10, reason: 'Yakıt alım (dolum) irsaliyesi — mali/stok kaydı.' },
  fuel_purchase_waybills: { minYears: 10, reason: 'Alım irsaliyesi başlığı (INV-1502) — KDV/ÖTV/toplam tutarlı mali kayıt, fuel_intake_receipts ile aynı gerekçe.' },
  stock_reconciliations: { minYears: 10, reason: 'Stok mutabakatı — denetim kaydı.' },
  inventory_movements: { minYears: 10, reason: 'Envanter hareketi — mali/stok kaydı.' },
  fire_records: { minYears: 10, reason: 'Fire (kayıp) kaydı — mali/denetim.' },
  calibration_commands: { minYears: 10, reason: 'Kalibrasyon geçmişi silinemez (FUEL-404.1).' },
  calibration_test_intakes: { minYears: 10, reason: 'Kalibrasyon test alım kaydı.' },
  manual_dispense_requests: { minYears: 10, reason: 'Manuel ikmal talebi/onayı — mali işlem izi.' },
  transaction_anomaly_flags: { minYears: 10, reason: 'Mali işlem anomali işaretleri — denetim.' },
  fuel_quota_history: { minYears: 10, reason: 'Kota değişiklik geçmişi — denetim.' },
  usage_metering_records: { minYears: 10, reason: 'Faturalamaya esas kullanım ölçümü (BILL-1701).' },
  lab_samples: { minYears: 10, reason: 'Laboratuvar numune kaydı — kalite/mevzuat.' },
  lab_test_results: { minYears: 10, reason: 'Laboratuvar test sonucu — kalite/mevzuat.' },
  vehicle_documents: { minYears: 10, reason: 'Araç belgeleri (ruhsat/sigorta vb.) — yasal belge.' },
  platform_audit_log: { minYears: 10, reason: 'Kalıcı tenant silme kararlarının tek kalıcı kaydı (ARCH-108).' },
  tenant_deletion_approvals: { minYears: 10, reason: 'Tenant silme onay kaydı (ARCH-108).' }
};

/** Kendi süpürücüsü olan tablolar. */
export const MANAGED_TABLES: Readonly<Record<string, string>> = {
  tenant_archives: 'REP-702: dosya içeriği expires_at sonrası sweepExpiredArchives ile temizlenir (satır/denetim izi kalır).',
  retention_archives: 'ARCH-107/COMP-606: soğuk arşiv; COLD_ARCHIVE süresi (varsayılan 5 yıl) dolunca silinir (bkz. docs/DATA_RETENTION.md).'
};

/** Tablo olarak var olmayan / harici sistemlerde tutulan veri sınıfları (bilgilendirme; purge kodu yok). */
export const EXTERNAL_CLASSES: ReadonlyArray<{ dataClass: string; label: string; where: string; retention: string }> = [
  { dataClass: 'RAW_TELEMETRY', label: 'Ham telemetri', where: 'Kalıcı tablo YOK (olay veri yolu + Redis presence TTL)', retention: 'Kalıcı saklanmaz; Redis presence anahtarları TTL ile kendiliğinden düşer.' },
  { dataClass: 'SYSTEM_LOG', label: 'Sistem logu', where: 'Loki (deploy/monitoring/loki.yml)', retention: 'retention_period ile sınırlı (varsayılan 14 gün); loglarda kişisel veri yazılmaz (COMP-606).' }
];

/** Bu tablolar MASTER: ana veri/ayar/durum — tenant ömrü boyunca. */
export const MASTER_TABLES: readonly string[] = [
  'companies', 'company_module_addons', 'vehicles', 'vehicle_site_assignments', 'tanks', 'drivers', 'personnel', 'leave_requests',
  'cross_site_permissions', 'hardware_devices', 'device_claim_codes', 'fail_open_policies', 'consumption_anomaly_reports',
  'tank_strapping_tables', 'rfid_card_blacklist', 'fuel_quotas', 'users', 'site_working_hours', 'user_totp', 'vehicle_meter_readings',
  'recipient_taxpayers', 'vehicle_fuel_limits', 'vehicle_maintenance_records', 'vehicle_compliance_deadlines', 'vehicle_tires',
  'vehicle_document_download_links', 'inventory_items', 'sites', 'firmware_artifacts', 'firmware_rollouts', 'firmware_rollout_devices',
  'sms_monthly_usage', 'tenant_notification_channels', 'user_notification_preferences', 'user_notification_mutes', 'report_schedules', 'monthly_management_reports',
  'fuel_budgets', 'tenant_retention_settings', 'data_subject_requests', 'suppliers'
];

export function getConfigurableSpec(dataClass: string): ConfigurableSpec | undefined {
  const p = getPurgeableSpec(dataClass);
  if (p) return { dataClass: p.dataClass, kind: 'PURGE', label: p.label, table: p.table, defaultDays: p.defaultDays, minDays: p.minDays, rationale: p.rationale };
  if (dataClass === COLD_ARCHIVE_CLASS.dataClass) return COLD_ARCHIVE_CLASS;
  return ANONYMIZABLE_CLASSES.find((c) => c.dataClass === dataClass);
}

export function getPurgeableSpec(dataClass: string): PurgeableSpec | undefined {
  return PURGEABLE_CLASSES.find((c) => c.dataClass === dataClass);
}

/** Şemadaki bir tablonun sınıfı (sınıflandırılmamışsa null → CI hatası). */
export function classifyTable(table: string): 'PURGEABLE' | 'PROTECTED' | 'MANAGED' | 'MASTER' | null {
  if (PURGEABLE_CLASSES.some((c) => c.table === table)) return 'PURGEABLE';
  if (table in PROTECTED_TABLES) return 'PROTECTED';
  if (table in MANAGED_TABLES) return 'MANAGED';
  if (MASTER_TABLES.includes(table)) return 'MASTER';
  return null;
}
