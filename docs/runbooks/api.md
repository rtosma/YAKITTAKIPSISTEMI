# Runbook — API / uygulama uyarıları

> Genel kurallar: [ALERTING.md](../ALERTING.md). Her uyarının bildirimi bu sayfadaki ilgili başlığa bağlanır. **Önce durumu sakinleştir, sonra kök nedeni ara**;
> şüphede: son dağıtımı geri al (`./scripts/rollback.sh` — [DEPLOY_ROLLBACK.md](../DEPLOY_ROLLBACK.md), [ENVIRONMENTS.md §Geri alma](../ENVIRONMENTS.md)).

Ortak tanı araçları: Grafana → "Yakıt Takip — Teknik Sağlık"; loglar Loki'de (`{service="backend", level=~"error|fatal"}`); bir isteğin tüm izi `{service="backend"} | traceId="<X-Trace-ID>"`;
sağlık: `curl -s localhost:3000/api/v1/health/ready` (DB + Redis + MQTT).

## ApiErrorRate

### Etki
Kullanıcı isteklerinin %2'den (warning) / %10'dan (critical) fazlası 5xx dönüyor: ikmal kaydı, cihaz yetkilendirme, raporlar kısmen veya tamamen çalışmıyor olabilir.

### Tanı
1. Grafana "5xx (route, ilk 10)" paneli: hata **tek bir route'ta mı** yoksa yaygın mı?
2. Loki: `{service="backend", level="error"}` — son hata mesajları ve `traceId`'ler; tek bir tenant'a mı özgü: `| tenantId="…"`.
3. `docker compose logs --tail 200 backend`; `curl -s localhost:3000/api/v1/health/ready` — 503 ise bağımlılık (DB/Redis/MQTT) sorunu (ilgili alarmlara bakın: DbPoolSaturated, PostgresDown).
4. Son dağıtım zamanı ile hata başlangıcı çakışıyor mu? (`git log -3`, GitHub Actions dağıtım kayıtları).

### Müdahale
- Bağımlılık kaynaklıysa ilgili runbook'a geçin ([database.md](database.md), [infrastructure.md](infrastructure.md)).
- Son dağıtımdan sonra başladıysa **geri alın**: sunucuda **`./scripts/rollback.sh`** (tek komut, sıfır kesinti, yeniden derleme yok; iki sürüm arasında geri dönüşsüz şema değişikliği varsa reddeder — bkz. [DEPLOY_ROLLBACK.md §5](../DEPLOY_ROLLBACK.md)).
- Tek route'ta ve kod hatası ise ilgili özelliği (varsa) kapatın veya düzeltme dağıtın; kullanıcıya etki çoksa önce geri alma.

### Doğrulama
5xx oranı paneli 10 dk boyunca %1'in altında; uyarı "resolved" bildirimi gelir; `scripts/smoke-test.mjs` yeşil.

### Eskalasyon
Critical uyarı 30 dk içinde çözülmezse veya veri bütünlüğü şüphesi varsa (yarım yazılmış ikmal kayıtları) teknik sorumlu + ürün sahibi aranır.

## ApiLatencyP95

### Etki
İsteklerin %5'i 1 sn'den (warning) / 3 sn'den (critical) yavaş: pompa yetkilendirmesi ve panel gezinmesi yavaşlar; cihaz zaman aşımlarına (ikmal kaçırma) yol açabilir.

### Tanı
1. "En yavaş 10 route (p95)" paneli: tek route (ör. ağır rapor/export) mi, hepsi mi?
2. "Event loop gecikmesi" ve "Uygulama bağlantı havuzu" panelleri — event loop yüksekse [EventLoopLag](#eventlooplag), `waiting` > 0 ise [DbPoolSaturated](database.md#dbpoolsaturated).
3. PostgreSQL yavaş sorgu: `docker compose exec postgres psql -U postgres -d yakittakip_db -c "SELECT pid, now()-query_start AS süre, left(query,120) FROM pg_stat_activity WHERE state='active' ORDER BY 2 DESC LIMIT 10"`.
4. Büyük rapor/PDF export'u devam ediyor mu (REP-703)? Loki: `|~ "reports/.*export"`.

### Müdahale
- Tek uzun sorgu ise: `SELECT pg_cancel_backend(<pid>)` (önce sahibini/işlevi doğrulayın; asla `pg_terminate_backend`'i körlemesine kullanmayın).
- Ağır raporlar için kullanıcıya daha dar tarih aralığı önerin; PDF satır sınırı (varsayılan 2000) zaten korur.
- Yük artışıysa (saha yoğunluğu) backend replikası ekleyin: `docker compose up -d --scale backend=2` (nginx havuzu için `nginx/backend_upstream.conf`; bkz. OPS-1102 betiği).

### Doğrulama
p95 paneli 10 dk boyunca < 1 sn; uyarı resolved.

### Eskalasyon
Critical 30 dk sürerse DB sorumlusu; kalıcı yavaşlık için kapasite/indeks incelemesi açın.

## EventLoopLag

### Etki
Node.js event loop p99 gecikmesi > 500 ms: **tüm** istekler (MQTT işleme, Socket.io dahil) bekler; belirtiler dağınık ve yanıltıcıdır.

### Tanı
1. Aynı anda CPU yükseliyor mu ("Süreç CPU" paneli)? Yüksek CPU + yüksek lag = CPU-yoğun senkron iş (büyük JSON/PDF/şifreleme).
2. Loki: zaman aralığında yavaş `responseTime` değerleri: `{service="backend"} | json | responseTime > 2000`.
3. Ağır işlemler: PDF/CSV export, tenant arşiv üretimi (REP-702), toplu sync-batch (IOT-303).

### Müdahale
- Sorumlu işlemi durdurun/erteleyin (ör. arşiv üretimi zamanlamasını geceye alın); tek seferlik ise bekleyin.
- Sürekliyse backend'i yeniden başlatmak geçici çözümdür: `./scripts/zero-downtime-deploy.sh` (kesintisiz) — kök neden için profil alın (`--cpu-prof`).

### Doğrulama
`nodejs_eventloop_lag_p99_seconds` < 100 ms (10 dk).

### Eskalasyon
Tekrarlıyorsa geliştirici ekibe iş açın (kod kaynaklı blokaj).

## BackendDown

### Etki
**Uptime kaybı.** Backend örneği `/metrics`'e yanıt vermiyor: API, cihaz yetkilendirme ve panel çalışmıyor olabilir (tek replikada tam kesinti).

### Tanı
1. `docker compose ps backend` ve `docker compose logs --tail 100 backend` — çökme/yeniden başlama döngüsü? OOM: `docker inspect $(docker compose ps -q backend) --format '{{.State.OOMKilled}}'`.
2. `curl -s localhost:3000/api/v1/health/live` (süreç canlı mı) ve `/health/ready` (bağımlılıklar).
3. Bağımlılıklar: `docker compose ps` (postgres/redis/emqx healthy mi?). Şema/ortam hatası: log'da "ARCH-110 … doğrulaması başarısız" (`.env` eksik/yanlış).
4. Bu uyarı tek başına değil de PostgresDown ile birlikteyse kök neden DB'dir.

### Müdahale
- Çökme döngüsü: log'daki hatayı düzeltin (yanlış `.env` → düzeltip `docker compose up -d backend`).
- OOM: bellek sınırını/sızıntıyı inceleyin ([BackendMemoryHigh](#backendmemoryhigh)); geçici: `docker compose restart backend`.
- Son dağıtımdan sonra başladıysa geri alın (yukarı bakın).

### Doğrulama
`up{job="backend"}` = 1; `scripts/smoke-test.mjs` yeşil; uyarı resolved.

### Eskalasyon
**Critical — anında.** 15 dk içinde geri gelmezse teknik sorumlu + (saha ikmali etkileniyorsa) operasyon yöneticisi; cihazlar çevrimdışı senkron (IOT-303) ile veri kaybetmeden tolere eder.

## BackendMissing

### Etki
Prometheus `up{job="backend"}` serisini hiç göremiyor: servis keşfi (DNS) boş — genellikle **tüm** backend konteynerleri yok. `BackendDown` bu durumda ateşlemez.

### Tanı
1. `docker compose ps -a backend` — konteyner silinmiş/hiç başlatılmamış mı? `docker compose config -q` yapılandırma hatası?
2. Prometheus → Status → Service Discovery / Targets: `backend` job'ı boş mu; `docker network inspect` ile backend'in ağa bağlı olduğunu doğrulayın.
3. Yanlış compose dosyası/proje adıyla başka bir yığın çalışıyor olabilir (`docker ps`).

### Müdahale
`docker compose up -d backend` (gerekirse `--build`); DNS keşfi 15 sn içinde toparlar.

### Doğrulama
Targets sayfasında backend `UP`; smoke testi yeşil.

### Eskalasyon
Critical: BackendDown ile aynı.

## BackendMemoryHigh

### Etki
Backend RSS belleği 1.5 GB üzerinde ve düşmüyor: bellek sızıntısı; sonunda OOM-kill (BackendDown) ve kesinti.

### Tanı
1. "Bellek" paneli: RSS + heap kullanımı birlikte artıyor mu (heap sızıntısı) yoksa yalnızca RSS mi (Buffer/native)?
2. Yeni dağıtımla başladı mı? Büyük export/arşiv işlemleri sırasında geçici tepe normaldir (uyarı `for: 15m` ile bunu eler).
3. Loki'de anormal büyük istek/yanıt.

### Müdahale
- Kontrollü yeniden başlatma: `./scripts/zero-downtime-deploy.sh` (kesintisiz geçiş).
- Kalıcı: heap snapshot alıp geliştirici ekibe iletin; sızıntı düzeltilene kadar günlük yeniden başlatma planlayın.

### Doğrulama
RSS yeniden başlatma sonrası ~200-400 MB bandında, 24 saat içinde monoton artmıyor.

### Eskalasyon
Yeniden başlatma sonrası hızla yeniden yükseliyorsa geliştirici ekip (kod kaynaklı sızıntı).
