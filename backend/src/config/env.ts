import { z } from 'zod';

/**
 * ARCH-110 — tüm ortam değişkenlerinin TEK doğrulama noktası.
 *
 * Amaç: eksik ya da hatalı bir ortam değişkeninin (örn. JWT_SECRET boş,
 * POSTGRES_PORT sayı olmayan bir metin) uygulama CANLIDA çalışırken değil,
 * AYAĞA KALKARKEN fark edilmesi. Bu dosya dışında hiçbir modül `process.env`e
 * doğrudan erişmemeli — CI bunu scripts/check-no-direct-process-env.mjs ile
 * denetler (repoda ESLint kurulumu yok; ARCH-101.2'deki
 * check-no-raw-pool-query.mjs ile aynı gerekçeyle aynı desen kullanıldı).
 *
 * Bu proje NestJS/Drizzle KULLANMIYOR (ticket'ın "Teknik Yığın" alanı
 * @nestjs/config öneriyor ama kod tabanı düz Express) — bu yüzden burada
 * bağımsız bir Zod şeması + module-level fail-fast doğrulama var, NestJS'e
 * özgü bir ConfigModule değil.
 */

// .env.example'daki placeholder'lar — üretimde JWT/MQTT sırlarından biri hâlâ
// bu değerlerden birindeyse "yapılandırılmış görünüyor ama aslında değil"
// durumudur (bkz. loadConfig()'teki POSTGRES_PASSWORD'ün neden bu listeye
// dahil OLMADIĞINA dair not).
const KNOWN_PLACEHOLDER_VALUES = new Set([
  '__CHANGE_ME_RUN_openssl_rand_-hex_64__',
  '__CHANGE_ME_RUN_openssl_rand_-hex_32__'
]);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  POSTGRES_HOST: z.string().min(1).default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_USER: z.string().min(1).default('postgres'),
  POSTGRES_PASSWORD: z.string().min(1).default('postgres'),
  POSTGRES_DB: z.string().min(1).default('yakittakip_db'),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),

  // JWT_SECRET/JWT_REFRESH_SECRET her ortamda ZORUNLU — varsayılan bir
  // değer, kaynak koduna gömülü bir sır demektir ve repoyu okuyan herkes
  // geçerli token sahteleyebilir (bkz. tokenService.ts'in eski requireSecret()
  // yorumu, artık bu şemaya taşındı).
  // `{ message }` hem "hiç tanımlı değil" (undefined) hem "boş string" (min(1))
  // durumunu aynı anlaşılır Türkçe mesajla kapsar — yalnızca .min(1, msg)
  // kullanmak undefined durumunda Zod'un jenerik "expected string, received
  // undefined" mesajına düşerdi.
  JWT_SECRET: z.string({ message: 'JWT_SECRET tanımlı değil. .env dosyanızda ayarlayın (öneri: openssl rand -hex 64).' }).min(1, 'JWT_SECRET boş olamaz.'),
  JWT_REFRESH_SECRET: z.string({ message: 'JWT_REFRESH_SECRET tanımlı değil. .env dosyanızda ayarlayın (öneri: openssl rand -hex 64).' }).min(1, 'JWT_REFRESH_SECRET boş olamaz.'),

  MQTT_URL: z.string().min(1).default('mqtt://localhost:1883'),
  // EMQX artık anonim bağlantı kabul etmiyor (bkz. docker/emqx/entrypoint.sh)
  // — bu ikisi de her ortamda zorunlu.
  MQTT_USERNAME: z.string({ message: 'MQTT_USERNAME tanımlı değil.' }).min(1, 'MQTT_USERNAME boş olamaz.'),
  MQTT_PASSWORD: z.string({ message: 'MQTT_PASSWORD tanımlı değil.' }).min(1, 'MQTT_PASSWORD boş olamaz.'),

  // OPS-1105: bu 3 donanım cihaz sırrı önceden hardwareAuthMiddleware.ts'te
  // düz metin olarak kaynak kodundaydı (`git log` diffiyle görülebilir) —
  // gitleaks taraması bunu gerçek bir sızıntı olarak işaretledi (bkz.
  // scripts/gitleaks.toml). AUTH-202.3 (cihaz secret yaşam döngüsü — üretim,
  // provisioning, rotasyon) henüz yapılmadığından bunlar hâlâ sabit/statik
  // sırlar, ama en azından artık KAYNAK KODUNDA DEĞİLLER.
  HW_SECRET_ESP32_PUMP_01: z.string({ message: 'HW_SECRET_ESP32_PUMP_01 tanımlı değil.' }).min(1),
  HW_SECRET_ESP32_TANK_01: z.string({ message: 'HW_SECRET_ESP32_TANK_01 tanımlı değil.' }).min(1),
  HW_SECRET_ESP32_FLOW_ISR: z.string({ message: 'HW_SECRET_ESP32_FLOW_ISR tanımlı değil.' }).min(1),

  // FUEL-401.4: finalize edilen her ikmal kaydına, sonradan doğrudan DB
  // üzerinden (bu HMAC anahtarını bilmeden) fark ettirilmeden değiştirilemeyecek
  // bir "değişmezlik mührü" (hash_signature) eklemek için kullanılan sunucu
  // sırrı. JWT_SECRET'ın yeniden kullanılması BİLİNÇLİ OLARAK tercih
  // edilmedi — token imzalama ile kayıt bütünlüğü farklı tehdit modelleri
  // (biri sızarsa diğerini de tehlikeye atmamalı).
  TRANSACTION_HASH_SECRET: z.string({ message: 'TRANSACTION_HASH_SECRET tanımlı değil.' }).min(1),

  // AUTH-202.3: hardware_devices.encrypted_secret'ı şifrelemek/çözmek için
  // kullanılan AES-256-GCM anahtarı (pepper) — tam olarak 32 bayt (64 hex
  // karakter) olmalı, aksi halde crypto.createCipheriv çalışma zamanında
  // (ilk cihaz kaydında) patlar; burada fail-fast doğrulanıyor.
  HW_SECRET_ENCRYPTION_KEY: z.string({ message: 'HW_SECRET_ENCRYPTION_KEY tanımlı değil.' })
    .regex(/^[0-9a-fA-F]{64}$/, 'HW_SECRET_ENCRYPTION_KEY tam olarak 64 hex karakter (32 bayt) olmalıdır (öneri: openssl rand -hex 32).'),

  // ARCH-108: tenant veri dışa aktarım arşivini (companies dahil TÜM tenant
  // tablolarının JSON dökümü) AES-256-GCM ile şifrelemek için kullanılan
  // pepper — HW_SECRET_ENCRYPTION_KEY'in YENİDEN kullanılması BİLİNÇLİ OLARAK
  // tercih edilmedi (cihaz sırları ile bir müşterinin TÜM verisi farklı
  // tehdit modelleri — biri sızarsa diğerini tehlikeye atmamalı, hardware
  // secret crypto ile AYNI gerekçe).
  TENANT_EXPORT_ENCRYPTION_KEY: z.string({ message: 'TENANT_EXPORT_ENCRYPTION_KEY tanımlı değil.' })
    .regex(/^[0-9a-fA-F]{64}$/, 'TENANT_EXPORT_ENCRYPTION_KEY tam olarak 64 hex karakter (32 bayt) olmalıdır (öneri: openssl rand -hex 32).'),

  // AI-502: yukarıdaki sırların aksine BİLEREK opsiyonel — bu özellik
  // (Gemini ile tüketim anomali analizi) yapılandırılmamışsa uygulamanın
  // TAMAMI ayağa kalkmayı reddetmemeli, yalnızca consumptionAnomalyService.ts
  // ilgili isteği 503 ile nazikçe reddetmeli (bkz. o dosyadaki
  // requestAnomalyAnalysis). JWT/MQTT/HW_SECRET_* sırlarının hepsi sistemin
  // ÇEKİRDEK güvenlik/işlev omurgası; bu ise P2 öncelikli, isteğe bağlı bir
  // AI zenginleştirmesi.
  GEMINI_API_KEY: z.string().min(1).optional(),

  // IOT-302.1: ChirpStack/TTN uplink webhook'unun paylaşılan doğrulama
  // token'ı. AI-502 gibi opsiyonel AMA "fail-closed": tanımlı değilse
  // POST /lorawan/uplink TÜM çağrıları 503 ile reddeder (yapılandırılmamış
  // bir webhook, doğrulanmamış istekleri kabul etmektense hiç veri almasın —
  // internete açık bir uçtan sahte tank seviyesi enjeksiyonu bu şekilde
  // engellenir). En az 24 karakter (öneri: openssl rand -hex 32).
  LORAWAN_WEBHOOK_TOKEN: z.string().min(24).optional(),

  // AUTH-207: "true"/"1" ise SUPER_ADMIN ve COMPANY_OWNER hesapları 2FA
  // KURMADAN sisteme giremez (login yalnızca kurulum için kısmi token döner;
  // refresh de reddedilir). Varsayılan KAPALI — aksi halde seed/demo yönetici
  // hesapları ve mevcut entegrasyon test paketi kilitlenirdi. 2FA'yı kendi
  // isteğiyle KURAN her kullanıcı, bu bayraktan bağımsız olarak her girişte
  // kod ister (opt-in geri alınamaz gevşeklikle çelişmesin).
  TOTP_ENFORCED: z.string().optional().default('false').transform((v) => v === 'true' || v === '1'),

  // TEST_PLAN.md §5.2 — CORS allowlist (virgülle ayrılmış origin listesi).
  // Önceden `app.use(cors())` varsayılanıyla çalışılıyordu, yani
  // `Access-Control-Allow-Origin: *` — HER origin API'ye istek atabiliyordu.
  // Pratikte buna hiç gerek yok: nginx hem SPA'yı hem /api'yi AYNI origin'den
  // sunuyor ve frontend API'yi göreli yolla (`/api/v1`) çağırıyor; saha
  // cihazları (ESP32/LoRaWAN) ise tarayıcı olmadığı için CORS'a zaten tabi
  // değil. Bu yüzden VARSAYILAN artık "CORS tamamen kapalı" (same-origin):
  // değişken tanımsız/boşsa cors ara katmanı HİÇ eklenmez.
  // Farklı bir origin'den (ayrı domain'de barındırılan panel, mobil web,
  // staging) erişim gerekirse buraya açıkça yazılır:
  //   CORS_ALLOWED_ORIGINS=https://panel.ornek.com,https://staging.ornek.com
  CORS_ALLOWED_ORIGINS: z.string().optional()
});

type EnvShape = z.infer<typeof envSchema>;
export type AppConfig = EnvShape & { readonly isProduction: boolean };

let cachedConfig: AppConfig | undefined;

function failFast(message: string): never {
  // Henüz logger başlatılmamış olabilir (logger.ts de bu modüle bağımlı) —
  // bu yüzden bilinçli olarak console.error kullanılıyor, tek istisna bu.
  // eslint-disable-next-line no-console
  console.error(`\n🚨 [ARCH-110] Ortam değişkeni doğrulaması başarısız — uygulama başlatılamıyor.\n\n${message}\n`);
  process.exit(1);
}

function loadConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    failFast(`${details}\n\nbackend/.env.example dosyasına bakıp .env dosyanızı tamamlayın.`);
  }

  const data: EnvShape = result.data;
  const isProduction = data.NODE_ENV === 'production';

  if (isProduction) {
    // Üretimde .env.example'daki placeholder değerlerden biri hâlâ
    // kullanılıyorsa "yapılandırılmış görünüp aslında güvensiz" bir kuruluma
    // canlıya çıkmayı engelle. Değişkenin ADI loglanır, DEĞERİ asla.
    //
    // POSTGRES_PASSWORD kasıtlı olarak bu listede DEĞİL: bu projede Postgres
    // hiçbir zaman docker-compose'un dahili ağının dışına çıkmıyor (host'a
    // port yayını yok, bkz. OPS-1102) ve docker-compose.yml'nin kendisi
    // postgres servisinin şifresini de AYNI ${POSTGRES_PASSWORD:-postgres}
    // değişkeninden okuyor — yani container ayağa kalkarken veritabanının
    // GERÇEK şifresi zaten bu değerle set ediliyor; .env'de "güçlü" bir
    // değere sadece burada geçmek DB'nin şifresini DEĞİŞTİRMEZ (Postgres
    // parolayı yalnızca ilk init'te, boş bir data dizininden okur) ve backend
    // kimlik doğrulamasını kırar. JWT/MQTT ise gerçek yetkilendirme/kimlik
    // sınırları olduğundan (oturum sahteciliği, sahte cihaz) bu kontrolde kalıyor.
    // Bunlar DEĞİŞKEN ADLARI, bir sır listesi değil — gitleaks:allow (bkz.
    // .gitleaks.toml: generic-api-key kuralı yalnızca ard arda gelen bu
    // isimlerin dizi görünümüne yanlışlıkla takılıyordu).
    const stillPlaceholder = ([
      'JWT_SECRET', 'JWT_REFRESH_SECRET', 'MQTT_PASSWORD',
      'HW_SECRET_ESP32_PUMP_01', 'HW_SECRET_ESP32_TANK_01', 'HW_SECRET_ESP32_FLOW_ISR', // gitleaks:allow
      'TRANSACTION_HASH_SECRET', 'HW_SECRET_ENCRYPTION_KEY', 'TENANT_EXPORT_ENCRYPTION_KEY'
    ] as const).filter((key) => KNOWN_PLACEHOLDER_VALUES.has(data[key]));

    if (stillPlaceholder.length > 0) {
      failFast(
        `Üretim ortamında hâlâ .env.example'daki varsayılan/placeholder değer(ler) kullanılıyor: ${stillPlaceholder.join(', ')}.\n` +
        `Bunları gerçek, rastgele üretilmiş sırlarla değiştirin (öneri: openssl rand -hex 64).`
      );
    }
  }

  return { ...data, isProduction };
}

/**
 * Tipli, doğrulanmış konfigürasyon nesnesi — kod tabanındaki tüm ortam
 * değişkeni erişimi buradan geçmeli. Modül ilk import edildiğinde (bkz.
 * bootstrap.ts: dotenv/config'ten SONRA, başka her şeyden ÖNCE) bir kez
 * doğrulanır; eksik/hatalı bir değişken varsa süreç burada, canlıya
 * çıkmadan, exit code 1 ile sonlanır.
 */
export const config: AppConfig = cachedConfig ?? (cachedConfig = loadConfig());
