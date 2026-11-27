# ESP32 pompa kontrol ünitesi firmware'i (FW-1300)

ESP-IDF v5.3, hedef **ESP32** (4 MB flash, ör. ESP32-WROOM-32). Sunucuyla sözleşme: [`docs/HARDWARE_INTEGRATION_GUIDE.md`](../docs/HARDWARE_INTEGRATION_GUIDE.md). Ekran mesajları: [`docs/operator/device-messages.json`](../docs/operator/device-messages.json).

## Durum

| İş | Durum |
|---|---|
| FW-1301 iskelet, bölüm tablosu, CI derlemesi | ✅ bu dizin |
| FW-1308 HMAC imzalama çekirdeği | ✅ şartname vektörleriyle test edildi. NVS'te şifreli secret saklama bekliyor |
| FW-1304 akışmetre (K-faktörü, 64-bit totalizatör, debi) | ✅ çekirdek + PCNT sürücüsü (`yt_pcnt`), K-faktörü NVS'te |
| FW-1314 güç kesintisinde totalizatör ve yarım ikmal | ✅ NVS commit politikası, oturum kaydı, açılışta kurtarma, opsiyonel güç kesintisi girişi |
| İkmal oturumu durum makinesi (rehber §9) + FW-1303 yazılım kilidi | ✅ çekirdek + röle sürücüsü + acil durdurma girişi |
| FW-1313 watchdog | ✅ ana döngü TWDT'ye bağlı (5 sn → panik → reset) |
| FUEL-401 cihaz akışı (kart → yetki → heartbeat → finalize) | ✅ QEMU'da gerçek backend'e karşı uçtan uca test ediliyor |
| FW-1307 HMAC imzalı HTTPS istemcisi (CA paketiyle sertifika doğrulama) | ✅ |
| FW-1307 MQTT: komut kanalı (`FORCE_CUTOFF`, `SET_K_FACTOR`, `TIME_SYNC`), presence + LWT, IOT-305 ack | ✅ QEMU'da gerçek backend + broker ile uçtan uca. Sertifika süre uyarısı sonraki adım |
| FW-1306 WiFi istasyon + yeniden bağlanma (≤ 30 sn) | ✅ — GSM/PPPoS sonraki adım |
| FW-1312 saat: SNTP + sunucu `Date`/`serverTime` | ✅ — DS3231 RTC sonraki adım |
| FW-1310 fail-open kararı | ✅ çekirdek. Whitelist ve politika önbelleği bekliyor; çevrimdışıyken kart şimdilik reddedilir |
| FW-1302 RFID, FW-1309 kuyruk, FW-1311 OTA, FW-1315, 1316, 1317 | ⏳ sonraki adımlar |

Donanım henüz yok. Donanımdan bağımsız her şey `components/yt_core` altında saf C olarak yazıldı ve bilgisayarda test ediliyor. İmajın kendisi ESP32 QEMU'sunda açılış testinden geçiyor (aşağıda). Sürücüler (PCNT, röle, girişler) şartnameye göre yazıldı; sinyal jeneratörü, referans kap ve güç kesme testleri donanım gelince yapılacak (TEST-1005).

## Derleme

Yerel kurulum gerekmez; Espressif'in resmi imajı yeterli:

```bash
# depo kökünden
docker run --rm -v "$PWD:/repo" -w /repo/firmware espressif/idf:v5.3.2 \
  bash -c 'git config --global --add safe.directory "*"; idf.py set-target esp32 && idf.py build'
```

Kendi ESP-IDF kurulumunuzla: `cd firmware && idf.py set-target esp32 && idf.py build flash monitor`.

- Sürüm, `git describe` ile otomatik gömülür ve açılış log'unda basılır. CI bunu `YT_FW_VERSION` ortam değişkeniyle açıkça verir.
- `sdkconfig` repoda tutulmaz; varsayılanlar `sdkconfig.defaults`'tadır. Pinler `idf.py menuconfig` içinde **Yakıt Takip pompa ünitesi** menüsündedir.
- CI (`firmware` işi) her PR'da birim testlerini koşturur, imajı derler ve `.bin` dosyalarını SHA-256 ile artefakt olarak saklar.

## Bilgisayarda birim testleri

```bash
docker run --rm -v "$PWD:/repo" espressif/idf:v5.3.2 bash -c \
  'cmake -S /repo/firmware/test/host -B /tmp/b && cmake --build /tmp/b && /tmp/b/yt_core_tests'
```

Testler cihazdaki **aynı** mbedTLS kaynağıyla derlenir. Kapsam:
- HMAC imzası: şartname §2.5'teki iki resmi vektör birebir.
- Akışmetre: K değişikliğinin ikmal bitene kadar ertelenmesi, 64-bit totalizatör, 60 L/dk debi.
- İkmal durum makinesi: röle kapısı, FORCE_CUTOFF mandalı, yerel limit, acil durdurma, anormal yeniden başlatma, idempotency.
- Fail-open kuralları.
- Güç kesintisi: commit politikası (60 L/dk'da en fazla 5 L kayıp), oturum kaydının biçimi/CRC'si, kurtarma.

## QEMU açılış testi (donanımsız)

```bash
docker run --rm -v "$PWD:/repo" -w /repo/firmware espressif/idf:v5.3.2 bash -c \
  'git config --global --add safe.directory "*"; idf.py -B /tmp/b build && bash test/qemu/run.sh /tmp/b'
```

Derlenen imaj, hazırlanmış NVS içerikleriyle ESP32 QEMU'sunda başlatılır: ilk kurulum, ikmal sürerken güç kesilmesi, finalize gitmeden yeniden başlama ve bozuk kayıt senaryoları. Her biri iki kez açılır, böylece NVS'e yazılanların kalıcı olduğu da doğrulanır. CI her PR'da koşturur.

## Uçtan uca test: firmware ↔ backend (QEMU)

Firmware, `sdkconfig.qemu` ile (emüle Ethernet, geliştirme konsolu, yerel düz HTTP) derlenip QEMU'da çalışır ve **gerçek backend'e** gerçek HMAC imzalı isteklerle bağlanır. Kart okutma ve akışmetre palsleri seri konsoldan verilir. Gerisi cihaz kodudur: imza, saat eşitleme, oturum durum makinesi, heartbeat, finalize ve NVS. [`backend/test/test_fw_qemu_e2e.ts`](../backend/test/test_fw_qemu_e2e.ts) iki senaryoyu doğrular:

- **Normal ikmal:** 30 L → `FLOW_STOPPED` → veritabanında tek kayıt, `DOĞRULANDI`.
- **İkmal ortasında güç kesintisi:** QEMU anında kapatılır. Açılışta oturum kurtarılır ve `DOĞRULAMA_BEKLIYOR` olarak kaydedilir; kayıp ≤ 5 L.
- **MQTT** (`FW_E2E_MQTT_URL` verilince, backend aynı broker'a bağlı):
  - Presence `ONLINE` olur.
  - Portaldan kalibrasyon → cihaz uygular → HTTP ACK → sunucuda `ONAYLANDI`; yeni K yeniden başlatmada korunur.
  - İkmal sürerken gelen kalibrasyon `NACK` (`DISPENSE_IN_PROGRESS`) ile reddedilir.
  - Broker'dan gelen `FORCE_CUTOFF` röleyi keser, IOT-305 ack'i yayınlanır ve ikmal kaydedilir.

CI'da `auth-integration-test` işinin son adımında koşar; o adım EMQX 5.8.0'ı başlatıp backend'i MQTT ile yeniden başlatır. Yerelde backend 5000 portunda ayaktayken:

```bash
# 1) imaj (sunucu, QEMU içinden ana makineye 10.0.2.2 ile ulaşır)
docker run --rm -v "$PWD:/repo" -v /tmp/fw:/fw -w /repo/firmware \
  -e E2E_DEVICE_ID=ESP32-PUMP-01 -e E2E_DEVICE_SECRET="$HW_SECRET_ESP32_PUMP_01" \
  -e E2E_SERVER_URL=http://10.0.2.2:5000/api/v1 -e E2E_TANK_NAME="Gebze Ana Tank (T-1)" \
  espressif/idf:v5.3.2 bash -c 'Q="-B /tmp/bq -D SDKCONFIG=/tmp/bq/sdkconfig -D SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.qemu"
    idf.py $Q build && bash test/qemu/make_e2e_image.sh /tmp/bq /fw/fw-e2e.bin'
# 2) test (QEMU, backend'e ulaşabilen bir ağda: Linux'ta --network host)
cd backend && FW_E2E_FLASH=/fw/fw-e2e.bin \
  FW_QEMU_CMD="docker run -i --rm --network host -v /tmp/fw:/fw espressif/idf:v5.3.2 qemu-system-xtensa" \
  npx tsx test/test_fw_qemu_e2e.ts
```

Konsol komutları (`CONFIG_YT_DEV_CONSOLE`, yalnızca geliştirme): `kart <uid>`, `akis <litre> <L/dk>` (yalnızca röle açıkken akar), `durum`.

## Saha yapılandırması (NVS)

| Ad alanı / anahtar | İçerik |
|---|---|
| `yt_sec` / `dev_id`, `secret` | Claim (rehber §6) ile alınan cihaz kimliği ve HMAC secret'ı |
| `yt_cfg` / `srv_url` | Sunucu, ör. `https://yakit.example.com/api/v1`. **`https://` zorunlu**: düz `http://` yalnızca geliştirme yapılandırmasında kabul edilir |
| `yt_cfg` / `tank_name` | Bu pompanın bağlı olduğu tank (sunucudaki adıyla) |
| `yt_cfg` / `wifi_ssid`, `wifi_pass` | WiFi |
| `yt_cfg` / `mqtt_url` | Broker, ör. `mqtts://yakit.example.com:8883`. **`mqtts://` zorunlu**: `mqtt://` yalnızca geliştirmede. Yoksa cihaz MQTT'siz çalışır; komutlar yalnızca heartbeat yanıtıyla gelir |
| `yt_cfg` / `mqtt_user`, `yt_sec` / `mqtt_pass` | Broker kimliği (rehber §3.1: bugün ortak kimlik) |
| `yt_cfg` / `tenant_id`, `site_id` | Topic'teki kiracı ve şantiye (`telemetry/v1/{tenant}/{site}/pump/{cihaz}/status`). Kiracı, cihazın sunucudaki kaydıyla **aynı** olmalı, yoksa sunucu paketleri düşürür |

Bugün üretim hattında `nvs_partition_gen.py` ile hazırlanan NVS imajı 0x9000'e yazılır; örnek: `test/qemu/make_e2e_image.sh`. Cihaz üzerinde claim ve kurulum portalı (FW-1317) sonraki adımda. Yapılandırma eksikse cihaz sunucuya bağlanmaz ve kart kabul etmez.

## Sunucuyla akış ve bağlantı kesintileri

- Ağ istekleri ayrı bir görevde yürür, aynı anda tek istek gider (TLS belleği). Röleyi süren 100 ms'lik döngü ağı **hiç beklemez**.
- Heartbeat 5 sn'de bir gider. Sunucudan 15 sn yanıt alınamazsa cihaz röleyi keser (`LINK_LOST`); sunucu da o oturumu `TIMED_OUT` yapmıştır. Finalize, ağ gelince aynı idempotency anahtarıyla gider. Geri çekilme 2 sn'den başlar, en fazla 60 sn'dir.
- Sunucu oturumu tanımıyorsa (heartbeat'e 404/409) röle hemen kesilir. `FORCE_CUTOFF` ve tanınmayan komut da kesme demektir.
- Çevrimdışıyken okutulan kart şimdilik reddedilir (`OFFLINE`). Sınırlı çevrimdışı ikmal FW-1310 ile gelecek.
- **MQTT:** kalıcı oturum (clean session kapalı) ve QoS 1 kullanılır; kısa kopmalarda kaçırılan komutlar yeniden bağlanınca gelir. LWT `OFFLINE`'dır; bağlıyken 8 sn'de bir `ONLINE` yayınlanır (sunucu TTL'i 10 sn). Komutlar denetim döngüsüne kuyrukla iletilir ve döngü hemen uyandırılır, böylece `FORCE_CUTOFF` 100 ms'lik turu beklemez.
- **Kalibrasyon (`SET_K_FACTOR`):** ikmal sürerken reddedilir (`NACK`). Kabul edilirse K uygulanıp kalıcı yazılır, sonra HTTP ACK gönderilir. Sunucu ACK'i 5 dk içinde kayda geçiremezse cihaz eski K'ye döner (ayrıntı: rehber §3.6).
- Saat: sunucu ±30 sn dışındaki imzayı reddeder. Cihaz SNTP'nin yanında her sunucu yanıtındaki `Date` başlığından ve heartbeat'teki `serverTime`'dan da eşitlenir. Saat güvenilir olmadan imzalı istek gönderilmez.

## Varsayılan pinler

| İşlev | GPIO | Not |
|---|---|---|
| Röle (pompa/solenoid) | 13 | **Fiziksel pull-down zorunlu**, aşağıya bakın |
| Akışmetre pals girişi | 14 | PCNT çevre birimi (FW-1304) |
| Acil durdurma girişi | 27 | Normalde kapalı kontak GPIO–GND: basılınca veya tel koparsa durur. **Geliştirme kartında pini GND'ye köprüleyin**, yoksa röle hiç açılmaz |
| Güç kesintisi erken uyarısı | — | Opsiyonel (`menuconfig`). LOW = besleme düşüyor, aşağıya bakın |
| PN532 RFID — I2C SDA / SCL | 21 / 22 | |

Varsayılan K-faktörü 450 pals/L'dir (eski saha prototipindeki değer). Gerçek değer uzaktan kalibrasyonla (rehber §5) gelir.

## Röle güvenliği (FW-1303 — en kritik donanım kararı)

- Röle sürücü girişinde **fiziksel pull-down direnci** olmalıdır (aktif-yüksek modül, ör. 10 kΩ GPIO→GND). MCU reset, brown-out ya da kilitlenmede GPIO yüksek empedansa düşer; direnç röleyi kapatır. Yazılım bunu tek başına garanti **edemez**.
- Aktif-düşük bir röle modülü kullanılırsa (`menuconfig` → "HIGH ile çeker" kapalı) direnç **pull-up** olmalıdır.
- Açılışta röle her şeyden önce kapalı seviyeye çekilir. Açabilmenin tek yolu `yt_relay_apply()`'dır; o da yalnızca `yt_session_relay_allowed()` izin verdiğinde (sunucu yetkisi + limit + kesme mandalı) ve acil durdurma aktif değilken açar.
- Acil durdurma kontağı röle besleme hattını **donanımsal olarak da** kesmelidir. Yazılımın bunu görmesi kayıt içindir, güvenliğin kendisi değildir.

## Güç kesintisi ve NVS (FW-1314)

**Totalizatör.** NVS'e her palste değil, akış varken son yazmadan bu yana **5 L** birikince veya **10 sn** geçince yazılır. Rölantide hiç yazılmaz. İkmal başında ve sonunda ayrıca zorla yazılır. Güç bir anda kesilirse kayıp en fazla 5 L'dir; düşük debide 10 sn'lik akış kadardır. Değer tamsayı mL olarak (`u64`) tutulur.

**Yarım ikmal.** Sunucu yetki verdiği anda oturum kaydı (oturum kimliği, idempotency anahtarı, başlangıç totalizatörü; sürümlü, CRC'li) NVS'e yazılır. İkmal bitince güncellenir, sunucu kabul edince silinir. Açılışta kayıt varsa:
- İkmal sürerken kesilmişse oturum `ABNORMAL_RESTART` ile kesinleştirilir. Finalize `"recoveredAfterRestart": true` ile gider ve sunucu kaydı **operatör onayına** düşürür (rehber §9.3).
- İkmal bitmiş ama finalize ulaşmamışsa aynı idempotency anahtarıyla yeniden gönderilir. Çift kayıt oluşmaz.
- Her iki durumda röle kapalı başlar ve o oturumda bir daha açılmaz.

**Flash ömrü.** NVS bölümü 6 × 4 KB sektördür ve yazmaları sektörler arasında döndürür. Bir sektör 126 kayıt alır, SPI flash sektör başına ≥ 100.000 silme döngüsü dayanır: ömür boyu ≈ 6 × 126 × 100.000 ≈ **75 milyon kayıt**. Bir ikmal 5 L başına 1 kayıt, artı oturum kaydı için ~15 kayıt yazar.

| Senaryo | Kayıt/gün | Ömür |
|---|---|---|
| Yoğun saha: 20.000 L/gün, 100 ikmal | ≈ 4.000 + 1.500 = 5.500 | ≈ 37 yıl |
| En kötü durum: 24 saat kesintisiz 60 L/dk (86.400 L/gün) | ≈ 17.300 + 4.300 = 21.600 | ≈ 9,5 yıl |

**NVS açılamazsa otomatik silinmez.** ESP-IDF örneklerindeki "hata → `nvs_flash_erase()`" kalıbı totalizatörü, K-faktörünü ve secret'ı sessizce sıfırlar. Bunun yerine cihaz ikmal kabul etmez, röle kapalı kalır ve servis gerekir.

**Brown-out.** ESP32'nin dahili brown-out dedektörü çipi doğrudan resetler; flash'a yazma fırsatı vermez. Son litreleri de kurtarmak isteyen kurulum, regülatör öncesindeki besleme hattını bir karşılaştırıcıyla izleyip `YT_PIN_POWER_FAIL` girişine bağlar ve en az 50 ms tutma kondansatörü ekler. Sinyal gelince röle kapanır ve totalizatör hemen yazılır. Bu giriş olmadan da 5 L sınırı geçerlidir.

## Bölüm tablosu (`partitions.csv`)

| Bölüm | Boyut | Amaç |
|---|---|---|
| `nvs` | 24 KB | K-faktörü, totalizatör, cihaz secret'ı (şifreli) |
| `nvs_keys` | 4 KB | NVS şifreleme anahtarları (üretim) |
| `otadata` + `ota_0` / `ota_1` | 2 × 1,75 MB | A/B OTA + bootloader rollback (FW-1311) |
| `storage` | 384 KB | Çevrimdışı ikmal kuyruğu (FW-1309) |

"factory" bölümü 4 MB'a sığmadığı için yoktur; geri dönüş A/B yuvalarıyla yapılır. Bölüm tablosu OTA ile değiştirilemez, bu yüzden yuva boyutları baştan geniş seçildi (bugünkü imaj ~200 KB). Flash şifreleme ve secure boot **üretim** yapılandırmasında açılmalı, geliştirmede kapalı kalır.
