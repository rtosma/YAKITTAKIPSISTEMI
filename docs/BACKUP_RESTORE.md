# Yedekleme ve Geri Yükleme Prosedürü (OPS-1106)

> **Test edilmemiş yedek, yedek sayılmaz.** Bu belge hem prosedürü hem de onu doğrulayan tatbikat düzenini tanımlar.
> Ortamlar ve dağıtım: [ENVIRONMENTS.md](ENVIRONMENTS.md) · Sırlar: [SECRETS.md](SECRETS.md).

## 1. Hedefler

| Hedef | Değer | Nasıl karşılanır | Nasıl ölçülür |
|---|---|---|---|
| **RPO** (kabul edilen azami veri kaybı) | **15 dakika** | Sürekli WAL arşivi: `archive_timeout=300 sn` + 5 dk'lık gönderim = tasarım RPO ≈ **10 dk** | Tatbikat: son WAL gönderiminden bu yana geçen süre + `archive_timeout` |
| **RTO** (kabul edilen azami kesinti) | **4 saat** | Tek komutlu geri yükleme (`restore.sh`), temiz ortamda | Tatbikat: PITR geri yükleme + doğrulama süresi |

Tatbikat bu hedefleri **ölçer ve aşılırsa başarısız olur** (`scripts/backup/restore-drill.sh`, çıkış kodu 1).

## 2. Ne yedeklenir?

| Veri | Nerede | Yedek |
|---|---|---|
| Tüm iş verisi (ikmaller, denetim izi, tenant'lar, kullanıcılar, rapor teslimleri…) | PostgreSQL | Günlük tam yedek + sürekli WAL |
| **Nesne depolama (e-İrsaliye XML/PDF, tenant arşivleri, araç belgeleri)** | **Ayrı bir nesne deposu YOKTUR** — hepsi PostgreSQL'dedir: `despatch_advice_transmissions.xml_snapshot`, `tenant_archives.file_data`, `vehicle_documents.file_content` (BYTEA) | Veritabanı yedeği bunları **zaten kapsar** (ayrı bir S3 senkronizasyonu gerekmez). Harici nesne deposuna geçilirse bu bölüm ve yedek betikleri o depoyu da kapsayacak şekilde genişletilmelidir. |
| Redis (oturum deny-list, kilitler, rate-limit) | Redis (AOF) | **Kasıtlı olarak yedeklenmez** — geçici durumdur; kaybı yalnızca herkesin yeniden giriş yapması demektir, veri kaybı değildir |
| Kaynak kod, şema, dağıtım betikleri | Git | Depo |
| Sırlar (`.env`) | Sunucu + GitHub Environments | [SECRETS.md](SECRETS.md) (yedek anahtarı dahil) |

Bir **yedek** şunlardan oluşur (`BACKUP_DEST_DIR/base/<zaman>/`): `base.tar.gz.enc` (fiziksel, `pg_basebackup`), `dump.custom.enc` (mantıksal, `pg_dump -Fc`),
`globals.sql.enc` (roller), `manifest.json.enc` (tablo başına satır sayısı + `id` özeti) ve **açık** `index.json` (zaman, WAL aralığı, dosya boyut/sha256 — veri içermez).
WAL segmentleri `BACKUP_DEST_DIR/wal/<segment>.enc`.

## 3. Mimari

```
postgres ──archive_command (atomik tmp+mv)──► wal_archive volume ──wal-ship.sh (cron */5)──► gzip+AES-256-GCM ──► BACKUP_DEST_DIR/wal/
postgres ──backup.sh (cron günlük 02:15)──► pg_basebackup + pg_dump + roller + manifest ──► AES-256-GCM ──► BACKUP_DEST_DIR/base/<zaman>/
                                                                                                │
                                              BACKUP_UPLOAD_CMD (rclone/rsync) ──► AYRI konum (uzak depo / ayrı disk) ◄─┘
```

- **Sürekli WAL arşivi** `docker-compose.backup.yml` ile açılır (staging/production; varsayılan geliştirici yığınında kapalıdır — `archive_timeout` her 5 dk'da 16 MB segment üretir):
  `docker compose -f docker-compose.yml -f docker-compose.backup.yml up -d` veya sunucudaki kök `.env`'ye `COMPOSE_FILE=docker-compose.yml:docker-compose.backup.yml`.
- **Şifreleme:** AES-256-GCM (doğrulanmış şifreleme). Yalnızca gizlilik değil **bütünlük** de: depoda değiştirilmiş bir yedek/WAL segmenti geri yüklenmez (GCM etiketi + sha256).
  Şifre çözme, etiket doğrulanmadan çıktı dosyasını yerine koymaz. Şifreleme yedek konumuna yazmadan **önce** yapılır — depo (uzak bucket, ayrı disk) düz veri görmez.
- **Ayrı konum:** `BACKUP_DEST_DIR` üretim sunucusunun diskinden ayrı bir bağlama noktası olmalıdır (uzak depolama, `rclone mount`, ayrı disk) veya `BACKUP_UPLOAD_CMD`
  (örn. `rclone sync "$BACKUP_DEST_DIR" uzak:kova`) ile yedek sonrası dışarı kopyalanır. Aynı fiziksel diskte tutulan yedek felakette yedek değildir.
- **Retansiyon:** `BACKUP_RETENTION_DAYS` (14) — en az 2 yedek her zaman korunur; en eski korunan yedeğin başlangıç WAL'ından önceki segmentler silinir.
- **Zamanlama:** [`deploy/cron/yakittakip-backup.cron`](../deploy/cron/yakittakip-backup.cron) — WAL gönderimi `*/5`, tam yedek günlük 02:15, tatbikat çeyrekte bir.

### Kurulum (sunucuda, bir kerelik)

```bash
node scripts/lib/backupCrypto.mjs genkey          # yeni anahtar; ÇIKTIYI ÇEVRİMDIŞI KASAYA (escrow) KAYDEDİN
sudo install -d -m 700 /etc/yakittakip
# /etc/yakittakip/backup.env (chmod 600) içeriği:
#   BACKUP_DEST_DIR=/mnt/yedek-deposu/yakittakip
#   BACKUP_ENCRYPTION_KEY=<64-hex>
#   BACKUP_UPLOAD_CMD='rclone sync "$BACKUP_DEST_DIR" uzak:yakittakip-yedek'   # isteğe bağlı
docker compose -f docker-compose.yml -f docker-compose.backup.yml up -d
sudo cp deploy/cron/yakittakip-backup.cron /etc/cron.d/yakittakip-backup
BACKUP_ENV=/etc/yakittakip/backup.env scripts/backup/backup.sh                                  # ilk yedek
BACKUP_ENV=/etc/yakittakip/backup.env scripts/backup/restore-drill.sh --label ilk-kurulum       # ilk tatbikat
```

## 4. Geri yükleme prosedürleri

Tüm geri yüklemeler **temiz bir konteynere** yapılır (`--network none`; üretime/dış servislere bağlanamaz) ve kaynak veritabanına dokunmaz.
Ortam: `BACKUP_DEST_DIR` ve `BACKUP_ENCRYPTION_KEY` (kasadan) tanımlı olmalı. Her şifreli dosya çözülmeden önce doğrulanır; kurcalanmış/yanlış anahtarlı dosyada işlem **durur**.

### 4.1 Felaket kurtarma — en son ana kadar
```bash
scripts/backup/restore.sh --mode pitr --target-time latest      # en yeni taban yedek + arşivdeki tüm WAL
```
### 4.2 Belirli bir ana geri dönüş (PITR) — örn. yanlış silme/bozulma öncesi
```bash
scripts/backup/restore.sh --mode pitr --target-time '2026-09-19 14:32:00+00'   # UTC; hedefin ÖNCESİNDE tamamlanmış en yeni taban yedek seçilir
```
`recovery_target_time` + `promote` kullanılır; hedef anın **sonrasında** yazılan kayıtlar gelmez. Hedef, arşivlenmiş WAL'ın ötesindeyse
(son gönderimden sonraki an — RPO penceresi) veya hedeften önce taban yedek yoksa işlem temiz bir hatayla reddedilir.
Doğru hedefi bulmak için sonucu **kontrol edin** (geri yüklenen konteynerde sorgu), yanlışsa farklı bir zamanla yeniden yükleyin.

### 4.3 Mantıksal geri yükleme (tek tablo / taşınabilirlik)
```bash
scripts/backup/restore.sh --mode dump                            # roller (globals) + pg_restore
# yalnızca bir tabloyu üretime almak: geri yüklenen konteynerden pg_dump -t tablo | üretime psql
```

### 4.4 Geri yüklenen veritabanını devreye alma
Yukarıdaki komutlar `{"container":"yk-restore-…","volume":"…"}` yazar. Üretime almak için: doğrulamadan sonra veri volume'unu (`…-data`) yeni `postgres` servisine
bağlayın (veya `pg_dump | psql` ile üretime aktarın), `docker compose up -d`, `scripts/smoke-test.mjs` çalıştırın ve ardından **yeni bir tam yedek + tatbikat** alın.
Geri yükleme yeni bir zaman çizgisi (timeline) başlatır — eski WAL arşivini yeni kümeye bağlamayın; yeni kümeden yeni bir taban yedek alın.

### TimescaleDB notu
Bu sürümde **TimescaleDB kullanılmıyor** (düz PostgreSQL 16). İleride hypertable eklenirse: (a) **PITR/fiziksel yol** (taban yedek + WAL) hypertable'ları olduğu gibi
geri getirir — birincil felaket kurtarma yolu bu olmalıdır; (b) **mantıksal (dump) yol** için `pg_restore` öncesi `SELECT timescaledb_pre_restore();`, sonrasında
`SELECT timescaledb_post_restore();` çalıştırılmalı ve hedef sunucuda **aynı TimescaleDB sürümü** kurulu olmalıdır (aksi halde katalog uyuşmazlığı). `restore.sh --mode dump`
bu durumda imajı `timescale/timescaledb` olacak şekilde (`PG_IMAGE`) çalıştırmalı ve iki çağrıyı eklemelidir.

## 5. Restore tatbikatı (AC)

`scripts/backup/restore-drill.sh` (çeyrekte **en az bir kez**; ayrıca büyük şema/altyapı değişikliğinden sonra):
1. En yeni yedeği **dump yoluyla** geri yükler → manifestle **kesin eşitlik** (tablo başına satır sayısı + `id` md5).
2. **PITR yoluyla** (taban yedek + tüm WAL) geri yükler → veritabanı açılır, tüm tablolar okunur, satır sayıları yedek anının altına düşmez.
3. Süreleri ölçer; **RTO** (PITR geri yükleme + doğrulama) ve **RPO** (son WAL gönderimi + `archive_timeout`) hedeflerle karşılaştırır; boyut ekstrapolasyonu verir.
4. Raporu [`docs/restore-drills/<tarih>.md`](restore-drills/) olarak yazar ve geçici konteyner/volume'ları siler. Hedef aşılırsa veya doğrulama tutmazsa **çıkış 1** (cron e-postası / OPS-1108 alarmı).

Tatbikat sonucunu ilgili sorumlu inceler; başarısız bir tatbikat, kök neden giderilip **yeniden yapılana kadar** açık bir olaydır.
`docs/restore-drills/` altındaki raporlar denetim kanıtıdır (kim, ne zaman, kaç saniye).

## 6. Anahtar yönetimi

- Anahtar **yedek deposunda ve uygulama `.env`'inde bulunmaz**; yalnızca yedek betiklerinin çalıştığı ana bilgisayarda (`/etc/yakittakip/backup.env`, `chmod 600`) ve **çevrimdışı escrow**'da (parola yöneticisi/kasa; en az iki yetkili kişi).
- **Anahtar kaybı = tüm yedeklerin kaybı.** Escrow doğrulanmadan yedek programı canlıya alınmaz; tatbikat, escrow'daki anahtarla yapılan bir geri yüklemeyi de içermelidir (çeyrekte bir kez anahtarı kasadan alıp deneyin).
- **Rotasyon (yıllık / sızıntıda):** yeni anahtar üret → yeni yedekler yeni anahtarla şifrelenir; eski yedekler eski anahtarla çözülür (eski anahtar, o yedeklerin retansiyonu bitene kadar kasada kalır). Sızıntıda: yeni anahtar + hemen yeni tam yedek, eski yedekler yeniden şifrelenir veya imha edilir.

## 7. Bilinen sınırlar ve genişleme yolu

- Yedek programı tek bir sunucu/konteyner için tasarlandı; pgBackRest/wal-g (artımlı yedek, paralel sıkıştırma, S3 yerel desteği) veri boyutu büyüdüğünde (≈100 GB+) devreye alınmalıdır —
  betik arayüzleri (`backup.sh` / `wal-ship.sh` / `restore.sh`) aynı kalıp arkası değiştirilebilir.
- Uzak depoya yükleme `BACKUP_UPLOAD_CMD` kancasıdır; doğrudan bir bulut SDK'sı içermez.
- Geri yükleme hızı ölçülen küçük veri setinden ekstrapole edilmiştir; **üretim boyutunda ölçüm yapılana kadar RTO hedefi tahmindir** — ilk üretim tatbikatı bunu doğrulamalıdır.
- Şema değişiklikleri expand/contract kuralına uyar ([ENVIRONMENTS.md §3](ENVIRONMENTS.md)); bu, eski yedeğin (eski şema) yeni kodla geri yüklenebilirliğini korur.
