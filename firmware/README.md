# ESP32 pompa kontrol ünitesi firmware'i (FW-1300)

ESP-IDF v5.3, hedef **ESP32** (4 MB flash, ör. ESP32-WROOM-32). Sunucuyla sözleşme: [`docs/HARDWARE_INTEGRATION_GUIDE.md`](../docs/HARDWARE_INTEGRATION_GUIDE.md). Ekran mesajları: [`docs/operator/device-messages.json`](../docs/operator/device-messages.json).

## Durum

| İş | Durum |
|---|---|
| FW-1301 iskelet, bölüm tablosu, CI derlemesi | ✅ bu dizin |
| FW-1308 HMAC imzalama çekirdeği | ✅ şartname vektörleriyle test edildi. NVS'te şifreli secret saklama bekliyor |
| FW-1304 akışmetre hesapları (K-faktörü, 64-bit totalizatör, debi) | ✅ çekirdek. PCNT sürücüsü bekliyor |
| İkmal oturumu durum makinesi (rehber §9) + FW-1303 yazılım kilidi | ✅ çekirdek + röle sürücüsü |
| FW-1310 fail-open kararı | ✅ çekirdek. Whitelist ve politika önbelleği bekliyor |
| FW-1302 RFID, FW-1306/1307 ağ ve MQTT/TLS, FW-1309 kuyruk, FW-1312 RTC, FW-1314 NVS, FW-1311 OTA, FW-1313, 1315, 1316, 1317 | ⏳ sonraki adımlar |

Donanım henüz yok. Donanımdan bağımsız her şey `components/yt_core` altında saf C olarak yazıldı ve bilgisayarda test ediliyor. Sürücüler şartnameye göre yazılıp donanım gelince sahada doğrulanacak (TEST-1005).

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

## Varsayılan pinler

| İşlev | GPIO | Not |
|---|---|---|
| Röle (pompa/solenoid) | 13 | **Fiziksel pull-down zorunlu**, aşağıya bakın |
| Akışmetre pals girişi | 14 | PCNT çevre birimi (FW-1304) |
| Acil durdurma girişi | 27 | Normalde kapalı kontak: tel koparsa da durur |
| PN532 RFID — I2C SDA / SCL | 21 / 22 | |

Varsayılan K-faktörü 450 pals/L'dir (eski saha prototipindeki değer). Gerçek değer uzaktan kalibrasyonla (rehber §5) gelir.

## Röle güvenliği (FW-1303 — en kritik donanım kararı)

- Röle sürücü girişinde **fiziksel pull-down direnci** olmalıdır (aktif-yüksek modül, ör. 10 kΩ GPIO→GND). MCU reset, brown-out ya da kilitlenmede GPIO yüksek empedansa düşer; direnç röleyi kapatır. Yazılım bunu tek başına garanti **edemez**.
- Aktif-düşük bir röle modülü kullanılırsa (`menuconfig` → "HIGH ile çeker" kapalı) direnç **pull-up** olmalıdır.
- Açılışta röle her şeyden önce kapalı seviyeye çekilir. Açabilmenin tek yolu `yt_relay_apply()`'dır; o da yalnızca `yt_session_relay_allowed()` izin verdiğinde (sunucu yetkisi + limit + kesme mandalı) ve acil durdurma aktif değilken açar.
- Acil durdurma kontağı röle besleme hattını **donanımsal olarak da** kesmelidir. Yazılımın bunu görmesi kayıt içindir, güvenliğin kendisi değildir.

## Bölüm tablosu (`partitions.csv`)

| Bölüm | Boyut | Amaç |
|---|---|---|
| `nvs` | 24 KB | K-faktörü, totalizatör, cihaz secret'ı (şifreli) |
| `nvs_keys` | 4 KB | NVS şifreleme anahtarları (üretim) |
| `otadata` + `ota_0` / `ota_1` | 2 × 1,75 MB | A/B OTA + bootloader rollback (FW-1311) |
| `storage` | 384 KB | Çevrimdışı ikmal kuyruğu (FW-1309) |

"factory" bölümü 4 MB'a sığmadığı için yoktur; geri dönüş A/B yuvalarıyla yapılır. Bölüm tablosu OTA ile değiştirilemez, bu yüzden yuva boyutları baştan geniş seçildi (bugünkü imaj ~200 KB). Flash şifreleme ve secure boot **üretim** yapılandırmasında açılmalı, geliştirmede kapalı kalır.
