# Operatör el kitabı — kullanılabilirlik testi (DOC-1207 Test Notu)

**Hedef:** sistemi **hiç görmemiş** bir kişi, yalnızca el kitabı ve özet kartla, **yardım almadan** ikmal yapabilmeli ve hata durumunda doğru davranmalı.

**Durum: HENÜZ YAPILMADI** — pompa ekranı (FW-1316) ve sahada çalışan cihaz gerektirdiği için pilot şantiyede ([../SAHA_KURULUM.md](../SAHA_KURULUM.md) KRT-10) yapılacaktır. Sonuçlar aşağıdaki tabloya işlenir; başarısız görevler el kitabına/kataloğa geri beslenir.

## Katılımcılar
- **En az 3 kişi**, sistemi ve el kitabını daha önce görmemiş (biri şoför, biri pompa operatörü, biri şantiye şefi profilinde). Gözlemci **yardım etmez**, yalnızca zaman ve hatayı not eder.
- Materyal: yalnızca pompaya asılı **özet kart** (önce), gerekirse **el kitabı** (telefondan). Gözlemci ek açıklama yapmaz.

## Görevler ve başarı ölçütleri
| # | Görev (katılımcıya sözlü verilir) | Başarı ölçütü |
|---|---|---|
| G1 | "Bu araca 20 litre yakıt alın." (kayıtlı kart, normal koşul) | 5 adımı yardımsız tamamlar; ≤ 5 dk; kayıt `DOĞRULANDI` |
| G2 | Kart **tanımsız** kartla (ret) | Ekran yazısını okur, "şantiye şefine haber verir"; **zorlamaya/başka kart denemeye kalkışmaz** |
| G3 | **Yakıt türü uyumsuz** senaryosu | İkmal **yapmaz** (kritik güvenlik görevi — tek hata = başarısız) |
| G4 | İnterneti kes (**çevrimdışı mod**), kartla ikmal | Çevrimdışı uyarısını anlar, limit içinde ikmal yapar, **cihazı kapatmaz** |
| G5 | Pompa ortasında **akış yok** senaryosu | Tabancayı kapatır, hortum/tank kontrolü yapıp şefe bildirir |
| G6 | "Acil durdurma nerede, ne zaman basılır?" | Doğru düğmeyi gösterir; "uzaklaşırım, şefe/112'yi ararım" der |
| G7 | (Şef) Panelde "dünkü ikmalleri bul, Excel'e indir" | **Yakıt Hareketleri**'nde süzer ve indirir; ≤ 3 dk |
| G8 | (Şef) "Tank seviyesi kritik mi?" | **Tank Durumu**'nda bulur |

**Genel geçme koşulu:** her katılımcı için G1–G6'nın tümü başarılı (G3 mutlaka); şef için G7–G8 başarılı. Ortalama G1 süresi ≤ 5 dk. **Her başarısızlık** el kitabında/mesaj kataloğunda düzeltme konusudur.

## Sonuç kaydı
| Tarih | Şantiye | Katılımcı profili | G1 (dk) | G2 | G3 | G4 | G5 | G6 | G7 | G8 | Notlar / düzeltmeler |
|---|---|---|---|---|---|---|---|---|---|---|---|
| _(pilotta doldurulacak)_ | | | | | | | | | | | |

Test sırasında **kişisel veri** (ad, kart no) kaydedilmez; katılımcılar K1, K2… olarak anılır.
