import { Router, Request, Response, NextFunction } from 'express';
import { getTenantStore } from '../context/tenantContext';
import { getTenantVehicles, createVehicle, updateVehicle, deleteVehicle, getTenantDrivers, createDriver, updateDriver, deleteDriver, getTenantTanks, createTank, updateTank, deleteTank, getTenantSites, createTenantSite, deleteTenantSite, getTenantCompanyProfile, getTenantTransactions, createTransaction } from '../db/tenantDb';
import { getAllCompanies, createCompanyWithOwner, updateCompanyAdmin } from '../db/adminDb';
import { validateRequest } from '../middleware/validateMiddleware';
import { createVehicleSchema, updateVehicleSchema } from '../schemas/vehicleSchema';
import { createDriverSchema, updateDriverSchema } from '../schemas/driverSchema';
import { createTankSchema, updateTankSchema } from '../schemas/tankSchema';
import { dispenseRequestSchema } from '../schemas/transactionSchema';
import { createCompanySchema, updateCompanySchema } from '../schemas/companySchema';
import { loginSchema } from '../schemas/authSchema';
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
import { loginRateLimiter } from '../middleware/rateLimitMiddleware';

const router = Router();

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
 * POST /api/v1/auth/refresh
 * Single-use JWT Refresh Token Rotation with Token Reuse Detection
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
    // Resolve the refresh token's real owner from PostgreSQL — rotateRefreshToken
    // calls this with the userId/tenantId taken from the verified token record,
    // so the caller can never dictate whose identity the new tokens carry.
    const newTokens = await rotateRefreshToken(refreshToken, async (userId, tenantId) => {
      const dbRes = await pool.query(
        'SELECT id, tenant_id, username, role, site_name FROM users WHERE id = $1 AND tenant_id = $2',
        [userId, tenantId]
      );
      if (dbRes.rows.length === 0) return null;

      const dbUser = dbRes.rows[0];
      const payload: JwtUserPayload = {
        userId: dbUser.id,
        tenantId: dbUser.tenant_id,
        username: dbUser.username,
        role: dbUser.role as UserRole,
        siteName: dbUser.site_name || undefined
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
 * Create/register a new site for the tenant in DB
 */
router.post(
  '/sites',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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
    const vehicles = await getTenantVehicles();
    const store = getTenantStore();

    res.json({
      success: true,
      tenantId: store?.tenantId || req.user?.tenantId,
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
    const drivers = await getTenantDrivers();
    const store = getTenantStore();

    res.json({
      success: true,
      tenantId: store?.tenantId || req.user?.tenantId,
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
    const tanks = await getTenantTanks();
    const store = getTenantStore();

    res.json({
      success: true,
      tenantId: store?.tenantId || req.user?.tenantId,
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
 *     summary: İkmal Geçmişi
 *     description: RLS kurallarına göre oturum açmış firmanın son 200 ikmal kaydını getirir.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: İkmal geçmişi başarıyla getirildi.
 */
router.get('/transactions', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const transactions = await getTenantTransactions();
    res.json({
      success: true,
      totalCount: transactions.length,
      data: transactions
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * POST /api/v1/telemetry/hardware-data
 * Protected by AUTH-202 HMAC-SHA256 Hardware Authentication Middleware
 * Receives verified telemetries from ESP32 & IoT sensors
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
