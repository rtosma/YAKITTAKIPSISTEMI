# Modül 1: Çekirdek Kurulum ve Güvenlik
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 1: Çekirdek Kurulum ve Güvenlik (Core & Security)" \
  --label "security, high-priority" \
  --body "Gerçek Kimlik Doğrulama (Authentication) ve RBAC Sisteminin Kurulması.

### Alt Görevler
- [ ] **1. Auth Servis Dosyasının Oluşturulması:** src/services/auth.service.ts dosyası oluşturularak login, logout ve token yenileme (refresh) HTTP istekleri yazılacak.
- [ ] **2. Login Sayfası UI Geliştirmesi:** WelcomeScreen.tsx ekranı e-posta/şifre girişi alacak bir forma dönüştürülecek.
- [ ] **3. Protected Route Bileşeni:** src/components/ProtectedRoute.tsx oluşturulacak ve izinsiz girişler engellenecek.
- [ ] **4. Role-Based Yönlendirme:** JWT payload'una göre Müşteri kullanıcısının /admin rotalarına girmesi engellenecek."

# Modül 2: Zustand'a Geçiş
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 2: React Context'ten Zustand'a Geçiş (Global State)" \
  --label "refactoring, medium-priority" \
  --body "Mevcut durumda tüm state ve mock veriler AppContext.tsx içinde yaşıyor. Bu yapı Zustand ile modüler hale getirilecek.

### Alt Görevler
- [ ] **1. Zustand Kurulumu:** zustand paketinin eklenmesi ve src/store/ klasörünün oluşturulması.
- [ ] **2. Entity Store'larının Ayrıştırılması:** useVehicleStore, useTankStore vb. oluşturularak verilerin taşınması.
- [ ] **3. Bileşenlerin Bağlanması:** Sayfalardaki useApp() hook'unun yeni Zustand hook'ları ile değiştirilmesi.
- [ ] **4. AppContext'in Kaldırılması:** src/context/AppContext.tsx dosyasının projeden tamamen silinmesi."

# Modül 3: REST API'ye Geçiş
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 3: Mock Veri Altyapısından REST API'ye Geçiş" \
  --label "backend-integration, high-priority" \
  --body "Uygulamanın statik verilerden kurtulup veritabanı ile konuşmaya başladığı aşama.

### Alt Görevler
- [ ] **1. API Katmanı Kurulumu:** src/services/api.ts oluşturulacak.
- [ ] **2. Cihaz ve Tank Verilerinin Bağlanması:** INITIAL_TANKS vb. mock veriler silinip backend'den çekilecek.
- [ ] **3. Yakıt Hareketi (Transaction) Endpoint'leri:** Hızlı İkmal formu POST /api/transactions isteği atacak şekilde güncellenecek.
- [ ] **4. Loading ve Error State'leri:** API istekleri sırasında iskelet (skeleton) ekranlar eklenecek."

# Modül 4: Gerçek Zamanlı Telemetri
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 4: Gerçek Zamanlı Telemetri (MQTT / WebSocket) Entegrasyonu" \
  --label "feature, high-priority" \
  --body "Rastgele (setInterval) üretilen donanım loglarını gerçek MQTT akışıyla değiştirmek.

### Alt Görevler
- [ ] **1. WebSocket/MQTT İstemcisi:** mqtt.js kurularak broker'a WSS bağlantısı sağlanacak.
- [ ] **2. Canlı Log Akışı Dinlenmesi:** LiveLogsPage.tsx gerçek MQTT verileriyle beslenecek.
- [ ] **3. Tank Göstergelerinin Güncellenmesi:** TankGauge.tsx içindeki animasyonlar gerçek veriyle tetiklenecek."

# Modül 5: Test ve CI/CD
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 5: Test ve Pipeline Kurulumu (CI/CD)" \
  --label "infrastructure, medium-priority" \
  --body "Test altyapısının kurulması ve otomatik dağıtım (deployment) süreçlerinin yapılandırılması.

### Alt Görevler
- [ ] **1. Unit Test Altyapısı:** Vitest kurularak TankGauge.tsx için temel testler yazılacak.
- [ ] **2. Dockerfile:** Nginx tabanlı, iki aşamalı prodüksiyona hazır Dockerfile yazılacak.
- [ ] **3. GitHub Actions:** .github/workflows/deploy.yml oluşturulacak."

# Modül 6: Personel Yönetimi
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 6: Personel İzin Takip Sisteminin Entegrasyonu" \
  --label "feature, medium-priority" \
  --body "Şantiyede görevli şoför, operatör ve personellerin izinlerinin merkezi bir takvim üzerinden yönetilmesi.

### Alt Görevler
- [ ] **1. UI Formu Tasarımı:** İzin giriş/onay UI formu tasarlanacak (Başlangıç-Bitiş tarihi, İzin Türü).
- [ ] **2. RFID Yetki Kontrolü:** İzinli olan personelin RFID yetkileri izin süresince pasife alınacak.
- [ ] **3. Eksik Personel Raporu:** Şantiye şefleri için, o gün sahada eksik olan personeli gösteren günlük rapor bileşeni oluşturulacak."

# Modül 7: Bakım Yönetimi
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 7: Araç Muayene, Periyodik Bakım ve Lastik Takip Merkezi" \
  --label "feature, high-priority" \
  --body "Araçların yasal muayeneleri, km/çalışma saati bazlı bakımları ve lastik ömürlerinin dijitalleştirilmesi.

### Alt Görevler
- [ ] **1. Muayene Takibi:** Son Muayene Tarihi ve Geçerlilik Tarihi alanları eklenip, bitimine 30 gün kala uyarı üretilecek.
- [ ] **2. Periyodik Bakım Tablosu:** Yakıt alımından hesaplanan çalışma saati üzerinden bakım yaklaşan araçlar listelenecek.
- [ ] **3. Lastik Takibi:** Aks/tekerlek pozisyonu bazlı diş derinliği ve değişim tarihi kayıt formu geliştirilecek."

# Modül 8: E-İrsaliye
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 8: GİB Uyumlu E-İrsaliye Entegrasyonu" \
  --label "feature, high-priority" \
  --body "Saha teslimatlarında ve yakıt/malzeme transferlerinde GİB UBL-TR formatına uygun e-irsaliye belgesinin otomatik oluşturulması.

### Alt Görevler
- [ ] **1. UBL-TR Servisi:** JSON verisini UBL-TR (XML) formatına çevirecek backend servisi yazılacak.
- [ ] **2. PDF Önizleme:** Kullanıcı arayüzünde oluşturulan irsaliyelerin PDF önizlemesi sunulacak.
- [ ] **3. GİB Entegrasyonu:** Entegratör firma API'si üzerinden irsaliyenin iletilmesi ve durum takibi sağlanacak."

# Modül 9: Laboratuvar
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 9: Şantiye Laboratuvar ve Numune Takibi" \
  --label "feature, low-priority" \
  --body "Şantiyede üretilen beton, dökülen asfalt, yakıt kalitesi veya zemin test numunelerinin dijital takibi.

### Alt Görevler
- [ ] **1. Barkodlu Kayıt Ekranı:** Test edilecek numuneler için barkod/QR kod destekli kayıt ekranı oluşturulacak.
- [ ] **2. Sonuç Tablosu ve PDF:** Test sonuçlarını içeren veri tablosu ve PDF rapor yükleme alanı eklenecek.
- [ ] **3. Alarm Sistemi:** Standart dışı çıkan laboratuvar sonuçları için proje yöneticisine otomatik sistem uyarısı (Notification) gönderilecek."

# Modül 10: Akıllı Ambar
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 10: Envanter ve Yedek Parça Stok Takibi" \
  --label "feature, medium-priority" \
  --body "Şantiye depolarındaki genel sarf malzemelerinin ve araçlara ait yedek parçaların giriş-çıkış (zimmet) takibi.

### Alt Görevler
- [ ] **1. Temel Envanter CRUD:** Depo envanteri için ekle/düzenle/sil işlemleri ve kategori yönetimi eklenecek.
- [ ] **2. Zimmet Yönetimi:** Çıkan bir yedek parça spesifik bir araca ve personele zimmetlenebilecek.
- [ ] **3. Kritik Stok Uyarısı:** Kritik seviyenin altına düşen malzemeler için kırmızı uyarı barları gösterilecek."

# Modül 11: AI Destekli Raporlama
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 11: AI Destekli Aylık Yönetim Raporu Jeneratörü" \
  --label "feature, medium-priority, ai" \
  --body "Gemini yapay zeka entegrasyonu ile aylık yakıt tüketim trendlerini ve performans skorlarını analiz eden raporların oluşturulması.

### Alt Görevler
- [ ] **1. AI Servis Katmanı:** İlgili ayın verilerini JSON formatında derleyip AI modeline prompt olarak gönderecek servis yazılacak.
- [ ] **2. AI Özeti UI Bileşeni:** AI tarafından üretilen metin, yönetim panelinde Markdown/HTML olarak render edilecek.
- [ ] **3. İçgörü Zorunluluğu:** Rapor çıktısında Tasarruf Önerileri ve Riskli Şantiye/Araçlar gibi içgörülerin bulunması prompt üzerinden zorunlu tutulacak."