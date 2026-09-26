# Veri saklama (retention) politikası ve purge (ARCH-107)

> Bu belge **hangi verinin ne kadar saklandığını**, süresi dolan verinin **nasıl** (arşivlenerek, parti parti) silindiğini ve **mali kayıtların neden hiçbir koşulda silinmediğini** anlatır.
> Sayısal süreler **iç politika varsayılanlarıdır**; hukuki saklama yükümlülükleri (vergi/e-Belge mevzuatı, KVKK) için hukuk müşaviri onayı gerekir — mali kayıtlarda ticket önerisi (10 yıl) esas alınmıştır.
> Kişisel veri envanteri ve anonimleştirme: COMP-606 (bu politikanın üstüne kurulur). Yedekler: [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
>
> **Kapsam uyarlaması:** Ticket TimescaleDB retention policy + BullMQ/@nestjs/schedule öneriyor; bu yığında TimescaleDB, hypertable ve ham telemetri tablosu **yoktur** (telemetri olay veri yolu + Redis presence; kalıcı
> günlük yok — bkz. `tenantArchiveService.ts` "KAPSAM UYARLAMASI 2"). "Ham telemetri" ve "sistem logu" harici sınıflar olarak belgelenir; ilişkisel tablolar için `index.ts`'teki düz `setInterval`
> süpürücü deseni kullanılır. TimescaleDB gelirse (ARCH-103) ham telemetri için `add_retention_policy` bu kataloğa `EXTERNAL` → `PURGEABLE` olarak eklenir.

## 1. Veri sınıfları ve süreler

Katalog: `backend/src/retention/retentionCatalog.ts` (tek gerçek kaynak). `test_arch107_retention.ts`, `schema.sql`'deki **her tablonun** tam olarak bir sınıfta olduğunu denetler — yeni bir tablo sınıflandırılmadan
eklenirse CI kırmızı yanar.

### PURGEABLE — süresi dolunca arşivlenip silinir (tenant bazında ayarlanabilir)

| Sınıf | Tablo | Varsayılan | Taban (en kısa) | Silinme koşulu |
|---|---|---|---|---|
| `AUDIT_LOG` | audit_logs | 1825 gün (5 yıl) | 730 | yaş |
| `NOTIFICATION` | notifications | 180 gün | 30 | yalnız sonuçlanmış (bekleyen/başarısız-tekrar-denenecek dokunulmaz) |
| `ALARM` | alarms | 730 gün | 180 | yalnız **çözülmüş** (açık/ertelenmiş alarm yaşına bakılmaksızın korunur) |
| `ALARM_EVENT` | alarm_events | 365 gün | 90 | açık alarma bağlı olaylar korunur |
| `DEVICE_PRESENCE` | device_presence_events | 365 gün | 90 | yaş |
| `REPORT_DELIVERY` | report_deliveries | 365 gün | 30 | yalnız sonuçlanmış; `file_data` arşive alınmaz (yeniden üretilebilir) |
| `CROSS_SITE_DENIAL` | cross_site_denials | 365 gün | 90 | yaş |
| `DRIVER_SCORE` | driver_behavior_scores | 730 gün | 90 | yaş (kişiye ait türetilmiş veri) |
| `DEVICE_HEALTH_SCORE` | device_health_scores | 365 gün | 90 | yaş |

Üst sınır 3650 gün. Tenant özelleştirmesi `PATCH /api/v1/retention/policies/{sınıf}` ile (COMPANY_OWNER/SUPER_ADMIN): `{"retentionDays": 365}`; `null` varsayılana döner. **Taban** altı ve **mali tablolar** için istek
reddedilir (400); değişiklik audit log'a (`RETENTION_POLICY_UPDATED`, önceki/sonraki değer) yazılır. `GET /api/v1/retention/policies` etkin süreleri, korumalı tabloları ve harici sınıfları listeler.

### PROTECTED — hiçbir koşulda otomatik silinmez

`transactions` (ikmal — mali kayıt), `despatch_advice_*` (e-İrsaliye), `fuel_intake_receipts`, `fuel_purchase_waybills` (INV-1502 alım irsaliyesi başlığı), `stock_reconciliations`, `inventory_movements`, `fire_records`, `calibration_*`, `manual_dispense_requests`,
`transaction_anomaly_flags`, `fuel_quota_history`, `usage_metering_records`, `lab_*`, `vehicle_documents`, `platform_audit_log`, `tenant_deletion_approvals` — önerilen saklama **10 yıl**. Bu tablolar için **ne ayar ne de silme kod yolu vardır**:
purge SQL'i yalnızca PURGEABLE girdilerinin sabit tablo/sütun adlarından üretilir; test, yıl **2100**'e sarılmış bir purge'ün 12 yıllık ikmali ve eski fire kaydını **bırakmasını** doğrular. Bu kayıtlar yalnızca tenant'ın kalıcı silinmesinde
(ARCH-108, çift onaylı) gider.

### MANAGED / MASTER / EXTERNAL

- **MANAGED:** `tenant_archives` (REP-702 `expires_at` süpürücüsü, dosya içeriği temizlenir), `retention_archives` (soğuk arşiv — aşağıda).
- **MASTER:** ana veri, ayar ve operasyonel durum (araç, sürücü, kullanıcı, tank, cihaz…) — tenant yaşadığı sürece tutulur; kişisel veri içerenlerin anonimleştirilmesi COMP-606.
- **EXTERNAL:** *Ham telemetri* — kalıcı tablo yok; Redis presence anahtarları TTL ile düşer. *Sistem logu* — Loki `retention_period` (14 gün, `deploy/monitoring/loki.yml`); loglara kişisel veri yazılmaz.

## 2. Purge nasıl çalışır

Günlük tur (`index.ts`, 24 sa) → `retentionService.runRetentionPurge()`; SUPER_ADMIN elle de çalıştırabilir: `POST /api/v1/admin/retention/run` `{ "dryRun": true, "tenantId": "...", "batchSize": 1000 }`
(`dryRun` yalnızca silinecek satır sayılarını döner — ilk kez açmadan önce mutlaka dry-run çalıştırın).

1. **Arşiv zorunlu ve silmeyle aynı transaction'da.** Her parti için: uygun satırlar seçilir (`FOR UPDATE SKIP LOCKED`) → gzip'lenip **AES-256-GCM** ile şifrelenerek `retention_archives`'a yazılır (`TENANT_EXPORT_ENCRYPTION_KEY`,
   ARCH-108 deseni; `sha256` bütünlük özeti) → aynı satırlar silinir → `RETENTION_PURGE` audit kaydı yazılır → `COMMIT`. **Arşiv yazılamazsa silme geri alınır, o sınıfın purge'ü iptal edilir** (arşivsiz silinmiş satır oluşamaz); sonuç
   `cancelled` sebebiyle raporlanır ve satırlar bir sonraki turda yeniden denenir.
2. **Parti parti.** Varsayılan 1000 satır/transaction (kilit süresi kısa), sınıf başına en çok 200 parti/tur; kalan satırlar ertesi tur devam eder. Tek büyük `DELETE` yoktur.
3. **Tek replika.** Tur `pg_try_advisory_lock` ile serileştirilir; kilit başka örnekteyse bu örnek atlar.
4. **Taban güvencesi.** Tenant ayarı (ör. doğrudan SQL ile) tabanın altında kalsa bile purge tabanı uygular.
5. **`audit_logs` özel durumu.** Uygulama rolü `audit_logs`'ta DELETE yapamaz (AUTH-203, DB düzeyinde); yalnızca retention işi (yönetim bağlantısı) yaşı dolan satırları arşive alarak siler. `RETENTION_PURGE` kaydı silinen satırların kendisini
   değil özetini (sınıf, satır sayısı, eşik, arşiv id) tutar.

## 3. Soğuk arşivler

`retention_archives` — silinen satırların şifreli, sıkıştırılmış kopyası (tenant başına RLS; uygulama rolüne kapalı). Arşivde kişisel veri kalabileceği için **süresiz tutulmaz** (COMP-606): `COLD_ARCHIVE` süresi (varsayılan 1825 gün, taban 365,
tenant ayarlı) sonunda günlük tur arşivi siler ve özeti audit log'a yazar (`RETENTION_COLD_ARCHIVE_PURGE`). Ayrıntı: [KVKK_ENVANTER.md §4](KVKK_ENVANTER.md). Meta veri: `GET /api/v1/retention/archives` (içerik dönmez).

**Bir arşivi açma (yönetici):** `retentionService.decryptRetentionArchive(file_data, sha256)` (sunucu ortamında; anahtar `TENANT_EXPORT_ENCRYPTION_KEY`) `{ header, rows }` döner; `header` sınıf/tablo/tenant/eşik/süre/satır sayısını,
`rows` silinen satırların tam JSON içeriğini taşır. Bütünlük (`sha256`) ve şifreleme etiketi (GCM) doğrulanmadan açılmaz. Arşivden geri yükleme otomatik değildir; satırlar elle `INSERT` edilir.

## 4. İşletme notları

- Uyarı: purge iptalleri `🚨 [ARCH-107] Purge iptal edildi` olarak loglanır (Loki: `{service="backend"} |= "ARCH-107"`); art arda iptal genellikle şifreleme anahtarı/DB alanı sorunudur.
- Disk: `retention_archives` büyür (gzip'li). Boyutu izleyin ([runbooks/infrastructure.md](runbooks/infrastructure.md#diskspace)); büyük tenant'larda arşivlerin nesne depolamaya taşınması gerekir (bkz. `tenantArchiveService.ts` S3 notu).
- Yeni tablo eklerken: `retentionCatalog.ts`'te sınıflandırın (test zorlar). Zaman damgalı, sınırsız büyüyen bir tabloysa PURGEABLE (varsayılan + taban + koşul), mali/mevzuat kaydıysa PROTECTED.
- Sistem başlangıcında geçmişe dönük ilk çalıştırma büyük olabilir: önce `dryRun`, sonra gündüz saatlerinde elle tur.
