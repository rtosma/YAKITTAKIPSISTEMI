# 📖 Terim Sözlüğü

> Bu projede ekipteki herkesin (gömülü, backend, frontend, saha, muhasebe) aynı terimi aynı anlamda kullanması için hazırlanmıştır.
> **Kural:** Konuşma dili Türkçe, kod/değişken/endpoint/tablo isimleri İngilizcedir.

---

## ⛽ Akaryakıt ve Saha Terimleri

| Terim | İngilizce | Tanım | Projede nerede |
|---|---|---|---|
| **Debimetre / Akışmetre** | Flow meter | Borudan geçen sıvı miktarını ölçen cihaz. Her litre için belirli sayıda elektriksel darbe (pals) üretir. | `FW-1304`, pompa kontrol ünitesi |
| **Pals** | Pulse | Akışmetrenin ürettiği elektriksel darbe. Litre = pals sayısı ÷ K-factor. | `FW-1304` |
| **K-factor** | K-factor | Bir litre yakıt için akışmetrenin ürettiği pals sayısı (pals/litre). Yanlış ayarlanırsa ölçülen litre gerçekten sapar; bu yüzden değişimi denetim altındadır. | `FUEL-404`, `FW-1304` |
| **Kalibrasyon** | Calibration | Bilinen hacimde referans bir kaba yakıt alıp ölçüm sapmasını hesaplayarak K-factor'ü düzeltme işlemi. | `FUEL-404.2` |
| **Totalizatör** | Totalizer | Cihazın açılışından beri saydığı toplam litre. Sıfırlanmaz; ikmal litresi iki totalizatör okuması arasındaki farktır. | `FW-1304`, `FW-1314` |
| **Strapping table / Daldırma cetveli** | Strapping table | Bir tankta her milimetre seviyenin kaç litreye karşılık geldiğini gösteren kalibrasyon tablosu. Silindirik tanklarda seviye-hacim ilişkisi doğrusal olmadığı için gereklidir. | `FUEL-403.1` |
| **Ultrasonik seviye sensörü** | Ultrasonic level sensor | Ses dalgasıyla tanktaki yakıt yüzeyine olan mesafeyi ölçen sensör. Çıktısı milimetredir, litreye cetvelle çevrilir. | `IOT-302`, `INV-1501` |
| **ASTM D1250 / VCF** | Volume Correction Factor | Yakıt hacminin sıcaklığa göre değiştiğini hesaba katıp 15 °C standart hacme indirgeyen düzeltme tablosu. Bu yapılmazsa yazın normal genleşme "fire" sanılır. | `FUEL-403.2` |
| **Fire** | Loss / shrinkage | Kayıtlara göre olması gereken ile fiilen ölçülen yakıt arasındaki eksik. Buharlaşma, ölçüm hatası, sızıntı veya hırsızlıktan kaynaklanabilir. | `FUEL-409`, `INV-1505` |
| **Mutabakat** | Reconciliation | Teorik stok (önceki bakiye + dolum − ikmal) ile fiziksel stoğun (sensör ölçümü) karşılaştırılması. | `FUEL-409` |
| **Teorik stok** | Book stock | Kayıtlardan hesaplanan, olması gereken yakıt miktarı. | `FUEL-409` |
| **Fiziksel stok** | Physical stock | Sensörün ölçtüğü, tankta gerçekten bulunan yakıt miktarı. | `FUEL-409` |
| **İkmal** | Fuel dispensing / refueling | Bir araca yakıt verme işlemi. Sistemdeki temel finansal kayıt. | `FUEL-401` |
| **Çapraz alım** | Cross-site dispensing | Bir şantiyenin aracının, yetkilendirildiği ölçüde başka bir şantiyenin tankından yakıt alması. | `FUEL-402` |
| **Kota** | Quota | Bir araç veya şantiyenin belirli bir dönemde alabileceği azami litre. | `FUEL-402.1` |
| **Mahsuplaşma** | Netting / settlement | Çapraz alımlar sonucu firmalar arasında oluşan borç-alacak dengesinin hesaplanması. | `REP-715` |
| **Ölü hacim** | Dead volume | Tank tabanında bulunan, pompayla çekilemeyen yakıt. Kullanılabilir stoktan düşülür. | `INV-1501` |
| **Motor-saat** | Hourmeter / engine hours | İş makinelerinde km yerine kullanılan çalışma süresi sayacı. Tüketim L/saat olarak hesaplanır. | `FLEET-1404` |
| **Hourmeter** | — | Bkz. Motor-saat. | `FLEET-1404` |
| **AdBlue** | AdBlue / DEF | Dizel araçlarda egzoz emisyonunu azaltan üre çözeltisi. Yakıt değildir ama aynı altyapıyla takip edilir. | `FUEL-407` |

## 📡 Donanım ve IoT Terimleri

| Terim | İngilizce | Tanım | Projede nerede |
|---|---|---|---|
| **RFID tag / UID** | RFID tag / UID | Araç veya şoföre ait, temassız okunan kimlik etiketi. UID etiketin benzersiz kimlik numarasıdır. | `FLEET-1402`, `FW-1302` |
| **Röle** | Relay | Pompaya giden elektriği açıp kapatan anahtar. Sistemin yakıt akışını fiilen kontrol ettiği nokta. | `FW-1303` |
| **Interlock** | Interlock | Röleyi yalnızca güvenli koşullarda açılmaya zorlayan donanımsal/yazılımsal kilit. | `FW-1303` |
| **ESP-IDF** | — | Espressif'in ESP32 için resmî geliştirme çerçevesi. Bu projede Arduino yerine ESP-IDF seçilmiştir (güvenli OTA, watchdog, NVS şifreleme gerekçesiyle). | `FW-1301` |
| **Watchdog (TWDT)** | Task Watchdog Timer | Kilitlenen bir görevi algılayıp cihazı yeniden başlatan koruma. Röle açık takılı kalmayı önler. | `FW-1313` |
| **Brown-out** | Brown-out | Besleme geriliminin cihazın çalışamayacağı seviyeye düşmesi. Tespit edilip güvenli kapanma yapılır. | `FW-1313`, `FW-1314` |
| **NVS** | Non-Volatile Storage | ESP32'de güç kesilse de kaybolmayan küçük ayar deposu. K-factor ve totalizatör burada saklanır. | `FW-1305`, `FW-1314` |
| **LittleFS** | — | ESP32 flash belleğinde çalışan, güç kesintisine dayanıklı dosya sistemi. Çevrimdışı ikmal kuyruğu burada tutulur. | `FW-1309` |
| **OTA** | Over-The-Air update | Firmware'in uzaktan, kablo bağlamadan güncellenmesi. A/B partition ile hatalı sürümden geri dönülebilir. | `FW-1311`, `IOT-306` |
| **RTC** | Real-Time Clock | Güç kesilse de saati koruyan pilli saat modülü. Çevrimdışı kayıtların zaman damgası buna bağlıdır. | `FW-1312` |
| **MQTT** | — | Az bant genişliği tüketen, IoT için tasarlanmış mesajlaşma protokolü. Cihaz-sunucu haberleşmesinin ana yolu. | `IOT-301` |
| **QoS 1** | Quality of Service 1 | MQTT'de "en az bir kez teslim" garantisi. Mesaj kaybolmaz ama mükerrer gelebilir; bu yüzden idempotency gerekir. | `IOT-301.1` |
| **LWT** | Last Will and Testament | Cihaz beklenmedik şekilde koptuğunda broker'ın otomatik yayımladığı "bu cihaz gitti" mesajı. | `IOT-301.2` |
| **EMQX** | — | Bu projede kullanılan MQTT broker (mesaj dağıtıcısı). | `IOT-301` |
| **LoRaWAN** | — | Kilometrelerce menzilli, düşük güç tüketen kablosuz ağ. Tank seviye sensörleri bunu kullanır. | `IOT-302` |
| **ChirpStack / TTN** | — | LoRaWAN ağ sunucusu yazılımları. Sensör paketlerini sunucuya ileten katman. | `IOT-302.1` |
| **DevEUI** | — | Bir LoRaWAN cihazının benzersiz donanım kimliği. | `INV-1501` |
| **RSSI / SNR** | — | Kablosuz sinyalin gücü ve gürültüye oranı. Cihaz sağlık skorunun girdisidir. | `IOT-308` |
| **Provisioning / Claim** | Device provisioning | Sahaya götürülen bir cihazın doğru firmaya, şantiyeye ve tanka bağlanması işlemi. | `IOT-304` |
| **Device shadow** | Device shadow | Cihazın "olması istenen" durumu ile "bildirdiği" durumun sunucuda tutulduğu kayıt. Çevrimdışı cihaza komut göndermeyi mümkün kılar. | `IOT-305` |
| **HIL** | Hardware-in-the-loop | Firmware'i gerçek sinyaller ve gerçek donanımla otomatik test etme düzeneği. | `TEST-1005` |
| **Captive portal** | — | Cihazın kurulum modunda açtığı, telefonla bağlanıp ayar yapılan geçici WiFi sayfası. | `FW-1317` |

## 🔐 Güvenlik ve Mimari Terimleri

| Terim | İngilizce | Tanım | Projede nerede |
|---|---|---|---|
| **Tenant / Kiracı** | Tenant | Sistemi kullanan müşteri firma. Her tenant'ın verisi diğerlerinden yalıtılmıştır. | `ARCH-101` |
| **Multi-tenancy** | Multi-tenancy | Tek bir sistem kurulumunun birden çok müşteriye, verileri karışmadan hizmet vermesi. | `ARCH-101` |
| **RLS** | Row-Level Security | PostgreSQL'in satır bazlı erişim kontrolü. Uygulama kodunda unutulan bir filtre olsa bile veritabanı başka tenant'ın satırını döndürmez. | `ARCH-101.3` |
| **AsyncLocalStorage** | — | Node.js'te bir isteğin bağlamını (tenant, kullanıcı) parametre geçmeden tüm çağrı zincirinde taşıyan mekanizma. | `ARCH-101.1` |
| **HMAC-SHA256** | — | Paylaşılan bir gizli anahtarla üretilen imza. Cihazdan gelen paketin gerçekten o cihazdan geldiğini ve değişmediğini kanıtlar. | `AUTH-202`, `FW-1308` |
| **Replay attack** | Replay attack | Ağdan yakalanan geçerli bir paketin tekrar gönderilerek sahte kayıt üretilmesi. Timestamp + nonce ile engellenir. | `AUTH-202.2` |
| **Nonce** | Nonce | Her pakette bir kez kullanılan rastgele değer. Aynı nonce ikinci kez kabul edilmez. | `AUTH-202.2` |
| **Argon2id** | — | Parola saklamak için kullanılan, kırılması pahalı hash algoritması. | `AUTH-201.1` |
| **JWT** | JSON Web Token | Kullanıcının kimliğini taşıyan imzalı erişim biletçiği. Access token kısa (15 dk), refresh token uzun (7 gün) ömürlüdür. | `AUTH-201.2` |
| **Token rotation** | Token rotation | Her yenilemede refresh token'ın değiştirilmesi. Eski token ikinci kez kullanılırsa çalınmış sayılır ve tüm oturumlar düşürülür. | `AUTH-201.2` |
| **RBAC** | Role-Based Access Control | Rol bazlı yetkilendirme. Bu projede 5 rol vardır. | `AUTH-201.4` |
| **Idempotency** | Idempotency | Aynı isteğin iki kez gönderilmesinin tek bir sonuç üretmesi. Ağ hatasında tekrar denenen ikmal kaydının çiftlenmesini önler. | `FUEL-401.4` |
| **Redlock** | — | Redis üzerinde çalışan dağıtık kilit. Aynı kotayı hedefleyen eşzamanlı isteklerin birbirini ezmesini engeller. | `FUEL-402.2` |
| **Fail-open / Fail-close** | — | Sunucuya ulaşılamadığında cihazın davranışı: fail-open yakıt verir, fail-close vermez. Bu projede **hibrit sınırlı fail-open** seçilmiştir. | `FUEL-410`, `FW-1310` |
| **Audit trail** | Audit trail | Kritik işlemlerin kim tarafından ne zaman yapıldığını gösteren, silinemeyen kayıt defteri. | `AUTH-203` |
| **Outbox pattern** | Transactional outbox | Veritabanı kaydı ile olay yayımının aynı transaction'da yapılmasını sağlayan desen. "Kaydettim ama olayı yayımlayamadım" durumunu önler. | `ARCH-102.1` |
| **DLQ** | Dead Letter Queue | Defalarca denenip başarısız olan işlerin incelenmek üzere düştüğü kuyruk. | `ARCH-102.3` |
| **Circuit breaker** | Circuit breaker | Sürekli hata veren dış servise istek göndermeyi geçici olarak durduran koruma. Entegratör çökünce sistemin kilitlenmesini önler. | `COMP-602.2` |
| **Hypertable** | Hypertable | TimescaleDB'nin zaman serisi verisi için otomatik parçalara (chunk) böldüğü tablo. Milyonlarca telemetri satırını hızlı tutar. | `ARCH-103.1` |
| **Continuous aggregate** | — | TimescaleDB'nin önceden hesaplayıp sakladığı özet (rollup) görünümü. Raporlar ham veri yerine bunu okur. | `ARCH-103.3` |
| **Feature flag** | Feature flag | Bir modülün firma bazında açılıp kapatılmasını sağlayan anahtar. | `ARCH-106` |
| **Graceful shutdown** | Graceful shutdown | Uygulama kapanırken devam eden işlemlerin tamamlanmasına izin verilmesi. | `RES-906` |
| **Graceful degradation** | Graceful degradation | Bir bileşen çöktüğünde tüm sistemin değil, yalnızca o özelliğin devre dışı kalması. | `RES-905` |

## 📄 Mevzuat ve Muhasebe Terimleri

| Terim | İngilizce | Tanım | Projede nerede |
|---|---|---|---|
| **GİB** | Turkish Revenue Administration | Gelir İdaresi Başkanlığı. e-Belge standartlarını belirleyen kurum. | `COMP-601` |
| **e-İrsaliye** | e-Despatch advice | Sevk irsaliyesinin elektronik hâli. Yakıt sevkiyatında düzenlenmesi gerekir. | `COMP-601` |
| **UBL-TR 1.2** | Universal Business Language | e-Belgelerin XML formatını tanımlayan uluslararası standardın Türkiye uyarlaması. | `COMP-601.1` |
| **DespatchAdvice** | — | UBL'de sevk irsaliyesi belgesinin adı. | `COMP-601.1` |
| **Özel entegratör** | Integrator | GİB ile şirket arasında belge iletimini sağlayan yetkili aracı kurum. | `COMP-602` |
| **Mükellef** | Taxpayer | Vergi yükümlüsü. e-İrsaliye yalnızca e-İrsaliye mükellefi olan alıcıya elektronik kesilebilir. | `COMP-605` |
| **VKN / TCKN** | Tax ID / National ID | Vergi Kimlik Numarası / T.C. Kimlik Numarası. | `COMP-605` |
| **GTIP** | Customs tariff code | Ürünün gümrük tarife kodu. Motorin ve benzin için farklıdır. | `COMP-601.1` |
| **KVKK** | Turkish GDPR | Kişisel Verilerin Korunması Kanunu. Şoför TC no, telefon gibi veriler bu kapsamdadır. | `COMP-606` |
| **FIFO / Ağırlıklı ortalama** | FIFO / Weighted average | Stok maliyetlendirme yöntemleri. Bu projede varsayılan ağırlıklı ortalamadır. | `INV-1503` |

## 🏗️ Süreç ve Proje Terimleri

| Terim | Tanım |
|---|---|
| **Epic** | Tek başına yapılamayacak kadar büyük olan, alt issue'lara bölünmüş takip issue'su. Etiketi `epic`. |
| **Modül kodu** | Her iş paketinin benzersiz kimliği (`FUEL-404.2` gibi). Issue başlığında ve dokümanlarda aynı kod kullanılır. |
| **Faz** | 12 haftalık planın dört bölümünden biri; GitHub'da milestone olarak tanımlıdır. FAZ 5 canlı sonrası backlog'dur. |
| **Kritik yol** | Projenin süresini belirleyen, birbirine bağımlı en uzun issue zinciri. |
| **P0-Blocker … P3-Low** | Öncelik skalası. P0 olmadan sistem çalışmaz veya güvenlik açığı doğar. |
| **XS / S / M / L / XL** | Efor skalası: 1-2 gün / 3-5 gün / 1-2 hafta / 2-3 hafta / 1+ ay. |
| **Devreye alma** | Yeni bir şantiyenin montaj, kalibrasyon ve kabul testleriyle canlıya alınması. |

---

## 👥 Roller

| Rol | Kim | Ne yapabilir |
|---|---|---|
| `SUPER_ADMIN` | Geliştirici / platform yöneticisi | Tüm firmalar, cihaz sağlığı, sistem logları, modül aç/kapa |
| `COMPANY_OWNER` | Müşteri firma yöneticisi | Kendi firmasının tüm şantiyeleri, araçları, yetkileri, raporları |
| `SITE_MANAGER` | Şantiye şefi | Yalnızca kendi şantiyesinin verisi, acil durdurma, km girişi |
| `PUMP_OPERATOR` | Pompa görevlisi | İkmal işlemleri, canlı ekran, manuel giriş talebi |
| `DRIVER` | Şoför / operatör | Yalnızca kendi ikmal geçmişi |
