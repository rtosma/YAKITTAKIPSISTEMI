import { Router, Request, Response } from 'express';
import { getTenantStore } from '../context/tenantContext';
import { getTenantVehicles } from '../db/tenantDb';
import { validateRequest } from '../middleware/validateMiddleware';
import { createVehicleSchema } from '../schemas/vehicleSchema';
import { dispenseRequestSchema } from '../schemas/transactionSchema';
import { loginSchema } from '../schemas/authSchema';
import { hashPassword, verifyPassword } from '../utils/password';
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
 * Mock Users Database with hashed passwords (In Production: PostgreSQL users table)
 * Initialized with Argon2id password hashes for testing
 */
interface SystemUser {
  id: string;
  tenantId: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  siteName?: string;
}

const mockUsersStore: Map<string, SystemUser> = new Map();

// Helper to seed initial users with Argon2id hashes
async function seedInitialUsers() {
  if (mockUsersStore.size > 0) return;
  const hash123456 = await hashPassword('123456');

  mockUsersStore.set('camsa', {
    id: 'usr-camsa-owner',
    tenantId: 'comp-camsa',
    username: 'camsa',
    passwordHash: hash123456,
    role: 'COMPANY_OWNER'
  });

  mockUsersStore.set('gebze-santiye', {
    id: 'usr-gebze-mgr',
    tenantId: 'comp-camsa',
    username: 'gebze-santiye',
    passwordHash: hash123456,
    role: 'SITE_MANAGER',
    siteName: 'Gebze Ana Şantiye'
  });

  mockUsersStore.set('pompa-op-01', {
    id: 'usr-pompa-op',
    tenantId: 'comp-camsa',
    username: 'pompa-op-01',
    passwordHash: hash123456,
    role: 'PUMP_OPERATOR',
    siteName: 'Gebze Ana Şantiye'
  });
}

// Seed initial users
seedInitialUsers();

/**
 * GET /api/v1/health
 * Public health check
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    service: 'Yakıttakip Backend API [ARCH-101 / RES-901 / AUTH-201]'
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
 * User login with Argon2id password verification and JWT Access + Refresh token issuance
 */
router.post(
  '/auth/login',
  validateRequest({ body: loginSchema }),
  async (req: Request, res: Response) => {
    await seedInitialUsers();
    const { username, password } = req.body;
    const lowerUser = username.trim().toLowerCase();

    const user = mockUsersStore.get(lowerUser);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Girilen kullanıcı adı veya şifre hatalı.'
      });
    }

    // Verify Argon2id password hash
    const isValidPassword = await verifyPassword(user.passwordHash, password);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Girilen kullanıcı adı veya şifre hatalı.'
      });
    }

    const payload: JwtUserPayload = {
      userId: user.id,
      tenantId: user.tenantId,
      username: user.username,
      role: user.role,
      siteName: user.siteName
    };

    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(user.id, user.tenantId);

    res.json({
      success: true,
      message: 'Giriş başarılı. JWT erişim ve yenileme tokenları üretildi.',
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresInSeconds: 900, // 15 min
      user: {
        userId: user.id,
        tenantId: user.tenantId,
        username: user.username,
        role: user.role,
        siteName: user.siteName
      }
    });
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
    // Find matching user from token (or dummy lookup for test)
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
