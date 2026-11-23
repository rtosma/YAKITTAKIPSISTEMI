/**
 * COMP-606 (#132) — KİŞİSEL VERİ ENVANTERİ (KVKK m.16 VERBİS/envanter yükümlülüğünün teknik karşılığı).
 *
 * Bu dosya envanterin TEK kaynağıdır: docs/KVKK_ENVANTER.md ve GET /privacy/inventory buradan üretilir/doğrulanır.
 * `test_comp606_kvkk.ts`, schema.sql'de kişisel veri adı taşıyan HER sütunun (tc_no, phone, email, *driver_name, full_name,
 * username, ip_address, rfid_card_id, license_type, address...) burada yer almasını zorunlu kılar: yeni bir kişisel veri
 * sütunu envantere girmeden eklenirse CI kırmızı yanar.
 *
 * NOT (hukuki): "legalBasis" alanı TEKNİK ekibin önerisidir (KVKK m.5/2 bentleri); nihai hukuki değerlendirme ve aydınlatma
 * metinleri hukuk müşavirinin sorumluluğundadır.
 */
export type PiiCategory = 'IDENTITY' | 'NATIONAL_ID' | 'CONTACT' | 'CREDENTIAL' | 'ACCOUNT' | 'NETWORK' | 'BUSINESS_ADDRESS';

export interface PiiInventoryEntry {
  table: string;
  column: string;
  category: PiiCategory;
  subjects: string;       // veri sahibi grubu
  purpose: string;        // işleme amacı
  legalBasis: string;     // KVKK m.5/2 (öneri)
  retention: string;      // ARCH-107 sınıfı / süre
  access: string;         // rol bazlı erişim
  protection: string;     // maskeleme / anonimleştirme / log
}

const FULL_ROLES = 'Tam: SUPER_ADMIN, COMPANY_OWNER, SITE_MANAGER; diğer tüm roller maskeli';
const DRIVER_RETENTION = 'DRIVER_PII: aktif olmayan sürücü için 5 yıl sonra anonimleştirilir (tenant ayarlı, taban 1 yıl)';
const NAME_PROTECTION = 'Rapor çıktısında rol bazlı maske (REP-720); anonimleştirmede takma ada çevrilir; dış servise (AI) takma adla gider';

export const PII_INVENTORY: readonly PiiInventoryEntry[] = [
  { table: 'drivers', column: 'name', category: 'IDENTITY', subjects: 'Sürücüler', purpose: 'İkmal yetkilendirme ve sürücü bazlı raporlama', legalBasis: 'm.5/2-c sözleşmenin ifası; ç hukuki yükümlülük (e-İrsaliye)', retention: DRIVER_RETENTION, access: 'Tüm roller okuyabilir (operasyonel)', protection: NAME_PROTECTION },
  { table: 'drivers', column: 'tc_no', category: 'NATIONAL_ID', subjects: 'Sürücüler', purpose: 'e-İrsaliye taşıyıcı/şoför bilgisi (yasal zorunluluk) ve kimlik doğrulama', legalBasis: 'm.5/2-ç hukuki yükümlülük', retention: DRIVER_RETENTION, access: FULL_ROLES, protection: 'API yanıtında rol bazlı maske (123******01); loglarda [TCKN]; anonimleştirmede ANON-… yer tutucu' },
  { table: 'drivers', column: 'phone', category: 'CONTACT', subjects: 'Sürücüler', purpose: 'Operasyonel iletişim', legalBasis: 'm.5/2-f meşru menfaat', retention: DRIVER_RETENTION, access: FULL_ROLES, protection: 'API yanıtında rol bazlı maske (son 2 hane); loglarda [TEL]; anonimleştirmede silinir' },
  { table: 'drivers', column: 'license_type', category: 'CREDENTIAL', subjects: 'Sürücüler', purpose: 'Araç/makine kullanım yetkinliği', legalBasis: 'm.5/2-c sözleşmenin ifası', retention: DRIVER_RETENTION, access: 'Tüm roller okuyabilir', protection: 'Anonimleştirmede silinir' },
  { table: 'drivers', column: 'rfid_card_id', category: 'CREDENTIAL', subjects: 'Sürücüler', purpose: 'RFID ile ikmal yetkilendirme (kişiye bağlı kimlik bilgisi)', legalBasis: 'm.5/2-c sözleşmenin ifası', retention: DRIVER_RETENTION, access: 'Tüm roller okuyabilir', protection: 'Anonimleştirmede benzersiz yer tutucuyla değiştirilir (kart artık kullanılamaz)' },
  { table: 'personnel', column: 'full_name', category: 'IDENTITY', subjects: 'Personel', purpose: 'Personel/izin yönetimi', legalBasis: 'm.5/2-c sözleşmenin ifası; ç iş hukuku yükümlülükleri', retention: 'PERSONNEL_PII: pasif personel için 10 yıl sonra anonimleştirilir (tenant ayarlı, taban 5 yıl)', access: 'HR rolleri (SUPER_ADMIN, COMPANY_OWNER, SITE_MANAGER)', protection: NAME_PROTECTION },
  { table: 'personnel', column: 'tc_no', category: 'NATIONAL_ID', subjects: 'Personel', purpose: 'Personel kimlik kaydı', legalBasis: 'm.5/2-ç hukuki yükümlülük', retention: 'PERSONNEL_PII', access: FULL_ROLES, protection: 'API yanıtında rol bazlı maske; loglarda [TCKN]; anonimleştirmede silinir' },
  { table: 'users', column: 'username', category: 'ACCOUNT', subjects: 'Panel kullanıcıları', purpose: 'Kimlik doğrulama', legalBasis: 'm.5/2-c sözleşmenin ifası', retention: 'Hesap yaşadığı sürece; tenant silinince ARCH-108 ile', access: 'Yönetici rolleri', protection: 'Loglarda takma ad (pii:xxxxxxxx)' },
  { table: 'users', column: 'email', category: 'CONTACT', subjects: 'Panel kullanıcıları', purpose: 'Bildirim/şifre sıfırlama', legalBasis: 'm.5/2-c sözleşmenin ifası', retention: 'Hesap yaşadığı sürece', access: 'Kendisi + yönetici', protection: 'Loglarda [EMAIL]; bounce durumunda işaretlenir' },
  { table: 'users', column: 'phone', category: 'CONTACT', subjects: 'Panel kullanıcıları', purpose: 'SMS bildirimi', legalBasis: 'm.5/2-c sözleşmenin ifası (kullanıcı tercihi)', retention: 'Hesap yaşadığı sürece', access: 'Kendisi + yönetici', protection: 'Loglarda [TEL]' },
  { table: 'audit_logs', column: 'ip_address', category: 'NETWORK', subjects: 'Panel kullanıcıları', purpose: 'Güvenlik denetim izi', legalBasis: 'm.5/2-ç hukuki yükümlülük; f meşru menfaat (güvenlik)', retention: 'AUDIT_LOG: 5 yıl (taban 2 yıl); arşiv COLD_ARCHIVE ile sınırlı', access: 'Denetim raporu yetkili roller', protection: 'Append-only (AUTH-203); soğuk arşiv şifreli' },
  { table: 'transactions', column: 'driver_name', category: 'IDENTITY', subjects: 'Sürücüler', purpose: 'İkmal hareketinin sürücüye atfı (mali kayıt)', legalBasis: 'm.5/2-ç hukuki yükümlülük', retention: 'Mali kayıt asla silinmez; ad, sürücü anonimleştirilince takma adla değiştirilir (tutar/plaka/tarih/mühür KORUNUR)', access: 'Rapor rol bazlı maske (REP-720)', protection: NAME_PROTECTION },
  { table: 'manual_dispense_requests', column: 'driver_name', category: 'IDENTITY', subjects: 'Sürücüler', purpose: 'Manuel ikmal talebi/onayı', legalBasis: 'm.5/2-ç hukuki yükümlülük', retention: 'Mali kayıt (PROTECTED); anonimleştirmede takma ad', access: 'Yönetici rolleri', protection: NAME_PROTECTION },
  { table: 'transaction_anomaly_flags', column: 'driver_name', category: 'IDENTITY', subjects: 'Sürücüler', purpose: 'İşlem anomali denetimi', legalBasis: 'm.5/2-f meşru menfaat', retention: 'Mali denetim kaydı (PROTECTED); anonimleştirmede takma ad', access: 'Yönetici rolleri', protection: NAME_PROTECTION },
  { table: 'cross_site_permissions', column: 'driver_name', category: 'IDENTITY', subjects: 'Sürücüler', purpose: 'Çapraz şantiye alım yetkisi', legalBasis: 'm.5/2-c sözleşmenin ifası', retention: 'Yetki geçerli olduğu sürece; anonimleştirmede takma ad', access: 'Yönetici rolleri', protection: NAME_PROTECTION },
  { table: 'driver_behavior_scores', column: 'driver_name', category: 'IDENTITY', subjects: 'Sürücüler', purpose: 'Sürücü davranış skoru (AI-506) — profilleme', legalBasis: 'm.5/2-f meşru menfaat', retention: 'DRIVER_SCORE: 2 yıl (taban 90 gün), arşivlenip silinir', access: 'Yönetici rolleri', protection: NAME_PROTECTION },
  { table: 'vehicles', column: 'assigned_driver_name', category: 'IDENTITY', subjects: 'Sürücüler', purpose: 'Araç-sürücü zimmeti (RFID ile ikmal eşleştirme)', legalBasis: 'm.5/2-c sözleşmenin ifası', retention: 'Zimmet süresince; anonimleştirmede zimmet kaldırılır', access: 'Tüm roller okuyabilir (operasyonel)', protection: 'Anonimleştirmede NULL' },
  { table: 'leave_requests', column: 'reason', category: 'IDENTITY', subjects: 'Personel', purpose: 'İzin talebi gerekçesi (serbest metin — sağlık vb. özel nitelikli veri içerebilir)', legalBasis: 'm.5/2-c sözleşmenin ifası; özel nitelikli veri için m.6 koşulları hukuk müşaviriyle doğrulanmalı', retention: 'PERSONNEL_PII', access: 'HR rolleri', protection: 'Gerekçe alanı anonimleştirmede silinir; mümkünse gerekçe girilmemesi önerilir' },
  { table: 'recipient_taxpayers', column: 'address', category: 'BUSINESS_ADDRESS', subjects: 'Alıcı firmalar (tüzel kişi/şahıs firması)', purpose: 'e-İrsaliye alıcı adresi', legalBasis: 'm.5/2-ç hukuki yükümlülük', retention: 'e-İrsaliye ile birlikte (PROTECTED sınıfı ile uyumlu)', access: 'Yönetici rolleri', protection: 'Tüzel kişi verisi; şahıs firmasında kişisel veri sayılabilir' }
];

/**
 * Şoför adı başka tablolarda METİN olarak (FK olmadan) tekrarlanır. Anonimleştirme bu sütunları çevirir; drift testi
 * schema.sql'deki her `*driver_name` sütununun burada olduğunu doğrular.
 */
export const NAME_REFERENCE_COLUMNS: ReadonlyArray<{ table: string; column: string; mode: 'ALIAS' | 'NULL' }> = [
  { table: 'transactions', column: 'driver_name', mode: 'ALIAS' },
  { table: 'manual_dispense_requests', column: 'driver_name', mode: 'ALIAS' },
  { table: 'transaction_anomaly_flags', column: 'driver_name', mode: 'ALIAS' },
  { table: 'cross_site_permissions', column: 'driver_name', mode: 'ALIAS' },
  { table: 'driver_behavior_scores', column: 'driver_name', mode: 'ALIAS' },
  { table: 'vehicles', column: 'assigned_driver_name', mode: 'NULL' }
];

/** Serbest metin sütunlarında ad geçişi `replace()` ile takma ada çevrilir (kullanıcı girdisi olan diğer serbest metin alanları en iyi çaba dışıdır — docs). */
export const TEXT_REFERENCE_COLUMNS: ReadonlyArray<{ table: string; columns: string[] }> = [
  { table: 'notifications', columns: ['title', 'body'] },
  { table: 'alarms', columns: ['title'] }
];

/** Şemada bu desenlerden biriyle eşleşen HER sütun envanterde olmak zorundadır (drift testi). Plakalar bilinçli hariç (yarı-tanımlayıcı, docs). */
export const PII_COLUMN_PATTERN = /^(tc_no|phone|email|.*driver_name|full_name|username|ip_address|address|rfid_card_id|license_type)$/;

/** Bilinçli dışlananlar (desene uysa da kişisel veri DEĞİL) — "tablo.sütun" → gerekçe. Şu an yok; eklenirse gerekçe zorunlu. */
export const PII_PATTERN_EXCLUSIONS: Record<string, string> = {};
