# 🎤 Sunum ve Anlatım Rehberi

> **Kime:** Firma sahibi, şantiye şefi, yatırımcı, satın alma müdürü — **teknik olmayan** dinleyici.
> **Süre:** 15 dakika sunum + 10 dakika soru.
> **Altın kural:** Teknik terim kullanma. "Row-Level Security" değil, *"her firmanın verisi birbirinden ayrı kasada durur"* de.
> **İkinci kural:** Rakam veriyorsan kaynağını bil. Ölçülmemiş oran vaat etme; "hedefimiz" ile "garantimiz" farklıdır.

---

## 🎯 Sunumun tek cümlelik hedefi

Dinleyici salondan şu cümleyle çıkmalı: **"Şantiyemde ne kadar yakıt aktığını artık tahmin etmeyeceğim, göreceğim."**

---

# SLAYT AKIŞI (13 slayt)

---

## Slayt 1 — Kapak

**Başlık:** Şantiyede Yakıt: Tahmin Etmeyi Bırakın, Görün
**Alt başlık:** Araç bazlı otomatik yakıt takibi, kaçak tespiti ve e-İrsaliye — tek platformda

> **Konuşma metni:**
> "Bugün size şantiyelerde en çok kaybedilen ama en az takip edilen kalemden bahsedeceğim: yakıt. On beş dakikada şunu göstereceğim — sahadaki her litrenin hangi araca, ne zaman, kim tarafından verildiğini nasıl otomatik kayıt altına alıyoruz ve bunun size ne kazandırdığını."

---

## Slayt 2 — Problem: Kağıt defterle yakıt yönetilmez

**Maddeler:**
- Yakıt defteri elle tutuluyor; kim ne kadar aldı, akşam yazılıyor
- Tankta ne kadar kaldığı ancak çubuk daldırılarak öğreniliyor
- Aracın deposuna giden yakıt ile bidona giden yakıt aynı deftere yazılıyor
- İş makinesi yakıtsız kalıyor, şantiye duruyor
- Ay sonunda "eksik var" deniyor ama nerede eksildiği bilinmiyor

> **Konuşma metni:**
> "Bugün sahalarda gördüğümüz tablo şu: bir defter, bir kalem ve akşam yazılan rakamlar. Bu defterde yazan sayıyla tankta gerçekten olan yakıt asla birbirini tutmaz. Tutmadığında da kimse nerede kaybolduğunu bilemez, çünkü ölçüm yok — sadece beyan var. Ve şunu net söyleyeyim: kimsenin kötü niyetli olduğunu iddia etmiyorum. Ölçülmeyen bir şey, sadece kaybolmaya açık hale gelir."

---

## Slayt 3 — Bu ne kadara mal oluyor?

**Maddeler:**
- Bir şantiyenin aylık yakıt gideri, toplam işletme maliyetinin en büyük kalemlerinden biridir
- Ölçülmeyen sistemlerde kayıp oranı sektörde genellikle **%3-8** aralığında konuşulur
- Buna ek görünmeyen maliyetler: yakıtsız kalan iş makinesinin durma maliyeti, elle irsaliye kesme iş yükü, ay sonu mutabakat için harcanan gün

> **Konuşma metni:**
> "Kendi rakamınızla düşünelim: aylık yakıt gideriniz ne kadar? Bunun yüzde üçü bile yılda ciddi bir tutar eder. Üstelik asıl maliyet bu değil — bir ekskavatörün yakıt bittiği için üç saat durması, o günün planını komple bozar. Biz iki tarafı da hedefliyoruz: kaybı görünür kılmak ve durmayı önlemek."
>
> *(Not: Buradaki %3-8 aralığı sektörel bir konuşma aralığıdır, müşteriye özel ölçüm değildir. Pilot kurulum sonrası gerçek rakamı biz ölçüp sunacağız — bunu söylemek güven kazandırır.)*

---

## Slayt 4 — Çözüm: Pompayı akıllı hale getiriyoruz

**Maddeler:**
- Her araca bir **kart** (RFID etiketi)
- Pompaya bir **kontrol ünitesi**: kart okuyucu + sayaç + otomatik vana
- Tanka bir **seviye sensörü**
- Hepsi bulut sistemine bağlı; her işlem anında kaydediliyor

**Görsel:** Basit şema — Araç → Kart → Pompa → Bulut → Panel

> **Konuşma metni:**
> "Yaptığımız iş aslında çok basit bir fikir: pompanın kendisine karar verdiriyoruz. Yetkisiz bir araç geldiğinde pompa açılmıyor. Yetkili araç geldiğinde açılıyor ve akan her litre otomatik sayılıyor. Kimse bir şey yazmıyor, kimse bir şey hatırlamak zorunda değil."

---

## Slayt 5 — Nasıl çalışır? (6 adım)

**Maddeler:**
1. Şoför tabancayı araca takar, kart okunur
2. Sistem yarım saniyeden kısa sürede kontrol eder: bu araç yetkili mi, kotası var mı, tankta yakıt var mı
3. Onay verilirse pompa açılır
4. Akan yakıt saniye saniye sayılır ve ekranda görünür
5. Tabanca kapanınca kayıt kesinleşir: hangi araç, hangi şantiye, kaç litre, kim
6. Stok düşer, e-İrsaliye hazırlanır, rapora yansır

> **Konuşma metni:**
> "Şoför açısından hiçbir şey değişmiyor — kart zaten araçta takılı, tabancayı takıyor, yakıtını alıyor. Değişen şey şu: bu işlemin arkasında artık bir kayıt var. Ve o kayıt sonradan değiştirilemiyor."

---

## Slayt 6 — Kaçak ve kayıp nasıl yakalanıyor?

**Maddeler:**
- **Pompa kapalıyken tank seviyesi düşerse** → anında alarm (elle çekim / sızıntı)
- **Sayaç 100 litre derken tanktan 130 litre eksilirse** → sayaç müdahalesi uyarısı
- **Gece 03:00'te alım yapılırsa** → mesai dışı işaretlemesi
- **Bir araç kendi geçmişine göre çok yakmaya başlarsa** → tüketim anomalisi
- Her alarm delilleriyle birlikte kaydedilir; kimin ne zaman kapattığı bile görünür

> **Konuşma metni:**
> "Sistemin asıl değeri burada. İki bağımsız ölçüm var: pompanın saydığı litre ve tankın seviyesi. Bu ikisi birbirini tutmuyorsa bir sorun var demektir — ve sorun ister hırsızlık ister bozuk sayaç olsun, ikisini de bilmek istersiniz. Sistem bunu size sormadan söylüyor."

---

## Slayt 7 — Üç panel, üç farklı ihtiyaç

**Maddeler:**
- **Firma Yönetici Paneli:** Tüm şantiyeler, araçlar, yetkiler, raporlar. Yeni şantiye eklediğinizde sistem o şantiyenin kullanıcı adı ve şifresini kendisi üretir, boş paneli hazır teslim eder.
- **Şantiye Paneli:** Sadece o şantiyenin verisi. Canlı ikmal ekranı, tank seviyeleri, acil durdurma.
- **Geliştirici Paneli:** Bizim tarafımız — cihaz sağlığı, teknik izleme, modül açma/kapama.

> **Konuşma metni:**
> "Her şantiye şefi sadece kendi şantiyesini görür — komşu şantiyenin verisine erişemez. Siz ise hepsini birden görürsünüz. Yeni bir şantiye açtığınızda tek tuşla o şantiyenin panelini ve giriş bilgilerini oluşturursunuz; bizi aramanıza gerek yok."

---

## Slayt 8 — Ortak şantiye ve çapraz alım

**Maddeler:**
- A firmasının aracı, izin verdiğiniz kadar B firmasının tankından yakıt alabilir
- Kota tanımlarsınız: kaç litre, hangi tarihe kadar, hangi araçlar
- Kota dolduğunda pompa otomatik durur
- Ay sonu mahsuplaşma raporu hazır gelir: kim kimden ne kadar çekti, borç-alacak ne

> **Konuşma metni:**
> "Ortak yürütülen işlerde en çok tartışma çıkan konu budur: 'senin araç bizim tanktan çekti'. Artık tartışma yok — sistem litre litre kim çekti yazıyor ve ay sonu mahsuplaşmayı kendisi çıkarıyor."

---

## Slayt 9 — Raporlar ve e-İrsaliye

**Maddeler:**
- 13 hazır rapor: ikmal hareketleri, araç bazlı tüketim (100 km'de kaç litre), şantiye stok durumu, tank mutabakatı, çapraz alım, maliyet, sürücü, denetim...
- Excel çıktısının altında **genel toplam satırı otomatik**
- İstediğiniz rapor her hafta e-postanıza otomatik düşer
- **e-İrsaliye** GİB standardında otomatik üretilir ve gönderilir; elle belge kesme derdi biter

> **Konuşma metni:**
> "Muhasebenizin ay sonu bir gün harcadığı işi sistem her sabah otomatik yapıyor. Raporu indirdiğinizde toplam satırı zaten hesaplanmış geliyor. e-İrsaliye tarafında ise ikmal biter bitmez belge kuyruğa giriyor; kimse elle bir şey yazmıyor."

---

## Slayt 10 — Kazanımlar

| Ne kazanıyorsunuz | Nasıl |
|---|---|
| **Kayıp görünür olur** | Her litre ölçülür; teorik ve fiziksel stok her gün karşılaştırılır |
| **Yetkisiz alım durur** | Kartı olmayan araca pompa açılmaz |
| **Şantiye durmaz** | Tank kritik seviyeye inmeden "3 gün sonra biter" uyarısı gelir |
| **Kağıt iş yükü biter** | e-İrsaliye ve raporlar otomatik |
| **Tartışma biter** | Çapraz alım ve mahsuplaşma kayıtlı |
| **Bakım kararı veriye dayanır** | Hangi araç normalden fazla yakıyor, sayılarla görürsünüz |

> **Konuşma metni:**
> "Ben size 'yüzde şu kadar tasarruf' diye bir rakam vermeyeceğim, çünkü bu sizin sahanıza göre değişir. Şunu söyleyebilirim: ölçmeye başladığınız gün kaybınız görünür hale gelir. Görünür olan kayıp da yönetilebilir kayıptır."

---

## Slayt 11 — Neden bu sistem? (rekabet farkı)

**Maddeler:**
- **İnternet kesilince de çalışır** — birçok sistem burada durur, biz durmayız
- **Sayaç uzaktan kalibre edilir** — sahaya teknisyen göndermeden ayar yapılır, üstelik her değişiklik kayıtlı
- **İki bağımsız ölçüm** — sadece sayaca değil, tank seviyesine de bakarız; sayaç şaşarsa fark ederiz
- **Türkiye mevzuatına uyumlu** — e-İrsaliye standart olarak içinde
- **İş makinesi de kapsamda** — km değil motor-saat üzerinden tüketim hesabı

> **Konuşma metni:**
> "Piyasadaki çoğu çözüm ya sadece sayaç okur ya sadece kart kontrolü yapar. Bizim farkımız ikisini birlikte, üstelik birbirini denetleyecek şekilde yapmamız. Bir de şu var: şantiyede internet her zaman yoktur. Bizim cihazımız internet yokken de çalışmaya devam eder, kayıtları kendi içinde tutar ve bağlantı gelince hepsini gönderir."

---

## Slayt 12 — Kurulum ve yol haritası

**Maddeler:**
- **Pilot:** Bir şantiye, bir pompa, bir tank — kurulum ve devreye alma yaklaşık yarım gün
- **Kalibrasyon:** Referans kapla test alımı yapılır, sapma ±%0,5 altına çekilir, kabul formu imzalanır
- **Yaygınlaştırma:** Pilot sonuçları görülünce diğer şantiyeler kademeli eklenir
- **Ölçek:** Sistem 20 firmaya, 80 şantiyeye, 300 cihaza kadar planlanmıştır

> **Konuşma metni:**
> "Önerimiz şu: tek bir şantiyede pilot yapalım. Bir ay çalıştıralım, kayıp oranınızı ölçelim, sonra siz karar verin. Kurulum yarım gün sürer, işinizi durdurmaz."

---

## Slayt 13 — Demo ve kapanış

**Maddeler:**
- Canlı demo: kart okut → pompa açılsın → litre aksın → kayıt oluşsun → rapora yansısın
- Kaçak senaryosu: pompa kapalıyken seviye düşür → alarm ekrana düşsün
- Sorularınız

> **Konuşma metni:**
> "Şimdi isterseniz sistemi canlı görelim. Kartı okutuyorum... pompa açıldı, litre akıyor, ekranda görüyorsunuz. Şimdi kapatıyorum — ve bakın, kayıt oluştu, tank stoğu düştü, rapor güncellendi. Hepsi üç saniye içinde. Sizin yapmanız gereken hiçbir şey yok."

---

# ❓ SIK SORULAN SORULAR VE HAZIR CEVAPLAR

### 1. "Şantiyede internet yok / sürekli kesiliyor. Ne olacak?"
> "Bu senaryo baştan tasarıma dahil. Cihaz internet olmadan da çalışır: yetkili kart listesini kendi içinde tutar, yakıtı verir ve kaydı hafızasına yazar. Bağlantı geldiğinde biriken tüm kayıtları otomatik gönderir, hiçbiri kaybolmaz. Sadece bir güvenlik sınırı koyduk: internet yokken araç başına günde bir kez ve en fazla belirlediğiniz litre kadar (varsayılan 200 litre) yakıt verilir. Yani şantiye durmaz ama sınırsız da akmaz. Bu sınırı siz belirlersiniz, istersek internet yokken hiç vermeyecek şekilde de ayarlayabiliriz."

### 2. "Sayaç şaşarsa? Yanlış ölçerse ne olur?"
> "İki koruma var. Birincisi: tank seviyesi ayrı ölçülüyor. Sayaç 100 litre derken tanktan 130 litre eksilmişse sistem bunu yakalar ve uyarır. İkincisi: sayaç ayarını sahaya gitmeden uzaktan düzeltebiliyoruz. Teknisyen bilinen hacimde bir kaba test alımı yapar, sistem sapmayı hesaplar ve doğru ayarı önerir. Üstelik her ayar değişikliği kim yaptı, ne zaman yaptı diye kayıt altına alınır — yani bu kapı kötüye kullanılamaz."

### 3. "Şoför kartını başkasına verirse?"
> "Tamamen engelleyemeyiz, hiçbir kart sistemi engelleyemez — ama görünür kılarız. Kart hangi araca tanımlıysa o aracın deposundan fazlası verilemez. Aynı araca kısa aralıkla ikinci alım yapılırsa işaretlenir. Mesai dışı alım işaretlenir. Aracın tüketimi kendi geçmişine göre anormal artarsa uyarı çıkar. İsterseniz ikinci güvenlik seviyesini açarız: hem araç kartı hem şoför kartı okutulmadan pompa açılmaz. Kart kaybolursa panelden tek tuşla bloke edersiniz, çevrimdışı cihazlarda bile çalışmaz."

### 4. "Veriler kimde duruyor? Rakip firma görebilir mi?"
> "Her firmanın verisi veritabanı seviyesinde ayrılmıştır — bu, bir yazılımcının yanlışlıkla bile başka firmanın verisini çekemeyeceği anlamına gelir. Şantiye şefi sadece kendi şantiyesini görür. Verilerinizi istediğiniz zaman şifreli bir paket halinde indirebilirsiniz; sistemden ayrılmak isterseniz veriniz sizinle gelir."

### 5. "Elektrik kesilirse sayaç sıfırlanır mı?"
> "Hayır. Sayaç değeri cihazın kalıcı hafızasına düzenli olarak yazılıyor. Elektrik ikmal ortasında kesilse bile kaldığı yerden devam eder ve yarım kalan işlem 'anormal sonlandı' diye size raporlanır — sessizce kaybolmaz."

### 6. "Cihaz bozulursa yakıt veremeyecek miyiz?"
> "Veriyorsunuz. Cihaz arızasında pompayı elle kullanıp işlemi sisteme manuel girersiniz. Ama bu kapıyı kontrollü tuttuk: manuel giriş iki farklı yetkilinin onayı olmadan kesinleşmez ve raporlarda ayrı işaretlenir. Bir şantiyede manuel giriş oranı artmaya başlarsa sistem sizi uyarır."

### 7. "Kurulum işimizi durdurur mu? Ne kadar sürer?"
> "Bir pompanın devreye alınması yaklaşık yarım gün. Montaj, ayar, test alımı ve kabul formu dahil. Şantiyenin tamamının durmasına gerek yok, pompa bazında ilerliyoruz."

### 8. "Mevcut pompalarımız değişecek mi?"
> "Hayır, pompanız kalıyor. Biz üzerine kart okuyucu, sayaç ve kontrol ünitesi ekliyoruz. Tanka da bir seviye sensörü koyuyoruz."

### 9. "e-İrsaliye zaten muhasebemizde var, çakışır mı?"
> "Çakışmaz. Biz belgeyi üretip özel entegratörünüze iletiyoruz — hangi entegratörle çalışıyorsanız ona bağlanacak şekilde tasarlandı. Muhasebeniz belgeleri her zamanki yerinde görmeye devam eder, tek fark artık elle yazılmıyor olması."

### 10. "Ya sistem çökerse?"
> "İki cevabım var. Birincisi: cihazlar sunucudan bağımsız çalışabilir, saha durmaz. İkincisi: verinin günlük yedeği alınıyor ve geri yükleme tatbikatını düzenli yapıyoruz — yani 'yedek var' demiyoruz, 'yedekten geri döndük, denedik' diyoruz."

### 11. "Fiyatlandırma nasıl?"
> "Şantiye ve cihaz sayısına göre paketliyoruz. Kullanmadığınız modül için ödeme yapmıyorsunuz — e-İrsaliye istemiyorsanız kapalı gelir. Pilot kurulum sonrası size özel rakamı netleştiriyoruz."

### 12. "Şoförler direnç gösterir mi?"
> "Deneyimimiz şu: şoför açısından iş kolaylaşıyor, çünkü defter doldurmuyor. Direnç genelde ilk hafta 'kart okumadı' gibi teknik sorunlardan çıkar; bu yüzden cihaz ekranında ne olduğunu Türkçe yazıyoruz — 'kart tanımsız', 'kota doldu' gibi. Ne yapacağını bilen kullanıcı direnç göstermez."

---

# ⏱️ 60 SANİYELİK ASANSÖR KONUŞMASI

> "Şantiyelerde yakıt hâlâ kağıt defterle takip ediliyor ve ay sonunda hep 'eksik var' deniyor ama nerede eksildiği bilinmiyor.
>
> Biz pompayı akıllı hale getiriyoruz: her araçta bir kart var, tabanca takıldığında sistem yarım saniyede yetkiyi kontrol ediyor, pompa açılıyor ve akan her litre otomatik kaydediliyor. Hangi araç, hangi şantiye, kim, kaç litre — hepsi kayıtlı.
>
> Asıl farkımız şu: tankın seviyesini de ayrı ölçüyoruz. Pompanın saydığı litre ile tanktan eksilen yakıt tutmuyorsa sistem sizi anında uyarıyor. Yani hem hırsızlığı hem bozuk sayacı yakalıyoruz.
>
> İnternet kesilse bile cihaz çalışmaya devam ediyor, kayıtları hafızasında tutup sonra gönderiyor. Üstüne e-İrsaliye otomatik kesiliyor ve 13 hazır rapor geliyor.
>
> Bir şantiyede pilot yapalım, bir ay çalıştıralım, kaybınızı ölçelim — sonra siz karar verin."

---

# 🎬 DEMO SENARYOSU (5 dakika)

| # | Adım | Ne gösterilir | Dikkat |
|---|---|---|---|
| 1 | Yetkili kartı okut | Ekranda "yetki verildi", pompa açılır | Sürenin kısalığını vurgula |
| 2 | Yakıt aktır | Panelde litre canlı artar, tank seviyesi düşer | Panel ve cihaz ekranı aynı anda gösterilsin |
| 3 | Tabancayı kapat | Kayıt oluşur, hareket listesinde belirir | "Bu kayıt artık değiştirilemez" de |
| 4 | Yetkisiz kart okut | "Kart tanımsız" — pompa açılmaz | En etkili an; yavaş göster |
| 5 | Kotası dolmuş araçla dene | "Kota doldu" mesajı | Çapraz alım anlatımıyla bağla |
| 6 | Kaçak simülasyonu | Pompa kapalıyken seviye düşür → alarm ekrana düşer | Alarmın deliliyle birlikte kaydedildiğini göster |
| 7 | Raporu indir | Excel açılır, genel toplam satırı hazır | Muhasebeciye hitap eder |
| 8 | İnterneti kes | Cihaz "çevrimdışı" moda geçer, alım yapılabilir; bağlantı gelince kayıt senkronlanır | En çok soru gelen konu; mutlaka göster |

**Demo öncesi kontrol listesi:** cihaz şarjlı/enerjili mi · test kartları hazır mı · tankta yeterli yakıt var mı · panel ekranı yansıtılabiliyor mu · internet kesme senaryosu prova edildi mi · yedek plan (ekran kaydı) hazır mı.

---

## 🚫 Sunumda söylenmeyecekler

- **"Hırsızlığı tamamen bitirir"** → Bitirmez, görünür kılar. Abartılan vaat ilk sorunda güveni yıkar.
- **"%X tasarruf garantisi"** → Ölçmeden oran verme. "Pilotta ölçüp size özel rakamı sunacağız" de.
- **Teknik terimler** → RLS, MQTT, HMAC, hypertable... Dinleyici bunları duymamalı.
- **"Şoförleriniz çalıyor"** → Kimseyi suçlama. "Ölçülmeyen şey kaybolmaya açıktır" dili kullan.
- **Yol haritasındaki tamamlanmamış özellikleri bitmiş gibi anlatma** → Neyin bugün, neyin yol haritasında olduğunu net söyle.
