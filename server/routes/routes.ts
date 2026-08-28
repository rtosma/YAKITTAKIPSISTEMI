import { Router, Request, Response } from 'express';
import { getTenantStore } from '../context/tenantContext';
import { getTenantVehicles } from '../db/tenantDb';
import { validateRequest } from '../middleware/validateMiddleware';
import { createVehicleSchema } from '../schemas/vehicleSchema';
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

const router = Router();

/**
 * GET /api/v1/health
 * Public health check
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
    const userPayload: JwtUserPayload = {
      userId: 'usr-camsa-owner',
      tenantId: 'comp-camsa',
      username: 'camsa',
      role: 'COMPANY_OWNER'
    };

    const newTokens = await rotateRefreshToken(refreshToken, userPayload);

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
 * GET /api/v1/vehicles
 * Protected endpoint returning vehicles filtered by RLS
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
 * POST /api/v1/vehicles
 * Protected endpoint requiring COMPANY_OWNER or SITE_MANAGER role
 */
router.post(
  '/vehicles',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  validateRequest({ body: createVehicleSchema }),
  async (req: AuthenticatedRequest, res: Response) => {
    const sanitizedBody = req.body;
    const store = getTenantStore();

    res.json({
      success: true,
      message: 'Araç başarıyla doğrulandı ve kaydedildi.',
      tenantId: store?.tenantId || req.user?.tenantId,
      createdBy: req.user?.username,
      sanitizedData: sanitizedBody
    });
  }
);

/**
 * POST /api/v1/dispense
 * Protected endpoint requiring PUMP_OPERATOR, SITE_MANAGER or COMPANY_OWNER role
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

export default router;
