# KVKK — kişisel veri envanteri ve işleme politikası (COMP-606)

> Kaynak: `backend/src/privacy/piiInventory.ts` (tek gerçek kaynak; `GET /api/v1/privacy/inventory` aynı listeyi döner). `test_comp606_kvkk.ts`, şemadaki her kişisel-veri sütununun
> burada olmasını zorunlu kılar (yeni sütun envantersiz eklenemez). **Hukuki not:** "Dayanak" sütunu teknik ekibin KVKK m.5/2 bentlerine göre *önerisidir*; nihai hukuki
> değerlendirme, aydınlatma metinleri, VERBİS kaydı ve saklama sürelerinin yasal yeterliliği hukuk müşavirinin sorumluluğundadır.
>
> **Kapsam uyarlaması:** Ticket "NestJS interceptor (maskeleme) + Drizzle" öneriyor; bu kod tabanı Express + ham SQL. Maskeleme, yanıtı üreten route'ların çağırdığı tek bir modülde
> (`privacy/piiPolicy.ts`) toplandı; log temizliği `logger.ts` kancasında (`privacy/piiScrub.ts`). Saklama/anonimleştirme ARCH-107 çatısının üstüne kuruludur ([DATA_RETENTION.md](DATA_RETENTION.md)).

## 1. Envanter

Roller: **Tam** = SUPER_ADMIN, COMPANY_OWNER, SITE_MANAGER (kaydı oluşturan/düzenleyen roller); diğer **tüm** roller (PUMP_OPERATOR, DRIVER, ileride eklenecekler) maskeli görür — liste dışı = maskeli (fail-closed).

| Tablo.sütun | Kategori | Veri sahibi | Amaç | Dayanak (öneri) | Saklama | Erişim | Koruma |
|---|---|---|---|---|---|---|---|
| drivers.name | Kimlik | Sürücüler | İkmal yetkilendirme, sürücü raporları | m.5/2-c, ç | DRIVER_PII (5 yıl) | Tüm roller (operasyonel) | rapor maskesi (REP-720), takma ad, dış servise takma adla |
| drivers.tc_no | Ulusal kimlik | Sürücüler | e-İrsaliye (yasal), kimlik | m.5/2-ç | DRIVER_PII | Tam roller | API maskesi `100******46`, log `[TCKN]`, anonimde `ANON-…` |
| drivers.phone | İletişim | Sürücüler | Operasyonel iletişim | m.5/2-f | DRIVER_PII | Tam roller | API maskesi (son 2 hane), log `[TEL]`, anonimde silinir |
| drivers.license_type | Yetkinlik | Sürücüler | Araç/makine yetkinliği | m.5/2-c | DRIVER_PII | Tüm roller | anonimde silinir |
| drivers.rfid_card_id | Kimlik bilgisi | Sürücüler | RFID ile ikmal yetkilendirme | m.5/2-c | DRIVER_PII | Tüm roller | anonimde benzersiz yer tutucu (kart kullanılamaz) |
| personnel.full_name | Kimlik | Personel | Personel/izin yönetimi | m.5/2-c, ç | PERSONNEL_PII (10 yıl) | HR rolleri | takma ad |
| personnel.tc_no | Ulusal kimlik | Personel | Personel kimlik kaydı | m.5/2-ç | PERSONNEL_PII | Tam roller | API maskesi, log `[TCKN]`, anonimde NULL |
| leave_requests.reason | Serbest metin (özel nitelikli olabilir) | Personel | İzin gerekçesi | m.5/2-c (+ m.6 doğrulaması) | PERSONNEL_PII | HR rolleri | anonimde silinir; gerekçe girilmemesi önerilir |
| users.username | Hesap | Panel kullanıcıları | Kimlik doğrulama | m.5/2-c | Hesap ömrü | Yöneticiler | loglarda takma ad `pii:xxxxxxxx` |
| users.email | İletişim | Panel kullanıcıları | Bildirim/şifre sıfırlama | m.5/2-c | Hesap ömrü | Kendisi + yönetici | log `[EMAIL]` |
| users.phone | İletişim | Panel kullanıcıları | SMS bildirimi | m.5/2-c | Hesap ömrü | Kendisi + yönetici | log `[TEL]` |
| audit_logs.ip_address | Ağ | Panel kullanıcıları | Güvenlik denetim izi | m.5/2-ç, f | AUDIT_LOG (5 yıl) | Denetim yetkilileri | append-only, arşiv şifreli + ömürlü |
| transactions.driver_name | Kimlik | Sürücüler | İkmalin sürücüye atfı (**mali kayıt**) | m.5/2-ç | Mali kayıt silinmez; ad anonimde takma ad | Rapor maskesi | tutar/plaka/tarih/mühür KORUNUR |
| manual_dispense_requests.driver_name | Kimlik | Sürücüler | Manuel ikmal talebi | m.5/2-ç | PROTECTED | Yöneticiler | takma ad |
| transaction_anomaly_flags.driver_name | Kimlik | Sürücüler | İşlem anomali denetimi | m.5/2-f | PROTECTED | Yöneticiler | takma ad |
| cross_site_permissions.driver_name | Kimlik | Sürücüler | Çapraz şantiye yetkisi | m.5/2-c | Yetki süresince | Yöneticiler | takma ad |
| driver_behavior_scores.driver_name | Kimlik (profilleme) | Sürücüler | Davranış skoru (AI-506) | m.5/2-f | DRIVER_SCORE (2 yıl) | Yöneticiler | takma ad; süre dolunca arşivlenip silinir |
| vehicles.assigned_driver_name | Kimlik | Sürücüler | Araç-sürücü zimmeti | m.5/2-c | Zimmet süresince | Tüm roller | anonimde zimmet kaldırılır |
| recipient_taxpayers.address | İş adresi | Alıcı firmalar | e-İrsaliye alıcı adresi | m.5/2-ç | e-İrsaliye ile | Yöneticiler | şahıs firmasında kişisel veri sayılabilir |

**Yarı-tanımlayıcılar (envanter dışı, bilinçli):** araç plakası (`*_plate`, kurumsal varlık tanımlayıcısı — sürücüyle ilişkilendirilebilir olduğundan sürücü anonimleşince tek başına kimlik vermez ama dış servise yalnızca analiz için gerekli olduğunda gider),
eylemi yapan kullanıcı id'leri (`created_by`, `user_id` — pseudonim id, ad değil), cihaz MAC adresi (cihaz tanımlayıcısı).

## 2. Erişim kısıtları ve maskeleme (AC: yetkisiz roller maskeli)

| Alan | Tam görenler | Diğer roller |
|---|---|---|
| TCKN (drivers, personnel) | SUPER_ADMIN, COMPANY_OWNER, SITE_MANAGER | `100******46` |
| Telefon | aynı | son 2 hane (`*********33`) |
| Kişi adı (raporlar) | rapor tanımındaki `piiViewerRoles` | `A*** Y***` (REP-720) |

Kural tek yerde: `privacy/piiPolicy.ts` (`canViewFullPii`, `maskDriverForRole`, `maskPersonnelForRole`). Uygulandığı uçlar: `GET /drivers`, `GET /personnel*`; raporlar REP-720 motorunda.
Yanıt kopyası maskelenir, kaynak nesne değişmez. **e-İrsaliye XML'i** yasal zorunlulukla taşıyıcı TCKN'sini içerir (yalnızca yetkili roller üretebilir).

## 3. Log ve dış servis minimizasyonu (AC: loglarda/dış servislerde kişisel veri yok)

- **Loglar:** `utils/logger.ts` her log çağrısını `privacy/piiScrub.ts`'ten geçirir: anahtar tabanlı (`tcNo, phone, email, password, token…` → `[PII]`), değer tabanlı (metin içindeki geçerli TCKN → `[TCKN]` — 11 haneli rastgele sayılar
  resmî sağlama toplamıyla ayrıştırılır; telefon → `[TEL]`; e-posta → `[EMAIL]`), kullanıcı adı/ad-soyad alanları takma ad (`pii:xxxxxxxx`, korelasyon korunur). Hata mesajları ve stack izleri de temizlenir (hata TÜRÜ korunur).
- **Otomatik kontrol:** `node scripts/check-no-pii-logging.mjs` (CI) — `logger.*(...)` çağrısında `tcNo/phone/email/password…` geçerse kırmızı. İstisna: aynı satıra `// pii-log:allow <gerekçe>`.
- **Gemini (AI-502):** şoför adları prompt'a **girmez** (`Sürücü-1`, `Sürücü-2` takma adları; yanıttaki takma adlar geri çevrilir). TCKN/telefon zaten istatistik verisinde yoktur. Plaka analiz için gider (yukarıdaki yarı-tanımlayıcı notu).
- **Sentry (RES-907):** hata olayları göndermeden önce aynı kural motoruyla (TCKN/telefon/e-posta/JWT maskesi, kullanıcı yalnızca id, URL sorgusuz, istek gövdesi/çerez yok) hem SDK `beforeSend`'inde hem sunucu tünelinde temizlenir; replay/tracing kapalı. Ayrıntı: [ERROR_TRACKING.md](ERROR_TRACKING.md).
- **Diğer dış servisler:** SMS/e-posta/Telegram sağlayıcıları yalnızca bildirimin alıcı adresini (telefon/e-posta) ve metnini alır — teslimat amacıyla zorunlu; bildirim şablonlarında TCKN yoktur.
- **Serbest metin sınırı:** kullanıcı girdisi serbest metin alanları (ör. `alarms.resolution_note`, arıza açıklamaları) otomatik taranamaz; kullanıcılara kişisel veri girmemeleri hatırlatılmalıdır.

## 4. Saklama süresi ve anonimleştirme (AC: süresi dolan kişisel veri anonimleştirilir)

| Sınıf | Varsayılan | Taban | Sayaç |
|---|---|---|---|
| `DRIVER_PII` | 1825 gün (5 yıl) | 365 | sürücü AKTİF/SAHADA/İZİNLİ dışına geçtiği andan (`drivers.deactivated_at`, tetikleyici) |
| `PERSONNEL_PII` | 3650 gün (10 yıl) | 1825 | personel PASİF'e geçtiği andan |
| `COLD_ARCHIVE` | 1825 gün | 365 | arşivin oluşturulma anından |

Tenant ayarı: `PATCH /retention/policies/{sınıf}` (taban ve 3650 üst sınır; tabanın altındaki değer SQL ile yazılsa bile uygulanmaz). Günlük tur (`index.ts`) ve `POST /admin/privacy/anonymize-expired` (SUPER_ADMIN, `dryRun`) aynı kodu çalıştırır.
**Aktif kayıtlar hiçbir zaman dolmaz.** Anonimleştirme geri alınamaz; kayıt silinmez:

- Sürücü: ad → `Anonim Sürücü xxxxxxxx`, TCKN → `ANON-xxxxxx` (geçersiz TCKN), telefon/ehliyet → NULL, RFID kartı → benzersiz yer tutucu, durum PASİF.
- Personel: ad → takma ad, TCKN → NULL, izin **gerekçesi** silinir (izin tarih/gün sayısı kalır).
- **Mali bütünlük:** `transactions` satırları, tutarlar, plaka, tarih, tank, maliyet ve değişmezlik mührü (`hash_signature` — şoför adı mühre girmez) **değişmez**; yalnızca şoför adı takma ad olur. Diğer ad referansları (`manual_dispense_requests`, anomali işaretleri, çapraz şantiye yetkisi, davranış skoru,
  bildirim/alarm başlıkları) aynı takma adla güncellenir; araç zimmeti kaldırılır.
- **Ad çakışması:** şoför adı diğer tablolarda FK'siz metindir. Aynı adı taşıyan *başka* bir kişi varsa metin referansları YENİDEN YAZILMAZ (yanlış kişinin kaydı bozulmasın) ve sonuçta `nameBasedDataSkipped: true` raporlanır — elle inceleme gerekir.
- **Kapsam:** süre dolumunda yalnızca süresi dolan kaydın türü (sürücü kaydı) anonimleşir; aynı kişinin daha uzun saklanan personel özlük kaydı süresi dolana dek kalır. Silme başvurusunda ise kişinin sürücü + personel kayıtları birlikte anonimleşir.
- **Soğuk arşivler** (ARCH-107) silinen satırların şifreli kopyasıdır; `COLD_ARCHIVE` süresi sonunda silinir (silme audit'e özet). Silme başvurusu yanıtı, etkilenebilecek arşiv sayısını ve en geç silinme tarihini bildirir.
- **Saklanan (yasal):** mali işlem kayıtları (takma adla), denetim izi (`audit_logs` — anonimleştirme kaydı kişisel veri içermez), e-İrsaliye (yeniden üretimde anonim veri; GİB'e iletilmiş belge GİB'de kalır).

## 5. Veri sahibi başvurusu (KVKK m.11) — teknik altyapı

`POST /privacy/requests` `{requestType: ACCESS|ERASURE, subjectType: DRIVER|PERSONNEL, subjectId, note}` (COMPANY_OWNER/SUPER_ADMIN) → `RECEIVED`, **`dueAt` = +30 gün** (KVKK m.13); gecikenler `GET /privacy/requests` içinde `overdue: true`.

| Adım | Uç | Sonuç |
|---|---|---|
| Erişim | `POST /privacy/requests/{id}/access-export` | Kişinin **tam** kaydı, bağlı personel/izin, ikmal özeti (adet/toplam/ilk-son tarih + en çok 1000 kayıt), skorlar, yetkiler, zimmetli araçlar. Döküm **yalnızca bu yanıtta** döner (saklanmaz, `no-store`); başvuru `COMPLETED`. Ad çakışmasında başkasının verisi sızmasın diye ad-tabanlı bölümler `nameBasedDataWithheld` ile boş döner. |
| Silme | `POST /privacy/requests/{id}/erase` | Yukarıdaki anonimleştirme (PERSON kapsamı); yanıt "korunanlar" listesini ve soğuk arşiv bilgisini içerir. Zaten anonimse 409 (başvuru açık kalır). |
| Ret | `POST /privacy/requests/{id}/reject` | Gerekçeli (≥ 5 karakter) → `REJECTED`. |

Her adım audit log'a yazılır (`DSR_RECEIVED`, `DSR_ACCESS_FULFILLED`, `DSR_REJECTED`, `PERSONAL_DATA_ANONYMIZED`) ve **kişisel veri içermez**. Kimlik doğrulama (başvuranın gerçekten o kişi olduğunun teyidi) süreç/insan adımıdır: başvuru kaydına `note` ile işlenir, teyit edilemezse reddedilir.

## 6. İşletme

- Günlük tur anonimleştirme sayısını loglar (`🔒 [COMP-606]`); başarısız kayıtlar korunur ve `failed` olarak raporlanır (Loki: `{service="backend"} |= "COMP-606"`).
- Yeni kişisel veri sütunu eklerken: `piiInventory.ts`'e girin (test zorlar), gerekiyorsa `NAME_REFERENCE_COLUMNS`'a ekleyin, maskeleme uçlarını `piiPolicy.ts` ile geçirin.
- İlk kez açarken: `POST /admin/privacy/anonymize-expired {"dryRun": true}` ile adayları görün; süreleri kurumsal saklama politikanıza göre ayarlayın.
