import { Router, Request, Response } from 'express';
import { getTenantStore } from '../context/tenantContext';
import { getTenantVehicles, createVehicle, updateVehicle, deleteVehicle, getTenantDrivers, createDriver, updateDriver, deleteDriver, getTenantTanks, createTank, updateTank, deleteTank, getTenantSites, createTenantSite, deleteTenantSite } from '../db/tenantDb';
import { validateRequest } from '../middleware/validateMiddleware';
import { createVehicleSchema } from '../schemas/vehicleSchema';
import { createDriverSchema, updateDriverSchema } from '../schemas/driverSchema';
import { dispenseRequestSchema } from '../schemas/transactionSchema';
import { loginSchema } from '../schemas/authSchema';
import { verifyPassword } from '../utils/password';
import { pool } from '../db/postgresPool';
import {
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  JwtUserPayload,
  UserRole
} from '../services/tokenService';
import { authenticateJWT, authorizeRoles, AuthenticatedRequest } from '../middleware/authMiddleware';
import { hardwareAuthMiddleware } from '../middleware/hardwareAuthMiddleware';

const router = Router();

/**
 * @swagger
 * /health:
 *   get:
 *     tags: [System]
 *     security: []
 *     summary: API Sağlık Durumu Kontrolü
 *     description: Sistemin ayakta olup olmadığını kontrol eder.
 *     responses:
 *       200:
 *         description: Başarılı, sistem ayakta.
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    service: 'Yakıttakip Backend API [ARCH-101 / RES-901 / AUTH-201 (PostgreSQL Connected)]'
  });
});

/**
 * @swagger
 * /tenant-info:
 *   get:
 *     tags: [System]
 *     summary: AsyncLocalStorage Tenant Bağlamını Oku (Tanılama)
 *     description: >
 *       AsyncLocalStorage üzerinde tutulan kiracı (tenant) bağlamını okumayı amaçlayan
 *       tanılama ucudur. Veritabanına HİÇBİR sorgu atmaz, hiçbir veri yazmaz.
 *
 *
 *       DİKKAT - GERÇEK DAVRANIŞ: Bu route'a hiçbir kimlik doğrulama ara katmanı bağlı
 *       DEĞİLDİR (`authenticateJWT` yok). Bağlamı kuran `TenantContextService`
 *       (middleware/tenantMiddleware.ts) uygulamada hiçbir yerde import edilmez veya
 *       mount edilmez - bkz. index.ts:49 yorumu. AsyncLocalStorage bağlamı yalnızca
 *       `authenticateJWT` içinde `tenantStorage.run()` ile kurulduğu için bu handler
 *       daima bağlamsız çalışır: `getTenantStore()` her zaman `undefined` döner ve
 *       `res.json` (JSON.stringify) `context` anahtarını gövdeden tamamen düşürür.
 *
 *
 *       Sonuç: yanıt gövdesi - geçerli bir Bearer token gönderilse de, `X-Tenant-ID`
 *       başlığı veya `tenantId` query parametresi verilse de - HER ZAMAN yalnızca
 *       `{ "success": true, "message": "..." }` içerir. `context` alanı PRATİKTE HİÇ
 *       DÖNMEZ; kodda yazılı olması yanıltıcıdır (canlı olarak doğrulandı).
 *     security: []
 *     responses:
 *       200:
 *         description: >
 *           Normal çalışmada tek olası yanıttır; handler kendi başına başka bir durum
 *           kodu üretmez. Gövde `context` alanı OLMADAN gelir. (Tek istisna route'a
 *           özgü değildir: sunucu graceful shutdown modundayken global ara katman
 *           tüm isteklere 503 SERVICE_UNAVAILABLE döner - bkz. index.ts:25-34.)
 *         headers:
 *           X-Trace-ID:
 *             description: >
 *               İstek izleme kimliği. İstemci `X-Trace-ID` başlığı gönderirse değer
 *               aynen yankılanır (doğrulandı: serbest metin de kabul edilir), aksi
 *               halde sunucu bir UUID v4 üretir. Bu nedenle format garantisi yoktur.
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TenantInfoResponse'
 */
router.get('/tenant-info', (_req: Request, res: Response) => {
  const store = getTenantStore();
  res.json({
    success: true,
    message: 'AsyncLocalStorage context başarıyla okundu.',
    context: store
  });
});

/**
 * @swagger
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Kullanıcı Girişi (PostgreSQL + Argon2id + JWT)
 *     description: |
 *       Kullanıcı adı ve parola ile oturum açar. Kullanıcı `users` tablosunda
 *       `LOWER(username)` üzerinden aranır, parola Argon2id ile doğrulanır ve
 *       başarılı olursa 15 dakikalık access token ile 7 günlük tek kullanımlık
 *       refresh token üretilir.
 *
 *       **Koddan doğrulanmış davranış notları:**
 *
 *       - Public uçtur. `authenticateJWT` uygulanmaz; global `bearerAuth`
 *         gereksinimi bu operasyonda `security: []` ile geçersiz kılınmıştır.
 *       - Kullanıcı adına arama öncesinde `trim()` + `toLowerCase()` uygulanır,
 *         yani giriş büyük/küçük harf duyarsızdır. Bu işlem Zod doğrulamasından
 *         SONRA yapıldığı için `" ab "` (4 karakter) `minLength: 3` kuralını
 *         geçer ve veritabanında `"ab"` olarak aranır.
 *       - `users.username` sütunu `VARCHAR(64) UNIQUE`tir, yani tüm kiracılarda
 *         globaldir; sorguda `tenant_id` filtresi yoktur. Kiracı bağlamı bulunan
 *         kullanıcı satırından türetilir.
 *       - Sorgu tenant bağlamı kurulmadan doğrudan `pool.query` ile çalışır.
 *         `users` tablosunda RLS açık (`FORCE ROW LEVEL SECURITY`) olmasına rağmen
 *         uygulama havuzu `postgres` süper kullanıcısıyla bağlandığı için RLS
 *         atlanır; giriş bu sayede çalışır.
 *       - Kullanıcı bulunamadığında ve parola yanlış olduğunda birebir AYNI gövde
 *         döner (`INVALID_CREDENTIALS`); kullanıcı adı sayımı (enumeration) mümkün değildir.
 *       - Gövdedeki bilinmeyen alanlar Zod tarafından sessizce silinir (hata verilmez).
 *       - Yanıttaki `expiresInSeconds` sabit `900` yazılıdır; access token gerçekten
 *         `15m` ile imzalanır (tutarlı).
 *       - `user.username` istekte gönderilen hali değil, veritabanındaki yazımıyla döner.
 *       - `user.siteName` KOŞULLU alandır: DB'deki `site_name` NULL/boş ise alan
 *         JSON'dan tamamen düşer (COMPANY_OWNER hesaplarında genellikle yoktur,
 *         SITE_MANAGER hesaplarında bulunur).
 *       - `role` değeri DB'den ham okunur (`VARCHAR(32) DEFAULT 'SITE_MANAGER'`);
 *         veritabanı seviyesinde enum kısıtı yoktur, listelenen değerler
 *         `tokenService.UserRole` tipinden gelir.
 *       - Refresh token yalnızca süreç belleğindeki Map'te tutulur
 *         (`tokenService.refreshTokenStore`); şemadaki `refresh_tokens` TABLOSUNA
 *         YAZILMAZ. Sunucu yeniden başladığında tüm refresh tokenlar geçersiz olur.
 *       - Bu uçta hız sınırlama (rate limit) YOKTUR; kaba kuvvet denemeleri engellenmez.
 *     security: []
 *     requestBody:
 *       required: true
 *       description: Giriş bilgileri. `loginSchema` (Zod) ile doğrulanır.
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             description: >
 *               Zod `loginSchema` karşılığı. Şemada tanımlı olmayan alanlar
 *               reddedilmez, sessizce silinir.
 *             properties:
 *               username:
 *                 type: string
 *                 minLength: 3
 *                 description: >
 *                   Kullanıcı adı. Doğrulamadan SONRA trim + lowercase uygulandığı için
 *                   giriş büyük/küçük harf duyarsızdır. Eksik veya string değilse
 *                   "Kullanıcı adı zorunludur.", kısaysa
 *                   "Kullanıcı adı en az 3 karakter olmalıdır." mesajı döner.
 *                 example: camsa
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 6
 *                 description: >
 *                   Düz metin parola; sunucuda Argon2id hash'i ile karşılaştırılır.
 *                   Eksik veya string değilse "Parola zorunludur.", kısaysa
 *                   "Parola en az 6 karakter olmalıdır." mesajı döner.
 *                 example: "123456"
 *           example:
 *             username: camsa
 *             password: "123456"
 *     responses:
 *       200:
 *         description: >
 *           Kimlik doğrulama başarılı. Tokenlar gövdenin ÜST seviyesindedir
 *           (`data` zarfı yoktur).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *             examples:
 *               companyOwner:
 *                 summary: COMPANY_OWNER (siteName alanı YOK)
 *                 value:
 *                   success: true
 *                   message: PostgreSQL & Argon2id doğrulaması başarılı. JWT tokenlar üretildi.
 *                   accessToken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c3ItY2Ftc2Etb3duZXIifQ.SIGNATURE
 *                   refreshToken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI4NGUxIn0.SIGNATURE
 *                   tokenType: Bearer
 *                   expiresInSeconds: 900
 *                   user:
 *                     userId: usr-camsa-owner
 *                     tenantId: comp-camsa
 *                     username: camsa
 *                     role: COMPANY_OWNER
 *               siteManager:
 *                 summary: SITE_MANAGER (siteName alanı VAR)
 *                 value:
 *                   success: true
 *                   message: PostgreSQL & Argon2id doğrulaması başarılı. JWT tokenlar üretildi.
 *                   accessToken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ1c3ItZ2ViemUtbWdyIn0.SIGNATURE
 *                   refreshToken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJiMDIzIn0.SIGNATURE
 *                   tokenType: Bearer
 *                   expiresInSeconds: 900
 *                   user:
 *                     userId: usr-gebze-mgr
 *                     tenantId: comp-camsa
 *                     username: gebze-santiye
 *                     role: SITE_MANAGER
 *                     siteName: Gebze Ana Şantiye
 *       400:
 *         description: >
 *           Zod doğrulaması başarısız (`VALIDATION_ERROR`) — alan bazlı Türkçe mesajlar
 *           `errors` dizisinde döner. Zod dışı bir ayrıştırma hatasında aynı 400 durumuyla
 *           `errors` alanı olmadan `BAD_REQUEST` gövdesi döner (pratikte nadir), bu yüzden
 *           `errors` alanı ZORUNLU DEĞİLDİR.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationErrorResponse'
 *             examples:
 *               validationError:
 *                 summary: Zod alan hataları (validateMiddleware)
 *                 value:
 *                   success: false
 *                   error: VALIDATION_ERROR
 *                   message: Gelen istek verileri doğrulanamadı.
 *                   errors:
 *                     - field: username
 *                       message: Kullanıcı adı en az 3 karakter olmalıdır.
 *                     - field: password
 *                       message: Parola zorunludur.
 *               badRequest:
 *                 summary: Zod dışı ayrıştırma hatası (errors alanı yok)
 *                 value:
 *                   success: false
 *                   error: BAD_REQUEST
 *                   message: Girdi verileri okunamadı.
 *       401:
 *         description: >
 *           Kullanıcı adı bulunamadı VEYA Argon2id parola doğrulaması başarısız.
 *           İki durum da aynı gövdeyi döndürür.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: INVALID_CREDENTIALS
 *               message: Girilen kullanıcı adı veya şifre hatalı.
 *       500:
 *         description: >
 *           Veritabanı sorgusu veya Argon2id doğrulaması sırasında beklenmeyen hata
 *           (`DB_ERROR`). Bu uçta ham DB mesajı istemciye SIZDIRILMAZ, sabit bir metin
 *           döner ve `traceId` gövdede bulunmaz (yalnızca `X-Trace-ID` yanıt başlığında).
 *           Gövde geçersiz JSON ise istek handler'a hiç ulaşmaz; `globalErrorHandler`
 *           body-parser hatasını tanımadığı için `traceId` içeren `INTERNAL_SERVER_ERROR`
 *           gövdesiyle yine 500 döndürür (aslında 400 olmalıydı — bilinen sapma).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               dbError:
 *                 summary: Route içi catch (traceId yok)
 *                 value:
 *                   success: false
 *                   error: DB_ERROR
 *                   message: Veritabanı bağlantı hatası oluştu.
 *               malformedJson:
 *                 summary: Bozuk JSON gövdesi (globalErrorHandler, traceId var)
 *                 value:
 *                   success: false
 *                   traceId: 58f00403-b7ab-4aa2-9810-35fc340ce50c
 *                   error: INTERNAL_SERVER_ERROR
 *                   message: Sunucu tarafında beklenmeyen bir hata oluştu. Lütfen traceId ile sistem yöneticisine başvurun.
 */
router.post(
  '/auth/login',
  validateRequest({ body: loginSchema }),
  async (req: Request, res: Response) => {
    const { username, password } = req.body;
    const lowerUser = username.trim().toLowerCase();

    try {
      // Query PostgreSQL Database users table
      const dbRes = await pool.query(
        'SELECT id, tenant_id, username, password_hash, role, site_name FROM users WHERE LOWER(username) = $1',
        [lowerUser]
      );

      if (dbRes.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error: 'INVALID_CREDENTIALS',
          message: 'Girilen kullanıcı adı veya şifre hatalı.'
        });
      }

      const dbUser = dbRes.rows[0];

      // Verify Argon2id password hash against stored DB hash
      const isValidPassword = await verifyPassword(dbUser.password_hash, password);
      if (!isValidPassword) {
        return res.status(401).json({
          success: false,
          error: 'INVALID_CREDENTIALS',
          message: 'Girilen kullanıcı adı veya şifre hatalı.'
        });
      }

      const payload: JwtUserPayload = {
        userId: dbUser.id,
        tenantId: dbUser.tenant_id,
        username: dbUser.username,
        role: dbUser.role as UserRole,
        siteName: dbUser.site_name || undefined
      };

      const accessToken = generateAccessToken(payload);
      const refreshToken = generateRefreshToken(dbUser.id, dbUser.tenant_id);

      res.json({
        success: true,
        message: 'PostgreSQL & Argon2id doğrulaması başarılı. JWT tokenlar üretildi.',
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresInSeconds: 900,
        user: {
          userId: dbUser.id,
          tenantId: dbUser.tenant_id,
          username: dbUser.username,
          role: dbUser.role,
          siteName: dbUser.site_name || undefined
        }
      });
    } catch (err: any) {
      console.error('Login DB Error:', err);
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: 'Veritabanı bağlantı hatası oluştu.'
      });
    }
  }
);

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Refresh Token Rotasyonu (Tek Kullanımlık)
 *     description: |
 *       Geçerli bir refresh token karşılığında YENİ bir access token (900 sn) ve YENİ bir
 *       refresh token (7 gün) üretir. JWT ile korunmaz; yetkilendirme tamamen istek
 *       gövdesindeki `refreshToken` alanına dayanır.
 *
 *       **Kimlik nereden geliyor (services/tokenService.ts:149-183):**
 *       Yeni tokenların kimliği çağırandan DEĞİL, refresh tokenın kendi sunucu tarafı store
 *       kaydından ve o kayda göre yapılan taze bir `users` okumasından (`findAuthUserById`)
 *       türetilir. `rotateRefreshToken` artık payload argümanı almaz; route bir kimlik iddia
 *       edemez. Her rotasyonda satır yeniden okunduğu için rol/kiracı değişiklikleri en geç bir
 *       access token ömrü (15 dk) içinde yansır.
 *
 *       **Rotasyon ve hırsızlık tespiti (tokenService.ts:99-135):**
 *       - Sunulan token tek kullanımlıktır: imza doğrulandıktan sonra kayıt `used` ve
 *         `isRevoked` olarak işaretlenir, bir daha kullanılamaz. Bu adım tek bir senkron event
 *         loop turunda çalışır (check-then-act yarışı yok).
 *       - Token store'da yoksa ya da zaten kullanılmış/iptal edilmişse hırsızlık varsayılır:
 *         token içindeki `userId` için `revokeAllUserTokens()` çalışır ve 401
 *         `TOKEN_REUSE_DETECTED` döner.
 *       - İmzalı claim'ler (`userId`/`tenantId`) store kaydıyla uyuşmazsa (bozuk store veya
 *         sızmış `JWT_REFRESH_SECRET`) her iki kimliğin de tüm tokenları iptal edilir ve yine
 *         401 `TOKEN_REUSE_DETECTED` döner.
 *       - Token tüketildikten sonra kullanıcı satırı bulunamazsa (silinmiş kullanıcı) token
 *         bilinçli olarak yanmış bırakılır, tüm oturumlar iptal edilir ve 401
 *         `INVALID_REFRESH_TOKEN` döner. Mesaj kullanıcı varlığını sızdırmamak için geneldir.
 *
 *       **Diğer doğrulanmış davranışlar:**
 *       - Yanıtta `user` nesnesi YOKTUR; `POST /auth/login` yanıtından tek farkı budur.
 *       - Gövde Zod ile doğrulanmaz; yalnızca `refreshToken` truthy kontrolü yapılır
 *         (routes.ts:137). Eksik alan, `""`, `null`, `false`, `0` -> 400. String olmayan
 *         truthy değerler (örn. `123`) bu kontrolü geçer ve `jwt.verify` aşamasında
 *         401 `INVALID_REFRESH_TOKEN` üretir.
 *       - Rotasyon store'u süreç belleğindeki bir `Map`'tir, kalıcı değildir. Backend yeniden
 *         başlatıldığında tüm kayıtlar silinir; imzası hâlâ geçerli olan eski refresh tokenlar
 *         "store'da yok" sayılır ve 401 `INVALID_REFRESH_TOKEN` değil, 401
 *         `TOKEN_REUSE_DETECTED` alır. Çok örnekli (multi-instance) dağıtımda da rotasyon
 *         örnekler arasında paylaşılmaz; tek kullanımlık garantisi tek sürece bağlıdır.
 *       - 401 yanıtlarının `message` alanı `err.message` ham geçirildiği için hata kodunu
 *         metnin içinde tekrarlar ve `traceId` içermez.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: >
 *                   Daha önce `POST /auth/login` veya bu endpoint tarafından üretilmiş,
 *                   henüz kullanılmamış refresh token.
 *           example:
 *             refreshToken: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJhOWYzYzJkMS0...
 *     responses:
 *       200:
 *         description: >
 *           Rotasyon başarılı. Eski refresh token bu andan itibaren geçersizdir; istemci
 *           yanıttaki yeni `refreshToken` değerini saklamak zorundadır.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, message, accessToken, refreshToken, tokenType, expiresInSeconds]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Token rotasyonu başarılı. Yeni erişim ve yenileme tokenları üretildi.
 *                 accessToken:
 *                   type: string
 *                   description: >
 *                     Yeni JWT access token (15 dk). Taşıdığı `userId`, `tenantId`, `username`,
 *                     `role`, `siteName` değerleri veritabanından taze okunmuştur.
 *                 refreshToken:
 *                   type: string
 *                   description: Yeni tek kullanımlık refresh token (7 gün).
 *                 tokenType:
 *                   type: string
 *                   enum: [Bearer]
 *                   example: Bearer
 *                 expiresInSeconds:
 *                   type: integer
 *                   description: Sabit kodlu değer (routes.ts:157), access token ömrüyle uyumludur.
 *                   example: 900
 *       400:
 *         description: İstek gövdesinde `refreshToken` alanı yok veya falsy bir değer.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: MISSING_REFRESH_TOKEN
 *               message: İstek gövdesinde refreshToken alanı zorunludur.
 *       401:
 *         description: >
 *           Token imzası geçersiz / süresi dolmuş ya da tokenın sahibi artık mevcut değil
 *           (`INVALID_REFRESH_TOKEN`); veya token daha önce kullanılmış, iptal edilmiş,
 *           store'da bulunamamış ya da claim'leri store kaydıyla uyuşmuyor
 *           (`TOKEN_REUSE_DETECTED`). İlk durumun ikinci varyantında ve ikinci durumda ilgili
 *           kullanıcının tüm aktif oturumları iptal edilir.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               invalidToken:
 *                 summary: Geçersiz veya süresi dolmuş token
 *                 value:
 *                   success: false
 *                   error: INVALID_REFRESH_TOKEN
 *                   message: 'INVALID_REFRESH_TOKEN: Geçersiz veya süresi dolmuş refresh token.'
 *               userGone:
 *                 summary: Token tüketildi ancak kullanıcı satırı bulunamadı
 *                 value:
 *                   success: false
 *                   error: INVALID_REFRESH_TOKEN
 *                   message: 'INVALID_REFRESH_TOKEN: Oturumunuz geçersiz. Lütfen tekrar giriş yapınız.'
 *               tokenReuse:
 *                 summary: Tekrar kullanım tespiti - tüm oturumlar kapatıldı
 *                 value:
 *                   success: false
 *                   error: TOKEN_REUSE_DETECTED
 *                   message: 'TOKEN_REUSE_DETECTED: Şüpheli çoklu token kullanımı tespit edildi! Tüm aktif oturumlarınız güvenlik nedeniyle kapatıldı.'
 *       500:
 *         description: >
 *           İki ayrı kaynak: (a) rotasyon sırasında token dışı bir hata oluşursa (veritabanı
 *           kesintisi, bağlantı havuzunun tükenmesi) handler `DB_ERROR` döndürür - bu gövde
 *           `traceId` İÇERMEZ (routes.ts:167-174); (b) istek gövdesi geçerli JSON olarak
 *           ayrıştırılamazsa `express.json` hatası globalErrorHandler'ın son bloğuna düşer
 *           (400 yerine 500) ve yanıt `traceId` içerir.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               dbError:
 *                 summary: Rotasyon sırasında altyapı hatası
 *                 value:
 *                   success: false
 *                   error: DB_ERROR
 *                   message: Veritabanı bağlantı hatası oluştu.
 *               malformedJson:
 *                 summary: Ayrıştırılamayan istek gövdesi
 *                 value:
 *                   success: false
 *                   traceId: 58f00403-b7ab-4aa2-9810-35fc340ce50c
 *                   error: INTERNAL_SERVER_ERROR
 *                   message: Sunucu tarafında beklenmeyen bir hata oluştu. Lütfen traceId ile sistem yöneticisine başvurun.
 */
router.post('/auth/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'MISSING_REFRESH_TOKEN',
      message: 'İstek gövdesinde refreshToken alanı zorunludur.'
    });
  }

  try {
    // Identity is resolved inside the service from the refresh token's own
    // store record + a fresh DB read. The route must not - and now cannot -
    // supply one.
    const newTokens = await rotateRefreshToken(refreshToken);

    res.json({
      success: true,
      message: 'Token rotasyonu başarılı. Yeni erişim ve yenileme tokenları üretildi.',
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      tokenType: 'Bearer',
      expiresInSeconds: 900
    });
  } catch (err: any) {
    const message: string = err?.message || '';
    const isReuse = message.includes('TOKEN_REUSE_DETECTED');
    const isInvalid = message.includes('INVALID_REFRESH_TOKEN');

    // Anything else (DB outage, connection pool exhaustion...) is an
    // infrastructure failure, not a token problem. Mirror /auth/login's
    // 500 DB_ERROR instead of mislabelling it as an auth error.
    if (!isReuse && !isInvalid) {
      console.error('Refresh Rotation Error:', err);
      return res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: 'Veritabanı bağlantı hatası oluştu.'
      });
    }

    res.status(401).json({
      success: false,
      error: isReuse ? 'TOKEN_REUSE_DETECTED' : 'INVALID_REFRESH_TOKEN',
      message: message
    });
  }
});

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Oturum Kapatma (Refresh Token İptali)
 *     description: |
 *       Gövdede gönderilen `refreshToken` değerini bellek içi token deposunda iptal (revoke) eder.
 *       Kimlik doğrulaması GEREKTİRMEZ — bu route'ta `authenticateJWT` yoktur, bu yüzden
 *       kök seviyedeki `bearerAuth` gereksinimi `security: []` ile geçersiz kılınmıştır.
 *
 *       GERÇEK DAVRANIŞ (routes.ts:177-187, tokenService.ts:135-145) — dokümanla kod arasında
 *       fark olmaması için aşağıdakiler olduğu gibi belgelenmiştir:
 *
 *       - İstek gövdesi tamamen OPSİYONELDİR. `refreshToken` gönderilmezse hiçbir iptal
 *         yapılmaz; yanıt yine `200` ve yine "yenileme tokenı iptal edildi" mesajıdır.
 *         Yanıt mesajı, iptalin gerçekten olup olmadığını YANSITMAZ.
 *       - Token geçersiz, süresi dolmuş veya imzası hatalıysa `revokeRefreshToken` içindeki
 *         `jwt.verify` hatası sessizce yutulur (boş catch) → yine `200` döner.
 *         Bu uç hiçbir zaman `400` veya `401` üretmez; tamamen idempotenttir.
 *       - İmzası geçerli bir token gönderilse bile, tokenın `jti` değeri süreç belleğindeki
 *         depoda bulunamazsa hiçbir şey yapılmaz (tokenService.ts:138-141) — yine `200`.
 *       - Doğrulama (Zod) şeması YOKTUR. Sadece `refreshToken` alanının truthy olup olmadığına
 *         bakılır; tip, uzunluk veya biçim kontrolü yapılmaz.
 *       - İptal kaydı süreç belleğindeki bir `Map` üzerinde tutulur (tokenService.ts:32).
 *         Sunucu yeniden başlarsa tüm depo sıfırlanır; birden fazla instance çalışıyorsa
 *         iptal diğer instance'lara yayılmaz.
 *       - ACCESS TOKEN İPTAL EDİLMEZ. JWT stateless doğrulanır ve kara liste yoktur;
 *         eldeki `accessToken` kalan ömrü (900 sn) boyunca geçerli kalmaya devam eder.
 *       - Sahiplik kontrolü yoktur: refresh token dizesini bilen herkes, kimlik doğrulaması
 *         olmadan o tokenı iptal edebilir.
 *     security: []
 *     requestBody:
 *       required: false
 *       description: "Gövde opsiyoneldir; boş gövde (`{}`) veya hiç gövde göndermemek de 200 döner."
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: >-
 *                   POST /auth/login veya POST /auth/refresh ile alınmış refresh token.
 *                   Gönderilmezse istek yine başarılı sayılır, ancak hiçbir token iptal edilmez.
 *                 example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5ZjNiMWEyYy00ZDVlLTRmNmEtOGI3Yy0xZDJlM2Y0YTViNmMiLCJ1c2VySWQiOiJ1c3ItY2Ftc2Etb3duZXIifQ.s1gn4tur3"
 *           example:
 *             refreshToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI5ZjNiMWEyYy00ZDVlLTRmNmEtOGI3Yy0xZDJlM2Y0YTViNmMiLCJ1c2VySWQiOiJ1c3ItY2Ftc2Etb3duZXIifQ.s1gn4tur3"
 *     responses:
 *       200:
 *         description: >-
 *           İstek işlendi. Geçerli ve depoda kayıtlı bir token gönderildiyse iptal edilmiştir;
 *           token gönderilmediyse, geçersizse veya depoda yoksa hiçbir işlem yapılmamıştır.
 *           Yanıt gövdesi her durumda birebir aynıdır.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessMessage'
 *             example:
 *               success: true
 *               message: "Oturum kapatıldı ve yenileme tokenı iptal edildi."
 *       500:
 *         description: >-
 *           Handler'ın kendisi hata üretmez (senkron kod, dış bağımlılık yok). Bu kod yalnızca
 *           istek gövdesi bozuk JSON olduğunda veya gövde `express.json()` boyut sınırını
 *           (varsayılan 100kb) aştığında oluşur: body-parser hatası `globalErrorHandler`
 *           içindeki catch-all dalına düşer ve 400 yerine 500 olarak döner
 *           (errorHandler.ts, AppError/ZodError dışındaki son blok).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               traceId: "58f00403-b7ab-4aa2-9810-35fc340ce50c"
 *               error: "INTERNAL_SERVER_ERROR"
 *               message: "Sunucu tarafında beklenmeyen bir hata oluştu. Lütfen traceId ile sistem yöneticisine başvurun."
 */
router.post('/auth/logout', (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    revokeRefreshToken(refreshToken);
  }

  res.json({
    success: true,
    message: 'Oturum kapatıldı ve yenileme tokenı iptal edildi.'
  });
});

/**
 * @swagger
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Oturum Açmış Kullanıcının Kimlik Bilgileri
 *     description: >
 *       Geçerli bir access token ile çağrıldığında, token içindeki kullanıcı
 *       claim'lerini geri döndürür.
 *
 *
 *       DAVRANIŞ NOTLARI (GET /auth/me handler kodundan doğrulanmıştır):
 *
 *
 *       1. Bu uç VERİTABANINA GİTMEZ. Yanıt tamamen JWT access token içinden
 *       çözülen claim'lerden üretilir (authenticateJWT ara katmanının doldurduğu
 *       req.user). Kullanıcının rolü, şantiyesi veya hesabı veritabanında
 *       değiştirilse ya da silinse bile bu uç, token süresi (15 dk) dolana kadar
 *       ESKİ değerleri döndürmeye devam eder. Canlı yetki/hesap doğrulaması için
 *       kullanılamaz.
 *
 *
 *       2. Rol kontrolü YOKTUR. Zincirde yalnızca authenticateJWT vardır,
 *       authorizeRoles kullanılmaz; her rol (SUPER_ADMIN, COMPANY_OWNER,
 *       SITE_MANAGER, PUMP_OPERATOR, DRIVER) erişebilir ve bu uç 403 DÖNDÜRMEZ.
 *
 *
 *       3. Yanıt zarfı `{ success, message, user }` biçimindedir. Diğer uçlardaki
 *       `data` alanı burada YOKTUR; kullanıcı bilgisi `user` altında gelir.
 *
 *
 *       4. `user.siteName` KOŞULLU bir alandır. Değer, giriş sırasında users
 *       tablosundaki site_name sütunundan token'a yazılır; yalnızca bu sütunu
 *       dolu olan hesaplarda (tipik olarak SITE_MANAGER) döner. COMPANY_OWNER
 *       gibi hesapların yanıtında alan hiç bulunmaz (undefined olduğu için
 *       JSON.stringify tarafından atılır). Zorunlu kabul edilmemelidir.
 *
 *
 *       5. Token'ın `iat` / `exp` alanları verifyAccessToken içinde yanıta
 *       taşınmaz; bu uçta token geçerlilik süresi bilgisi yoktur.
 *
 *
 *       6. Handler senkrondur; try/catch, veritabanı ya da başka I/O içermez.
 *       Bu uçtan 500 DB_ERROR üretilmez.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: >
 *           Token geçerli; token içindeki kullanıcı claim'leri döndürüldü.
 *           (Kullanıcının veritabanında hâlâ var olduğu DOĞRULANMAMIŞTIR.)
 *         headers:
 *           X-Trace-ID:
 *             description: >
 *               traceMiddleware tarafından her yanıta eklenen korelasyon kimliği.
 *               İstemci X-Trace-ID başlığı gönderirse o değer korunur, aksi halde
 *               yeni bir UUID v4 üretilir.
 *             schema:
 *               type: string
 *               example: 63efeccf-5ac9-4076-9bd0-2c18f4cecae9
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, message, user]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Kimlik bilgileri doğrulandı.
 *                 user:
 *                   $ref: '#/components/schemas/AuthUser'
 *             examples:
 *               companyOwner:
 *                 summary: COMPANY_OWNER — siteName alanı YOK
 *                 value:
 *                   success: true
 *                   message: Kimlik bilgileri doğrulandı.
 *                   user:
 *                     userId: usr-camsa-owner
 *                     tenantId: comp-camsa
 *                     username: camsa
 *                     role: COMPANY_OWNER
 *               siteManager:
 *                 summary: SITE_MANAGER — siteName alanı VAR
 *                 value:
 *                   success: true
 *                   message: Kimlik bilgileri doğrulandı.
 *                   user:
 *                     userId: usr-gebze-mgr
 *                     tenantId: comp-camsa
 *                     username: gebze-santiye
 *                     role: SITE_MANAGER
 *                     siteName: Gebze Ana Şantiye
 *       401:
 *         description: >
 *           Kimlik doğrulanamadı. İki farklı hata kodu üretilebilir -
 *           `UNAUTHORIZED` (Authorization başlığı yok ya da "Bearer " ön ekiyle
 *           başlamıyor) ve `INVALID_TOKEN` (imza geçersiz veya token süresi dolmuş).
 *           Bu gövdelerde `traceId` alanı BULUNMAZ; izleme kimliği yalnızca
 *           X-Trace-ID yanıt başlığındadır.
 *         headers:
 *           X-Trace-ID:
 *             description: İstek korelasyon kimliği (hata gövdesinde tekrarlanmaz).
 *             schema:
 *               type: string
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               missingHeader:
 *                 summary: Authorization başlığı yok / Bearer öneki eksik
 *                 value:
 *                   success: false
 *                   error: UNAUTHORIZED
 *                   message: Erişim engellendi. Geçerli bir Authorization Bearer token gereklidir.
 *               invalidToken:
 *                 summary: Token bozuk veya süresi dolmuş
 *                 value:
 *                   success: false
 *                   error: INVALID_TOKEN
 *                   message: Oturum süreniz doldu veya geçersiz token. Lütfen tekrar giriş yapınız.
 */
router.get('/auth/me', authenticateJWT, (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    message: 'Kimlik bilgileri doğrulandı.',
    user: req.user
  });
});

/**
 * @swagger
 * /sites:
 *   get:
 *     tags: [Sites]
 *     summary: Şantiye Listesi
 *     description: Firmaya ait sistemde kayıtlı olan (kullanıcılar, tanklar, araçlar, şoförler üzerinden çıkarılan) tüm benzersiz şantiyeleri listeler.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Şantiye listesi başarıyla getirildi.
 */
router.get('/sites', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sites = await getTenantSites();
    res.json({
      success: true,
      data: sites
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'DB_ERROR',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /sites:
 *   post:
 *     tags: [Sites]
 *     summary: Yeni Şantiye Ekle (upsert)
 *     description: >
 *       Oturum açmış firmaya (tenant) ait `sites` tablosuna yeni bir şantiye kaydeder.
 *       `tenant_id` daima JWT içindeki bağlamdan alınır; gövdeden gönderilemez ve PostgreSQL
 *       RLS ile zorlanır.
 *
 *       DAVRANIŞ NOTLARI (gerçek kod davranışı):
 *
 *       1. UPSERT'tir, saf INSERT değildir. SQL `ON CONFLICT (tenant_id, name) DO UPDATE SET
 *       location = EXCLUDED.location` kullanır. Aynı ada sahip bir şantiye zaten varsa 409
 *       DÖNMEZ; mevcut kaydın `location` alanı güncellenir ve yanıtta MEVCUT kaydın orijinal
 *       `id` ve `created_at` değerleri döner (istek sırasında üretilen yeni `site-<epoch_ms>`
 *       kimliği atılır). İşlem bu yüzden idempotenttir, ancak `message` alanı her iki durumda
 *       da "başarıyla eklendi" der - güncelleme yapıldığı bilgisini vermez.
 *
 *       2. Başarıda HTTP 200 döner, 201 Created DEĞİL. `Location` başlığı da gönderilmez.
 *
 *       3. `siteName` sunucuda `.trim()` edilir ve trim edilmiş hali kaydedilir.
 *       Yalnızca boşluk karakterlerinden oluşan bir değer 400 ile reddedilir.
 *
 *       4. `location` HİÇ doğrulanmaz. Falsy ise (alan yok, boş string, null, 0, false)
 *       sunucu `'Türkiye'` atar. Tip kontrolü yoktur; string olmayan bir değer doğrudan
 *       PostgreSQL'e gider.
 *
 *       5. Uzunluk sınırı uygulama katmanında YOKTUR. DB kısıtları `name VARCHAR(128)` ve
 *       `location VARCHAR(255)`; aşılırsa 500 DB_ERROR olarak ham PostgreSQL hata metniyle
 *       döner (bkz. 500 yanıtı).
 *
 *       6. Eklenen şantiye `GET /sites` listesinde görünür (o uç `sites`, `users`, `tanks`,
 *       `vehicles`, `drivers` tablolarının UNION'unu döndürür).
 *
 *       7. İstek gövdesi camelCase (`siteName`), yanıt gövdesi ham DB satırı olduğu için
 *       snake_case'dir (`name`, `tenant_id`, `created_at`).
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       description: >
 *         Yalnızca `siteName` zorunludur ve tek doğrulaması "truthy + string + trim sonrası boş
 *         değil" kontrolüdür (Zod kullanılmaz). `location` opsiyoneldir, doğrulanmaz ve
 *         gönderilmezse `'Türkiye'` olur. Tanımsız ek alanlar yok sayılır (destructuring).
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateSiteRequest'
 *           examples:
 *             tamGovde:
 *               summary: Konum ile birlikte
 *               value:
 *                 siteName: "Kocaeli 2. Şantiye"
 *                 location: "Kocaeli / Gebze"
 *             sadeceAd:
 *               summary: Yalnızca ad (location varsayılan 'Türkiye' olur)
 *               value:
 *                 siteName: "Silivri Tesisleri"
 *     responses:
 *       200:
 *         description: >
 *           Şantiye eklendi VEYA aynı adlı şantiye zaten mevcut olduğu için konumu güncellendi.
 *           Her iki durumda da 200 ve aynı gövde şekli döner.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   description: Şantiye adı gövdeye enterpole edilir; upsert durumunda da aynı metin döner.
 *                   example: "'Kocaeli 2. Şantiye' şantiyesi veritabanına başarıyla eklendi."
 *                 data:
 *                   $ref: '#/components/schemas/Site'
 *             example:
 *               success: true
 *               message: "'Kocaeli 2. Şantiye' şantiyesi veritabanına başarıyla eklendi."
 *               data:
 *                 id: "site-1757268144351"
 *                 tenant_id: "comp-camsa"
 *                 name: "Kocaeli 2. Şantiye"
 *                 location: "Kocaeli / Gebze"
 *                 created_at: "2026-09-07T18:22:24.351Z"
 *       400:
 *         description: >
 *           `siteName` eksik, string değil ya da trim sonrası boş (VALIDATION_ERROR).
 *           DİKKAT - bu uç Zod/validateRequest kullanmaz, bu yüzden gövdede `errors` dizisi
 *           BULUNMAZ; şekil sade ErrorResponse'tur.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: "VALIDATION_ERROR"
 *               message: "Geçerli bir şantiye adı giriniz."
 *       401:
 *         description: >
 *           Authorization başlığı yok veya 'Bearer ' önekiyle başlamıyor (UNAUTHORIZED),
 *           ya da token geçersiz/süresi dolmuş (INVALID_TOKEN).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: "INVALID_TOKEN"
 *               message: "Oturum süreniz doldu veya geçersiz token. Lütfen tekrar giriş yapınız."
 *       403:
 *         description: >
 *           Token geçerli ancak rol yetersiz. Yalnızca SUPER_ADMIN ve COMPANY_OWNER bu ucu
 *           çağırabilir; SITE_MANAGER, PUMP_OPERATOR ve DRIVER reddedilir.
 *           Mesaj, izinli rol listesini dinamik olarak içerir.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: "FORBIDDEN"
 *               message: "Yetkisiz erişim. Bu işlemi gerçekleştirme yetkiniz bulunmamaktadır. (Gerekli Rol: SUPER_ADMIN, COMPANY_OWNER)"
 *       500:
 *         description: >
 *           Veritabanı hatası; işlem ROLLBACK edilir. Tipik nedenler - `name` 128 veya
 *           `location` 255 karakteri aşması, string olmayan `location` tipi, bağlantı havuzu
 *           hatası. Ayrıca JWT içinde tenantId yoksa `createTenantSite` TENANT_CONTEXT_MISSING
 *           fırlatır ve aynı 500 DB_ERROR gövdesiyle döner. Route kendi catch bloğunu
 *           kullandığı için gövdede `traceId` YOKTUR ve `message` ham PostgreSQL hata metnini içerir (bilinen bilgi sızıntısı).
 *           İzleme için `X-Trace-ID` yanıt başlığına bakınız.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: "DB_ERROR"
 *               message: "value too long for type character varying(128)"
 */
router.post(
  '/sites',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { siteName, location } = req.body;
      if (!siteName || typeof siteName !== 'string' || !siteName.trim()) {
        return res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Geçerli bir şantiye adı giriniz.'
        });
      }

      const trimmedSiteName = siteName.trim();
      const newSite = await createTenantSite(trimmedSiteName, location || 'Türkiye');

      res.json({
        success: true,
        message: `'${trimmedSiteName}' şantiyesi veritabanına başarıyla eklendi.`,
        data: newSite
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /sites/{siteName}:
 *   delete:
 *     tags: [Sites]
 *     summary: Şantiye Sil
 *     description: |
 *       Firmaya ait bir şantiyeyi `sites` tablosundan siler ve o şantiyeye bağlı kayıtları
 *       TEK bir veritabanı transaction'ı içinde yeniden atar. Bağlı kayıtlar SİLİNMEZ:
 *
 *       - `vehicles.site_name` -> `'Atanmadı'`
 *       - `drivers.site_name`  -> `'Atanmadı'`
 *       - `tanks.site_name`    -> `'Atanmadı'`
 *       - `users.site_name`    -> `NULL`
 *
 *       Kiracı izolasyonu PostgreSQL RLS ile sağlanır (`SET LOCAL ROLE app_user` +
 *       `app.current_tenant_id`). SQL'de ayrıca `tenant_id` filtresi YOKTUR; izolasyon
 *       tamamen beş tablonun da üzerinde tanımlı `FORCE ROW LEVEL SECURITY` politikalarına
 *       dayanır (schema.sql:111-152), bu nedenle başka bir firmanın şantiyesi bu uçtan
 *       etkilenemez.
 *
 *       GERÇEK DAVRANIŞ NOTLARI (koddan doğrulanmıştır):
 *
 *       - **404 DÖNMEZ.** Var olmayan bir şantiye adı için `DELETE ... WHERE name = $1`
 *         sıfır satır etkiler, `deleteTenantSite()` koşulsuz `true` döner ve uç yine
 *         **200** + "başarıyla silindi" mesajı üretir. Uç idempotenttir ve yanıt,
 *         gerçekten silinen satır sayısını bildirmez.
 *       - Silmeden sonra `GET /sites` çıktısında bu ad kaybolur, ancak yeniden atanan
 *         araç/şoför/tank kayıtları yüzünden listede **`Atanmadı`** adlı yeni bir giriş
 *         belirebilir (`GET /sites`, beş tablonun UNION'ı üzerinden türetilir).
 *       - İstek gövdesi okunmaz; gövde gönderilse bile tamamen yok sayılır.
 *       - Yol parametresi Express tarafından zaten çözüldükten (decode) sonra handler
 *         içinde `decodeURIComponent` ile **ikinci kez** çözülür (routes.ts:285).
 *         Bu yüzden `%` karakteri içeren şantiye adları bu uçla silinemez; ayrıntı için
 *         500 yanıtına bakınız.
 *       - Koddaki `400 VALIDATION_ERROR` dalı pratikte ERİŞİLEMEZDİR: Express
 *         `/sites/:siteName` rotası boş yol parçasıyla eşleşmez, `DELETE /sites/`
 *         isteği bu operasyona hiç ulaşmadan router seviyesindeki 404 NOT_FOUND'a düşer.
 *       - Uçta hiçbir uzunluk/biçim doğrulaması yoktur. `sites.name` sütunu `VARCHAR(128)`
 *         olduğundan 128 karakterden uzun bir ad hiçbir kayıtla eşleşemez; istek yine de
 *         reddedilmez, 200 döner.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: siteName
 *         required: true
 *         description: >
 *           Silinecek şantiyenin ADI (id değil). URL kodlaması uygulanmalıdır
 *           (örn. "Silivri Tesisleri" -> "Silivri%20Tesisleri"). Çift decode hatası
 *           nedeniyle adında "%" karakteri geçen şantiyeler bu uçla silinemez.
 *         schema:
 *           type: string
 *         example: Silivri Tesisleri
 *     responses:
 *       200:
 *         description: >
 *           İşlem tamamlandı. Şantiye kaydı hiç bulunmasa bile bu yanıt döner (idempotent).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessMessage'
 *             example:
 *               success: true
 *               message: "'Silivri Tesisleri' şantiyesi veritabanından başarıyla silindi."
 *       401:
 *         description: >
 *           Authorization başlığı yok veya "Bearer " ile başlamıyor (UNAUTHORIZED);
 *           ya da token geçersiz / süresi dolmuş (INVALID_TOKEN).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: UNAUTHORIZED
 *               message: Erişim engellendi. Geçerli bir Authorization Bearer token gereklidir.
 *       403:
 *         description: >
 *           Rol yetersiz. Bu ucu yalnızca SUPER_ADMIN ve COMPANY_OWNER çağırabilir;
 *           SITE_MANAGER ve PUMP_OPERATOR reddedilir.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: FORBIDDEN
 *               message: 'Yetkisiz erişim. Bu işlemi gerçekleştirme yetkiniz bulunmamaktadır. (Gerekli Rol: SUPER_ADMIN, COMPANY_OWNER)'
 *       500:
 *         description: |
 *           İki ayrı gövde şekli vardır:
 *
 *           1. **`DB_ERROR`** — route içi `catch` bloğundan gelir: veritabanı/transaction
 *              hatası (transaction ROLLBACK edilir), eksik tenant bağlamı
 *              (`TENANT_CONTEXT_MISSING`) veya `%25` ile kodlanmış (yani gerçek `%`
 *              içeren) bir addan doğan ikinci decode `URIError`'ı. Ham hata metni
 *              `message` alanına olduğu gibi yazılır (DB detayı sızabilir) ve bu yanıtta
 *              `traceId` BULUNMAZ; route içi catch globalErrorHandler'ı atlar.
 *           2. **`INTERNAL_SERVER_ERROR`** — yol parçası hatalı yüzde kodlaması içeriyorsa
 *              (örn. sonu `%` ile biten ham URL) Express'in kendi `decode_param` adımı
 *              handler'a hiç girmeden hata fırlatır. globalErrorHandler bunu bilinmeyen
 *              istisna olarak ele alır, `traceId` ekler ve genel mesaj döner
 *              (Express'in `status = 400` işareti dikkate ALINMAZ).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             examples:
 *               dbError:
 *                 summary: Route içi catch (traceId yok)
 *                 value:
 *                   success: false
 *                   error: DB_ERROR
 *                   message: URI malformed
 *               unhandled:
 *                 summary: Express decode hatası (globalErrorHandler)
 *                 value:
 *                   success: false
 *                   traceId: 8f3c1e0a-4b2d-4f11-9c3e-77a0d2b5e901
 *                   error: INTERNAL_SERVER_ERROR
 *                   message: Sunucu tarafında beklenmeyen bir hata oluştu. Lütfen traceId ile sistem yöneticisine başvurun.
 */
router.delete(
  '/sites/:siteName',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { siteName } = req.params;
      if (!siteName) {
        return res.status(400).json({
          success: false,
          error: 'VALIDATION_ERROR',
          message: 'Şantiye adı gereklidir.'
        });
      }

      const decodedSiteName = decodeURIComponent(siteName);
      await deleteTenantSite(decodedSiteName);

      res.json({
        success: true,
        message: `'${decodedSiteName}' şantiyesi veritabanından başarıyla silindi.`
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /vehicles:
 *   get:
 *     tags: [Vehicles]
 *     summary: Araç Listesi
 *     description: RLS kurallarına göre oturum açmış firmanın araçlarını getirir.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Araç listesi başarıyla getirildi.
 */
router.get('/vehicles', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const vehicles = await getTenantVehicles();
    const store = getTenantStore();

    res.json({
      success: true,
      tenantId: store?.tenantId || req.user?.tenantId,
      totalCount: vehicles.length,
      data: vehicles
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'DB_ERROR',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /vehicles:
 *   post:
 *     tags: [Vehicles]
 *     summary: Yeni Araç Ekle
 *     description: >
 *       Oturum açmış firmanın (tenant) araç filosuna yeni bir araç kaydeder.
 *       `tenant_id` yalnızca JWT içindeki değerden alınır; istek gövdesinden okunmaz.
 *       INSERT işlemi `SET LOCAL ROLE app_user` + `app.current_tenant_id` ile RLS
 *       koruması altında çalışır.
 *
 *
 *       GERÇEK DAVRANIŞ NOTLARI (kod ile birebir):
 *
 *
 *       1. Başarıda **201 değil 200** döner (`res.json`, açık durum kodu yok).
 *
 *       2. `fuelCapacityLiters` doğrulama için ZORUNLUDUR, ancak kaydedilmez.
 *       `vehicles` tablosunda böyle bir sütun yoktur; handler'daki `vehicleData`
 *       eşlemesi bu alanı INSERT'e hiç aktarmaz — değer sessizce atılır ve
 *       yanıtta da görünmez.
 *
 *       3. `status` oluşturma sırasında GÖNDERİLEMEZ. Zod şeması bilinmeyen
 *       anahtarları sessizce siler (`validateRequest` `req.body`'yi parse
 *       sonucuyla değiştirir), bu yüzden `sanitizedBody.status` daima
 *       `undefined` olur ve kayıt her zaman `AKTİF` durumuyla açılır.
 *       (`site_name` snake_case varyantı da aynı sebeple hiç okunamaz;
 *       yalnızca camelCase `siteName` işe yarar.)
 *
 *       4. `type` gönderilmezse Zod tarafından `Kamyon` olarak doldurulur ve
 *       DB'ye `vehicle_type` sütununa yazılır. Değer bir enum'a karşı
 *       doğrulanmaz.
 *
 *       5. `siteName` gönderilmezse `Gebze Ana Şantiye` atanır. Değer mevcut
 *       şantiyelere karşı DOĞRULANMAZ; serbest metin olduğu gibi yazılır ve
 *       `GET /sites` bu sütunu UNION ile taradığı için sonrasında listede
 *       yeni bir şantiye gibi görünür (`sites` tablosuna satır EKLENMEZ).
 *
 *       6. Yanıttaki `data`, `RETURNING *` sonucu olan HAM DB satırıdır:
 *       alan adları snake_case'dir ve `created_at` DAHİLDİR. Not: `GET /vehicles`
 *       satırları elle map'lediği için `created_at` alanını DÜŞÜRÜR — aynı kaynağın
 *       iki ucu farklı alan kümesi döndürür.
 *
 *       7. `plate` ve `rfid_tag` üzerinde UNIQUE kısıtı yoktur; aynı plaka
 *       birden çok kez eklenebilir, hata dönmez.
 *
 *
 *       Gerekli rol: SUPER_ADMIN, COMPANY_OWNER veya SITE_MANAGER.
 *       SITE_MANAGER kendi şantiyesiyle sınırlandırılmaz; herhangi bir
 *       `siteName` değeri gönderebilir.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateVehicleRequest'
 *           example:
 *             plate: 34 CTP 82
 *             brandModel: Volvo FMX 460 Damperli
 *             type: Kamyon
 *             rfidTag: TAG-882910
 *             fuelCapacityLiters: 400
 *             siteName: Gebze Ana Şantiye
 *     responses:
 *       200:
 *         description: >
 *           Araç kaydedildi. (201 değil 200 döner.) `data` alanı `RETURNING *`
 *           ile gelen ham `vehicles` satırıdır.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, message, data]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Araç başarıyla doğrulandı ve kaydedildi.
 *                 data:
 *                   $ref: '#/components/schemas/Vehicle'
 *             example:
 *               success: true
 *               message: Araç başarıyla doğrulandı ve kaydedildi.
 *               data:
 *                 id: veh-1788805324772
 *                 tenant_id: comp-camsa
 *                 plate: 34 CTP 82
 *                 brand_model: Volvo FMX 460 Damperli
 *                 vehicle_type: Kamyon
 *                 rfid_tag: TAG-882910
 *                 site_name: Gebze Ana Şantiye
 *                 status: AKTİF
 *                 created_at: '2026-09-07T18:22:04.772Z'
 *       400:
 *         description: >
 *           Zod doğrulaması başarısız (validateMiddleware). Gövde
 *           `errors: [{field, message}]` dizisi içerir — global hata
 *           işleyicinin `details` alanı BU uçta kullanılmaz.
 *           Sık görülen durumlar: geçersiz plaka formatı, `brandModel` < 2 karakter,
 *           `rfidTag` < 3 karakter, eksik veya pozitif olmayan `fuelCapacityLiters`.
 *           DİKKAT: `fuelCapacityLiters` sayısal STRING olarak gönderilirse
 *           (`"400"`) coerce YOKTUR ve mesaj yanıltıcı biçimde
 *           `Yakıt kapasitesi zorunludur.` olur.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationErrorResponse'
 *             example:
 *               success: false
 *               error: VALIDATION_ERROR
 *               message: Gelen istek verileri doğrulanamadı.
 *               errors:
 *                 - field: plate
 *                   message: 'Geçersiz Türkiye plaka formatı. (Örn: 34 CTP 82)'
 *                 - field: fuelCapacityLiters
 *                   message: Yakıt kapasitesi zorunludur.
 *       401:
 *         description: >
 *           `Authorization: Bearer ...` başlığı yok veya `Bearer ` ile başlamıyor
 *           (`UNAUTHORIZED`), ya da token geçersiz/süresi dolmuş (`INVALID_TOKEN`).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: INVALID_TOKEN
 *               message: Oturum süreniz doldu veya geçersiz token. Lütfen tekrar giriş yapınız.
 *       403:
 *         description: >
 *           Token geçerli ancak rol yetersiz (ör. PUMP_OPERATOR).
 *           Mesaj izin verilen rol listesini dinamik olarak içerir.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: FORBIDDEN
 *               message: 'Yetkisiz erişim. Bu işlemi gerçekleştirme yetkiniz bulunmamaktadır. (Gerekli Rol: SUPER_ADMIN, COMPANY_OWNER, SITE_MANAGER)'
 *       500:
 *         description: >
 *           Veritabanı hatası. Route kendi `catch` bloğunda yanıtı yazar:
 *           `error: DB_ERROR` ve `message` alanında HAM PostgreSQL hata metni
 *           döner (`traceId` YOKTUR — global hata işleyici bu yolda devrede değildir).
 *           Bilinen tetikleyiciler: VARCHAR taşması (brand_model>128,
 *           vehicle_type>64, rfid_tag>64, site_name>128 karakter — Zod bu üst
 *           sınırları kontrol etmez; `plate` regex ile en fazla 11 karaktere
 *           sınırlandığı için taşamaz), `id` çakışması (`veh- + Date.now()`;
 *           aynı milisaniyede iki kayıt birincil anahtar ihlali verir) ve
 *           `TENANT_CONTEXT_MISSING`.
 *           AYRI DURUM: gövde bozuk JSON ise hata route'a hiç ulaşmaz;
 *           `express.json` hatayı global işleyiciye düşürür ve yanıt
 *           `error: INTERNAL_SERVER_ERROR` + `traceId` biçiminde olur.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: DB_ERROR
 *               message: value too long for type character varying(128)
 */
router.post(
  '/vehicles',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  validateRequest({ body: createVehicleSchema }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sanitizedBody = req.body;
      const vehicleData = {
        plate: sanitizedBody.plate,
        brand_model: sanitizedBody.brandModel,
        vehicle_type: sanitizedBody.type,
        rfid_tag: sanitizedBody.rfidTag,
        site_name: sanitizedBody.siteName || sanitizedBody.site_name || 'Gebze Ana Şantiye',
        status: sanitizedBody.status || 'AKTİF'
      };

      const newVehicle = await createVehicle(vehicleData);

      res.json({
        success: true,
        message: 'Araç başarıyla doğrulandı ve kaydedildi.',
        data: newVehicle
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /vehicles/{id}:
 *   put:
 *     tags:
 *       - Vehicles
 *     summary: Araç Güncelle
 *     description: >
 *       Var olan bir aracın bilgilerini kısmi olarak günceller (PATCH benzeri davranış).
 *       Sadece gövdede gönderilen ve truthy olan alanlar güncellenir; gönderilmeyen alanlar
 *       mevcut değerlerini korur. Kiracı izolasyonu PostgreSQL RLS ile sağlanır
 *       (vehicles_tenant_isolation_policy / app.current_tenant_id).
 *       Gerekli rol: SUPER_ADMIN, COMPANY_OWNER veya SITE_MANAGER.
 *
 *
 *       DOĞRULAMA YOKTUR (routes.ts:387): Bu uçta hiçbir Zod şeması çalıştırılmaz.
 *       createVehicleSchema yalnızca POST /vehicles üzerinde uygulanır, bu nedenle
 *       Türkiye plaka regex'i GÜNCELLEMEDE DOĞRULANMAZ - plate alanına herhangi bir metin
 *       yazılabilir (tek sınır VARCHAR(32)). rfidTag için de uzunluk kontrolü yapılmaz.
 *       Create/update arasındaki bu asimetri bilerek belgelenmiştir.
 *
 *
 *       TRUTHY FİLTRESİ: Alanlar `...(x && { ... })` kalıbıyla toplanır. Boş string ("")
 *       veya null gönderilen alan SESSİZCE yok sayılır - bir alanı boşaltmak mümkün değildir.
 *
 *
 *       BOŞ GÖVDE 400 DEĞİL 500 DÖNER: Hiçbir güncellenebilir alan gönderilmezse
 *       (`{}` veya yalnızca bilinmeyen alanlar) updateVehicle (tenantDb.ts:225)
 *       "Güncellenecek alan bulunamadı." hatası fırlatır; route'un catch bloğu bunu
 *       500 DB_ERROR olarak döner.
 *
 *
 *       BULUNAMAYAN ARAÇ 404 DEĞİL 500 DÖNER: Kayıt yoksa ya da RLS politikası satırı
 *       başka bir kiracıya ait olduğu için gizliyorsa UPDATE 0 satır etkiler ve
 *       "Araç bulunamadı veya yetkiniz yok." hatası yine 500 DB_ERROR olarak yanıtlanır.
 *       Bu uç HİÇBİR ZAMAN 404 üretmez.
 *
 *
 *       KABUL EDİLMEYEN ALAN: fuelCapacityLiters - POST /vehicles'ta zorunlu olmasına
 *       rağmen burada hiç okunmaz ve vehicles tablosunda karşılığı yoktur.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: >
 *           Güncellenecek aracın birincil anahtarı (vehicles.id, VARCHAR(64)).
 *           createVehicle tarafından "veh-<epoch_ms>" biçiminde üretilir.
 *           Sunucu tarafında biçim doğrulaması yapılmaz.
 *         schema:
 *           type: string
 *         example: veh-1757268144351
 *     requestBody:
 *       required: true
 *       description: >
 *         Tüm alanlar opsiyoneldir, ancak en az biri truthy olmalıdır (aksi halde 500 DB_ERROR).
 *         İstek gövdesi camelCase, yanıt ise snake_case DB satırıdır. Listelenmeyen alanlar
 *         (ör. fuelCapacityLiters, id, tenant_id, created_at) sessizce yok sayılır.
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: >
 *               Sunucu tarafında Zod doğrulaması YOKTUR; buradaki kısıtlar yalnızca
 *               veritabanı sütun tiplerinden (schema.sql) türetilmiştir.
 *             properties:
 *               plate:
 *                 type: string
 *                 maxLength: 32
 *                 description: >
 *                   Araç plakası. DİKKAT - POST /vehicles'taki plaka regex'i burada
 *                   UYGULANMAZ; doğrulanmamış herhangi bir metin kabul edilir.
 *                   32 karakteri aşarsa PostgreSQL hatası 500 DB_ERROR olarak döner.
 *                 example: 34 CTP 82
 *               brandModel:
 *                 type: string
 *                 maxLength: 128
 *                 description: vehicles.brand_model sütununa yazılır.
 *                 example: Volvo FMX 460 Damperli
 *               type:
 *                 type: string
 *                 maxLength: 64
 *                 description: vehicles.vehicle_type sütununa yazılır (alan adı farklıdır).
 *                 example: Kamyon
 *               rfidTag:
 *                 type: string
 *                 maxLength: 64
 *                 description: >
 *                   vehicles.rfid_tag sütununa yazılır. Benzersizlik kısıtı yoktur;
 *                   aynı etiket birden fazla araca atanabilir.
 *                 example: TAG-882910
 *               siteName:
 *                 type: string
 *                 maxLength: 128
 *                 description: >
 *                   vehicles.site_name sütununa yazılır. Şantiyenin sites tablosunda
 *                   gerçekten var olup olmadığı KONTROL EDİLMEZ (yabancı anahtar yoktur).
 *                 example: Gebze Ana Şantiye
 *               status:
 *                 type: string
 *                 maxLength: 32
 *                 description: >
 *                   Serbest metin; enum kısıtı yoktur. Uygulamada kullanılan değerler
 *                   AKTİF, PASİF, BAKIMDA.
 *                 example: AKTİF
 *           example:
 *             plate: 34 CTP 82
 *             brandModel: Volvo FMX 460 Damperli
 *             siteName: Gebze Ana Şantiye
 *             status: BAKIMDA
 *     responses:
 *       200:
 *         description: >
 *           Araç güncellendi. data alanı UPDATE ... RETURNING * sonucudur; bu nedenle
 *           created_at DAHİL tüm sütunları snake_case olarak içerir. DİKKAT: GET /vehicles
 *           bundan FARKLIDIR - orada getTenantVehicles satırları elle map ettiği için
 *           created_at düşer. Vehicle şeması GET davranışını yansıtır.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Araç başarıyla güncellendi.
 *                 data:
 *                   $ref: '#/components/schemas/Vehicle'
 *       401:
 *         description: >
 *           Authorization başlığı yok veya "Bearer " öneki eksik (UNAUTHORIZED);
 *           token bozuk ya da süresi dolmuş (INVALID_TOKEN).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: INVALID_TOKEN
 *               message: Oturum süreniz doldu veya geçersiz token. Lütfen tekrar giriş yapınız.
 *       403:
 *         description: Rol yetersiz (authorizeRoles reddetti).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: FORBIDDEN
 *               message: >-
 *                 Yetkisiz erişim. Bu işlemi gerçekleştirme yetkiniz bulunmamaktadır.
 *                 (Gerekli Rol: SUPER_ADMIN, COMPANY_OWNER, SITE_MANAGER)
 *       500:
 *         description: >
 *           Bu uçtaki TEK hata gövdesi ailesi. Dört ayrı durum aynı 500 DB_ERROR kodunu üretir:
 *           (1) araç bulunamadı veya RLS gizledi - "Araç bulunamadı veya yetkiniz yok.";
 *           (2) güncellenecek alan yok - "Güncellenecek alan bulunamadı.";
 *           (3) token yükünde tenantId yok - "TENANT_CONTEXT_MISSING";
 *           (4) gerçek veritabanı hatası (uzunluk taşması vb.) - ham PostgreSQL metni
 *           message alanında istemciye sızar. Bu yanıtlarda traceId BULUNMAZ; izleme için
 *           her yanıtta gönderilen X-Trace-ID başlığı kullanılmalıdır. Ayrıca bozuk JSON
 *           gövdesi route'a hiç ulaşmadan globalErrorHandler'a düşer ve traceId'li
 *           INTERNAL_SERVER_ERROR üretir.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: DB_ERROR
 *               message: Araç bulunamadı veya yetkiniz yok.
 */
router.put(
  '/vehicles/:id',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = req.params.id;
      const { plate, brandModel, type, rfidTag, siteName, status } = req.body;
      const updateData = {
        ...(plate && { plate }),
        ...(brandModel && { brand_model: brandModel }),
        ...(type && { vehicle_type: type }),
        ...(rfidTag && { rfid_tag: rfidTag }),
        ...(siteName && { site_name: siteName }),
        ...(status && { status })
      };

      const updatedVehicle = await updateVehicle(id, updateData);

      res.json({
        success: true,
        message: 'Araç başarıyla güncellendi.',
        data: updatedVehicle
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /vehicles/{id}:
 *   delete:
 *     tags:
 *       - Vehicles
 *     summary: Araç Sil
 *     description: >
 *       Verilen `id` değerine sahip aracı, oturum açmış firmanın (tenant) RLS kapsamı
 *       içinde siler. İstek gövdesi okunmaz; tüm bilgi path parametresinden alınır.
 *
 *
 *       DİKKAT — Bu uç, silme işleminin gerçekleşip gerçekleşmediğini DOĞRULAMAZ.
 *       Katman, tek bir koşullu silme ifadesi çalıştırır ve etkilenen satır sayısını
 *       hiç kontrol etmez. Bu nedenle:
 *
 *
 *       * Var olmayan bir `id` gönderilirse yine 200 ve "başarıyla silindi" mesajı döner.
 *
 *       * Başka bir firmaya ait bir `id` gönderilirse RLS politikası
 *       (`vehicles_tenant_isolation_policy`, FOR ALL / USING) satırı gizler,
 *       hiçbir kayıt silinmez, ancak yanıt yine 200 olur.
 *
 *       * Sonuç olarak bu uç 404 DÖNMEZ ve 200 yanıtı bir kaydın gerçekten
 *       silindiğinin kanıtı değildir. İstemci, silme sonrası `GET /vehicles` ile
 *       listeyi tazelemelidir.
 *
 *
 *       İşlem idempotenttir: aynı `id` için tekrarlanan çağrılar hep 200 döner.
 *       Yanıt gövdesinde `data` alanı YOKTUR, yalnızca `success` ve `message` bulunur.
 *       `vehicles` tablosuna işaret eden yabancı anahtar bulunmadığından yayılan
 *       (cascade) bir yan etki oluşmaz.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: >
 *           Silinecek aracın birincil anahtarı (`vehicles.id`, VARCHAR(64)).
 *           Seed kayıtlarda `veh-1`, `veh-2`; API üzerinden oluşturulanlarda
 *           `veh-<epoch_ms>` biçimindedir. Doğrulanmaz; eşleşmezse yine 200 döner.
 *         schema:
 *           type: string
 *           maxLength: 64
 *         example: veh-1
 *     responses:
 *       200:
 *         description: >
 *           İstek işlendi. UYARI: Bu yanıt bir kaydın gerçekten silindiğini garanti
 *           etmez; eşleşen satır yoksa da 200 döner.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessMessage'
 *             example:
 *               success: true
 *               message: Araç kaydı başarıyla silindi.
 *       401:
 *         description: >
 *           Authorization başlığı yok veya `Bearer ` ile başlamıyor (`UNAUTHORIZED`);
 *           ya da token geçersiz/süresi dolmuş (`INVALID_TOKEN`).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: UNAUTHORIZED
 *               message: Erişim engellendi. Geçerli bir Authorization Bearer token gereklidir.
 *       403:
 *         description: >
 *           Token geçerli ancak rol yetersiz. İzinli roller: SUPER_ADMIN, COMPANY_OWNER,
 *           SITE_MANAGER. PUMP_OPERATOR ve DRIVER rolleri bu hatayı alır.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: FORBIDDEN
 *               message: 'Yetkisiz erişim. Bu işlemi gerçekleştirme yetkiniz bulunmamaktadır. (Gerekli Rol: SUPER_ADMIN, COMPANY_OWNER, SITE_MANAGER)'
 *       500:
 *         description: >
 *           Veritabanı/bağlantı hatası ya da tenant bağlamının okunamaması
 *           (`TENANT_CONTEXT_MISSING`). Route kendi catch bloğunda yanıtı yazdığı için
 *           gövdede `traceId` BULUNMAZ ve ham PostgreSQL hata metni `message` alanına
 *           sızar.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: DB_ERROR
 *               message: TENANT_CONTEXT_MISSING
 */
router.delete(
  '/vehicles/:id',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      await deleteVehicle(req.params.id);
      res.json({
        success: true,
        message: 'Araç kaydı başarıyla silindi.'
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /drivers:
 *   get:
 *     tags: [Drivers]
 *     summary: Şoför Listesi
 *     description: RLS kurallarına göre oturum açmış firmanın şoförlerini getirir.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Şoför listesi başarıyla getirildi.
 */
router.get('/drivers', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const drivers = await getTenantDrivers();
    const store = getTenantStore();

    res.json({
      success: true,
      tenantId: store?.tenantId || req.user?.tenantId,
      totalCount: drivers.length,
      data: drivers
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'DB_ERROR',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /drivers:
 *   post:
 *     tags: [Drivers]
 *     summary: Yeni Şoför Ekle
 *     description: Yeni şoför ekler.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Şoför başarıyla eklendi.
 */
router.post(
  '/drivers',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  validateRequest({ body: createDriverSchema }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, tcNo, phone, licenseType, rfidCardId, siteName, status } = req.body;
      const driverData = {
        name,
        tc_no: tcNo,
        phone,
        license_type: licenseType,
        rfid_card_id: rfidCardId,
        site_name: siteName || 'Gebze Ana Şantiye',
        status: status || 'AKTİF'
      };

      const newDriver = await createDriver(driverData);

      res.json({
        success: true,
        message: 'Şoför başarıyla kaydedildi.',
        data: newDriver
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /drivers/{id}:
 *   put:
 *     tags: [Drivers]
 *     summary: Şoför Güncelle
 *     description: Var olan bir şoförün bilgilerini günceller.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Şoför başarıyla güncellendi.
 */
router.put(
  '/drivers/:id',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  validateRequest({ body: updateDriverSchema }),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = req.params.id;
      const { name, tcNo, phone, licenseType, rfidCardId, siteName, status } = req.body;
      const updateData = {
        ...(name && { name }),
        ...(tcNo && { tc_no: tcNo }),
        ...(phone && { phone }),
        ...(licenseType && { license_type: licenseType }),
        ...(rfidCardId && { rfid_card_id: rfidCardId }),
        ...(siteName && { site_name: siteName }),
        ...(status && { status })
      };

      const updatedDriver = await updateDriver(id, updateData);

      res.json({
        success: true,
        message: 'Şoför başarıyla güncellendi.',
        data: updatedDriver
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /drivers/{id}:
 *   delete:
 *     tags: [Drivers]
 *     summary: Şoför Sil
 *     description: Var olan bir şoförü siler.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Şoför başarıyla silindi.
 */
router.delete(
  '/drivers/:id',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      await deleteDriver(req.params.id);
      res.json({
        success: true,
        message: 'Şoför kaydı başarıyla silindi.'
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /tanks:
 *   get:
 *     tags: [Tanks]
 *     summary: Tank Listesi
 *     description: RLS kurallarına göre oturum açmış firmanın tanklarını getirir.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tank listesi başarıyla getirildi.
 */
router.get('/tanks', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tanks = await getTenantTanks();
    const store = getTenantStore();

    res.json({
      success: true,
      tenantId: store?.tenantId || req.user?.tenantId,
      totalCount: tanks.length,
      data: tanks
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'DB_ERROR',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /tanks:
 *   post:
 *     tags: [Tanks]
 *     summary: Yeni Tank Ekle
 *     description: Yeni tank ekler.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tank başarıyla eklendi.
 */
router.post(
  '/tanks',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, capacityLiters, currentLevelLiters, fuelType, siteName, status } = req.body;
      const tankData = {
        name,
        capacity_liters: capacityLiters,
        current_level_liters: currentLevelLiters,
        fuel_type: fuelType || 'Motorin',
        site_name: siteName || 'Gebze Ana Şantiye',
        status: status || 'GÜVENLİ'
      };

      const newTank = await createTank(tankData);

      res.json({
        success: true,
        message: 'Tank başarıyla kaydedildi.',
        data: newTank
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /tanks/{id}:
 *   put:
 *     tags: [Tanks]
 *     summary: Tank Güncelle
 *     description: Var olan bir tankın bilgilerini günceller.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tank başarıyla güncellendi.
 */
router.put(
  '/tanks/:id',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const id = req.params.id;
      const { name, capacityLiters, currentLevelLiters, fuelType, siteName, status } = req.body;
      const updateData = {
        ...(name && { name }),
        ...(capacityLiters !== undefined && { capacity_liters: capacityLiters }),
        ...(currentLevelLiters !== undefined && { current_level_liters: currentLevelLiters }),
        ...(fuelType && { fuel_type: fuelType }),
        ...(siteName && { site_name: siteName }),
        ...(status && { status })
      };

      const updatedTank = await updateTank(id, updateData);

      res.json({
        success: true,
        message: 'Tank başarıyla güncellendi.',
        data: updatedTank
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /tanks/{id}:
 *   delete:
 *     tags: [Tanks]
 *     summary: Tank Sil
 *     description: Var olan bir tankı siler.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tank başarıyla silindi.
 */
router.delete(
  '/tanks/:id',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      await deleteTank(req.params.id);
      res.json({
        success: true,
        message: 'Tank kaydı başarıyla silindi.'
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * @swagger
 * /dispense:
 *   post:
 *     tags: [Dispense]
 *     summary: Yakıt İkmal İsteği Doğrulama (yalnızca doğrulama — kayıt YAPILMAZ)
 *     description: |
 *       Yakıt ikmal (dispense) isteğini JWT + rol + Zod katmanlarından geçirir ve
 *       temizlenmiş gövdeyi çağırana geri yansıtır.
 *
 *       **GERÇEK DAVRANIŞ — YANILTICI OLMAMASI İÇİN AÇIKÇA BELİRTİLİR:**
 *       Bu uç nokta bir ikmal işlemi GERÇEKLEŞTİRMEZ.
 *       - Veritabanına hiçbir kayıt yazılmaz; şemada bir `transactions` tablosu
 *         dahi tanımlı değildir (backend/src/db/schema.sql).
 *       - Tank seviyesi (`tanks.current_level_liters`) DÜŞÜRÜLMEZ.
 *       - `vehiclePlate` ve `rfidTag` veritabanındaki araç/şoför kayıtlarıyla
 *         KARŞILAŞTIRILMAZ; var olmayan bir plaka veya RFID de 200 döner.
 *       - Tank kapasitesi / mevcut seviye kontrolü yapılmaz; `amountLiters`
 *         tanktaki miktardan büyük olsa da istek başarılı sayılır.
 *       - `pumpCode` hiçbir donanımla eşleştirilmez.
 *       - SITE_MANAGER için şantiye (site) kısıtı uygulanmaz; rol kontrolü dışında
 *         kiracı/şantiye bazlı ek yetki denetimi yoktur.
 *
 *       Kısacası yanıt "istek biçimsel olarak geçerli" demektir; "yakıt verildi" demek değildir.
 *       Yanıt zarfı diğer uçlardan farklıdır: veri `data` altında değil `dispenseDetails`
 *       altında döner ve zarfa `tenantId` ile `operator` alanları eklenir.
 *
 *       Yetki: JWT zorunlu. İzinli roller — SUPER_ADMIN, COMPANY_OWNER, SITE_MANAGER, PUMP_OPERATOR.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       description: |
 *         Zod `dispenseRequestSchema` ile doğrulanır (backend/src/schemas/transactionSchema.ts).
 *         Bilinmeyen alanlar sessizce SİLİNİR (strip), yanıtta geri dönmez.
 *         `amountLiters` alanı `z.coerce.number()` kullandığı için sayısal STRING de
 *         kabul edilir ("120.5" → 120.5); boolean `true` ise 1 litreye dönüşür.
 *         `vehiclePlate` regex'i büyük/küçük harf duyarsızdır ("34 ctp 82" geçerlidir)
 *         ve boşluklar isteğe bağlıdır ("34CTP82" da geçerlidir).
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DispenseRequest'
 *           example:
 *             vehiclePlate: "34 CTP 82"
 *             rfidTag: "TAG-882910"
 *             amountLiters: 120.5
 *             pumpCode: "PMP-1"
 *     responses:
 *       200:
 *         description: >-
 *           İstek doğrulandı ve temizlenmiş gövde yankılandı. Bu yanıt bir ikmal
 *           işleminin gerçekleştiğini GÖSTERMEZ; veritabanına hiçbir şey yazılmaz.
 *           HTTP 201 kullanılmaz çünkü oluşturulan bir kaynak yoktur.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - success
 *                 - message
 *                 - tenantId
 *                 - operator
 *                 - dispenseDetails
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   description: Sabit metin. İşlemin yapıldığını değil, isteğin doğrulandığını bildirir.
 *                   example: "İkmal yetkilendirme isteği doğrulandı."
 *                 tenantId:
 *                   type: string
 *                   description: >-
 *                     AsyncLocalStorage tenant bağlamından okunur (authenticateJWT tarafından
 *                     doldurulur); yedek olarak JWT payload'ındaki tenantId kullanılır.
 *                     JwtUserPayload'da zorunlu olduğu için pratikte daima doludur.
 *                   example: comp-camsa
 *                 operator:
 *                   type: string
 *                   description: İsteği yapan kullanıcının JWT içindeki username değeri.
 *                   example: camsa
 *                 dispenseDetails:
 *                   type: object
 *                   description: >-
 *                     Zod tarafından temizlenmiş istek gövdesinin birebir yankısı.
 *                     Bilinmeyen alanlar silinmiştir; amountLiters daima number'a
 *                     dönüştürülmüş olarak döner. pumpCode gönderilmediyse alan yanıtta hiç bulunmaz.
 *                   required:
 *                     - vehiclePlate
 *                     - rfidTag
 *                     - amountLiters
 *                   properties:
 *                     vehiclePlate:
 *                       type: string
 *                       example: "34 CTP 82"
 *                     rfidTag:
 *                       type: string
 *                       example: "TAG-882910"
 *                     amountLiters:
 *                       type: number
 *                       format: double
 *                       example: 120.5
 *                     pumpCode:
 *                       type: string
 *                       example: "PMP-1"
 *             example:
 *               success: true
 *               message: "İkmal yetkilendirme isteği doğrulandı."
 *               tenantId: "comp-camsa"
 *               operator: "camsa"
 *               dispenseDetails:
 *                 vehiclePlate: "34 CTP 82"
 *                 rfidTag: "TAG-882910"
 *                 amountLiters: 120.5
 *                 pumpCode: "PMP-1"
 *       400:
 *         description: >-
 *           Zod doğrulaması başarısız (error = VALIDATION_ERROR); errors dizisi alan
 *           bazlı Türkçe mesajları taşır. Bu yanıt traceId İÇERMEZ, çünkü
 *           validateRequest hatayı kendi içinde yakalar ve globalErrorHandler'a düşmez.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ValidationErrorResponse'
 *             example:
 *               success: false
 *               error: VALIDATION_ERROR
 *               message: "Gelen istek verileri doğrulanamadı."
 *               errors:
 *                 - field: vehiclePlate
 *                   message: "Geçersiz Türkiye plaka formatı."
 *                 - field: rfidTag
 *                   message: "RFID etiketi en az 3 karakter olmalıdır."
 *                 - field: amountLiters
 *                   message: "Yakıt miktarı 0'dan büyük pozitif bir sayı olmalıdır."
 *       401:
 *         description: >-
 *           Authorization başlığı yok ya da "Bearer " ile başlamıyor (error = UNAUTHORIZED),
 *           veya token geçersiz / süresi dolmuş (error = INVALID_TOKEN).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: INVALID_TOKEN
 *               message: "Oturum süreniz doldu veya geçersiz token. Lütfen tekrar giriş yapınız."
 *       403:
 *         description: >-
 *           Rol yetersiz (error = FORBIDDEN). İzinli roller SUPER_ADMIN, COMPANY_OWNER,
 *           SITE_MANAGER ve PUMP_OPERATOR olduğundan, tanımlı roller arasında bu hatayı
 *           yalnızca DRIVER alır. Mesaj izinli rol listesini dinamik olarak içerir.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: FORBIDDEN
 *               message: "Yetkisiz erişim. Bu işlemi gerçekleştirme yetkiniz bulunmamaktadır. (Gerekli Rol: SUPER_ADMIN, COMPANY_OWNER, SITE_MANAGER, PUMP_OPERATOR)"
 *       500:
 *         description: >-
 *           Rota mantığından KAYNAKLANMAZ (handler'da try/catch yoktur ve veritabanına
 *           erişilmez). Pratikte yalnızca istek gövdesi geçerli JSON değilse oluşur:
 *           express.json() SyntaxError'ı globalErrorHandler'a düşer ve traceId taşıyan
 *           INTERNAL_SERVER_ERROR döner. Bilinen hata: bu durum aslında 400 dönmelidir.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               traceId: "58f00403-b7ab-4aa2-9810-35fc340ce50c"
 *               error: INTERNAL_SERVER_ERROR
 *               message: "Sunucu tarafında beklenmeyen bir hata oluştu. Lütfen traceId ile sistem yöneticisine başvurun."
 */
router.post(
  '/dispense',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR'),
  validateRequest({ body: dispenseRequestSchema }),
  async (req: AuthenticatedRequest, res: Response) => {
    const sanitizedBody = req.body;
    const store = getTenantStore();

    res.json({
      success: true,
      message: 'İkmal yetkilendirme isteği doğrulandı.',
      tenantId: store?.tenantId || req.user?.tenantId,
      operator: req.user?.username,
      dispenseDetails: sanitizedBody
    });
  }
);

/**
 * @swagger
 * /telemetry/hardware-data:
 *   post:
 *     tags: [Telemetry]
 *     summary: IoT Donanım Telemetri Girişi (HMAC-SHA256)
 *     description: >
 *       ESP32 / IoT sensörlerinden gelen telemetri paketlerini kabul eder. Bu uç JWT
 *       kullanmaz; AUTH-202 HMAC-SHA256 donanım kimlik doğrulamasıyla korunur
 *       (hardwareAuthMiddleware). Üç başlık da zorunludur ve birlikte (AND) doğrulanır.
 *       İmza HMAC_SHA256(cihazGizliAnahtari, "<X-Timestamp>.<ham HTTP gövdesi>") biçiminde
 *       hesaplanır ve hex olarak gönderilir. Normal akışta gövde yeniden serileştirilmez;
 *       express.json({ verify }) ile saklanan ham bayt dizisi (req.rawBody) imzalanır ve
 *       karşılaştırma crypto.timingSafeEqual ile yapılır. Content-Type application/json
 *       gönderilmezse req.rawBody oluşmaz ve sunucu imzayı JSON.stringify(req.body) yedeğine,
 *       yani literal "{}" metnine göre hesaplar - cihazlar bu başlığı daima göndermelidir.
 *       DAVRANIŞ UYARISI - yanıt metni "Telemetri kaydedildi." dese de handler
 *       (routes.ts:814-827) hiçbir kalıcılık işlemi yapmaz; veritabanına yazmaz, MQTT/Redis'e
 *       aktarmaz. Yalnızca doğrulanmış cihaz bilgisini ve gelen gövdeyi aynen geri yansıtır
 *       (echo). Gövde için şema doğrulaması (Zod) da yoktur.
 *     security: []
 *     parameters:
 *       - in: header
 *         name: X-Device-ID
 *         required: true
 *         description: Kayıtlı donanım kimliği (ESP32-PUMP-01, ESP32-TANK-01, ESP32-FLOW-ISR).
 *         schema:
 *           type: string
 *           example: ESP32-TANK-01
 *       - in: header
 *         name: X-Timestamp
 *         required: true
 *         description: >
 *           Milisaniye epoch veya Date ile ayrıştırılabilir ISO tarih. Sunucu saatinden
 *           30 saniyeden fazla sapması replay saldırısı sayılır. İmza girdisinin ilk
 *           bileşenidir; gönderilen metnin birebir kendisi imzalanır.
 *         schema:
 *           type: string
 *           example: '1757268144351'
 *       - in: header
 *         name: X-Hardware-Signature
 *         required: true
 *         description: HMAC-SHA256 imzası, küçük harfli hex (64 karakter).
 *         schema:
 *           type: string
 *           example: 9f1c2b7d4e5a6083bd11a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607
 *     requestBody:
 *       required: false
 *       description: >
 *         Serbest biçimli sensör yükü. Sunucu bu gövdeyi doğrulamaz, dönüştürmez ve saklamaz;
 *         yalnızca HMAC imzasının girdisi olarak kullanıp receivedData alanında geri döndürür.
 *         Gövde boş bırakılabilir (imza yine "<X-Timestamp>." üzerinden hesaplanır).
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *           example:
 *             tankId: tank-1
 *             levelLiters: 14830.5
 *             flowLitersPerMin: 42.7
 *             readAt: '2026-09-07T18:22:24.351Z'
 *     responses:
 *       200:
 *         description: >
 *           İmza doğrulandı ve istek kabul edildi. DİKKAT - veri kalıcı olarak KAYDEDİLMEZ;
 *           receivedData gönderilen gövdenin birebir kopyasıdır.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                 hardware:
 *                   type: object
 *                   description: hardwareAuthMiddleware tarafından doğrulanan cihaz bağlamı.
 *                   properties:
 *                     deviceId:
 *                       type: string
 *                     name:
 *                       type: string
 *                     siteName:
 *                       type: string
 *                     timestampMs:
 *                       type: integer
 *                       format: int64
 *                       description: X-Timestamp başlığının milisaniye epoch karşılığı.
 *                 receivedData:
 *                   type: object
 *                   additionalProperties: true
 *                   description: Gelen gövdenin işlenmemiş kopyası (kaydedilmez).
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                   description: Yanıtın üretildiği sunucu zamanı (ISO 8601).
 *             example:
 *               success: true
 *               message: 'Donanım HMAC-SHA256 doğrulaması başarılı. Telemetri kaydedildi.'
 *               hardware:
 *                 deviceId: ESP32-TANK-01
 *                 name: 'Gebze Ultrasonik Tank Probu #1'
 *                 siteName: 'Gebze Ana Şantiye'
 *                 timestampMs: 1757268144351
 *               receivedData:
 *                 tankId: tank-1
 *                 levelLiters: 14830.5
 *               timestamp: '2026-09-07T18:22:24.351Z'
 *       400:
 *         description: >
 *           INVALID_TIMESTAMP_FORMAT - X-Timestamp ne sayısal (ms epoch) ne de ayrıştırılabilir
 *           bir tarih. Bu uçtaki tek 400 durumudur (gövde Zod ile doğrulanmadığı için
 *           VALIDATION_ERROR üretilmez).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: INVALID_TIMESTAMP_FORMAT
 *               message: 'X-Timestamp geçerli bir milisaniye zaman damgası veya ISO tarihi olmalıdır.'
 *       401:
 *         description: >
 *           Donanım kimlik doğrulaması başarısız. Olası error kodları -
 *           MISSING_HARDWARE_HEADERS (üç başlıktan biri eksik),
 *           REPLAY_ATTACK_DETECTED (X-Timestamp sunucu saatinden 30 sn'den fazla sapıyor),
 *           UNAUTHORIZED_DEVICE (X-Device-ID kayıtlı cihaz listesinde yok),
 *           INVALID_HARDWARE_SIGNATURE (HMAC eşleşmedi veya imza hex değil).
 *           NOT - kodda tanımlı INVALID_SIGNATURE_FORMAT dalı erişilemezdir; Buffer.from(x, 'hex')
 *           Node.js'te istisna fırlatmaz, geçersiz karakterlerden itibaren sessizce keser, bu
 *           yüzden hex olmayan imzalar uzunluk uyuşmazlığına düşüp INVALID_HARDWARE_SIGNATURE döner.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               error: INVALID_HARDWARE_SIGNATURE
 *               message: 'Kriptografik imza doğrulaması başarısız. Veri manipüle edilmiş veya anahtar hatalı.'
 *       500:
 *         description: >
 *           INTERNAL_SERVER_ERROR - gövde ayrıştırılamadı (bozuk JSON ya da express.json
 *           varsayılan 100kb sınırının aşılması). Bu hata HMAC ara katmanından ÖNCE, gövde
 *           ayrıştırıcısında oluşur; globalErrorHandler bunları AppError/ZodError dışı kabul
 *           edip 413/400 yerine traceId ile 500 olarak döndürür. Handler'ın kendisi istisna üretmez.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               success: false
 *               traceId: 58f00403-b7ab-4aa2-9810-35fc340ce50c
 *               error: INTERNAL_SERVER_ERROR
 *               message: 'Sunucu tarafında beklenmeyen bir hata oluştu. Lütfen traceId ile sistem yöneticisine başvurun.'
 */
router.post(
  '/telemetry/hardware-data',
  hardwareAuthMiddleware,
  (req: Request, res: Response) => {
    const hardwareInfo = (req as any).authenticatedHardware;
    res.json({
      success: true,
      message: 'Donanım HMAC-SHA256 doğrulaması başarılı. Telemetri kaydedildi.',
      hardware: hardwareInfo,
      receivedData: req.body,
      timestamp: new Date().toISOString()
    });
  }
);

export default router;
