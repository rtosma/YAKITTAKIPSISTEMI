# Runbook — Altyapı (host) uyarıları

> Genel kurallar: [ALERTING.md](../ALERTING.md). Geri dönülmez temizlik komutlarında **volume'lara dokunmayın** (`docker volume rm`/`docker compose down -v` YASAK: pgdata, redisdata, wal_archive).

## DiskSpace

### Etki
Bir dosya sistemi %85 (warning) / %95 (critical) dolu. Dolarsa: PostgreSQL yazamaz ve durur, WAL arşivi/yedekler başarısız olur, log ve konteyner yazımları çöker — **tam kesinti + veri riski**.

### Tanı
1. Uyarıdaki `mountpoint` hangi disk? `df -h`; `docker system df` (imaj/build cache/volume payı).
2. En büyük tüketici: `du -xh / --max-depth=2 2>/dev/null | sort -rh | head -15`; Docker: `docker system df -v | head -40`.
3. Sık nedenler: WAL spool birikmesi ([WalSpoolBacklog](backup.md#walspoolbacklog)), Loki/Prometheus verisi, eski imajlar/build cache, konteyner logları, `tenant_archives`/belge BYTEA büyümesi (pgdata).

### Müdahale
- Güvenli temizlik: `docker builder prune -af` ve `docker image prune -f` (kullanılmayan imaj/cache; çalışan konteynerlere ve volume'lara dokunmaz).
- WAL spool doluysa göndericiyi çalıştırın: `scripts/backup/wal-ship.sh` (yedek konumu erişilebilir olmalı).
- Loki/Prometheus şişiyorsa retansiyonu düşürün (`loki.yml retention_period`, Prometheus `--storage.tsdb.retention.size`).
- Kalıcı: disk büyütme veya veri arşivleme planı; **pgdata volume'unu asla elle silmeyin/küçültmeyin**.

### Doğrulama
Boş oran > %20; `DiskSpace` resolved; `PostgresDown`/yedek uyarıları yok.

### Eskalasyon
Critical: **anında** — DB volume'unun dolmasına dakikalar kalmış olabilir; teknik sorumlu + altyapı sağlayıcı (disk genişletme).

## DiskWillFillSoon

### Etki
Mevcut yazma hızıyla disk ≈ 4 saat içinde dolacak (henüz eşik altında değil). Erken uyarıdır: mesai içinde çözülürse gece kesintisi olmaz.

### Tanı
1. Grafana "Disk doluluk" eğilimi; hangi mountpoint? Büyüme ani mi (yeni bir iş/hata) yoksa kademeli mi?
2. [DiskSpace](#diskspace) tanı adımları; ayrıca hızlı büyüyen log: `docker ps -q | xargs -I{} sh -c 'echo {} $(docker inspect -f "{{.LogPath}}" {})'` (log dosyası boyutları).
3. Bir hata döngüsü (aynı satırı sürekli loglayan) veya sürekli yeniden deneme (bildirim/e-İrsaliye) olabilir.

### Müdahale
Büyümenin kaynağını durdurun/düzeltin; gerekiyorsa [DiskSpace](#diskspace) temizliği; disk büyütmeyi mesai içinde planlayın.

### Doğrulama
`predict_linear` eğilimi pozitif/düz; uyarı resolved.

### Eskalasyon
İlk mesai gününde çözülmezse teknik sorumlu (kapasite planı).

## HostMemoryLow

### Etki
Kullanılabilir bellek %10'un altında: OOM-killer bir konteyneri (çoğunlukla backend/postgres) öldürebilir; performans düşer (swap).

### Tanı
1. `free -h`; `docker stats --no-stream` — hangi konteyner şişmiş?
2. Backend ise [BackendMemoryHigh](api.md#backendmemoryhigh); Loki/Prometheus ise bellek sınırları; PostgreSQL ise `shared_buffers`/bağlantı sayısı.
3. Kernel log: `dmesg | grep -i "killed process"` (geçmiş OOM olayları).

### Müdahale
Şişen bileşeni yeniden başlatın/sınırlayın; geçici çözüm olarak izleme yığınını (Loki/Prometheus) küçültün; kalıcı: RAM artışı.

### Doğrulama
Kullanılabilir bellek > %20 (10 dk).

### Eskalasyon
Tekrarlarsa altyapı kapasite planı (teknik sorumlu).

## HostCpuHigh

### Etki
Host CPU kullanımı 15 dk'dır > %90: gecikmeler artar (ApiLatencyP95/EventLoopLag tetikleyebilir).

### Tanı
1. `top -o %CPU` / `docker stats --no-stream` — hangi süreç/konteyner?
2. Backend ise aynı anda ağır bir iş var mı (export/arşiv/anomali taraması); PostgreSQL ise pahalı sorgu ([DbPoolSaturated](database.md#dbpoolsaturated) tanısı).
3. Harici bir süreç (yedek sıkıştırma, imaj derleme) çalışıyor olabilir.

### Müdahale
Zamanlanabilir işi kaydırın (yedek/arşiv/derleme); süreklilik varsa ölçekleyin (replika/CPU).

### Doğrulama
Grafana "CPU kullanımı" paneli 15 dk boyunca %70'in altında; `HostCpuHigh` resolved bildirimi gelir ve API gecikme uyarıları (ApiLatencyP95) sessiz.

### Eskalasyon
Kalıcı yüksekse kapasite planı (teknik sorumlu).
