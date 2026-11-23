# Saha kurulum fotoğrafları (DOC-1206)

`docs/SAHA_KURULUM.md`'deki her adımda bir **`[FOTO-nn]`** yeri vardır. Bu klasör, **pilot şantiye devreye almasında** çekilen fotoğraflarla doldurulur (dosya adı: `FOTO-nn-kisa-ad.jpg`; genişlik ≤ 1600 px, yüz/plaka/kimlik görünmemeli — KVKK).
Fotoğraf çekilmeden önce belgede ilgili adımın altında **çekim tarifi** (aşağıdaki tablo) yer alır; pilot sonrasında görsel dosyaları eklenip belgedeki yer tutucu satırı `![FOTO-nn](saha-kurulum/foto/FOTO-nn-....jpg)` ile değiştirilir.

> Şematik çizimler (`../img/*.svg`) fotoğrafın yerine geçmez; fotoğrafsız adımın anlaşılmasını kolaylaştırmak içindir. **Durum: fotoğraflar pilotta çekilecek (henüz eklenmedi).**

| Kod | Adım | Çekim tarifi |
|---|---|---|
| FOTO-01 | Ön hazırlık | Kurulacak pompa kabini ve çevresi (geniş çekim) + mevcut topraklama barası |
| FOTO-02 | Portal: şantiye/tank | Ekran: şantiye ve tank kaydı (kişisel veri yok) |
| FOTO-03 | Montaj: kabin içi | Ünite, besleme, sigorta, toprak barası; kablo etiketleri okunur olmalı |
| FOTO-04 | Montaj: akışmetre | Akışmetrenin boruya bağlantısı, yön oku, ekranlı kablonun girişi |
| FOTO-05 | Montaj: röle/kontaktör | Pompa kesme rölesi ve kontaktör; yüksek akım kabloları sinyalden ayrı |
| FOTO-06 | Topraklama/ekran | Ekranın kabin ucunda PE'ye bağlandığı nokta (yakın çekim) + toprak direnci ölçüm cihazı ekranı |
| FOTO-07 | Konfigürasyon portalı | Cihaz konfigürasyon ekranı: WiFi/APN, sunucu, cihaz kimliği (**secret ve claim kodu görünmemeli**) |
| FOTO-08 | Claim ve doğrulama | Portalda cihazın AKTİF/ONLINE görünümü |
| FOTO-09 | K-faktör kalibrasyonu | Referans kap, akışmetre çıkışı ve okuma ekranı |
| FOTO-10 | Test alımı | Referans kabın dolu seviyesi (gözle okuma) + portaldaki test alımı sonucu |
| FOTO-11 | Uçtan uca ikmal | RFID kart okutma anı (kart no görünmemeli) ve ikmal kaydı ekranı |
| FOTO-12 | Offline senaryosu | Modem/yönlendirici fişinin çekilmiş hâli + cihazın çevrimdışı göstergesi |
| FOTO-13 | 24 saat izleme | Online SLA ekranı (offlineSeconds = 0) |
| FOTO-14 | Kabul ve teslim | İmzalı form + kabin kapatılmış, etiketli son hâl |
