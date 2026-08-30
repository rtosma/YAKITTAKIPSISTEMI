# 🔧 Yakıt Takip Sistemi (YAKITTAKIPSISTEMI)

Akıllı şantiye yakıt yönetim ve izleme sistemi. ESP32 IoT donanımları ile entegre, multi-tenant SaaS mimarisi.

## 📁 Proje Yapısı

```
YAKITTAKIPSISTEMI/
├── backend/                 # Node.js Express API Server
│   ├── src/                 # Kaynak kodlar
│   │   ├── context/         # AsyncLocalStorage tenant context
│   │   ├── db/              # PostgreSQL bağlantı, schema, seed
│   │   ├── middleware/      # Auth, tenant, HMAC, error handler, logger
│   │   ├── routes/          # API route tanımları
│   │   ├── schemas/         # Zod doğrulama şemaları
│   │   ├── services/        # JWT token servisi
│   │   ├── utils/           # Logger, password, errors, graceful shutdown
│   │   └── index.ts         # Sunucu giriş noktası
│   ├── test/                # Test dosyaları
│   ├── Dockerfile           # Multi-stage production Docker imajı
│   ├── package.json         # Backend bağımlılıkları
│   └── tsconfig.json        # Node.js TypeScript konfigürasyonu
│
├── frontend/                # Vite + React SPA
│   ├── src/                 # React kaynak kodları
│   │   ├── components/      # Yeniden kullanılabilir bileşenler
│   │   ├── context/         # React Context (AppContext)
│   │   ├── layouts/         # Sayfa düzenleri (Customer, Developer)
│   │   ├── mock/            # Demo veri setleri
│   │   ├── pages/           # Sayfa bileşenleri (customer, developer, santiye)
│   │   ├── types/           # TypeScript tip tanımları
│   │   ├── utils/           # Yardımcı fonksiyonlar
│   │   ├── App.tsx          # Ana uygulama bileşeni
│   │   └── main.tsx         # Vite giriş noktası
│   ├── index.html           # HTML şablonu
│   ├── nginx.conf           # Production Nginx konfigürasyonu
│   ├── Dockerfile           # Multi-stage build (Vite → Nginx)
│   ├── vite.config.ts       # Vite dev server + API proxy
│   ├── package.json         # Frontend bağımlılıkları
│   └── tsconfig.json        # React TypeScript konfigürasyonu
│
├── hardware/                # ESP32 IoT donanım dosyaları
│   └── esp32veriakışı.cpp   # ESP32 veri akış kontrol kodu
│
├── docker-compose.yml       # Tüm servisleri orkestre eder
├── .env.example             # Ortam değişkenleri şablonu
└── README.md
```

## 🚀 Hızlı Başlangıç

### Docker Compose ile (Önerilen)

```bash
# 1. Ortam değişkenlerini konfigüre et
cp .env.example .env

# 2. Tüm servisleri başlat (PostgreSQL + Backend + Frontend)
docker compose up --build

# 3. Erişim
# Frontend:  http://localhost:3000
# Backend:   http://localhost:5000/api/v1/health
# PostgreSQL: localhost:5432
```

### Geliştirme (Manuel)

```bash
# Backend
cd backend
npm install
cp .env.example .env
npm run dev          # http://localhost:5000

# Frontend (ayrı terminalde)
cd frontend
npm install
cp .env.example .env
npm run dev          # http://localhost:3000
```

## 🏗️ Teknoloji Yığını

| Katman     | Teknoloji                                         |
| ---------- | ------------------------------------------------- |
| Frontend   | React 19, Vite, Tailwind CSS v4, Recharts, Motion |
| Backend    | Node.js 20, Express, TypeScript, Zod              |
| Veritabanı | PostgreSQL 16 (RLS + Multi-Tenant)                |
| Auth       | Argon2id + JWT (Access + Refresh Token Rotation)  |
| IoT        | ESP32, HMAC-SHA256 Hardware Auth, MQTT             |
| Deploy     | Docker, Docker Compose, Nginx                     |
