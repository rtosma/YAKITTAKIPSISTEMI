# Zero-downtime dağıtım ve geri alma (OPS-1110)

> Bu belge **nasıl** dağıtıldığını, dağıtım sırasında canlı bağlantıların ve ikmal oturumlarının **ne olduğunu**, tek komutla **nasıl geri dönüleceğini** ve geri almanın
> **sınırını** (migrasyon) anlatır. Ortamlar/onay akışı: [ENVIRONMENTS.md](ENVIRONMENTS.md) · yedekten geri yükleme: [BACKUP_RESTORE.md](BACKUP_RESTORE.md) ·
> tatbikat kanıtı: [deploy-drills/](deploy-drills/).
>
> **Kapsam uyarlaması:** Ticket Kubernetes "rolling update + readiness probe" varsayar; bu proje Docker Compose + nginx çalıştırır. Aynı garantiler `scripts/zero-downtime-deploy.sh`
> içinde **blue/green (yan yana iki replika + atomik nginx kesmesi)** ile sağlanır: trafik yalnızca *hazır* örneğe gider (readiness), eski örnek trafik kesildikten SONRA drain ile kapanır.

## 1. Dağıtım akışı (`./scripts/zero-downtime-deploy.sh`)

| Adım | Ne olur | Hata olursa |
|---|---|---|
| 1 | Yeni imaj derlenir (`APP_VERSION` build-arg → imaja gömülür) | Derleme hatası: hiçbir şeye dokunulmadı |
| 2 | `schema.sql` tek transaction'da uygulanır (yalnızca *expand*; bkz. §5) | Transaction geri alınır, eski replika trafik almaya devam eder |
| 3 | Eski replika **yeniden oluşturulmadan** 2. replika (yeni imaj) eklenir | — |
| 4 | Docker healthcheck (**liveness**) → **readiness** (`/health/ready`: DB+Redis+MQTT) → `/health` sürümü beklenenle aynı mı | Yeni replika kaldırılır, deploy durur, **kesinti yok** |
| 5 | nginx upstream'i yalnızca yeni replikaya yazılır, `nginx -s reload` (**atomik kesme**) + 3 sn tampon | — |
| 6 | Eski replika `docker stop -t 45` ile **drain** edilerek kapatılır, çıkış kodu doğrulanır | Çıkış kodu ≠ 0 ise uyarı (§2) |
| 7 | Sürüm kaydı: `$RELEASE_LOG`'a satır + imaj `yakittakip-backend-release:<sürüm>` etiketi (son `RELEASE_KEEP`=5 sürüm) | — |

Ortam değişkenleri: `APP_VERSION` (varsayılan `git describe`), `DRAIN_TIMEOUT_SECONDS` (45), `HEALTH_TIMEOUT_SECONDS` (90), `RELEASE_LOG` (`.deploy/releases.log`, sunucuya özgü, repoya girmez),
`RELEASE_KEEP`, `RELEASE_IMAGE_REPO`, `SKIP_BUILD`/`SKIP_SCHEMA` (yalnızca rollback kullanır). Çalışan sürüm: `curl -s localhost:3000/api/v1/health` → `version`.

## 2. Drain süresi ve dayanağı

`docker stop` SIGTERM gönderir, `-t` saniye sonra SIGKILL. Süreler **kademeli ve bilinçli olarak sıralıdır**:

| Değer | Süre | Anlamı |
|---|---|---|
| WebSocket boşaltma penceresi (`SOCKET_DRAIN_WINDOW_MS`, `index.ts`) | 8 sn | Soketler bu sürede jitter'lı dilimlerle koparılır |
| Uygulama zorla-çıkış zamanlayıcısı (`setupGracefulShutdown timeoutMs`) | 30 sn | Bu süre dolarsa süreç kendi `exit(1)` yapar |
| `stop_grace_period` (compose) / `docker stop -t` (deploy) | 45 sn | SIGKILL ancak uygulama bu süreyi de aşarsa gelir |

**Eski varsayılan sorundu:** `docker stop` 10 sn beklerdi → uygulamanın 30 sn'lik kapanışı SIGKILL ile yarıda kesilir, devam eden istekler ve soket boşaltma tamamlanamazdı.
Ayrıca `server.close()` açık bir WebSocket bağlantısı kaldıkça **hiç tamamlanmıyordu** (her dağıtım 30 sn zorla-çıkışa takılıyordu); artık soketler önce boşaltılıyor ve boştaki
keep-alive bağlantıları kapatılıyor → kapanış **saniyeler içinde, çıkış kodu 0** ile biter (deploy bunu doğrular: `1` = zorla-çıkış, `137` = SIGKILL ⇒ uyarı).

**"Drain ≥ en uzun ikmal süresi" gerekir mi?** Hayır — ve bu bilinçli bir tasarım sonucudur. Aktif ikmal oturumu **süreçte değil Redis'te** yaşar
(`dispenseSessionService.ts`: 30 dk TTL, 15 sn heartbeat zaman aşımı). Cihazın heartbeat/finalize isteği bir HTTP isteğidir ve nginx onu kesmeden sonra yeni replikaya yollar;
oturum durumu her iki replikada aynıdır. Drain'in koruması gereken tek şey **uçuştaki (birkaç yüz ms) HTTP istekleridir**. Eski replikanın kendi sweeper'ları (heartbeat zaman aşımı taraması vb.) kapanırken
durur, yenisi devralır. Tatbikat bunu **ölçer**: oturum eski örnekte başlar, dağıtım sırasında heartbeat almaya devam eder ve yeni örnekte finalize edilir.
Bir HTTP isteği 30 sn'den uzun sürebiliyorsa (ör. büyük dışa aktarım) `DRAIN_TIMEOUT_SECONDS` ve `timeoutMs` birlikte artırılmalıdır (drain her zaman `timeoutMs`'den büyük kalmalı; `test-ops1110` bunu denetler).

## 3. Canlı bağlantılar

**WebSocket (Socket.io).** Dağıtımda tüm istemcilerin aynı anda düşmesi (thundering herd: el sıkışma + JWT + oda katılımı) yerine soketler 8 sn'ye **jitter'lı, karıştırılmış sırayla**
yayılarak koparılır (`drainSocketClients`). Kopuş `socket.conn.close()` iledir → istemci **"transport close"** görür ve `frontend/src/utils/socket.ts`'in sonsuz üstel geri çekilmeli
reconnect'i (1 sn→10 sn, ±%50 jitter) otomatik devreye girer; nginx artık yeni replikaya yönlendirdiği için istemci yeni örneğe bağlanır. **`socket.disconnect(true)` KULLANILMAZ:** istemciye
"io server disconnect" nedeni gider ve socket.io-client bu durumda **yeniden bağlanmaz** (ilk tatbikatta 20/20 istemci kalıcı düştü — bu hata canlı ölçümle yakalandı, `test-ops1110` kilitler).
Kapanma sırasında gelen geç bağlantılar da kademeli koparılır (handshake'te reddetmek istemcide reconnect'i durdururdu).

**MQTT.** Backend, EMQX'e paylaşımlı abonelikle (`$share/<grup>`) bağlanır: iki replika aynı anda ayaktayken telemetri iki örnek arasında paylaştırılır, çift işleme olmaz. Eski replika kapanırken
**önce** MQTT bağlantısı kapatılır (yeni telemetri girişi durur), sonra tamponlar boşalıp Redis/Postgres kapatılır (sıra RES-906 ile korunmuştur). Broker abonelik havuzundan çıkan örneğin payını yeni örneğe verir;
cihaz tarafı MQTT oturumunu değiştirmez.

**Cihaz HTTP çağrıları** (`/dispense/*`, HMAC imzalı) nginx üzerinden geldiği için kesmeden sonra yeni replikaya gider; nonce/anti-replay durumu Redis'tedir (örnekler arası ortak).

## 4. Geri alma — tek komut

```bash
./scripts/rollback.sh              # bir önceki (farklı) sürüme
./scripts/rollback.sh v1.4.2       # kayıtlı belirli bir sürüme
./scripts/rollback.sh --list       # kayıtlı sürümler (yalnızca listeler)
```

Betik **yeniden derlemez** (dakikalar sürer, kaynak ağacına bağımlıdır): `yakittakip-backend-release:<sürüm>` imajını Compose'un backend imajı olarak yeniden etiketler ve aynı blue/green yolunu
`SKIP_BUILD=1 SKIP_SCHEMA=1 DEPLOY_KIND=rollback` ile çalıştırır → geri alma da sıfır kesintili, readiness doğrulamalı ve drain'li; kayda `rollback` olarak yazılır. "Önceki" = güncelden **farklı** en son sürümdür
(rollback sonrası tekrar `rollback.sh` çağırmak ileri sürüme döner — *ping-pong*; belirli sürüm vermek istiyorsanız sürümü yazın). **Ölçülen süre (2026-09-21 tatbikatı, geliştirme makinesi): 19,8 sn, 0 başarısız istek, aktif ikmal oturumu kesilmedi, 20/20 WebSocket istemcisi 7,7 sn'ye yayılarak koptu ve yeniden bağlandı** — ayrıntı: [deploy-drills/2026-09-21.md](deploy-drills/2026-09-21.md).

**Frontend (nginx statik dosyaları)** imajla birlikte değil `git` ağacından gelir: `git checkout <etiket> -- frontend nginx && docker compose up -d --build frontend`. Üretim CI'ı bunu otomatik yapar (otomatik geri alma adımı).
**Hangi imajlar kalır:** yalnızca son 5 sürümün etiketi; daha eskisine dönmek için o etiketi kaynaktan yeniden dağıtın (`git checkout <etiket> && ./scripts/zero-downtime-deploy.sh`) — betik hedef imaj yoksa bunu söyler ve çalışan sürüme dokunmaz.

## 5. Migrasyon geri alma politikası (sınır)

- **Şema asla otomatik geri alınmaz.** `schema.sql` **expand-only**'dir (OPS-1104: `check-migration-safety.mjs`, CI kapısı) — yeni tablo/sütun/indeks eski kodu bozmaz; bu yüzden **önceki UYGULAMA sürümü güncel şemayla çalışır**. Geri alma yalnızca uygulamayı geri alır.
- **Onaylı contract adımı (`-- MIGRATION-CONTRACT:` — DROP/RENAME/NOT NULL…) iki sürüm arasında varsa uygulama-yalnız geri alma güvensizdir** (eski kod silinen/yeniden adlandırılan yapıyı bekler). `rollback.sh` hedef ile güncel
  sürümün `schema.sql`'ini (kayıttaki git SHA'larından) `check-migration-safety.mjs --strict` ile karşılaştırır ve **reddeder (çıkış 3)**. Şema sürümleri çözülemezse (sığ klon vb.) da muhafazakâr davranıp reddeder.
- Reddedilince seçenekler: **(a) ileri düzeltme (hotfix)** — çoğu zaman en güvenlisi; **(b) yedekten geri yükleme** ([BACKUP_RESTORE.md](BACKUP_RESTORE.md); PITR ile hedef zamana dönülür, o zamandan sonraki **veri kaybedilir**, RPO ≤ 15 dk kadar geriye kadar);
  **(c) `--accept-schema-risk`** — yalnızca sonucu bilerek kabul ediyorsanız (ör. contract'ın sildiği sütunu eski kod artık okumuyor).
- **Geri alma veriyi geri almaz:** yeni sürümün ürettiği kayıtlar (ikmaller, denetim günlüğü) korunur. Yeni sürüm, eski kodun tanımadığı bir *değer* yazdıysa (ör. yeni enum değeri) bu, expand-only kuralının kapsamadığı bir uyumluluk riskidir — geri almadan önce yeni özelliğin kullanıldığı verileri kontrol edin.
- Contract adımı **iki aşamalı** yapılır: (1) kod artık yapıyı kullanmayı bırakır, dağıtılır, bir sürüm bekler; (2) ayrı dağıtımda contract. Bu sırayla contract ile aynı sürümde geri alma tuzağı doğmaz.

## 6. Tatbikat

`node scripts/test-ops1110.mjs --live` (dev/staging; çalışan compose yığını gerekir): sürekli yük, aktif ikmal oturumu ve 20 WebSocket istemcisi altında A→B dağıtımı ve B→A geri alma; kesinti, oturum sürekliliği,
soket yayılımı ve **rollback süresi** ölçülür ve `docs/deploy-drills/<tarih>.md` olarak kaydedilir. Statik/davranış kısmı (`node scripts/test-ops1110.mjs`; sahte docker ile gerçek `rollback.sh` + migrasyon kapısı senaryoları) CI'da her commit'te çalışır.

## 7. Sorun giderme

| Belirti | Neden / Çözüm |
|---|---|
| "yeni konteyner … HAZIR olmadı — geri alındı" | DB/Redis/MQTT erişimi veya `.env` hatası; `docker compose logs backend`. Eski replika trafik alıyordu, kesinti olmadı. |
| "beklenen sürümü bildirmedi" | İmaj yanlış/eski (önbellek). `APP_VERSION` build-arg'ının geçtiğini doğrulayın; `docker compose build --no-cache backend`. |
| "eski konteyner temiz kapanmadı (çıkış kodu 1/137)" | 1: uygulama 30 sn içinde kapanamadı (takılı istek/bağlantı; `docker logs <eski-id>` deploy sonrası silinmeden önce alınamaz — `docker compose logs`/Loki `{service="backend"}`); 137: drain süresi yetmedi (`DRAIN_TIMEOUT_SECONDS`↑). |
| Rollback "imaj yerelde yok" | Etiket son 5 sürümün dışında kalıp temizlendi → §4 kaynaktan yeniden dağıtım. |
| Rollback "GÜVENSİZ" (çıkış 3) | §5. |
| `.deploy/releases.log` yok/boş | Bu sunucuda henüz `zero-downtime-deploy.sh` çalışmadı; kayıt ilk başarılı dağıtımla başlar. |
