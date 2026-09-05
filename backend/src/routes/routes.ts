import { Router, Request, Response, NextFunction } from 'express';
import { getTenantStore } from '../context/tenantContext';
import { getTenantVehicles, createVehicle, updateVehicle, deleteVehicle, getTenantDrivers, createDriver, updateDriver, deleteDriver, getTenantTanks, createTank, updateTank, deleteTank, getTenantSites, createSiteWithManager, deleteTenantSite, getTenantCompanyProfile, getTenantTransactionsPaginated, createTransaction, getTenantCrossSitePermissions, createCrossSitePermission, updateCrossSitePermissionStatus, changeOwnPassword, getAuditLogs, authorizeDispenseRequest, finalizeDispenseSession, findTransactionByIdempotencyKey, createHardwareDevice, rotateHardwareDeviceSecret, blockHardwareDevice, unblockHardwareDevice, getTenantHardwareDevices, relocateHardwareDevice, createDeviceClaimCode, getTenantClaimCodes } from '../db/tenantDb';
import { getAllCompanies, createCompanyWithOwner, updateCompanyAdmin, getAllHardwareDevices, redeemDeviceClaimCode } from '../db/adminDb';
import { validateRequest } from '../middleware/validateMiddleware';
import { createVehicleSchema, updateVehicleSchema } from '../schemas/vehicleSchema';
import { createDriverSchema, updateDriverSchema } from '../schemas/driverSchema';
import { createTankSchema, updateTankSchema } from '../schemas/tankSchema';
import { dispenseRequestSchema, transactionQuerySchema } from '../schemas/transactionSchema';
import { dispenseRequestAuthSchema, dispenseHeartbeatSchema, dispenseFinalizeSchema } from '../schemas/dispenseSessionSchema';
import { createCrossSitePermissionSchema, updateCrossSitePermissionStatusSchema } from '../schemas/crossSiteSchema';
import { createCompanySchema, updateCompanySchema } from '../schemas/companySchema';
import { loginSchema, changePasswordSchema } from '../schemas/authSchema';
import { createSiteSchema } from '../schemas/siteSchema';
import { createHardwareDeviceSchema, relocateHardwareDeviceSchema, createDeviceClaimCodeSchema, claimDeviceSchema } from '../schemas/hardwareDeviceSchema';
import { verifyPassword } from '../utils/password';
import { NotFoundError } from '../utils/errors';
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
import { redisPool } from '../db/redisPool';
import { broadcastToTenant } from '../socket/socketServer';
import { logger } from '../utils/logger';
import { loginRateLimiter, refreshRateLimiter, hardwareRateLimiter } from '../middleware/rateLimitMiddleware';
import { checkLockout, recordFailedLogin, clearFailedLogins } from '../services/accountLockoutService';
import { runWithTenant } from '../context/tenantContext';
import { mqttService } from '../iot/mqttClient';
import * as dispenseSessionService from '../services/dispenseSessionService';

const router = Router();

/**
 * AUTH-201.4 AC: "SITE_MANAGER başka şantiyenin verisini sorgulayamamalıdır."
 * SUPER_ADMIN/COMPANY_OWNER için undefined döner (tüm şantiyeleri görürler);
 * SITE_MANAGER için kendi şantiyesine kısıtlar — istemcinin query/body'de
 * gönderdiği herhangi bir siteName'e değil, JWT'deki (giriş sırasında DB'den
 * okunan, sahtesi üretilemeyen) siteName'e göre.
 */
function siteScopeFor(user: JwtUserPayload): string | undefined {
  return user.role === 'SITE_MANAGER' ? user.siteName : undefined;
}

/**
 * @swagger
 * /health:
 *   get:
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
 * GET /api/v1/tenant-info
 * Returns AsyncLocalStorage context state for current request
 */
router.get('/tenant-info', (_req: Request, res: Response) => {
  const store = getTenantStore();
  res.json({
    success: true,
    message: 'AsyncLocalStorage context başarıyla okundu.',
    context: store
  });
});

/** AUTH-209: checkLockout/recordFailedLogin'in 3 çağrı noktasında da aynı 423 yanıtı üretmesi için. */
function respondAccountLocked(res: Response, remainingSeconds: number | undefined): void {
  res.status(423).json({
    success: false,
    error: 'ACCOUNT_LOCKED',
    message: `Çok fazla hatalı giriş denemesi nedeniyle hesap geçici olarak kilitlendi. Yaklaşık ${Math.ceil((remainingSeconds || 0) / 60)} dakika sonra tekrar deneyin.`
  });
}

/**
 * POST /api/v1/auth/login
 * User login querying PostgreSQL database, Argon2id verification, and JWT Token issuance
 */
router.post(
  '/auth/login',
  loginRateLimiter,
  validateRequest({ body: loginSchema }),
  async (req: Request, res: Response) => {
    const { username, password } = req.body;
    const lowerUser = username.trim().toLowerCase();

    try {
      // AUTH-209: hesap kilitliyse Argon2id'nin ~ms mertebesindeki CPU
      // maliyetine hiç girmeden erken çık — kilitli bir hesaba karşı hızlı
      // art arda istek atmak login ucunu bir DoS vektörüne çevirmesin.
      // Var olmayan bir kullanıcı adı da aynı yolu izler (aşağıdaki
      // recordFailedLogin çağrıları) — "kilitli" ile "yanlış şifre" yanıtları
      // arasındaki fark hangi kullanıcı adlarının gerçekten var olduğunu
      // sızdırmamalı.
      const lockStatus = await checkLockout(lowerUser);
      if (lockStatus.locked) {
        return respondAccountLocked(res, lockStatus.remainingSeconds);
      }

      // Query PostgreSQL Database users table
      const dbRes = await pool.query(
        'SELECT id, tenant_id, username, password_hash, role, site_name, must_change_password, temp_password_expires_at FROM users WHERE LOWER(username) = $1',
        [lowerUser]
      );

      if (dbRes.rows.length === 0) {
        const afterFailure = await recordFailedLogin(lowerUser);
        if (afterFailure.locked) {
          return respondAccountLocked(res, afterFailure.remainingSeconds);
        }
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
        const afterFailure = await recordFailedLogin(lowerUser);
        if (afterFailure.locked) {
          return respondAccountLocked(res, afterFailure.remainingSeconds);
        }
        return res.status(401).json({
          success: false,
          error: 'INVALID_CREDENTIALS',
          message: 'Girilen kullanıcı adı veya şifre hatalı.'
        });
      }

      await clearFailedLogins(lowerUser);

      // AUTH-204: geçici parola 72 saat sonra geçersiz olur (bkz.
      // db/tenantDb.ts createSiteWithManager) — parola doğru olsa bile süresi
      // dolmuş bir geçici parolayla giriş reddedilir; kullanıcı şirket
      // yöneticisinden yeni bir şantiye/hesap oluşturulmasını istemelidir
      // (henüz kendi kendine "yeni geçici parola iste" ucu yok).
      if (dbUser.must_change_password && dbUser.temp_password_expires_at && new Date(dbUser.temp_password_expires_at) < new Date()) {
        return res.status(401).json({
          success: false,
          error: 'TEMP_PASSWORD_EXPIRED',
          message: 'Geçici parolanızın süresi doldu. Yeni bir geçici parola için firma yöneticinizle iletişime geçin.'
        });
      }

      const payload: JwtUserPayload = {
        userId: dbUser.id,
        tenantId: dbUser.tenant_id,
        username: dbUser.username,
        role: dbUser.role as UserRole,
        siteName: dbUser.site_name || undefined,
        mustChangePassword: dbUser.must_change_password === true
      };

      const accessToken = generateAccessToken(payload);
      const refreshToken = await generateRefreshToken(dbUser.id, dbUser.tenant_id);

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
          siteName: dbUser.site_name || undefined,
          mustChangePassword: dbUser.must_change_password === true
        }
      });
    } catch (err: any) {
      logger.error({ err }, 'Login DB Error');
      res.status(500).json({
        success: false,
        error: 'DB_ERROR',
        message: 'Veritabanı bağlantı hatası oluştu.'
      });
    }
  }
);

/**
 * POST /api/v1/auth/refresh
 * Single-use JWT Refresh Token Rotation with Token Reuse Detection
 */
router.post('/auth/refresh', refreshRateLimiter, async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'MISSING_REFRESH_TOKEN',
      message: 'İstek gövdesinde refreshToken alanı zorunludur.'
    });
  }

  try {
    // Resolve the refresh token's real owner from PostgreSQL — rotateRefreshToken
    // calls this with the userId/tenantId taken from the verified token record,
    // so the caller can never dictate whose identity the new tokens carry.
    const newTokens = await rotateRefreshToken(refreshToken, async (userId, tenantId) => {
      const dbRes = await pool.query(
        'SELECT id, tenant_id, username, role, site_name, must_change_password FROM users WHERE id = $1 AND tenant_id = $2',
        [userId, tenantId]
      );
      if (dbRes.rows.length === 0) return null;

      const dbUser = dbRes.rows[0];
      const payload: JwtUserPayload = {
        userId: dbUser.id,
        tenantId: dbUser.tenant_id,
        username: dbUser.username,
        role: dbUser.role as UserRole,
        siteName: dbUser.site_name || undefined,
        // AUTH-204: yeniden okunuyor (eski token'daki değere güvenilmiyor) —
        // parola değiştirildikten sonra rotasyonla basılan yeni token'ın
        // hâlâ eski mustChangePassword:true taşımaması için.
        mustChangePassword: dbUser.must_change_password === true
      };
      return payload;
    });

    res.json({
      success: true,
      message: 'Token rotasyonu başarılı. Yeni erişim ve yenileme tokenları üretildi.',
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      tokenType: 'Bearer',
      expiresInSeconds: 900
    });
  } catch (err: any) {
    const isReuse = err.message.includes('TOKEN_REUSE_DETECTED');
    res.status(401).json({
      success: false,
      error: isReuse ? 'TOKEN_REUSE_DETECTED' : 'INVALID_REFRESH_TOKEN',
      message: err.message
    });
  }
});

/**
 * POST /api/v1/auth/logout
 * Revokes current refresh token
 */
router.post('/auth/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }

    res.json({
      success: true,
      message: 'Oturum kapatıldı ve yenileme tokenı iptal edildi.'
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * GET /api/v1/auth/me
 * Protected endpoint returning authenticated user profile & roles
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
 * /companies/me:
 *   get:
 *     summary: Oturum Açan Firmanın Profili
 *     description: >
 *       JWT'deki tenant'a ait firma bilgisini döndürür (ad, kod, vergi no, şehir,
 *       lisans, modüller, şantiyeler). SITE_MANAGER rolünde yalnızca kullanıcının
 *       kendi şantiyesi listelenir; COMPANY_OWNER tüm şantiyeleri görür.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Firma profili başarıyla getirildi.
 *       404:
 *         description: Tenant'a karşılık gelen firma bulunamadı.
 */
router.get('/companies/me', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const profile = await getTenantCompanyProfile({
      role: req.user?.role,
      siteName: req.user?.siteName
    });
    res.json({ success: true, data: profile });
  } catch (error: any) {
    if (error.message === 'COMPANY_NOT_FOUND') {
      return next(new NotFoundError('Oturum açan kullanıcının firma kaydı bulunamadı.'));
    }
    next(error);
  }
});

/**
 * @swagger
 * /companies:
 *   get:
 *     summary: Tüm Kiracı Firmalar (Süper Admin)
 *     description: >
 *       Platformdaki tüm firmaları (tenant'ları) tenant sınırı olmadan
 *       listeler. Yalnızca SUPER_ADMIN erişebilir — Geliştirici (Süper
 *       Admin) panelindeki "Tüm Firmalar" sayfası içindir.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Firma listesi başarıyla getirildi.
 */
router.get('/companies', authenticateJWT, authorizeRoles('SUPER_ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const companies = await getAllCompanies();
    res.json({ success: true, totalCount: companies.length, data: companies });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /companies:
 *   post:
 *     summary: Yeni Kiracı Firma Oluştur (Süper Admin)
 *     description: Yeni bir firma + ilk şantiyesi + COMPANY_OWNER giriş hesabını oluşturur.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Firma oluşturuldu.
 */
router.post(
  '/companies',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN'),
  validateRequest({ body: createCompanySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const newCompany = await createCompanyWithOwner(req.body);
      res.json({ success: true, message: 'Firma başarıyla oluşturuldu.', data: newCompany });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /companies/{id}:
 *   patch:
 *     summary: Firma Lisans/Modül Güncelle (Süper Admin)
 *     description: Bir firmanın lisans durumunu ve/veya modül izinlerini günceller.
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
 *         description: Firma güncellendi.
 */
router.patch(
  '/companies/:id',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN'),
  validateRequest({ body: updateCompanySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const updated = await updateCompanyAdmin(req.params.id, req.body);
      res.json({ success: true, message: 'Firma güncellendi.', data: updated });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /devices:
 *   get:
 *     summary: Kayıtlı IoT Donanımları (Süper Admin)
 *     description: >
 *       HMAC-SHA256 ile kayıtlı ESP32/debimetre cihazlarını, Redis'teki
 *       gerçek son bilinen bağlantı durumuyla (MQTT LWT/veri akışından)
 *       birlikte listeler. Hiç bağlanmamış bir cihaz OFFLINE görünür —
 *       bu, önceki mock veriden farklı olarak sistemin gerçek durumudur.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cihaz listesi başarıyla getirildi.
 */
router.get('/devices', authenticateJWT, authorizeRoles('SUPER_ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const registeredDevices = await getAllHardwareDevices();
    const devices = await Promise.all(
      registeredDevices.map(async (d) => {
        const status = await redisPool.getDeviceState(d.device_id);
        return {
          deviceCode: d.device_id,
          name: d.name,
          siteName: d.site_name,
          tenantId: d.tenant_id,
          registrationStatus: d.status,
          status
        };
      })
    );
    res.json({ success: true, totalCount: devices.length, data: devices });
  } catch (error: any) {
    next(error);
  }
});

/**
 * AUTH-202.3 — Cihaz Provisioning, Rotasyon ve Bloke Etme (kendi tenant'ı).
 * SUPER_ADMIN/COMPANY_OWNER dışındaki roller (SITE_MANAGER, PUMP_OPERATOR)
 * donanım kaydı yönetemez — bu, sahadaki fiziksel cihazların ait olduğu
 * güvenlik sınırıdır, günlük operasyon değil.
 */
const HARDWARE_DEVICE_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER'] as const;

/**
 * @swagger
 * /hardware-devices:
 *   get:
 *     summary: Kendi Tenant'ının Cihaz Kayıtları (AUTH-202.3)
 *     description: Secret'lar ASLA döndürülmez — yalnızca provisioning/rotasyon anında, tek seferlik.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cihaz listesi başarıyla getirildi.
 */
router.get('/hardware-devices', authenticateJWT, authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const devices = await getTenantHardwareDevices();
    res.json({ success: true, totalCount: devices.length, data: devices });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /hardware-devices:
 *   post:
 *     summary: Yeni Cihaz Provisioning (AUTH-202.3)
 *     description: >
 *       256-bit rastgele bir secret üretir, AES-256-GCM ile şifreleyip saklar.
 *       Üretilen secret yalnızca BU yanıtta düz metin olarak döner — bir daha
 *       asla geri okunamaz, cihaza güvenli bir kanaldan (QR/tek seferlik) aktarılmalıdır.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cihaz oluşturuldu, secret tek seferlik döndü.
 */
router.post(
  '/hardware-devices',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  validateRequest({ body: createHardwareDeviceSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { device, secret } = await createHardwareDevice(req.body);
      res.json({
        success: true,
        message: 'Cihaz kaydedildi. Secret yalnızca bu yanıtta gösterilecek, tekrar alınamaz.',
        data: { ...device, secret }
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /hardware-devices/{deviceId}/rotate-secret:
 *   post:
 *     summary: Cihaz Secret Rotasyonu (AUTH-202.3)
 *     description: >
 *       Yeni bir secret üretir; eski secret 24 saatlik bir geçiş penceresi
 *       boyunca da geçerli kalır (henüz komutu almamış cihazlar sahada
 *       kilitlenmesin diye). Yeni secret yalnızca bu yanıtta döner.
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema: { type: string }
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Secret rotasyonu tamamlandı.
 */
router.post(
  '/hardware-devices/:deviceId/rotate-secret',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { device, secret } = await rotateHardwareDeviceSecret(req.params.deviceId);
      res.json({
        success: true,
        message: 'Secret rotasyonu tamamlandı. Yeni secret yalnızca bu yanıtta gösterilecek.',
        data: { ...device, secret }
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /hardware-devices/{deviceId}/block:
 *   post:
 *     summary: Cihazı Bloke Et (AUTH-202.3)
 *     description: Sızıntı şüphesinde cihazın paketlerini anında (403) reddetmeye başlar.
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema: { type: string }
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cihaz bloke edildi.
 */
router.post(
  '/hardware-devices/:deviceId/block',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const device = await blockHardwareDevice(req.params.deviceId);
      res.json({ success: true, message: 'Cihaz bloke edildi.', data: device });
    } catch (error: any) {
      next(error);
    }
  }
);

router.post(
  '/hardware-devices/:deviceId/unblock',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const device = await unblockHardwareDevice(req.params.deviceId);
      res.json({ success: true, message: 'Cihazın bloku kaldırıldı.', data: device });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /hardware-devices/{deviceId}/relocate:
 *   post:
 *     summary: Cihazı Başka Şantiyeye Nakil Et (IOT-304)
 *     description: >
 *       Yalnızca cihazın GELECEKTEKİ site_name'ini günceller — geçmiş
 *       ikmal/denetim kayıtları kendi satırlarındaki site_name'i taşıdığından
 *       (canlı bir referans değil) bozulmaz.
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema: { type: string }
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cihaz nakledildi.
 */
router.post(
  '/hardware-devices/:deviceId/relocate',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  validateRequest({ body: relocateHardwareDeviceSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const device = await relocateHardwareDevice(req.params.deviceId, req.body.siteName);
      res.json({ success: true, message: 'Cihaz nakledildi.', data: device });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * IOT-304 — Cihaz Provisioning ve Eşleştirme (Device Claim) Akışı.
 * Ticket'ın "Teknik Yığın"ı NestJS + Drizzle + EMQX API (kimlik/ACL) + QR
 * üretimi öneriyor. Drizzle/NestJS yerine (kod tabanı geneliyle tutarlı)
 * raw-pg kullanıldı. EMQX'in HTTP Yönetim API'si üzerinden CİHAZ BAŞINA MQTT
 * kimlik bilgisi/ACL üretimi BİLİNÇLİ OLARAK YAPILMADI — bu proje şu anda
 * TÜM cihazlar (ve backend'in kendisi) için TEK bir paylaşılan MQTT
 * kullanıcı adı/şifresi kullanıyor (bkz. docker/emqx/entrypoint.sh); bunu
 * cihaz başına dinamik hale getirmek EMQX yönetim API'sine yeni bir servis
 * katmanı + docker-compose'a yeni bir admin API anahtarı eklemeyi gerektiren,
 * bu ticket'ın "Efor: S" etiketinin çok ötesinde ayrı bir altyapı işi —
 * ayrı bir ticket olarak ele alınmalı. Bunun yerine "eşleştirilmemiş cihaz
 * veri gönderememeli" AC'si HTTP/HMAC katmanında zaten TAM olarak sağlanıyor:
 * hardwareAuthMiddleware, hardware_devices'ta kaydı OLMAYAN bir device_id'yi
 * UNAUTHORIZED_DEVICE ile reddediyor — claim edilmemiş bir cihazın zaten
 * hiçbir secret'ı yok, bu yüzden geçerli bir HMAC üretemez.
 * QR üretimi de aynı gerekçeyle atlandı (bkz. tenantDb.ts createDeviceClaimCode
 * yorumu) — sunucu yalnızca kriptografik olarak güçlü kodu üretir/doğrular.
 */

/**
 * @swagger
 * /devices/claim-codes:
 *   post:
 *     summary: Yeni Cihaz Claim Kodu Üret (IOT-304)
 *     description: Tek kullanımlık, süreli (varsayılan 15dk) bir kod üretir.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Claim kodu oluşturuldu.
 */
router.post(
  '/devices/claim-codes',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  validateRequest({ body: createDeviceClaimCodeSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const claim = await createDeviceClaimCode(req.body);
      res.json({ success: true, message: 'Claim kodu oluşturuldu.', data: claim });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/devices/claim-codes',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const codes = await getTenantClaimCodes();
      res.json({ success: true, totalCount: codes.length, data: codes });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /devices/claim:
 *   post:
 *     summary: Claim Kodunu Tüketip Cihazı Eşleştir (IOT-304)
 *     description: >
 *       Kimlik doğrulaması YOK (JWT/HMAC) — cihazın henüz secret'ı yok, bu
 *       endpoint'in amacı tam olarak onu üretmek. Yetkilendirme, kodun
 *       kendisinin (yüksek entropili, tek kullanımlık, süreli) bilinmesiyle
 *       sağlanır. Secret yalnızca bu yanıtta döner.
 *     security: []
 *     responses:
 *       200:
 *         description: Cihaz eşleştirildi, secret tek seferlik döndü.
 */
router.post(
  '/devices/claim',
  hardwareRateLimiter,
  validateRequest({ body: claimDeviceSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { device, secret } = await redeemDeviceClaimCode(req.body);
      res.json({
        success: true,
        message: 'Cihaz başarıyla eşleştirildi. Secret yalnızca bu yanıtta gösterilecek, tekrar alınamaz.',
        data: {
          deviceId: device.device_id,
          name: device.name,
          siteName: device.site_name,
          serialNumber: device.serial_number,
          macAddress: device.mac_address,
          model: device.model,
          hardwareRevision: device.hardware_revision,
          secret
        }
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /sites:
 *   get:
 *     summary: Şantiye Listesi
 *     description: Firmaya ait sistemde kayıtlı olan (kullanıcılar, tanklar, araçlar, şoförler üzerinden çıkarılan) tüm benzersiz şantiyeleri listeler.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Şantiye listesi başarıyla getirildi.
 */
router.get('/sites', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const sites = await getTenantSites();
    res.json({
      success: true,
      data: sites
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/v1/sites
 * AUTH-204: Yeni şantiyeyi ve o şantiyenin SITE_MANAGER kullanıcısını
 * (okunabilir kullanıcı adı + tek seferlik gösterilen geçici parola) TEK
 * işlemde oluşturur.
 */
router.post(
  '/sites',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER'),
  validateRequest({ body: createSiteSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { siteName, location } = req.body;
      const provisioned = await createSiteWithManager(siteName, location || 'Türkiye');

      res.json({
        success: true,
        message: `'${siteName}' şantiyesi ve şantiye yöneticisi hesabı başarıyla oluşturuldu. Geçici parola yalnızca bu yanıtta gösterilir — kaydedin.`,
        data: {
          site: provisioned.site,
          manager: {
            username: provisioned.username,
            temporaryPassword: provisioned.temporaryPassword,
            passwordExpiresAt: provisioned.passwordExpiresAt
          }
        }
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/auth/change-password
 * AUTH-204: hem ilk girişte zorunlu değiştirme hem kullanıcının kendi
 * isteğiyle değiştirmesi için — authenticateJWT'nin
 * PASSWORD_CHANGE_GATE_ALLOWLIST'i bu ucu mustChangePassword=true iken de
 * geçirir. Başarılı değişiklikten sonra mustChangePassword:false taşıyan
 * taze bir token çifti döner — istemcinin yeniden login olmasına gerek yok.
 */
router.post(
  '/auth/change-password',
  authenticateJWT,
  validateRequest({ body: changePasswordSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { currentPassword, newPassword } = req.body;
      await changeOwnPassword(req.user!.userId, currentPassword, newPassword);

      const payload: JwtUserPayload = { ...req.user!, mustChangePassword: false };
      const accessToken = generateAccessToken(payload);
      const refreshToken = await generateRefreshToken(payload.userId, payload.tenantId);

      res.json({
        success: true,
        message: 'Parolanız başarıyla güncellendi.',
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresInSeconds: 900
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/sites/:siteName
 * Delete a site for the tenant in DB
 */
router.delete(
  '/sites/:siteName',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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
      next(error);
    }
  }
);

/**
 * @swagger
 * /vehicles:
 *   get:
 *     summary: Araç Listesi
 *     description: RLS kurallarına göre oturum açmış firmanın araçlarını getirir.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Araç listesi başarıyla getirildi.
 */
router.get('/vehicles', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const vehicles = await getTenantVehicles(siteScopeFor(req.user!));

    res.json({
      success: true,
      // authenticateJWT her zaman req.user.tenantId'yi (ve aynı değeri taşıyan
      // AsyncLocalStorage store'unu) JWT payload'undan set eder — ikisi asla
      // farklılaşmaz, o yüzden burada ayrıca getTenantStore() çağırıp
      // fallback yapmaya gerek yok.
      tenantId: req.user?.tenantId,
      totalCount: vehicles.length,
      data: vehicles
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/v1/vehicles
 * Protected endpoint requiring COMPANY_OWNER or SITE_MANAGER role
 */
router.post(
  '/vehicles',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  validateRequest({ body: createVehicleSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const sanitizedBody = req.body;
      const vehicleData = {
        plate: sanitizedBody.plate,
        brand_model: sanitizedBody.brandModel,
        vehicle_type: sanitizedBody.type,
        rfid_tag: sanitizedBody.rfidTag,
        site_name: sanitizedBody.siteName || sanitizedBody.site_name || 'Gebze Ana Şantiye',
        status: sanitizedBody.status || 'AKTİF',
        fuel_capacity_liters: sanitizedBody.fuelCapacityLiters ?? null,
        assigned_driver_name: sanitizedBody.assignedDriver ?? null
      };

      const newVehicle = await createVehicle(vehicleData);

      res.json({
        success: true,
        message: 'Araç başarıyla doğrulandı ve kaydedildi.',
        data: newVehicle
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * PUT /api/v1/vehicles/:id
 * Protected endpoint requiring COMPANY_OWNER or SITE_MANAGER role
 */
router.put(
  '/vehicles/:id',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  validateRequest({ body: updateVehicleSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const { plate, brandModel, type, rfidTag, siteName, status, fuelCapacityLiters, assignedDriver } = req.body;
      const updateData = {
        ...(plate && { plate }),
        ...(brandModel && { brand_model: brandModel }),
        ...(type && { vehicle_type: type }),
        ...(rfidTag && { rfid_tag: rfidTag }),
        ...(siteName && { site_name: siteName }),
        ...(status && { status }),
        ...(fuelCapacityLiters !== undefined && { fuel_capacity_liters: fuelCapacityLiters }),
        ...(assignedDriver !== undefined && { assigned_driver_name: assignedDriver })
      };

      const updatedVehicle = await updateVehicle(id, updateData);

      res.json({
        success: true,
        message: 'Araç başarıyla güncellendi.',
        data: updatedVehicle
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/vehicles/:id
 * Protected endpoint requiring COMPANY_OWNER or SITE_MANAGER role
 */
router.delete(
  '/vehicles/:id',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await deleteVehicle(req.params.id);
      res.json({
        success: true,
        message: 'Araç kaydı başarıyla silindi.'
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /drivers:
 *   get:
 *     summary: Şoför Listesi
 *     description: RLS kurallarına göre oturum açmış firmanın şoförlerini getirir.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Şoför listesi başarıyla getirildi.
 */
router.get('/drivers', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const drivers = await getTenantDrivers(siteScopeFor(req.user!));

    res.json({
      success: true,
      tenantId: req.user?.tenantId,
      totalCount: drivers.length,
      data: drivers
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /drivers:
 *   post:
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
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { name, tcNo, phone, licenseType, rfidCardId, siteName, status, assignedVehiclePlate } = req.body;
      const driverData = {
        name,
        tc_no: tcNo,
        phone,
        license_type: licenseType,
        rfid_card_id: rfidCardId,
        site_name: siteName || 'Gebze Ana Şantiye',
        status: status || 'AKTİF',
        assigned_vehicle_plate: assignedVehiclePlate
      };

      const newDriver = await createDriver(driverData);

      res.json({
        success: true,
        message: 'Şoför başarıyla kaydedildi.',
        data: newDriver
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /drivers/{id}:
 *   put:
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
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const { name, tcNo, phone, licenseType, rfidCardId, siteName, status, assignedVehiclePlate } = req.body;
      const updateData = {
        ...(name && { name }),
        ...(tcNo && { tc_no: tcNo }),
        ...(phone && { phone }),
        ...(licenseType && { license_type: licenseType }),
        ...(rfidCardId && { rfid_card_id: rfidCardId }),
        ...(siteName && { site_name: siteName }),
        ...(status && { status }),
        ...(assignedVehiclePlate !== undefined && { assigned_vehicle_plate: assignedVehiclePlate })
      };

      const updatedDriver = await updateDriver(id, updateData);

      res.json({
        success: true,
        message: 'Şoför başarıyla güncellendi.',
        data: updatedDriver
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /drivers/{id}:
 *   delete:
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
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await deleteDriver(req.params.id);
      res.json({
        success: true,
        message: 'Şoför kaydı başarıyla silindi.'
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /tanks:
 *   get:
 *     summary: Tank Listesi
 *     description: RLS kurallarına göre oturum açmış firmanın tanklarını getirir.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tank listesi başarıyla getirildi.
 */
router.get('/tanks', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const tanks = await getTenantTanks(siteScopeFor(req.user!));

    res.json({
      success: true,
      tenantId: req.user?.tenantId,
      totalCount: tanks.length,
      data: tanks
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /tanks:
 *   post:
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
  validateRequest({ body: createTankSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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
      next(error);
    }
  }
);

/**
 * @swagger
 * /tanks/{id}:
 *   put:
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
  validateRequest({ body: updateTankSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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
      next(error);
    }
  }
);

/**
 * @swagger
 * /tanks/{id}:
 *   delete:
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
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await deleteTank(req.params.id);
      res.json({
        success: true,
        message: 'Tank kaydı başarıyla silindi.'
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /dispense:
 *   post:
 *     summary: İkmal Kaydı Oluştur
 *     description: >
 *       Bir yakıt ikmalini kalıcı olarak kaydeder ve ilgili tankın seviyesini
 *       atomik olarak düşürür. Önceden bu endpoint DB'ye hiçbir şey yazmayan
 *       bir stub'dı (yalnızca success:true dönerdi).
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: İkmal kaydedildi.
 */
router.post(
  '/dispense',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR'),
  validateRequest({ body: dispenseRequestSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const b = req.body;
      const newTransaction = await createTransaction({
        site_name: b.siteName,
        vehicle_plate: b.vehiclePlate,
        driver_name: b.driverName ?? null,
        tank_name: b.tankName ?? null,
        amount_liters: b.amountLiters,
        flow_rate_lpm: b.flowRateLpm ?? null,
        pump_status: b.pumpStatus || 'TAMAMLANTI',
        type: b.type || 'Manuel',
        rfid_auth: b.rfidAuth ?? true
      });

      // FE-801: ikmal tamamlanır tamamlanmaz aynı kiracının diğer açık
      // panellerine (örn. Tank Durumu ekranı, başka bir kullanıcının
      // tarayıcısında) sayfa yenilenmeden anında yansısın diye canlı yayın.
      const tenantId = req.user?.tenantId;
      if (tenantId) {
        try {
          const freshTanks = await getTenantTanks();
          broadcastToTenant(tenantId, 'dispense:completed', { transaction: newTransaction, tanks: freshTanks });
        } catch (broadcastErr) {
          // Canlı yayın başarısız olsa bile ikmal kaydı zaten kalıcıdır —
          // bu bir best-effort bildirimdir, isteği başarısız kılmamalı.
          logger.warn({ err: broadcastErr }, '⚠️ [Socket.io] dispense:completed yayını başarısız oldu.');
        }
      }

      res.json({
        success: true,
        message: 'İkmal başarıyla kaydedildi.',
        data: newTransaction
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /transactions:
 *   get:
 *     summary: İkmal Geçmişi (FE-802 — sunucu taraflı sayfalama)
 *     description: RLS kurallarına göre oturum açmış firmanın ikmal geçmişini sayfalı ve filtreli olarak getirir.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 10, maximum: 100 }
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: siteName
 *         schema: { type: string }
 *       - in: query
 *         name: driverName
 *         schema: { type: string }
 *       - in: query
 *         name: pumpStatus
 *         schema: { type: string, enum: [TAMAMLANTI, DURDURULDU, ANOMALİ] }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [Otomatik, Manuel, Çapraz Şantiye] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: İkmal geçmişi sayfası başarıyla getirildi.
 */
router.get(
  '/transactions',
  authenticateJWT,
  validateRequest({ query: transactionQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as {
        page: number;
        pageSize: number;
        startDate?: string;
        endDate?: string;
        siteName?: string;
        driverName?: string;
        pumpStatus?: string;
        type?: string;
        search?: string;
      };

      const result = await getTenantTransactionsPaginated(q, siteScopeFor(req.user!));

      res.json({
        success: true,
        data: result.data,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          totalCount: result.totalCount,
          totalPages: result.totalPages,
          totalLiters: result.totalLiters
        }
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /cross-site-permissions:
 *   get:
 *     summary: Çapraz Şantiye İkmal Yetkileri (FUEL-402)
 *     description: Firmaya ait tüm çapraz şantiye ikmal yetkilerini listeler.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Yetki listesi başarıyla getirildi.
 */
router.get('/cross-site-permissions', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const permissions = await getTenantCrossSitePermissions();
    res.json({ success: true, totalCount: permissions.length, data: permissions });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /cross-site-permissions:
 *   post:
 *     summary: Çapraz Şantiye İkmal Yetkisi Oluştur (FUEL-402)
 *     description: >
 *       Bir aracın kendi şantiyesi dışında geçici olarak yakıt alabilmesi
 *       için kota tanımlar. POST /dispense bu kaydı kontrol edip
 *       kullanılan miktarı atomik olarak günceller.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Yetki oluşturuldu.
 */
router.post(
  '/cross-site-permissions',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  validateRequest({ body: createCrossSitePermissionSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const b = req.body;
      const newPermission = await createCrossSitePermission({
        vehicle_plate: b.vehiclePlate,
        driver_name: b.driverName ?? null,
        home_site: b.homeSite,
        target_site: b.targetSite,
        allowed_liters: b.allowedLiters,
        expiry_date: b.expiryDate
      });
      res.json({ success: true, message: 'Çapraz şantiye yetkisi oluşturuldu.', data: newPermission });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /cross-site-permissions/{id}:
 *   patch:
 *     summary: Çapraz Şantiye Yetki Durumunu Güncelle
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
 *         description: Durum güncellendi.
 */
router.patch(
  '/cross-site-permissions/:id',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  validateRequest({ body: updateCrossSitePermissionStatusSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const updated = await updateCrossSitePermissionStatus(req.params.id, req.body.status);
      res.json({ success: true, message: 'Yetki durumu güncellendi.', data: updated });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/telemetry/hardware-data
 * Protected by AUTH-202 HMAC-SHA256 Hardware Authentication Middleware
 * Receives verified telemetries from ESP32 & IoT sensors
 */
router.post(
  '/telemetry/hardware-data',
  hardwareRateLimiter,
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

/**
 * FUEL-401 — RFID-Tetiklemeli Otomatik İkmal Oturumu (Dispense Session
 * State Machine). Ticket'ın "Teknik Yığın" alanı NestJS + Drizzle + BullMQ
 * + ARCH-102 outbox öneriyor — bu kod tabanında hiçbiri kurulu değil.
 * Bunun yerine: Express route + raw-pg (tenantDb.ts) + Redis (TTL'li oturum,
 * bkz. services/dispenseSessionService.ts) + mevcut manuel setInterval
 * süpürücü (bkz. index.ts) deseni kullanıldı — kod tabanının geri kalanıyla
 * tutarlı, yeni bir bağımlılık eklemeden.
 *
 * Üçü de hardwareAuthMiddleware'den (HMAC-SHA256, AUTH-202) geçer — bu
 * yüzden JWT değil, cihazın kendi kimliği kullanılır. tenantDb.ts
 * fonksiyonları AsyncLocalStorage tenant context'i beklediğinden
 * (withTenant), her route kendi context'ini authenticatedHardware.tenantId
 * ile (bkz. hardwareAuthMiddleware.ts'teki REGISTERED_HARDWARE_DEVICES notu)
 * runWithTenant() ile açıkça kurar — mqttClient.ts'in MQTT topic'inden
 * tenantId çıkarıp aynısını yapmasının HTTP kanalındaki karşılığı.
 */

/**
 * @swagger
 * /dispense/request-auth:
 *   post:
 *     summary: FUEL-401.1 — RFID kartı okutulduğunda yetkilendirme zinciri
 *     description: >
 *       Kart aktif mi → sürücüye atanmış araç aktif mi → şantiye yetkisi/kota
 *       → tank seviyesi zincirini kontrol eder; başarılıysa AUTHORIZED
 *       durumunda yeni bir ikmal oturumu (Redis, TTL'li) açar. Reddedilirse
 *       details.error alanında makine-okunur bir kod döner (CARD_UNKNOWN,
 *       DRIVER_INACTIVE, NO_VEHICLE_ASSIGNED, VEHICLE_BLOCKED,
 *       NO_SITE_PERMISSION, QUOTA_EXHAUSTED, TANK_NOT_FOUND, TANK_LOW).
 *     security: []
 *     responses:
 *       200:
 *         description: Oturum yetkilendirildi (AUTHORIZED).
 */
router.post(
  '/dispense/request-auth',
  hardwareRateLimiter,
  hardwareAuthMiddleware,
  validateRequest({ body: dispenseRequestAuthSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    const hw = (req as any).authenticatedHardware as { deviceId: string; siteName: string; tenantId: string };
    try {
      const auth = await runWithTenant({ tenantId: hw.tenantId }, () =>
        authorizeDispenseRequest({
          rfidCardId: req.body.rfidCardId,
          tankName: req.body.tankName,
          deviceSiteName: hw.siteName
        })
      );

      const session = await dispenseSessionService.createSession({
        tenantId: hw.tenantId,
        siteName: auth.siteName,
        deviceId: hw.deviceId,
        vehiclePlate: auth.vehiclePlate,
        driverName: auth.driverName,
        tankName: auth.tankName,
        maxAllowedLiters: auth.maxAllowedLiters
      });

      broadcastToTenant(hw.tenantId, 'dispense:session', session);

      res.json({
        success: true,
        message: 'İkmal oturumu yetkilendirildi.',
        data: {
          sessionId: session.sessionId,
          state: session.state,
          vehiclePlate: session.vehiclePlate,
          driverName: session.driverName,
          maxAllowedLiters: session.maxAllowedLiters
        }
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /dispense/heartbeat:
 *   post:
 *     summary: FUEL-401.2/401.3 — Pompalama sırasında periyodik (5sn) durum bildirimi
 *     description: >
 *       İlk çağrıda oturumu AUTHORIZED'dan PUMPING'e geçirir. Sunucu, maksimum
 *       litre/süre aşımını burada da kontrol eder (cihazın kendi limitine
 *       KÖRÜ KÖRÜNE güvenmeyen ikinci savunma hattı) — aşım varsa cihaza
 *       FORCE_CUTOFF komutu döner VE aynı komutu MQTT üzerinden de yayınlar.
 *     security: []
 *     responses:
 *       200:
 *         description: Heartbeat işlendi; command alanı CONTINUE veya FORCE_CUTOFF olabilir.
 */
router.post(
  '/dispense/heartbeat',
  hardwareRateLimiter,
  hardwareAuthMiddleware,
  validateRequest({ body: dispenseHeartbeatSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    const hw = (req as any).authenticatedHardware as { deviceId: string; tenantId: string };
    try {
      const session = await dispenseSessionService.recordHeartbeat(
        hw.deviceId, req.body.sessionId, req.body.totalizerLiters, req.body.flowRateLpm
      );

      const limitCheck = await dispenseSessionService.checkLimits(session);
      if (limitCheck.exceeded) {
        await dispenseSessionService.forceAbort(hw.deviceId, 'TIMED_OUT');
        mqttService.publishCommand(hw.deviceId, 'FORCE_CUTOFF', { reason: limitCheck.reason, sessionId: session.sessionId });
        broadcastToTenant(hw.tenantId, 'dispense:session', { ...session, state: 'TIMED_OUT' });
        res.json({ success: true, command: 'FORCE_CUTOFF', reason: limitCheck.reason });
        return;
      }

      broadcastToTenant(hw.tenantId, 'dispense:session', session);
      res.json({ success: true, command: 'CONTINUE', state: session.state });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /dispense/finalize:
 *   post:
 *     summary: FUEL-401.4 — Oturumu sonlandırıp kalıcı ikmal kaydı oluşturur
 *     description: >
 *       Start/end totalizatör farkı asıl doğruluk kaynağıdır — cihazın kendi
 *       bildirdiği reportedLiters yalnızca %1'lik bir sapma toleransı için
 *       karşılaştırılır, doğrudan güvenilmez. idempotencyKey ile aynı
 *       isteğin tekrarı yeni bir kayıt YARATMAZ. TIMED_OUT bir oturumdan
 *       gelen finalize (kurtarma yolu) her zaman verification_status'u
 *       DOĞRULAMA_BEKLIYOR olarak işaretler.
 *     security: []
 *     responses:
 *       200:
 *         description: İkmal kaydı oluşturuldu (veya idempotency nedeniyle var olan döndürüldü).
 */
router.post(
  '/dispense/finalize',
  hardwareRateLimiter,
  hardwareAuthMiddleware,
  validateRequest({ body: dispenseFinalizeSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    const hw = (req as any).authenticatedHardware as { deviceId: string; tenantId: string };
    try {
      // Oturum state machine'ine dokunmadan ÖNCE idempotency kontrolü —
      // aksi halde bu isteğin ÖNCEKİ bir denemesi zaten başarıyla
      // tamamlanmışsa (oturum artık COMPLETED, cihaz yalnızca yanıtı
      // alamadığı için tekrar gönderiyor) beginFinalize COMPLETED→FINALIZING
      // geçişini reddedip idempotent yanıt yerine 409 dönerdi (bkz.
      // test_fuel401_dispense_session.ts Test 10).
      const alreadyFinalized = await runWithTenant({ tenantId: hw.tenantId }, () =>
        findTransactionByIdempotencyKey(req.body.idempotencyKey)
      );
      if (alreadyFinalized) {
        res.json({
          success: true,
          message: 'Bu idempotencyKey için ikmal kaydı zaten mevcuttu, tekrar oluşturulmadı.',
          data: { ...alreadyFinalized, alreadyExisted: true }
        });
        return;
      }

      const { session, wasTimedOut } = await dispenseSessionService.beginFinalize(hw.deviceId, req.body.sessionId);

      const transaction = await runWithTenant({ tenantId: hw.tenantId }, () =>
        finalizeDispenseSession({
          siteName: session.siteName,
          vehiclePlate: session.vehiclePlate,
          driverName: session.driverName,
          tankName: session.tankName,
          startTotalizerLiters: session.startTotalizerLiters ?? 0,
          endTotalizerLiters: req.body.endTotalizerLiters,
          reportedLiters: req.body.reportedLiters,
          flowRateLpm: session.currentFlowRateLpm,
          idempotencyKey: req.body.idempotencyKey,
          forceManualVerification: wasTimedOut
        })
      );

      await dispenseSessionService.completeSession(hw.deviceId, req.body.sessionId);

      try {
        const freshTanks = await runWithTenant({ tenantId: hw.tenantId }, () => getTenantTanks());
        broadcastToTenant(hw.tenantId, 'dispense:completed', { transaction, tanks: freshTanks });
      } catch (broadcastErr) {
        logger.warn({ err: broadcastErr }, '⚠️ [Socket.io] dispense:completed yayını başarısız oldu (FUEL-401).');
      }

      res.json({
        success: true,
        message: transaction.alreadyExisted
          ? 'Bu idempotencyKey için ikmal kaydı zaten mevcuttu, tekrar oluşturulmadı.'
          : 'İkmal oturumu sonlandırıldı ve kayda geçirildi.',
        data: transaction
      });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/audit-logs
 * AUTH-203 — append-only denetim izi. Yalnızca SUPER_ADMIN/COMPANY_OWNER
 * görebilir; kayıtlar yalnızca INSERT edilir (bkz. schema.sql'deki
 * REVOKE UPDATE, DELETE ON audit_logs FROM app_user).
 */
router.get(
  '/audit-logs',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const logs = await getAuditLogs(limit);
      res.json({ success: true, data: logs });
    } catch (error: any) {
      next(error);
    }
  }
);

export default router;
