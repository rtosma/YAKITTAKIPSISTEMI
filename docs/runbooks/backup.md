# Runbook — Yedekleme uyarıları (OPS-1106)

> Prosedürler: [BACKUP_RESTORE.md](../BACKUP_RESTORE.md). Bu uyarılar yedekleme **çalışmıyor** demektir: RPO 15 dk / günlük tam yedek garantisi şu an geçerli değil.
> Yedek betikleri `BACKUP_ENV` (genellikle `/etc/yakittakip/backup.env`) ile çalışır; cron kayıtları `/etc/cron.d/yakittakip-backup`; log `/var/log/yakittakip-backup.log`.

## BackupTooOld

### Etki
Son **başarılı** günlük tam yedek 26 saatten eski. Felakette kurtarılabilecek en yeni taban yedek eski: PITR yine WAL ile ileri gidebilir (WAL sağlıklıysa) ama taban yedek yoksa/eskiyse geri yükleme süresi ve riski artar.

### Tanı
1. `tail -100 /var/log/yakittakip-backup.log` — son `backup.sh` çalışması hata verdi mi? Tipik mesajlar: `BACKUP_DEST_DIR ... yazılamıyor`, `WAL arşivi 240 sn içinde boşalmadı`, `snapshot alınamadı`, şifreleme anahtarı yok.
2. Cron çalışıyor mu: `grep CRON /var/log/syslog | tail`; `/etc/cron.d/yakittakip-backup` var mı?
3. Yedek konumu erişilebilir mi (`df -h $BACKUP_DEST_DIR`, uzak bağlama düşmüş mü)? Disk dolu mu ([DiskSpace](infrastructure.md#diskspace))?
4. `BACKUP_ENCRYPTION_KEY` tanımlı mı (yoksa şifresiz yedek **alınmaz**, betik durur).
5. WAL arşivi kapalı mı (`docker-compose.backup.yml` etkin mi)? `SHOW archive_mode;` = `on` olmalı.

### Müdahale
Nedeni giderip **elle yedek alın**: `BACKUP_ENV=/etc/yakittakip/backup.env scripts/backup/backup.sh`. Bittiğinde `restore-drill.sh` ile geri yüklenebilirliği doğrulayın (en azından dump yolu).

### Doğrulama
`yakit_backup_last_success_timestamp_seconds{kind="base"}` yenilendi; uyarı resolved; `docs/restore-drills/` içinde yeni başarılı tatbikat.

### Eskalasyon
**Critical.** 24 saat içinde yedek alınamıyorsa teknik sorumlu + yönetim (veri koruma taahhüdü riskte).

## BackupMetricsMissing

### Etki
Yedek metrikleri hiç görünmüyor: yedek programı kurulmamış olabilir **veya** metrik dosyası (textfile) node-exporter'a ulaşmıyor. Yani yedek sağlığı **izlenmiyor** — yedek çalışsa bile bozulursa haberimiz olmaz.

### Tanı
1. `ls -l $BACKUP_METRICS_DIR/yakit_backup_*.prom` — dosyalar var mı, taze mi? `BACKUP_METRICS_DIR` `backup.env`'de tanımlı mı?
2. Dizin, node-exporter'ın bağladığı dizinle aynı mı (`docker-compose.monitoring.yml`: `${BACKUP_METRICS_DIR:-./deploy/monitoring/textfile}:/textfile`)? `docker compose exec node-exporter wget -qO- localhost:9100/metrics | grep yakit_backup`.
3. Yedek hiç çalışmadıysa → [BackupTooOld](#backuptooold) adımları; kurulum yapılmadıysa [BACKUP_RESTORE.md §Kurulum](../BACKUP_RESTORE.md).

### Müdahale
`BACKUP_METRICS_DIR`'ü doğru dizine ayarlayıp `backup.sh` ve `wal-ship.sh`'i bir kez çalıştırın; node-exporter'ı yeniden başlatmak gerekmez (textfile okunur).

### Doğrulama
Prometheus'ta `yakit_backup_last_success_timestamp_seconds` serileri görünür.

### Eskalasyon
Mesai içinde çözülmezse teknik sorumlu (izlenmeyen yedek = yedek yok varsayın).

## WalShippingStalled

### Etki
Son başarılı **WAL gönderimi** 15 dk'dan eski: **RPO hedefi (15 dk) aşılıyor** — şu an felaket olursa 15 dakikadan fazla veri kaybedilir. WAL segmentleri yerel spool'da birikir (disk dolarsa [PostgresDown](database.md#postgresdown) riski).

### Tanı
1. `tail -50 /var/log/yakittakip-backup.log | grep wal-ship`; cron `*/5` çalışıyor mu?
2. Gönderici hata veriyor mu: yedek konumu yazılamıyor (izin/dolu/uzak bağlama), `BACKUP_ENCRYPTION_KEY` yok, postgres konteyneri adı değişti (`PG_CONTAINER`).
3. Spool: `docker compose exec postgres sh -c 'ls /wal_archive | wc -l'` — birikiyor mu ([WalSpoolBacklog](#walspoolbacklog))?
4. Postgres'te `SELECT last_archived_wal, last_failed_wal, last_failed_time FROM pg_stat_archiver;` — `archive_command` hatası (volume izni/dolu)?

### Müdahale
Nedeni giderin ve göndericiyi elle çalıştırın: `BACKUP_ENV=... scripts/backup/wal-ship.sh` (çıkış 0 = tüm segmentler gitti; 2 = bir kısmı gönderilemedi, tekrar deneyin). Gönderici idempotenttir; segment kaybı olmaz.

### Doğrulama
`yakit_backup_last_success_timestamp_seconds{kind="wal"}` 5 dk içinde yenilenir; `yakit_wal_spool_pending_files` 0.

### Eskalasyon
**Critical.** Kısa sürede (30 dk) çözülemezse teknik sorumlu — RPO ihlali kayıt altına alınır.

## WalSpoolBacklog

### Etki
Yedek konumuna taşınmamış WAL segmenti birikti (>20 ≈ 320 MB+): gönderici çalışmıyor. Spool volume'u dolarsa `archive_command` başarısız olur, WAL birikir ve **PostgreSQL disk dolunca yazmayı durdurur**.

### Tanı
[WalShippingStalled](#walshippingstalled) tanısı; spool boyutu: `docker compose exec postgres du -sh /wal_archive`; disk: [DiskSpace](infrastructure.md#diskspace).

### Müdahale
Göndericiyi çalıştırın (`scripts/backup/wal-ship.sh`); yedek konumu geçici olarak erişilemiyorsa spool'a yer açın ve konumu düzeltin — **segmentleri elle silmeyin** (PITR zincirini keser).

### Doğrulama
`yakit_wal_spool_pending_files` < 5.

### Eskalasyon
Spool disk kullanımı %80'i geçerse critical muamelesi: teknik sorumlu.
