# Pompa ve Şantiye Operatör El Kitabı

**Kimler için:** pompa operatörü, şoför ve şantiye şefi. Teknik bilgi gerekmez.
**Telefondan okuyun:** kısa bölümler, madde madde yazıldı. Pompaya asılacak tek sayfalık kart: [OZET_KART.html](operator/OZET_KART.html) ([PDF](operator/pdf/OZET_KART.pdf)).

> Bu kitaptaki **ekran yazıları cihazdaki yazılarla birebir aynıdır** (tek kaynaktan üretilir: `docs/operator/device-messages.json`). Cihaz ekranında burada olmayan bir yazı görürseniz şantiye şefine haber verin.

**İçindekiler:** [1. Günlük kullanım](#1-günlük-kullanım) · [2. Ekran mesajları ve ne yapmalı](#2-ekran-mesajları-ve-ne-yapmalı) · [3. Sorun olursa](#3-sorun-olursa) · [4. Panel kullanımı](#4-panel-kullanımı) · [5. Acil durum](#5-acil-durum) · [6. Sık sorulanlar](#6-sık-sorulanlar)

---

## 1. Günlük kullanım

### Şoför / pompa operatörü: ikmal nasıl yapılır?

1. **Kartınızı okutun.** Kartı okuyucuya düz ve yavaşça yaklaştırın. Ekranda *Kart okundu* yazar.
2. **Bekleyin.** *Yetki kontrol ediliyor* yazar (birkaç saniye). Kartı çekmeyin.
3. **Ekranı kontrol edin.** *Yetki verildi* yazarsa **plakanın sizin aracınız olduğunu** ve *en çok kaç litre* alabileceğinizi okuyun.
4. **İkmal yapın.** Tabancayı aracın deposuna takın, pompayı açın. Ekranda litre ve debi (litre/dakika) canlı görünür. Tabancayı bırakmayın.
5. **Bitirin.** Tabancayı kapatıp yerine asın. Ekranda *İkmal bitti* ve aldığınız litre görünür. Litreyi depoyla karşılaştırın.

**Önemli kurallar**
- Başkasının kartıyla ikmal yapmayın. Her ikmal kartınızın adına yazılır.
- Ekranda **kırmızı/hata** yazısı varsa ikmal yapmayın; §2'de o yazının karşılığına bakın.
- Pompa kendiliğinden durursa (*En çok litreye ulaşıldı*) zorlamayın; normaldir.
- Yakıt türü aracınıza uygun değilse (*Yakıt türü uyumsuz*) **kesinlikle ikmal yapmayın**.

### Şantiye şefi: günlük işler

- Sabah: pompa ekranında *HAZIR / Kartınızı okutun* yazdığını görün (cihaz açık ve internete bağlı demektir).
- Gün içinde: panelde **Yakıt Hareketleri**'ne bakın (§4). Beklenmedik ikmal varsa sorun.
- Tank seviyesi **Tank Durumu** ekranında görünür; kırmızıya (kritik) düşmeden dolum isteyin.
- Bildirimleri (**Bildirimler**) her gün kontrol edin.
- Sürücü izne çıktı/ayrıldı ya da kart kayboldu ise **hemen yöneticiye bildirin** (kart kapatılır).

---

## 2. Ekran mesajları ve ne yapmalı

<!-- MESAJLAR:BAŞLA (scripts/generate-operator-manual.mjs üretir — ELLE DEĞİŞTİRMEYİN) -->
Ekran 16 harf × 4 satırdır. Aşağıda **ekranda gördüğünüz yazı** kalın yazılmıştır; satırlar `/` ile ayrılır. `{plaka}`, `{litre}`, `{debi}` yerine gerçek değer gelir.

**Ses (buzzer):** **KABUL** = 1 uzun bip · **RET** = 3 kısa bip · **UYARI** = 2 orta bip · **HATA** = 1 uzun alçak bip + 2 kısa · **KISA** = 1 çok kısa bip

#### Bekleme

- **HAZIR / Kartınızı okutun** — ses: yok
  - Anlamı: Pompa hazır, kart bekliyor.
  - **Ne yapmalı:** Kartınızı okuyucuya yaklaştırın.
  - <sub>Kod: `BEKLEME`</sub>

#### Kart okundu

- **Kart okundu / Bekleyin...** — ses: KISA (1 çok kısa bip)
  - Anlamı: Kart okundu, sunucuya soruluyor.
  - **Ne yapmalı:** Bekleyin; birkaç saniye sürer. Kartı çekmeyin.
  - <sub>Kod: `KART_OKUNDU`</sub>

#### Yetki bekleniyor

- **Yetki kontrol / ediliyor...** — ses: yok
  - Anlamı: Sistem araç, sürücü ve kotayı kontrol ediyor.
  - **Ne yapmalı:** Bekleyin. 10 saniyeden uzun sürerse 'Sunucu meşgul' bölümüne bakın.
  - <sub>Kod: `YETKI_BEKLENIYOR`</sub>

#### Yetki verildi

- **Yetki verildi / {plaka} / En çok {litre} L / Pompayı açın** — ses: KABUL (1 uzun bip)
  - Anlamı: İkmal onaylandı. Araç ve en çok alabileceği miktar ekranda.
  - **Ne yapmalı:** Tabancayı aracın deposuna takın, pompayı açın. Ekrandaki plakanın sizin aracınız olduğunu kontrol edin.
  - <sub>Kod: `OK`</sub>

#### İkmal sürüyor

- **İkmal sürüyor / {litre} L / {debi} L/dk** — ses: yok
  - Anlamı: Yakıt akıyor; litre ve debi canlı güncellenir.
  - **Ne yapmalı:** Tabancayı bırakmayın. Bitince tabancayı kapatın.
  - <sub>Kod: `AKIS`</sub>

#### İkmal bitti

- **İkmal bitti / {litre} L / İyi çalışmalar** — ses: KABUL (1 uzun bip)
  - Anlamı: İkmal kaydedildi.
  - **Ne yapmalı:** Tabancayı yerine asın. Ekrandaki litre ile aracınızın deposunu kontrol edin.
  - <sub>Kod: `TAMAMLANDI`</sub>

#### Hata / ret

- **Kart tanımsız / Yöneticiye / başvurun** — ses: RET (3 kısa bip)
  - Anlamı: Bu kart sisteme kayıtlı değil.
  - **Ne yapmalı:** Başka bir pompaya gitmeyin. Kartı şantiye şefine gösterin; kart kaydı yönetici tarafından yapılır.
  - <sub>Kod: `CARD_UNKNOWN`</sub>
- **Kart bloke / Kayıp/çalıntı / Şefe bildirin** — ses: RET (3 kısa bip)
  - Anlamı: Kart kara listede (kayıp, çalıntı veya değiştirilmiş).
  - **Ne yapmalı:** Kartı kullanmaya çalışmayın. Şantiye şefine haber verin; yeni kart yönetici tarafından verilir.
  - <sub>Kod: `RFID_CARD_BLOCKED`</sub>
- **Sürücü aktif / değil (izinli / veya pasif)** — ses: RET (3 kısa bip)
  - Anlamı: Sürücü kaydı aktif değil (izinli veya pasif).
  - **Ne yapmalı:** Şantiye şefine haber verin; sürücü durumu yönetici tarafından güncellenir.
  - <sub>Kod: `DRIVER_INACTIVE`</sub>
- **Araç atanmamış / Şefe bildirin** — ses: RET (3 kısa bip)
  - Anlamı: Kartın sahibine bir araç atanmamış.
  - **Ne yapmalı:** Şantiye şefine haber verin; araç ataması yönetici tarafından yapılır.
  - <sub>Kod: `NO_VEHICLE_ASSIGNED`</sub>
- **Araç kullanıma / kapalı / Şefe bildirin** — ses: RET (3 kısa bip)
  - Anlamı: Araç kaydı aktif değil (bakımda veya kapalı).
  - **Ne yapmalı:** Şantiye şefine haber verin. Başka bir araca ikmal yapmayın.
  - <sub>Kod: `VEHICLE_BLOCKED`</sub>
- **Araç limiti / doldu / Şefe bildirin** — ses: RET (3 kısa bip)
  - Anlamı: Aracın dönemlik yakıt limiti bitti.
  - **Ne yapmalı:** Şantiye şefine haber verin; gerekirse yönetici geçici artış verir. Zorlamayın.
  - <sub>Kod: `VEHICLE_FUEL_LIMIT_EXCEEDED`</sub>
- **Kota doldu / Çapraz şantiye / kotası bitti** — ses: RET (3 kısa bip)
  - Anlamı: Aracın başka şantiyeden alım kotası bitti.
  - **Ne yapmalı:** Kendi şantiyenizin pompasını kullanın veya şantiye şefine haber verin.
  - <sub>Kod: `QUOTA_EXHAUSTED`</sub>
- **Bu şantiyede / alım izni yok** — ses: RET (3 kısa bip)
  - Anlamı: Araç bu şantiyeden yakıt alma iznine sahip değil.
  - **Ne yapmalı:** Kendi şantiyenizin pompasını kullanın; izin için şantiye şefine haber verin.
  - <sub>Kod: `NO_SITE_PERMISSION`</sub>
- **Yanlış tank / Pompa başka / tanka bağlı** — ses: HATA (1 uzun alçak bip + 2 kısa)
  - Anlamı: Pompa, istenen tanka bağlı değil (kayıt hatası).
  - **Ne yapmalı:** İkmal yapmayın. Şantiye şefine ve teknik servise haber verin.
  - <sub>Kod: `DEVICE_TANK_MISMATCH`</sub>
- **Yakıt türü / uyumsuz / İkmal yapmayın** — ses: RET (3 kısa bip)
  - Anlamı: Aracın yakıt türü bu tanktakiyle uyuşmuyor.
  - **Ne yapmalı:** İKMAL YAPMAYIN (yanlış yakıt araca zarar verir). Şantiye şefine haber verin.
  - <sub>Kod: `FUEL_TYPE_MISMATCH`</sub>
- **Tankta yakıt / yok / Şefe bildirin** — ses: RET (3 kısa bip)
  - Anlamı: Tankta yakıt kalmamış.
  - **Ne yapmalı:** Şantiye şefine haber verin; tank dolumu bekleyin.
  - <sub>Kod: `TANK_LOW`</sub>
- **Tank tanımsız / Teknik servis** — ses: HATA (1 uzun alçak bip + 2 kısa)
  - Anlamı: Pompaya bağlı tank sistemde bulunamadı (kurulum hatası).
  - **Ne yapmalı:** İkmal yapmayın. Teknik servise haber verin.
  - <sub>Kod: `TANK_NOT_FOUND`</sub>
- **Açık ikmal var / Önce bitirin** — ses: RET (3 kısa bip)
  - Anlamı: Bu araç için zaten açık bir ikmal var.
  - **Ne yapmalı:** Önceki ikmali bitirin; 15 saniye sonra tekrar deneyin. Sürerse şantiye şefine haber verin.
  - <sub>Kod: `SESSION_ALREADY_ACTIVE`</sub>
- **Oturum kapandı / Kartı tekrar / okutun** — ses: UYARI (2 orta bip)
  - Anlamı: İkmal oturumu süresi dolduğu için kapandı.
  - **Ne yapmalı:** Kartı yeniden okutup ikmali baştan başlatın.
  - <sub>Kod: `SESSION_NOT_FOUND`</sub>
- **İşlem sırası / hatalı / Kartı yeniden / okutun** — ses: UYARI (2 orta bip)
  - Anlamı: Cihaz ile sistem arasında işlem sırası tutmadı.
  - **Ne yapmalı:** Kartı yeniden okutun; sürerse teknik servise haber verin.
  - <sub>Kod: `INVALID_STATE_TRANSITION`</sub>
- **Cihaz hatası / Teknik servis** — ses: HATA (1 uzun alçak bip + 2 kısa)
  - Anlamı: Cihaz kimliği eksik (kurulum/yazılım hatası).
  - **Ne yapmalı:** İkmal yapmayın. Teknik servise haber verin.
  - <sub>Kod: `DEVICE_ID_REQUIRED`</sub>
- **En çok litreye / ulaşıldı / Pompa durdu** — ses: UYARI (2 orta bip)
  - Anlamı: İzin verilen en çok litre alındı; pompa otomatik durdu.
  - **Ne yapmalı:** Normaldir. Tabancayı kapatın. Daha fazlası gerekiyorsa şantiye şefine haber verin.
  - <sub>Kod: `MAX_LITERS_EXCEEDED`</sub>
- **En çok süre / doldu / Pompa durdu** — ses: UYARI (2 orta bip)
  - Anlamı: İkmal olağan süreden uzun sürdü; pompa otomatik durdu.
  - **Ne yapmalı:** Tabancayı kapatın. Depo ya da hortumda sorun olabilir; tekrar denemeden önce kontrol edin.
  - <sub>Kod: `MAX_DURATION_EXCEEDED`</sub>
- **Cihaz yetkisiz / Teknik servis** — ses: HATA (1 uzun alçak bip + 2 kısa)
  - Anlamı: Cihazın sunucuyla kimlik doğrulaması başarısız (saat/kimlik hatası).
  - **Ne yapmalı:** İkmal yapmayın. Teknik servise haber verin.
  - <sub>Kod: `UNAUTHORIZED_DEVICE`</sub>
- **Çok fazla istek / 30 sn bekleyin** — ses: UYARI (2 orta bip)
  - Anlamı: Cihaz kısa sürede çok fazla istek gönderdi.
  - **Ne yapmalı:** 30 saniye bekleyip kartı tekrar okutun.
  - <sub>Kod: `TOO_MANY_REQUESTS`</sub>
- **Sunucu meşgul / Tekrar deneyin** — ses: UYARI (2 orta bip)
  - Anlamı: Sunucu geçici olarak yanıt veremiyor.
  - **Ne yapmalı:** Bir dakika bekleyip kartı tekrar okutun. Sürerse çevrimdışı moda bakın.
  - <sub>Kod: `SERVER_BUSY`, `NONCE_STORE_UNAVAILABLE`, `DB_UNAVAILABLE`, `DB_BUSY`, `SERVICE_UNAVAILABLE`</sub>
- **Kart okunamadı / Tekrar okutun** — ses: UYARI (2 orta bip)
  - Anlamı: Kart okunamadı.
  - **Ne yapmalı:** Kartı düz ve yavaşça okuyucuya yaklaştırın; 3 denemede olmazsa 'Kart okunmuyor' bölümüne bakın.
  - <sub>Kod: `CARD_READ_ERROR`</sub>
- **Akış yok / Pompa durdu / Hortumu kontrol** — ses: HATA (1 uzun alçak bip + 2 kısa)
  - Anlamı: Pompa açık ama yakıt akmıyor (tank boş, hortum tıkalı veya sensör arızası).
  - **Ne yapmalı:** Tabancayı kapatın. Hortum/vana ve tank durumunu kontrol edin; çözülmezse şantiye şefine ve teknik servise haber verin.
  - <sub>Kod: `FLOW_FAULT`</sub>
- **ACİL DURDURMA / Pompa kapalı** — ses: HATA (1 uzun alçak bip + 2 kısa)
  - Anlamı: Acil durdurma düğmesine basıldı; pompa enerjisi kesildi.
  - **Ne yapmalı:** Güvenli hâle gelene kadar düğmeyi bırakmayın. Neden ortadan kalkınca şantiye şefi düğmeyi serbest bırakır.
  - <sub>Kod: `EMERGENCY_STOP`</sub>
- **Cihaz arızası / Kullanmayın / Teknik servis** — ses: HATA (1 uzun alçak bip + 2 kısa)
  - Anlamı: Cihaz kendi kendini denetlerken arıza buldu.
  - **Ne yapmalı:** Pompayı kullanmayın; şantiye şefine ve teknik servise haber verin.
  - <sub>Kod: `DEVICE_FAULT`</sub>
- **Cihaz bloke / Teknik servis** — ses: HATA (1 uzun alçak bip + 2 kısa)
  - Anlamı: Bu cihaz yönetici tarafından bloke edilmiş.
  - **Ne yapmalı:** İkmal yapmayın. Şantiye şefine ve teknik servise haber verin; cihaz yönetici tarafından açılır.
  - <sub>Kod: `DEVICE_BLOCKED`</sub>
- **Cihaz saati / hatalı / Teknik servis** — ses: HATA (1 uzun alçak bip + 2 kısa)
  - Anlamı: Cihazın saati sunucudan çok farklı; sunucu istekleri reddediyor.
  - **Ne yapmalı:** İkmal yapmayın (çevrimdışı moda geçebilir). Teknik servise haber verin; cihaz saati düzeltilir.
  - <sub>Kod: `CLOCK_DRIFT`</sub>
- **Güvenlik hatası / Tekrar deneyin / Sürerse servis** — ses: UYARI (2 orta bip)
  - Anlamı: Cihaz ile sunucu arasındaki güvenlik doğrulaması başarısız oldu.
  - **Ne yapmalı:** Kartı bir kez daha okutun. Tekrarlarsa teknik servise haber verin.
  - <sub>Kod: `INVALID_TIMESTAMP_FORMAT`, `INVALID_SIGNATURE_FORMAT`, `INVALID_HARDWARE_SIGNATURE`, `NONCE_REUSED`, `REPLAY_ATTACK_DETECTED`, `MISSING_HARDWARE_HEADERS`</sub>

#### Çevrimdışı

- **ÇEVRİMDIŞI MOD / Sınırlı yetki / Limit: {litre} L** — ses: UYARI (2 orta bip)
  - Anlamı: İnternet yok. Cihaz kayıtlı kartlara sınırlı miktarda ikmal verir.
  - **Ne yapmalı:** İkmal yapabilirsiniz ama limiti aşmayın. Bağlantı gelince kayıtlar otomatik gönderilir; cihazı kapatmayın.
  - <sub>Kod: `OFFLINE`</sub>
- **Çevrimdışı limit / doldu / Pompa durdu** — ses: RET (3 kısa bip)
  - Anlamı: Çevrimdışıyken verilen limit doldu.
  - **Ne yapmalı:** Bağlantı gelene kadar ikmal yapılamaz. Şantiye şefine haber verin.
  - <sub>Kod: `OFFLINE_LIMIT`</sub>
- **Çevrimdışı: kart / önbellekte yok** — ses: RET (3 kısa bip)
  - Anlamı: İnternet yokken bu kart doğrulanamıyor.
  - **Ne yapmalı:** Bağlantı gelene kadar bekleyin; şantiye şefine haber verin.
  - <sub>Kod: `OFFLINE_CARD_UNKNOWN`</sub>
- **Bağlantı koptu / Kayıt cihazda / saklanıyor** — ses: UYARI (2 orta bip)
  - Anlamı: İkmal sırasında bağlantı koptu; ikmal cihazda saklanıyor.
  - **Ne yapmalı:** İkmali normal bitirin. Kayıt bağlantı gelince sunucuya gider; cihazı kapatmayın.
  - <sub>Kod: `CONNECTION_LOST`</sub>
- **Veri gönderilir / Kapatmayın** — ses: yok
  - Anlamı: Çevrimdışıyken yapılan ikmaller sunucuya gönderiliyor.
  - **Ne yapmalı:** Cihazı kapatmayın; birkaç dakika sürebilir.
  - <sub>Kod: `SYNCING`</sub>
<!-- MESAJLAR:BİTİŞ -->

---

## 3. Sorun olursa

### 3.1 Kart okunmuyor
1. Kartı **düz** tutun, okuyucuya yaklaştırıp **1 saniye** bekleyin; çok hızlı çekmeyin.
2. Kart ve okuyucu **kuru ve temiz** olmalı; kartın yanında metal/anahtar olmasın.
3. **3 kez** denediniz ve olmadıysa (*Kart okunamadı* tekrarlıyor): başka bir kartla deneyin. O çalışıyorsa kartınız bozuktur; şantiye şefine söyleyin (yeni kart verilir).
4. Hiçbir kart çalışmıyorsa okuyucu/cihaz arızalıdır → **teknik servisi** arayın, ikmal yapmayın.

### 3.2 Yetki reddedildi (hata ekranı)
1. Ekrandaki yazıyı **aynen** okuyun (§2 → *Hata / ret*). Sebep yazılıdır.
2. Yazının yanındaki **Ne yapmalı** kısmını uygulayın.
3. Sebep çoğunlukla sizin çözemeyeceğiniz bir kayıt konusudur (kart, araç, limit, kota) → **şantiye şefine söyleyin**; şef yöneticiye iletir.
4. **Ret'i atlatmaya çalışmayın** (başka kart, başka pompa, elle ikmal). Bunlar kayda geçer ve alarm üretebilir.

### 3.3 İnternet yok / çevrimdışı mod
- Ekranda *ÇEVRİMDIŞI MOD* yazar. Cihaz internet olmadan da **sınırlı miktarda** ikmal verir.
- **İkmal yapabilirsiniz**, ama ekrandaki limiti aşmayın. Limit dolarsa *Çevrimdışı limit doldu* yazar; bağlantı gelene kadar ikmal yapılamaz.
- İkmaller cihazda **saklanır**; internet gelince kendiliğinden gönderilir (*Veri gönderilir, Kapatmayın*).
- **Cihazı kapatmayın / fişini çekmeyin** — saklanan kayıtlar kaybolabilir.
- 30 dakikadan uzun sürerse şantiye şefine haber verin (modem/sinyal kontrolü gerekir).

### 3.4 Akış kesildi / pompa durdu
- *En çok litreye ulaşıldı* veya *En çok süre doldu*: normal otomatik durma. Tabancayı kapatın.
- *Akış yok — Hortumu kontrol*: pompa açık ama yakıt akmıyor. Tabancayı kapatın; hortum, vana ve tank seviyesine bakın. Çözülmezse şantiye şefi ve teknik servis.
- *Bağlantı koptu — Kayıt cihazda saklanıyor*: ikmali normal bitirin; kayıt sonra gönderilir.
- Pompa hiç ihtar vermeden durursa **zorlamayın**; kartı yeniden okutup ikmali baştan başlatın.

---

## 4. Panel kullanımı

Panele telefon veya bilgisayardan tarayıcıyla girilir. Şantiye şefi/pompa operatörü **Şantiye Girişi** ile, yönetici **Yönetici Girişi** ile girer. İlk girişte **parolanızı değiştirmeniz** istenir; parolayı kimseyle paylaşmayın.

### 4.1 Şantiye paneli (şantiye şefi ve pompa operatörü)
- **Saha Pompa İkmali:** panelden elle ikmal kaydı açılabilir: **Plaka** (araç), **İkmal Eden Şoför**, **Miktar (Litre)** seçilir ve **Pompayı Başlat & İkmal Et**'e basılır. Akış sürerken *Pompa Akışı Aktif...* ve **Debi (L/dk)** görünür. (Yalnızca ikmal yetkisi olan kullanıcılar; yoksa *İkmal başlatma yetkiniz yok* yazar.)
- **İkmal Kaydı listesi:** son ikmaller *Tarih/Saat, Plaka, Şoför, Miktar, Durum* olarak listelenir. **Hareket sorgulama** için bu listeye ve yönetici panelindeki *Yakıt Hareketleri*'ne bakın.

### 4.2 Yönetici paneli (şantiye şefi yetkisi varsa)
- **Yakıt Hareketleri:** ikmalleri **plaka** (arama kutusu), **şoför**, **şantiye** ve tarihe göre süzün; toplam litre üstte görünür; **Excel Olarak İndir** ile liste indirilir, **Filtreleri Temizle** ile baştan başlarsınız. *Anomali / Şüpheli* işaretli kayıtlara özellikle bakın. Yanlış bir kayıt görürseniz **kaydı değiştirmeyin**, yöneticiye bildirin.
- **Tank Durumu:** tank seviyesi (litre ve yüzde; kritik/uyarı/güvenli). İkmal bitince kendiliğinden güncellenir.
- **Bildirimler:** sistemin uyarıları burada listelenir (limit, kota, düşük stok, şüpheli ikmal gibi). Uyarılar ayrıca e-posta/SMS/Telegram ile de gelebilir (hangisinin geleceğini yönetici ayarlar). Her gün bakın.

### 4.3 Şu an panelde olmayan ekranlar (yakında)
| İhtiyaç | Şu an ne yapmalı |
|---|---|
| **Km / motor saati girişi** (araç sayaç okuması) | Ayrı bir giriş ekranı henüz yok (FE-813). Sayaç okumalarını **yöneticiye yazılı bildirin**; yönetici sisteme girer. |
| **Canlı ikmal ekranı ve acil durdurma düğmesi** (panel) | Henüz yok (FE-811). Canlı bilgiyi **pompa ekranından** izleyin; acil durdurma için **fiziksel düğme** kullanılır (§5). |
| **Alarm merkezi** | Henüz yok (FE-815). Alarmlar **Bildirimler**'de (ve ayarlıysa e-posta/SMS/Telegram'da) görünür. |

*Bu tablo, ekranlar yayına girdikçe güncellenir.*

---

## 5. Acil durum

### 5.1 Acil durdurma (yangın, sızıntı, taşma, tehlike)
1. **Hemen** pompanın **kırmızı acil durdurma düğmesine** basın (pompa enerjisi kesilir; ekranda *ACİL DURDURMA — Pompa kapalı* yazar).
2. Tabancayı bırakın, **araçtan ve pompadan uzaklaşın**. Sigara/kıvılcım yok.
3. **Yangın varsa:** yangın söndürücüyü yalnızca güvenle kullanabiliyorsanız kullanın; değilse uzaklaşın ve **112 / şantiye acil hattı**nı arayın.
4. Yakıt döküldüyse: alanı kapatın, kimseyi yaklaştırmayın; şantiye güvenlik sorumlusuna haber verin.
5. Düğmeyi **yalnızca şantiye şefi** ve tehlike geçtikten sonra serbest bırakır.

### 5.2 Hırsızlık / şüpheli ikmal alarmı
Yakıt kaybı şüphesi (tank beklenenden hızlı azalıyor, mesai dışı ikmal, aynı araca art arda ikmal, bilinmeyen kart denemeleri) sistemde **alarm** olarak kaydedilir ve yöneticiye bildirim gider; **Bildirimler**'de (ve ayarlıysa e-posta/SMS/Telegram'da) görünür.
1. Sakin olun; **kimseyi suçlamayın**, kimseyle yüzleşmeyin.
2. Alarm yazısını ve saatini not edin. Pompa çevresinde olağandışı bir durum (açık vana, kırık kilit, kaçak) var mı bakın.
3. **Şantiye şefine ve yöneticiye hemen bildirin.** Şüphe ciddiyse pompa alanına girişi sınırlayın.
4. **Kayıtları silmeye/değiştirmeye çalışmayın**, kartları toplamayın — inceleme sistemdeki kayıtlarla yapılır.
5. Kart kaybı/çalıntı şüphesinde kartın **hemen kapatılması** için yöneticiyi arayın.

### 5.3 Cihaz arızası
- Ekranda *Cihaz arızası — Kullanmayın*, ekran boş/donmuş, ya da tuhaf davranış: **pompayı kullanmayın**.
- Şantiye şefine ve **teknik servise** haber verin (telefon aşağıda).
- Acil ikmal gerekiyorsa **yönetici onayıyla** ve yazılı bir ikmal defterine (tarih, plaka, şoför, litre) yazarak elle ikmal yapılır; bu kayıt yönetici tarafından sisteme işlenir. **Onaysız ikmal yapılmaz.**
- Arızalı cihaza kendiniz **müdahale etmeyin** (kablo, sigorta, kabin).

### 5.4 Telefonlar (şantiyede doldurun ve pompaya asın)
- Şantiye şefi: ______________________
- Yönetici / sistem sorumlusu: ______________________
- Teknik servis: ______________________
- Acil durum: **112** · Şantiye güvenlik: ______________________

---

## 6. Sık sorulanlar

- **Kartımı arkadaşıma verebilir miyim?** Hayır. Kart sizin adınıza kayıtlıdır; her ikmal sizden sorulur.
- **Litre depoyla uyuşmuyor?** Küçük farklar olabilir; büyük fark varsa şantiye şefine söyleyin (cihaz kalibrasyonu gerekebilir).
- **Kartımı kaybettim?** Hemen şantiye şefine söyleyin; kart kapatılır ve yenisi verilir.
- **İnternet yokken ikmal kaydım kaybolur mu?** Hayır, cihaz saklar ve sonra gönderir — cihazı kapatmamak şartıyla.
- **Ekranda Türkçe karakter bozuk görünüyor?** Teknik servise haber verin (cihaz yazılımı/fontu).
- **Yeni sürücü/araç eklemek?** Yönetici yapar; şantiye şefi talebi iletir.

---

*Bu el kitabı sürümü: DOC-1207. Cihaz mesajları: `docs/operator/device-messages.json`. Kurulum/kalibrasyon: [SAHA_KURULUM.md](SAHA_KURULUM.md). Kullanılabilirlik testi: [operator/KULLANILABILIRLIK_TESTI.md](operator/KULLANILABILIRLIK_TESTI.md).*
