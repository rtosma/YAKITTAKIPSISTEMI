# Secret Yönetimi ve Rotasyon Prosedürü (OPS-1105)

Bu belge, sistemdeki her gerçek sırrın **nerede tutulduğunu**, **kimin
erişebildiğini**, **ne zaman değişmesi gerektiğini** ve **nasıl rotasyona
sokulacağını** tanımlar. Tüm ortam değişkeni şeması
[`backend/src/config/env.ts`](../backend/src/config/env.ts) içinde Zod ile
doğrulanır (ARCH-110) — bu belge o şemanın "neden" ve "nasıl"ını anlatır,
şemanın kendisi tek doğruluk kaynağıdır.

## Genel kural

- Hiçbir gerçek sır kaynak koduna, `.env.example`'a veya bu belgeye
  **yazılmaz**. Yalnızca değişken adları ve placeholder'lar görünür.
- Repo genelinde her push'ta [gitleaks](https://github.com/gitleaks/gitleaks)
  taraması çalışır (`secret-scan` job, `.github/workflows/ci-cd.yml`) —
  yapılandırması [`.gitleaks.toml`](../.gitleaks.toml)'da.
- `.env` dosyaları `.gitignore`'da hariç tutulur; yalnızca `.env.example`
  commit edilir.

## Secret Envanteri

| Değişken | Nerede kullanılıyor | Kim erişebilir | Rotasyon sıklığı |
|---|---|---|---|
| `JWT_SECRET` | Access token imzalama/doğrulama (`services/tokenService.ts`) | Backend süreci (host/container ortamı) | Şüpheli sızıntıda hemen; aksi halde yılda 1 |
| `JWT_REFRESH_SECRET` | Refresh token imzalama/doğrulama (`services/tokenService.ts`) | Backend süreci | Şüpheli sızıntıda hemen; aksi halde yılda 1 |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | EMQX broker kimlik doğrulaması (`iot/mqttClient.ts`, `docker/emqx/entrypoint.sh`) | Backend süreci + EMQX broker | Şüpheli sızıntıda hemen |
| `HW_SECRET_ESP32_PUMP_01`, `HW_SECRET_ESP32_TANK_01`, `HW_SECRET_ESP32_FLOW_ISR` | Donanım HMAC-SHA256 imza doğrulaması, cihaz başına (`middleware/hardwareAuthMiddleware.ts`) | Backend süreci + ilgili fiziksel ESP32 cihazının firmware'i | Cihaz sızıntı şüphesinde hemen (yalnızca o cihaz) |
| `POSTGRES_PASSWORD` | Postgres kimlik doğrulaması (`db/postgresPool.ts`) | Backend süreci + Postgres container | **Rotasyona sokulmaz** (bkz. aşağıdaki not) — bağlantı hiç host'a açılmıyor |

`POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_HOST`, `POSTGRES_PORT`,
`REDIS_HOST`, `REDIS_PORT`, `MQTT_URL`, `PORT`, `NODE_ENV`, `LOG_LEVEL`
gerçek sır değildir (yapılandırma değeridir) — envanterde yer almazlar,
tam listesi `backend/.env.example`'dadır.

**Neden `POSTGRES_PASSWORD` rotasyona sokulmuyor?** Bu projede Postgres
hiçbir zaman docker-compose'un dahili ağının dışına çıkmıyor (host'a port
yayını yok, bkz. OPS-1102 zero-downtime deploy notları) ve
`docker-compose.yml`'nin kendisi Postgres container'ının şifresini de AYNI
`${POSTGRES_PASSWORD}` değişkeninden okuyor. `.env`'de değeri değiştirmek
DB'nin gerçek şifresini DEĞİŞTİRMEZ (Postgres parolayı yalnızca ilk init'te,
boş bir data dizininden okur) — gerçek bir rotasyon `ALTER USER ... PASSWORD`
ile DB içinde ayrıca yapılmalı ve bu belgeye eklenmelidir, o güne kadar
env değişkeninin kendisi rotasyon prosedürünün kapsamı dışında.

## Rotasyon Prosedürleri

### JWT_SECRET / JWT_REFRESH_SECRET

⚠️ **Rotasyon TÜM aktif oturumları düşürür** — mevcut access/refresh
token'lar yeni sırla doğrulanamaz hale gelir, her kullanıcı yeniden giriş
yapmak zorunda kalır. Kademeli (eski+yeni ikisi birden geçerli) bir rotasyon
şu anda desteklenmiyor — `tokenService.ts` tek bir aktif sırla çalışıyor.

1. Yeni bir değer üretin: `openssl rand -hex 64`
2. Bakım penceresi planlayın (tüm kullanıcılar oturumdan düşecek).
3. `.env`'de (veya gerçek secret store'da) değeri güncelleyin.
4. Backend'i yeniden başlatın (zero-downtime deploy script'i burada
   **kullanılmamalı** — script eski/yeni repliğin AYNI ANDA ayakta kalmasını
   varsayıyor, ama eski replik yeni token'ları, yeni replik eski token'ları
   doğrulayamayacağı için geçiş penceresinde rastgele 401'ler üretir; düz bir
   `docker compose up -d --build backend` ile kısa bir kesinti kabul edilmeli).
5. Kullanıcılara oturumlarının düştüğünü ve yeniden giriş yapmaları
   gerektiğini bildirin.

### MQTT_USERNAME / MQTT_PASSWORD

1. EMQX broker'da yeni kimlik bilgisini oluşturun (bkz.
   `docker/emqx/entrypoint.sh` — kimlik bilgisi orada seed'leniyor).
2. `.env`'i güncelleyip backend'i yeniden başlatın.
3. Eski kimlik bilgisini EMQX'ten kaldırın.
4. Geçiş sırasında backend MQTT'ye bağlanamazsa telemetri ingestion durur
   (bkz. `mqttClient.ts`'in reconnect mantığı) — bu adımı kısa bir bakım
   penceresinde yapın.

### HW_SECRET_ESP32_* (donanım cihaz sırları)

⚠️ **AUTH-202.3 (cihaz secret üretimi/saklanması/uzaktan rotasyon komutu)
henüz uygulanmadı.** Şu anda tek bir statik sır var, iki secret'ın birlikte
geçerli olduğu bir geçiş penceresi YOK — bir cihazın sırrını değiştirmek,
o cihazın FİZİKSEL OLARAK yeni sırla yeniden flaşlanmasını (veya elle
yapılandırılmasını) gerektirir ve bu yapılana kadar o cihaz backend'e hiçbir
paket gönderemez (401 `INVALID_HARDWARE_SIGNATURE`). Bu yüzden:

1. Yalnızca o cihazın sızdığından/ele geçirildiğinden şüpheleniyorsanız
   rotasyona sokun — rastgele/periyodik rotasyon şu an sahada kesintiye
   sebep olur.
2. Yeni bir değer üretin: `openssl rand -hex 32`
3. `.env`'de yalnızca o cihazın değişkenini güncelleyin, backend'i yeniden
   başlatın.
4. Cihazı fiziksel olarak (veya varsa yerel bir yapılandırma arayüzünden)
   yeni sırla güncelleyin.
5. AUTH-202.3 tamamlandığında bu prosedür, sahada kesinti yaratmayan
   uzaktan bir rotasyon komutuyla değiştirilmelidir.

## Sızıntı Şüphesinde İzlenecek Adımlar

1. **Hemen** ilgili sırrı yukarıdaki prosedüre göre rotasyona sokun —
   soruşturmayı beklemeyin, önce erişimi kapatın.
2. `git log`'da o sırrın hangi commit(ler)de göründüğünü tespit edin
   (`gitleaks detect --log-opts="--all"` geçmişi tarayabilir).
3. Sızıntı bir commit'teyse ve repo public/geniş erişimliyse, sırrı
   rotasyona sokmak YETERLİDİR — git geçmişini yeniden yazmak (BFG/
   git-filter-repo + force-push) yalnızca rotasyon sonrası, ayrı bir
   kararla ve tüm collaborator'lar bilgilendirilerek yapılmalıdır (force-push
   herkesin yerel kopyasını bozar).
4. Etkilenen sistemin (JWT → tüm oturumlar, MQTT → broker, donanım → tek
   cihaz) kapsamını bu belgedeki envanter tablosundan doğrulayın.
