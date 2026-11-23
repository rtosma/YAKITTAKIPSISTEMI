# Runbook — Veritabanı uyarıları

> Genel kurallar: [ALERTING.md](../ALERTING.md). DB erişimi: `docker compose exec postgres psql -U postgres -d yakittakip_db`.
> **Uyarı:** `pg_terminate_backend` / `DELETE` / `TRUNCATE` gibi geri dönülmez komutları körlemesine çalıştırmayın; denetim izi (`audit_logs`) DB seviyesinde değiştirilemezdir ve öyle kalmalıdır.

## DbPoolSaturated

### Etki
Uygulamanın pg havuzu (10 bağlantı) dolu: yeni istekler bağlantı bekliyor; `connectionTimeout` (10 sn) sonrası 503 (yeniden denenebilir) döner. Cihaz yetkilendirmesi ve panel yavaşlar/başarısız olur.

### Tanı
1. Grafana "Uygulama bağlantı havuzu": `waiting` ne kadar, `idle` sıfır mı?
2. Uzun süren/bekleyen sorgular:
   `SELECT pid, state, now()-xact_start AS tx_süresi, wait_event_type, left(query,100) FROM pg_stat_activity WHERE datname='yakittakip_db' ORDER BY xact_start NULLS LAST LIMIT 15;`
3. Kilit beklemeleri: `SELECT * FROM pg_locks WHERE NOT granted;` — aynı tank satırını bekleyen ikmaller (FOR UPDATE) havuzu tüketebilir (TEST_PLAN §7).
4. Trafik artışı mı? "İstek hızı" paneli.

### Müdahale
- Tek bir uzun/kilitli işlem ise `SELECT pg_cancel_backend(<pid>)` (işlevi doğruladıktan sonra).
- Trafik artışıysa ikinci backend replikası (`docker compose up -d --scale backend=2`) toplam bağlantıyı artırır — `PostgresConnectionsHigh` eşiğini izleyin.
- Havuz boyutu (`postgresPool.ts`, `max: 10`) kalıcı çözüm olarak ancak `max_connections` payı doğrulandıktan sonra artırılır.

### Doğrulama
`waiting` = 0 (10 dk); uyarı resolved; 503 oranı normale döner.

### Eskalasyon
Critical (waiting > 5) 15 dk sürerse DB sorumlusu; kilit zinciri bir dağıtım/kodla ilgiliyse geliştirici ekip.

## PostgresConnectionsHigh

### Etki
PostgreSQL bağlantı sayısı `max_connections`'ın %80'i (warning) / %90'ı (critical): tükenirse **yeni bağlantılar reddedilir** (tüm servisler, yedek betikleri dahil).

### Tanı
1. Durum dağılımı: `SELECT state, count(*) FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC;` — çok sayıda `idle in transaction` = sızan transaction (idle_in_transaction_session_timeout 60 sn ile temizlenir).
2. Kimin açtığı: `SELECT usename, application_name, count(*) FROM pg_stat_activity GROUP BY 1,2 ORDER BY 3 DESC;` (backend mi, exporter mı, elle bağlantı mı).
3. Replika sayısı: her backend replikası havuzu kadar (10) bağlantı tutar.

### Müdahale
- Elle açılmış `psql` oturumlarını kapatın; `idle in transaction` yığılıyorsa kaynağı bulun.
- Geçici: gereksiz replikayı kapatın; kalıcı: `max_connections` artışı + bellek payı veya bağlantı havuzlayıcı (PgBouncer) — değişiklik plan gerektirir.

### Doğrulama
Kullanım oranı < %70 (10 dk).

### Eskalasyon
Critical: DB sorumlusu; tükenme anında yeni ikmal/yetkilendirme başarısız olabilir.

## PostgresDown

### Etki
**Veritabanına ulaşılamıyor.** Tüm iş işlevleri durur; backend `health/ready` 503 verir (BackendDown/ApiErrorRate bastırılır — kök neden budur). Cihazlar çevrimdışı senkron ile kayıt biriktirir.

### Tanı
1. `docker compose ps postgres`; `docker compose logs --tail 100 postgres` — çökme, disk dolu (`No space left on device`), bozuk WAL?
2. Disk: [DiskSpace](infrastructure.md#diskspace) — DB volume'u dolduysa Postgres durur; WAL arşivi şişmiş olabilir ([WalSpoolBacklog](backup.md#walspoolbacklog)).
3. `docker compose exec postgres pg_isready`.
4. Exporter bağlantı hatası olabilir (kimlik/yetki): `docker compose logs postgres-exporter`.

### Müdahale
- Disk doluysa önce yer açın (eski log/imaj: `docker system prune` **yalnızca** kullanılmayan imaj/build cache; **volume silmeyin**).
- `docker compose up -d postgres`; bozulma şüphesinde **veriye dokunmadan** yedekten geri yükleme prosedürüne geçin: [BACKUP_RESTORE.md §4](../BACKUP_RESTORE.md).
- Yalnızca exporter sorunuysa (uygulama sağlıklı): exporter kimlik bilgilerini düzeltin.

### Doğrulama
`pg_up` = 1; `/api/v1/health/ready` 200; `scripts/smoke-test.mjs` yeşil; cihaz çevrimdışı kayıtları senkronlandı (IOT-303 sync-batch).

### Eskalasyon
**Critical — anında**, 10 dk içinde geri gelmezse DB sorumlusu + teknik sorumlu; veri kaybı şüphesinde PITR kararı (RPO 15 dk) yönetimle birlikte verilir.
