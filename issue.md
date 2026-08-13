# Modül 1: Çekirdek Kurulum ve Güvenlik
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 1: Çekirdek Kurulum ve Güvenlik (Core & Security)" \
  --label "security, high-priority" \
  --body "Gerçek Kimlik Doğrulama (Authentication) ve RBAC Sisteminin Kurulması.
  
### Alt Görevler (Sub-tasks)
- [ ] **1. Auth Servis Dosyasının Oluşturulması:** \`src/services/auth.service.ts\` dosyası oluşturularak login, logout ve token yenileme (refresh) HTTP istekleri yazılacak. (Karmaşıklık: Orta)
- [ ] **2. Login Sayfası UI Geliştirmesi:** \`WelcomeScreen.tsx\` ekranı e-posta/şifre girişi alacak bir forma dönüştürülecek. (Karmaşıklık: Düşük)
- [ ] **3. Protected Route Bileşeni:** \`src/components/ProtectedRoute.tsx\` oluşturulacak ve izinsiz girişler engellenecek. (Karmaşıklık: Düşük)
- [ ] **4. Role-Based Yönlendirme:** JWT payload'una göre Müşteri kullanıcısının \`/admin\` rotalarına girmesi engellenecek. (Karmaşıklık: Düşük)"

# Modül 2: Zustand'a Geçiş
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 2: React Context'ten Zustand'a Geçiş (Global State)" \
  --label "refactoring, medium-priority" \
  --body "Mevcut durumda tüm state ve mock veriler \`AppContext.tsx\` içinde yaşıyor. Bu yapı Zustand ile modüler hale getirilecek.

### Alt Görevler (Sub-tasks)
- [ ] **1. Zustand Kurulumu:** \`npm install zustand\` eklenecek ve \`src/store/\` klasörü oluşturulacak. (Karmaşıklık: Düşük)
- [ ] **2. Entity Store'larının Ayrıştırılması:** \`useVehicleStore\`, \`useTankStore\` vb. oluşturularak veriler taşınacak. (Karmaşıklık: Orta)
- [ ] **3. Bileşenlerin Bağlanması:** \`OverviewPage\`, \`SitesPage\` gibi sayfalardaki \`useApp()\` hook'u kaldırılacak. (Karmaşıklık: Yüksek)
- [ ] **4. AppContext'in Kaldırılması:** \`src/context/AppContext.tsx\` dosyası projeden tamamen silinecek. (Karmaşıklık: Düşük)"

# Modül 3: REST API'ye Geçiş
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 3: Mock Veri Altyapısından REST API'ye Geçiş" \
  --label "backend-integration, high-priority" \
  --body "Uygulamanın statik verilerden kurtulup veritabanı ile konuşmaya başladığı aşama.

### Alt Görevler (Sub-tasks)
- [ ] **1. API Katmanı Kurulumu:** \`src/services/api.ts\` oluşturulacak. (Karmaşıklık: Düşük)
- [ ] **2. Cihaz ve Tank Verilerinin Bağlanması:** \`INITIAL_TANKS\` vb. mock veriler silinip backend'den çekilecek. (Karmaşıklık: Orta)
- [ ] **3. Yakıt Hareketi (Transaction) Endpoint'leri:** Hızlı İkmal formu \`POST /api/transactions\` isteği atacak şekilde güncellenecek. (Karmaşıklık: Orta)
- [ ] **4. Loading ve Error State'leri:** API istekleri sırasında iskelet (skeleton) ekranlar eklenecek. (Karmaşıklık: Düşük)"

# Modül 4: Gerçek Zamanlı Telemetri
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 4: Gerçek Zamanlı Telemetri (MQTT / WebSocket) Entegrasyonu" \
  --label "feature, high-priority" \
  --body "Rastgele (setInterval) üretilen donanım loglarını gerçek MQTT akışıyla değiştirmek.

### Alt Görevler (Sub-tasks)
- [ ] **1. WebSocket/MQTT İstemcisi:** \`mqtt.js\` kurularak broker'a WSS bağlantısı sağlanacak. (Karmaşıklık: Orta)
- [ ] **2. Canlı Log Akışı Dinlenmesi:** \`LiveLogsPage.tsx\` gerçek MQTT verileriyle beslenecek. (Karmaşıklık: Orta)
- [ ] **3. Tank Göstergelerinin Güncellenmesi:** \`TankGauge.tsx\` içindeki animasyonlar gerçek veriyle tetiklenecek. (Karmaşıklık: Yüksek)"

# Modül 5: Test ve CI/CD
gh issue create --repo rtosma/YAKITTAKIPSISTEMI \
  --title "Modül 5: Test ve Pipeline Kurulumu (CI/CD)" \
  --label "infrastructure, medium-priority" \
  --body "Test altyapısının kurulması ve otomatik dağıtım (deployment) süreçlerinin yapılandırılması.

### Alt Görevler (Sub-tasks)
- [ ] **1. Unit Test Altyapısı:** Vitest kurularak \`TankGauge.tsx\` için temel testler yazılacak. (Karmaşıklık: Orta)
- [ ] **2. Dockerfile:** Nginx tabanlı, iki aşamalı prodüksiyona hazır \`Dockerfile\` yazılacak. (Karmaşıklık: Düşük)
- [ ] **3. GitHub Actions:** \`.github/workflows/deploy.yml\` oluşturulacak. (Karmaşıklık: Orta)"