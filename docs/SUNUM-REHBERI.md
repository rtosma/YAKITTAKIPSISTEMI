# Yakıt Takip Sistemi — Anlatım ve Sunum Rehberi

> **Kimin için:** projeyi teknik olmayan bir dinleyiciye — firma sahibi, yatırımcı, şantiye şefi — **15 dakikada** anlatacak yönetici.
> **Nasıl kullanılır:** her slaytın altındaki *Ekranda* maddeleri slayta, *Konuşma metni* sizin ağzınıza göre uyarlanacak öneri metne aittir. Metni ezberlemeyin, cümlelerin **sırasını** koruyun.
> **Dil kuralı:** bu rehberin sunucu metinlerinde teknik terim yoktur. Teknik terim yerine günlük dil kullanılır: "her firmanın verisi birbirinden ayrı tutulur" denir. Teknik sorulara [SSS](#3-sık-sorulan-sorular-ve-hazır-cevaplar) ve [Ek B](#ek-b-söylenen-her-iddianın-kanıtı) yeter; ayrıntı isteyen olursa [Proje Rehberi](PROJE-REHBERI.md) ve [Sözlük](SOZLUK.md) vardır.

**Üç ilke**
1. **Ölçülebilir söyleyin, vaat etmeyin.** Bu rehber hiçbir "yüzde şu kadar tasarruf" oranı vermez; çünkü henüz bir müşteri şantiyesinde ölçülmüş bir oran yoktur. Sistemin ölçtüğü şeyler (her litre kime gitti, tankta ne kadar kaldı) ve *laboratuvarda denenmiş* davranışlar anlatılır. Kazanım, pilotta **sizin rakamınızla** hesaplanır ([Slayt 3](#slayt-3--bugünkü-durumun-bedeli-100)).
2. **Gösteremeyeceğinizi söylemeyin.** Her iddianın kanıtı [Ek B](#ek-b-söylenen-her-iddianın-kanıtı)'dedir; demo da [gerçek sistemde provası yapılmış](#ek-a-sunum-öncesi-hazırlık-teknik-yardımcı-için) adımlardan oluşur.
3. **Bilmediğinizi söyleyin.** Yanıtı bilmediğiniz soruya "yazılı olarak dönerim" demek, uydurmaktan daima iyidir.

## 1. Slayt akışı (15 slayt, 15 dakika)

| # | Slayt | Süre | # | Slayt | Süre |
|---|---|---|---|---|---|
| 1 | Açılış | 0:30 | 9 | Veriniz ve güvenlik | 1:00 |
| 2 | Problem | 1:00 | 10 | Kazanımlar | 1:00 |
| 3 | Bugünkü durumun bedeli | 1:00 | 11 | Fark nedir? | 0:30 |
| 4 | Çözüm | 0:45 | 12 | Paketler ve fiyat | 0:45 |
| 5 | Nasıl çalışır? | 1:15 | 13 | Yol haritası | 0:45 |
| 6 | Yönetici paneli | 1:00 | 14 | **Canlı gösterim** | **3:30** |
| 7 | Şantiye şefi ve raporlar | 0:45 | 15 | Kapanış ve sonraki adım | 0:30 |
| 8 | İnternet kesilirse | 0:45 | | **Toplam** | **15:00** |

Akış: problem (2–3) → bugünün maliyeti (3) → çözüm (4) → nasıl çalışır (5) → panel ekranları (6–7) → güvenilirlik ve veri (8–9) → kazanımlar (10) → rekabet farkı (11) → fiyatlandırma (12) → yol haritası (13) → demo (14) → kapanış (15).

### Slayt 1 — Açılış (0:30)

**Ekranda:** "Şantiyenizdeki her litre yakıt: kime, ne zaman, ne kadar." · logo ve sunucunun adı

> Günaydın. Bugün size tek bir soruya cevap veren bir sistem göstereceğim: şantiyenizdeki mazotun her litresi nereye gidiyor? On beş dakika sonunda bu sorunun cevabını ekranda, canlı olarak göreceksiniz. Önce neden bu soruyu sorduğumuzu anlatayım.

### Slayt 2 — Problem: yakıt görünmez (1:00)

**Ekranda:** tank + kâğıt defter görseli · "Kim aldı?" "Ne kadar aldı?" "Tankta ne kalmış?" · üç soru, üç belirsizlik

> Şantiyede yakıt çoğu yerde hâlâ defterle, fişle, güvene dayalı olarak takip ediliyor. Pompanın başında bir kişi var, bir defter var. Gün sonunda deftere bakıyorsunuz: kim almış, ne kadar almış, bilmiyorsunuz; tankta gerçekte ne kaldığını ise ancak bir görevli çubukla ölçünce öğreniyorsunuz.
>
> Bu bir dürüstlük sorunu değil, bir **görünürlük** sorunu. İyi niyetli insanlar da yanlış yazar, unutur, toplamı tutturamaz. Yönetici ise ay sonunda elindeki rakamın ne kadarına güvenebileceğini bilmez.

### Slayt 3 — Bugünkü durumun bedeli (1:00)

**Ekranda:** üç satırlık hesap tablosu (aşağıdaki), **boş kutularla** · "Bu rakamları sizinle birlikte dolduralım."

| Sizin rakamınız | Değer |
|---|---|
| Aylık toplam yakıt harcaması (₺) | ……… |
| Defter/fiş ile gerçek stok arasındaki fark, geçen ay (litre) | ……… |
| Ay sonu yakıt mutabakatına harcanan saat | ……… |

> Bugünkü durumun bedelini ben size bir yüzde söyleyerek değil, **sizin rakamlarınızla** hesaplayalım. Aylık yakıt harcamanız ne kadar? Ay sonunda defterle tank arasında kaç litre fark çıkıyor? Bunu kim, kaç saatte uzlaştırıyor?
>
> Bu üç sayı elinizdeyse, bugünkü kaybın alt sınırını görürsünüz. Ben size "şu kadar tasarruf edeceksiniz" demeyeceğim; çünkü bunu ancak sizin şantiyenizde, sistem çalışırken ölçebiliriz. Pilot dönemin amacı tam olarak budur.

*Sunucu notu:* tabloyu dinleyiciyle doldurun; **rakam uydurmayın**, örnek yüzde vermeyin. Dinleyici rakam bilmiyorsa bunu bulgu olarak kabul edin ("işte tam bu yüzden görünürlük lazım").

### Slayt 4 — Çözüm (0:45)

**Ekranda:** üç parça: **Kart** · **Pompa ünitesi** · **Panel** · "Kart okutmadan yakıt yok. Yazılan her litre ölçülmüş litre."

> Çözüm üç parçadan oluşuyor. Birincisi, her sürücüye verilen bir kart. İkincisi, pompaya takılan, akan yakıtı ölçen bir kontrol ünitesi. Üçüncüsü, yöneticinin tarayıcıdan gördüğü panel.
>
> Kural basit: **kart okutulmadan pompa açılmaz.** Ve deftere el ile yazılan bir rakam yok; yakıtın ne kadar aktığını pompadaki sayaç ölçüyor, panel onu olduğu gibi gösteriyor.

### Slayt 5 — Nasıl çalışır? (1:15)

**Ekranda:** beş adım, soldan sağa: ① Kartı okut → ② Sistem karar verir → ③ Pompa açılır → ④ Sayaç ölçer → ⑤ Kayıt ve stok güncellenir

> Sürücü pompaya gidiyor ve kartını okutuyor. **Bir:** sistem kartın kime ait olduğuna bakıyor; bu sürücü aktif mi, aracı hangisi, bu tankta yeterli yakıt var mı, bu araca izin verilen miktar ne kadar? Hepsi tamamsa pompa **iki:** açılıyor, ekranda "en fazla şu kadar litre alabilirsiniz" yazıyor.
>
> **Üç:** ikmal sürerken cihaz sistemle sürekli konuşuyor. Bağlantı beş on saniye kopsa da sorun yok; ama on beş saniyeden uzun sessizlik olursa sistem pompayı kapatıyor. **Dört:** ikmal bitince sayaçtaki fark litre olarak alınıyor. **Beş:** kayıt kart sahibinin ve aracın adına yazılıyor, tank stoku aynı anda düşüyor. Yani deftere ihtiyaç kalmıyor, kayıt kendiliğinden oluşuyor.

### Slayt 6 — Yönetici paneli (1:00)

**Ekranda:** panel ekran görüntüleri: **Genel Bakış** · **Tank Durumu** · **Yakıt Hareketleri** · **Araç Yönetimi** · **Şoför Yönetimi**

> Bu, yöneticinin gördüğü panel. Soldaki menüde işinizle ilgili her şey var: Genel Bakış, Tank Durumu, Yakıt Hareketleri, Araç ve Şoför Yönetimi, Şantiye Yönetimi.
>
> Tank Durumu ekranı her tankta ne kadar yakıt kaldığını gösteriyor; azalmaya başlayan tank uyarı durumuna geçiyor. Yakıt Hareketleri ekranında her ikmali görüyorsunuz: hangi araç, hangi sürücü, hangi tank, kaç litre, saat kaçta. Aramak, süzmek, kişi veya plaka bazlı bakmak mümkün. Bunları bir sonraki ay başında değil, **şu anda** görüyorsunuz.

### Slayt 7 — Şantiye şefi ve raporlar (0:45)

**Ekranda:** şantiye paneli görüntüsü · rapor listesi · uyarı bildirimi örneği

> Şantiye şefi kendi şantiyesini görüyor, başka şantiyenin verisini görmüyor. Yakıt kalmayınca, olağandışı bir çekiş olunca kendisine bildirim düşüyor. Örneğin pompa kapalıyken tank on dakikada beş litreden fazla azalıyorsa sistem alarm veriyor.
>
> Yönetici tarafında hazır raporlar var: ikmal hareketleri, araç bazlı tüketim, tank mutabakat ve fire, maliyet ve bütçe gibi. Tek tuşla tablo ya da belge olarak alabiliyorsunuz; ay sonu mutabakat elle hazırlanan bir iş olmaktan çıkıyor.

### Slayt 8 — İnternet kesilirse (0:45)

**Ekranda:** "Şantiyede internet kesilir. Sistem durmaz. Kayıt kaybolmaz." · deneme sonucu: **72 saat kesinti → 216 ikmalin 216'sı kayıtta**

> Şantiyede internet kesilir, bunu hepimiz biliyoruz. Cihaz bu durumda ikmali kendi hafızasına yazıyor; internet gelince biriken kayıtları sunucuya gönderiyor. Aynı kayıt iki kez gelse bile ikinci kez yazılmıyor.
>
> Bunu laboratuvarda denedik: üç günlük bir kesintiyi taklit ettik, o sürede 216 ikmal biriktirdik. İnternet gelince 216 ikmalin 216'sı da kayıtta çıktı, tank hesabı litre litre tuttu. Şunu dürüstçe söyleyeyim: bu bir **laboratuvar denemesi**, gerçek bir şantiyede üç gün beklemedik. Pilotta gerçeğini göreceğiz.

### Slayt 9 — Veriniz ve güvenlik (1:00)

**Ekranda:** "Her firmanın verisi birbirinden ayrı." · "Kim ne görebilir, yetkiye bağlı." · "Şifreli yedek, düzenli geri yükleme denemesi."

> Yakıt verisi ticari olarak hassastır ve sürücülerin kişisel bilgilerini de içerir. Bu yüzden üç şeyi baştan kurduk. Bir: her firmanın verisi birbirinden ayrı tutuluyor; bir başka firmanın yöneticisi giriş yapsa bile sizinkini göremiyor. Bunu sonra canlı göstereceğim.
>
> İki: herkes yalnızca yetkisi kadarını görüyor; sürücünün kimlik numarası gibi bilgiler yetkisi olmayanlara **maskeli** görünüyor. Üç: veriler şifreli yedekleniyor ve yedekten geri dönme düzenli olarak deneniyor. Hedefimiz, bir arızada en fazla on beş dakikalık veriyi kaybetmek ve dört saat içinde geri dönmek. Bu bir **hedef**, biz bunu ölçüyoruz ve tutmazsa uyarı alıyoruz.

### Slayt 10 — Kazanımlar (1:00)

**Ekranda:** dört kazanım, her birinin altında "nasıl ölçülür" · sonuna: "Oran vaadi yok — pilot ölçer."

| Kazanım | Nasıl ölçülür |
|---|---|
| **Her litrenin sahibi belli** | Panelde kaç ikmalin kart sahibi ve araç ile eşleşmiş olduğu |
| **Tank stoku anlık** | Fiziksel ölçümle panel arasındaki fark (litre) |
| **Ay sonu mutabakat süresi** | Slayt 3'te yazdığınız saat, pilot sonunda |
| **Olağandışı çekiş fark edilir** | Alarm sayısı ve her alarmın nedeni |

> Kazanımları dört başlıkta özetliyorum ve her birinin yanında nasıl ölçüldüğünü yazdım. Birincisi: her litrenin sahibi belli. İkincisi: tank stoku bir hesap değil, anlık bir ölçüm; panelle fiziksel ölçüm arasındaki farkı görüp güveninizi buna göre ayarlarsınız. Üçüncüsü: mutabakat işi kısalır; ne kadar kısaldığını bugün söylemiyorum, pilot sonunda birlikte ölçeceğiz. Dördüncüsü: bir şey ters gittiğinde ay sonunu beklemeden haberiniz olur.
>
> Burada bilerek "yüzde şu kadar tasarruf" demiyorum. Bu rakamı bir şantiyede ölçmeden söylemek doğru olmaz.

### Slayt 11 — Fark nedir? (0:30)

**Ekranda:** dört satırlık karşılaştırma: "Sadece sayaç okumak" ↔ "Sürücüye, araca, tanka bağlı kayıt" ve benzeri

> Piyasada yalnızca sayaç okuyup rakam gösteren çözümler var. Bizim farkımız dört noktada: ikmal **karta ve sürücüye bağlı**, yani pompa yetkisizlere kapalı. İnternet kesilince **çalışmaya devam ediyor**. Birden çok şantiyeyi ve **şantiyeler arası** ikmali tek yerden yönetiyor. Ve firmanıza ait verinin kime ait olduğu, kimin ne görebileceği baştan tanımlı. Rakiplerin adını anmıyorum; sizden istediğim, benim söylediklerimi canlı gösterimde kendiniz kontrol etmeniz.

### Slayt 12 — Paketler ve fiyat (0:45)

**Ekranda:** paket tablosu ve ek modül fiyatları (aşağıda)

| Özellik (aylık liste fiyatı) | Temel | Profesyonel | Kurumsal |
|---|---|---|---|
| Şoför performans skoru (500 ₺) | ✔ | ✔ | ✔ |
| Yapay zekâ anomali tespiti (1.500 ₺) | — | ✔ | ✔ |
| e-Fatura / e-İrsaliye hazırlığı (2.000 ₺) | — | ✔ | ✔ |
| Bakım ve muayene takibi (750 ₺) | — | ✔ | ✔ |
| Şantiyeler arası yetkilendirme (500 ₺) | — | ✔ | ✔ |
| Akıllı depo ve envanter (1.000 ₺) | — | — | ✔ |

> Üç paket var: Temel, Profesyonel ve Kurumsal. Temel paket ikmal takibini ve raporları içerir. Profesyonel pakete olağandışı çekiş tespiti, bakım takibi, şantiyeler arası ikmal ve e-İrsaliye hazırlığı eklenir. Kurumsalda akıllı depo da vardır. İstemediğiniz özelliği ödemezsiniz, isterseniz tek tek ekleyebilirsiniz.
>
> Ekrandaki rakamlar bu özelliklerin **aylık liste fiyatıdır**. Paketin ana bedeli ve cihaz maliyeti şantiye sayınıza ve saha durumuna göre teklifle belirlenir; bugün onun için bir rakam söylemeyeceğim.

*Sunucu notu:* rakamlar sistemdeki güncel modül listesinden alınmıştır (test ile denetlenir). Sunumdan önce satış ekibiyle güncelliğini teyit edin; **ana paket bedeli** için sistemde bir rakam **yoktur**, uydurmayın.

### Slayt 13 — Yol haritası (0:45)

**Ekranda:** üç sütun: **Hazır** · **Pilotta yapılacak** · **Sırada**

| Hazır | Pilotta yapılacak | Sırada |
|---|---|---|
| Kartlı ikmal, panel, raporlar, uyarılar, kesintide çalışma, yedekleme | Sahada kurulum ve ölçüm, gerçek rakamla kazanım hesabı | Cihaz yazılımının saha onayı, e-İrsaliye'nin gerçek entegratörle bağlanması |

> Neyin hazır olduğunu, neyin henüz olmadığını açıkça söyleyeyim. Panel, kartlı ikmal, raporlar, uyarılar, kesintide çalışma ve yedekleme hazır ve denenmiş durumda. Pilotta yapacağımız şey sahada kurulum ve sizin rakamlarınızla gerçek ölçüm.
>
> Sırada iki iş var: pompadaki cihazın yazılımının sahada onaylanması ve e-İrsaliye'nin gerçek bir entegratör firmayla bağlanması. Bu ikisi için bugün **tarih vermiyorum**; tarihi pilot planında birlikte yazarız.

### Slayt 14 — Canlı gösterim (3:30)

**Ekranda:** boş slayt; **canlı sisteme geçilir**. Adımlar: [§4 Demo senaryosu](#4-demo-senaryosu-35-dakika-canlı).

> Şimdi anlattıklarımı canlı gösteriyorum. Sürücü kartını okutacak, ikmal yapılacak, siz de panelde aynı anda göreceksiniz.

### Slayt 15 — Kapanış ve sonraki adım (0:30)

**Ekranda:** "Öneri: tek şantiyede 4 haftalık pilot." · "Ölçeceğimiz üç sayı: stok farkı, mutabakat süresi, alarm sayısı."

> Bugün gördüğünüz her şey gerçek sistemde çalıştı. Önerim, tek bir şantiyede dört haftalık bir pilot: kurulum, ölçüm ve sonunda **sizin rakamlarınızla** bir değerlendirme. Ölçeceğimiz üç sayı var: stok farkı, mutabakat süresi ve alarm sayısı. Pilot sonunda bu sayılar iyileşmemişse bunu birlikte görürüz. Sorularınızı alayım.

## 2. 60 saniyelik asansör konuşması

*(≈ 125 kelime; yavaş ve net okunduğunda 60 saniyedir. Sunum yapamayacağınız ortamlarda — koridor, asansör, telefon — tek başına yeterlidir.)*

> Şantiyelerde yakıt hâlâ defterle takip ediliyor; kim ne kadar aldı, tankta ne kaldı, kimse tam bilmiyor. Biz bunu basit bir kuralla çözüyoruz: **kart okutulmadan pompa açılmıyor.** Sürücü kartını okutuyor, sistem sürücüyü, aracı ve tankı kontrol ediyor, pompadaki sayaç akan yakıtı ölçüyor, kayıt kendiliğinden yazılıyor. Yönetici de her litrenin kime gittiğini, tankta ne kaldığını tarayıcıdan anında görüyor.
>
> İnternet kesilse bile ikmaller cihazın hafızasında birikiyor, bağlantı gelince kayıpsız tamamlanıyor. Olağandışı bir şey olursa, örneğin pompa kapalıyken tank azalırsa, yöneticiye alarm düşüyor. Her firmanın verisi birbirinden ayrı; herkes yalnızca yetkisi kadarını görüyor. Kurulum bir pompa noktası için yaklaşık bir iş günü sürüyor.
>
> Bir oran vaat etmiyoruz: tek şantiyede dört haftalık pilotla, **sizin rakamlarınızla** stok farkını ve ay sonu mutabakat süresini ölçüyoruz. Bir şantiyenizi bu ay pilot yapalım mı?

## 3. Sık sorulan sorular ve hazır cevaplar

### 3.1 İnternet kesilirse ne olur? Yakıt alınamaz mı?

Alınabilir. Cihaz, sunucuya ulaşamadığında ikmali kendi hafızasına yazar ve bağlantı gelince gönderir; aynı kayıt tekrar gelse çift sayılmaz. Çevrimdışıyken hangi koşullarla ikmale izin verileceğini **siz** belirlersiniz: araç başına en fazla litre, günlük ikmal sayısı ve hiç izin vermeme seçeneği. Laboratuvar denemesinde üç günlük kesintide 216 ikmalin 216'sı kayıpsız kaydedildi; gerçek şantiyede bu pilotta doğrulanacaktır.

### 3.2 Sayaç şaşarsa? Ölçüm yanlışsa?

Sistem iki ölçümü karşılaştırır: pompadaki sayacın farkı ile cihazın kendi bildirdiği toplam. Fark **yüzde 1'den** fazlaysa kayıt "doğrulama bekliyor" olarak işaretlenir ve yetkili bir kişinin onayına düşer, sessizce kabul edilmez. Sayacın ayarı (katsayısı) uzaktan güncellenebilir; büyük değişiklikler ikinci bir kişinin onayı olmadan uygulanmaz. Pompa kapalıyken tank azalıyorsa ayrı bir alarm verilir. Kurulumda sayaç bir ölçü kabıyla kalibre edilir.

### 3.3 Kart başkasına verilirse?

Bunu tamamen **engelleyemeyiz**, bunu dürüstçe söylemek gerekir; bir kart, verdiğiniz kişinin elindeki bir anahtardır. Ama üç şey değişir: her ikmal kartın sahibi ve ona bağlı araç adına kaydedilir, yani iz kalır; kart kaybolduğunda ya da sürücü işten ayrıldığında kart **panelden hemen kapatılır**; sürücü izne çıkmışsa kartı zaten çalışmaz. Olağandışı çekişler (örneğin tanktaki beklenmedik düşüş) ayrıca alarm üretir. Yani sistem hırsızlığı imkânsız yapmaz, **fark edilmesini** ve izlenmesini mümkün kılar.

### 3.4 Veriler kimde durur? Başkası görebilir mi?

Veri **firmanıza aittir**. Her firmanın verisi diğerlerinden ayrı tutulur; başka bir firmanın yöneticisi sizinkini göremez (bunu demoda gösteriyoruz). Kişisel bilgiler yetkisi olmayan kullanıcılara maskeli görünür. Kişisel verilerin korunması kanunu kapsamında sürücü/personel için bilgi alma ve silme talepleri **30 gün** içinde yanıtlanacak şekilde takip edilir; saklama süreleri tanımlıdır. Yedekler şifreli tutulur. *Verilerin fiziksel olarak nerede barındırıldığı (sizin sunucunuz mu, bizimki mi) ticari modele bağlıdır; bunu sözleşmede net olarak yazarız.*

### 3.5 Kart kaybolursa ya da sürücü işten çıkarsa?

Kart panelden kapatılır; kapatıldığı andan itibaren bu kartla pompa açılmaz. Sürücünün geçmiş ikmalleri kayıtta kalır; çünkü vergi ve denetim için bunların silinmemesi gerekir. Kişisel bilgileri ise saklama süresi dolunca ya da talep üzerine anonim hâle getirilir; ikmal kaydının kendisi ve toplamlar bozulmaz.

### 3.6 Bir sürücü pompanın fişini çekerse ya da kabloyu keserse?

Cihaz ikmal sırasında sistemle kısa aralıklarla konuşur; **15 saniye** sessizlik olursa sistem oturumu kapatır ve pompaya durma komutu gönderir. Cihaz kapatılırsa ya da bağlantısı kesilirse panelde "çevrimdışı" görünür ve uyarı alırsınız. Kurulumda cihaza yedek besleme (akü/kesintisiz güç) takılması şartıdır.

### 3.7 Kurulum ne kadar sürer? Mevcut pompalarımıza takılır mı?

Bir pompa noktası için kurulum, ayar ve kabul denemeleri yaklaşık **bir iş günü**, ardından 24 saatlik kesintisiz izleme yapılır. Cihaz pompa hattına bir akış ölçer ve bir röle olarak takılır; uygunluk **saha keşfinde** teknisyen tarafından belirlenir, buradan söz vermiyoruz. Kurulum bir saha teknisyeni ve bir yetkili elektrikçi ile yapılır ve imzalı bir kabul formuyla tamamlanır.

### 3.8 Bir şantiyenin aracı başka şantiyeden yakıt alabilir mi?

Evet, ama yalnızca **siz izin verirseniz**: aracın başka şantiyede yakıt alması için önceden bir izin ve litre sınırı tanımlanır. Sınır ikmal başlarken ayrılır; aynı sınırı iki cihazın aynı anda tüketmesi engellenir. Sınır bitince pompa açılmaz.

### 3.9 Sistem çökerse ya da sunucu bozulursa?

Yeni bir sürüm yüklerken kesinti olmaz; hata olursa önceki sürüme geri dönülür. Sunucu arızasında hedefimiz en fazla 15 dakikalık veri kaybı ve 4 saat içinde geri dönüştür; bu hedefler düzenli tatbikatlarla **ölçülür**. Cihazlar bu sırada çevrimdışı çalışmaya devam eder.

### 3.10 e-İrsaliye gönderebiliyor musunuz?

İkmal kayıtlarından e-İrsaliye belgesi hazırlıyoruz ve göndermeye hazır. Ancak gerçek bir entegratör firmayla **canlı bağlantı henüz kurulmadı**; bu yol haritasındadır. Pilotta hangi entegratörle çalıştığınızı öğrenip bağlantıyı birlikte planlarız; bu konuda bugün bir tarih ya da "hazır" sözü vermiyoruz.

### 3.11 Çalışanlar için mahremiyet sorunu olur mu?

Sistem sürücünün *ne kadar ve hangi araca yakıt aldığını* kaydeder; sistemde araç ya da kişi konum takibi yoktur. Kişisel bilgilere erişim yetkiye bağlıdır; yapılan değişiklikler ve rapor dışa aktarımları **kimin yaptığıyla birlikte** kayda geçer. Sürücüleri sistemden önce bilgilendirmenizi öneririz; bilgilendirme metni için hukuk danışmanınız ile çalışırız.

### 3.12 Öğrenmesi zor mu? Şantiye çalışanı kullanabilir mi?

Pompadaki işlem "kartı okut, yakıtı al" kadar basittir; ekrandaki mesajlar kısa ve aynı dilde yazılıdır. Sürücüler ve pompa operatörleri için tek sayfalık bir özet kart ve operatör el kitabı hazırdır. Yönetici paneli için ise bir eğitim oturumu öneriyoruz; **anlaşılırlığı pilotta ölçeceğiz**, şimdiden "çocuk oyuncağı" demiyoruz.

## 4. Demo senaryosu (3,5 dakika, canlı)

Senaryo, [Ek A](#ek-a-sunum-öncesi-hazırlık-teknik-yardımcı-için)'daki prova komutuyla **gerçek sistemde adım adım koşturulmuş** ve her adımın sonucu doğrulanmıştır. Aşağıdaki değerler (plaka, litre, tank) prova verisinden gelir.

**Hazırlık (sunumdan önce):** iki tarayıcı sekmesi — biri **yönetici** (Yönetici A), biri **başka bir firmanın yöneticisi** (Yönetici B) olarak giriş yapmış. Pompa tarafı için teknik yardımcı hazır olsun. Ekran paylaşımından bildirimleri kapatın.

| # | Ne yaparsınız | Ne söylersiniz | Ne görülür |
|---|---|---|---|
| **D1** | Yönetici A ile **Tank Durumu**'nu açın | "Şantiyemizin tankı şu an dolu, şu kadar litre var." | Gebze Ana Tank (T-1): tank seviyesi ve durumu (güvenli) |
| **D2** | Yetkisiz bir kart okutun | "Önce kayıtlı olmayan bir kart deniyorum." | Pompa **açılmaz**: kart tanınmadı |
| **D3** | Kayıtlı sürücünün kartını okutun | "Şimdi Ahmet Yılmaz kartını okutuyor." | Sürücü, **34 CTP 82** plakalı araç ve izin verilen litre görünür |
| **D4** | 50 litrelik ikmali yaptırın | "Pompa çalışıyor, sayaç ölçüyor." | İkmal biter: **50 litre**, "doğrulandı" |
| **D5** | **Tank Durumu**'nu ve **Yakıt Hareketleri**'ni yenileyin | "Bakın, defter yok, kimse yazmadı; kayıt kendiliğinden oluştu." | Tank **50 litre azaldı**, listede yeni ikmal, plaka 34 CTP 82 |
| **D6** | İnternet kesintisini gösterin: cihazın biriktirdiği iki ikmali gönderin, sonra **aynısını tekrar** gönderin | "İnternet yokken cihaz kendi hafızasına yazmıştı. Şimdi bağlantı geldi." | İlk gönderimde **2 kayıt** kabul; tekrarda **2'si de "zaten var"** diye atlanır, çift kayıt yok |
| **D7** | **İkmal Hareket Raporu**'nu açın | "Ay sonu mutabakat işi bu." | Bugünün ikmalleri satır satır listelenir |
| **D8** | Yönetici B sekmesine geçin, **Tank Durumu**'na bakın | "Şimdi başka bir firmanın yöneticisi." | Kendi tankları dışında **hiçbir şey görünmez**, bizim tankımız ve ikmalimiz yok |

**Sorun çıkarsa (yedek planı):**
- Pompa/cihaz tarafı yanıt vermezse D2–D4'ü atlayıp D5'ten devam edin ve önceden hazırlanmış ekran görüntülerini gösterin: "Bunu az önce denedik" **demeyin**; "bu, sabah yaptığımız denemenin kaydı" deyin.
- Panel açılmazsa slaytlardaki ekran görüntülerine dönün ve durumu **saklamayın**: "Canlı bağlantıda sorun var, aynı adımları kayıtlı görüntüyle göstereyim."
- **Asla** gerçek müşteri verisini demoda göstermeyin; demo yalnızca örnek firmalarla yapılır.

## 5. Prova ve geri bildirim protokolü

Amaç: rehberin gerçekten **anlaşılır** olduğunu ölçmek. Rehber "hazır" sayılmak için önce gerçek dinleyiciyle **bir kez** denenmelidir.

1. **Kim:** teknik olmayan 3–5 kişi (firma sahibi, şantiye şefi, muhasebe ya da benzeri). Sunumu hazırlayan kişi **dinleyici olmamalı**.
2. **Nasıl:** rehberle 15 dakikalık sunum yapılır, saat tutulur. Sunum sonunda dinleyicilere sırasıyla soru sorulmadan formu doldurtulur.
3. **Form (1–5 puan, 5 = tamamen katılıyorum):**
   1. Sistemin ne yaptığını **kendi cümlelerimle** anlatabilirim.
   2. Kullanılan hiçbir kelimeyi anlamadığım an olmadı.
   3. Sistemin bana ne fayda sağlayacağını ve bunun **nasıl ölçüleceğini** anlıyorum.
   4. Anlatılanların abartıldığını düşünmüyorum.
   5. Bir pilot için sonraki adımı biliyorum.
   6. (Açık uçlu) En çok hangi anda kafam karıştı?
4. **Geçme ölçütü:** 1–5. soruların her birinin ortalaması **≥ 4,0**; hiçbir dinleyici 2. soruya 2 veya altında puan vermemiş olmalı. Süre **15 dakikayı ≥ 1 dakikadan fazla aşmamalı**.
5. **Sonuç:** anlaşılmayan yerler bu rehberde düzeltilir; düzeltmeden sonra yeni bir dinleyiciyle tekrarlanır. Sonuçlar kaydedilir (tarih, dinleyici sayısı, ortalamalar, düzeltilen slaytlar).

> **Durum:** bu protokol yazılmıştır, **henüz gerçek dinleyiciyle uygulanmamıştır**. Uygulanınca sonuç buraya işlenir. Demo adımları ise gerçek sistemde prova edilmiştir ([Ek A](#ek-a-sunum-öncesi-hazırlık-teknik-yardımcı-için)).

## Ek A: Sunum öncesi hazırlık (teknik yardımcı için)

*Bu bölüm sunucu metni değildir; sunuma yardım eden teknik kişi içindir, bu yüzden teknik terim içerir.*

**Sistem ayakta mı ve senaryo çalışıyor mu — sunumdan önce, aynı ortamda:**

```bash
# Yerelde (docker compose, nginx 3000'de) — sunumdan ÖNCE koşturun, her adım ✅ olmalı
DEMO_API_URL=http://localhost:3000/api/v1 node scripts/demo-provasi.mjs

# Sunum sırasında: pompa tarafını adım adım siz yönetin (her adım Enter ile başlar)
DEMO_API_URL=http://localhost:3000/api/v1 node scripts/demo-provasi.mjs --canli
```

`--canli` kipinde betik, sunucunun panelde D1'i gösterdiği sırada bekler; **Enter** ile pompa tarafındaki adım (D2, D3+D4, D6) çalışır ve sonucu ekrana yazar; sunucu paneli yenileyip D5/D7/D8'i gösterir.

Beklenen çıktı: `SONUÇ: 9/9 adım geçti.` Betik demo senaryosunun **D1–D8** adımlarını (ayrıca aracı sürücüye atama hazırlığını) gerçek API, veritabanı ve Redis üzerinde koşturur; her adımın "sunumda görünen" çıktısını yazar. Art arda çalıştırılabilir (her koşuda yeni idempotency anahtarı/sıra numarası). Bir adım ❌ ise **sunuma çıkmayın**; sistemi düzeltin.

| Gereksinim | Not |
|---|---|
| Örnek firmalar | `camsa` (Yönetici A) ve `kusak` (Yönetici B); parola seed verisindedir (`backend/src/db/seed.ts`) |
| Cihaz sırrı | `HW_SECRET_ESP32_PUMP_01` (kök `.env`) |
| Oturum sınırı | Giriş denemesi IP başına 10/15 dk; demo öncesi tekrar tekrar provada bunu tüketmeyin |
| Yedek görüntüler | Her demo adımının ekran görüntüsü alınıp slaytlara yedek olarak konmalıdır |
| Prova sonrası | Tank seviyesi her koşuda 50 litre düşer; sunumdan sonra örnek verinin gerçek olmadığı unutulmamalıdır |

**Kontrol listesi (sunumdan 30 dakika önce):** ☐ prova betiği 9/9 · ☐ iki firmanın sekmeleri açık · ☐ ekran paylaşımı testi · ☐ bildirimler kapalı · ☐ yedek ekran görüntüleri hazır · ☐ [Slayt 12](#slayt-12--paketler-ve-fiyat-045) fiyatları satışla teyit edildi.

## Ek B: Söylenen her iddianın kanıtı

Bu rehber "gösteremeyeceğiniz şeyi söylemeyin" ilkesine dayanır. Bir dinleyici "buna nereden bakayım?" derse:

| İddia | Rehberde | Kanıt |
|---|---|---|
| Kart okutulmadan pompa açılmaz; bilinmeyen kart reddedilir | Slayt 4–5, D2 | `docs/HARDWARE_INTEGRATION_GUIDE.md` §9 · `backend/test/test_fuel401_dispense_session.ts` |
| 15 saniye sessizlikte pompa kesilir | Slayt 5, SSS 3.6 | `backend/src/services/dispenseSessionService.ts` (`HEARTBEAT_TIMEOUT_MS`) |
| Sayaç farkı esas, ±%1 sapma onaya düşer | SSS 3.2 | `docs/HARDWARE_INTEGRATION_GUIDE.md` §9.3 |
| Pompa kapalıyken 10 dakikada 5 L'den fazla düşüş alarm verir | Slayt 7, SSS 3.2 | `backend/src/services/theftDetectionService.ts` |
| 72 saatlik kesintide 216/216 ikmal kayıpsız (laboratuvar) | Slayt 8, SSS 3.1 | `docs/CHAOS_TESTING.md` · `backend/test/test_test1007_chaos.ts` |
| Aynı paket tekrar gelse çift kayıt olmaz | Slayt 8, D6 | `scripts/demo-provasi.mjs` (adım 6) |
| Firmalar birbirinin verisini göremez | Slayt 9, SSS 3.4, D8 | `scripts/demo-provasi.mjs` (adım 8) · `backend/test/test_195_tenant_isolation.ts` |
| Kişisel veri maskeli, bilgi talebi 30 gün | Slayt 9, SSS 3.4–3.5 | `docs/KVKK_ENVANTER.md` |
| Yedek hedefi 15 dk / 4 sa, tatbikatla ölçülür | Slayt 9, SSS 3.9 | `docs/BACKUP_RESTORE.md` |
| Paketler ve modül liste fiyatları | Slayt 12 | `backend/src/db/adminDb.ts` (`PACKAGE_MODULE_DEFAULTS`, `MODULE_PRICING`) |
| Menü adları (Genel Bakış, Tank Durumu, …) | Slayt 6, demo | `frontend/src/layouts/CustomerLayout.tsx` |
| Kurulum ≈ 1 iş günü + 24 saat izleme | SSS 3.7 | `docs/SAHA_KURULUM.md` |
| Şantiyeler arası ikmal izin ve sınırla | SSS 3.8 | `docs/SOZLUK.md` ("Çapraz alım", "Kota") |
| e-İrsaliye gerçek entegratöre bağlı **değil** | Slayt 13, SSS 3.10 | `docs/PROJE-REHBERI.md` §1 (kapsam dışı) |
| Operatör özet kartı ve el kitabı hazır | SSS 3.12 | `docs/OPERATOR_EL_KITABI.md` · `docs/operator/OZET_KART.html` |

---

*Bu belge `scripts/test-doc1204.mjs` ile denetlenir: slayt sayısı ve süre toplamı, SSS sayısı, asansör konuşması uzunluğu, sunucu metinlerinde teknik terim ve uydurma oran olmaması, fiyat/paket/menü/sabitlerin koddaki değerle aynı olması, demo adımlarının prova betiğiyle eşleşmesi.*
