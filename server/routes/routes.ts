import { Router, Request, Response } from 'express';
import { getTenantStore } from '../context/tenantContext';
import { getTenantVehicles } from '../db/tenantDb';
import { validateRequest } from '../middleware/validateMiddleware';
import { createVehicleSchema } from '../schemas/vehicleSchema';
import { dispenseRequestSchema } from '../schemas/transactionSchema';
import { loginSchema } from '../schemas/authSchema';

const router = Router();

/**
 * GET /api/v1/health
 * Public health check
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    service: 'Yakıttakip Backend API [ARCH-101 / RES-901]'
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
 * GET /api/v1/vehicles
 * Returns vehicles filtered by PostgreSQL Row-Level Security (RLS)
 */
router.get('/vehicles', async (_req: Request, res: Response) => {
  try {
    const vehicles = await getTenantVehicles();
    const store = getTenantStore();

    res.json({
      success: true,
      tenantId: store?.tenantId,
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
 * Creates a new vehicle with strict Zod validation & sanitization
 */
router.post(
  '/vehicles',
  validateRequest({ body: createVehicleSchema }),
  async (req: Request, res: Response) => {
    const sanitizedBody = req.body;
    const store = getTenantStore();

    res.json({
      success: true,
      message: 'Araç başarıyla doğrulandı ve kaydedildi.',
      tenantId: store?.tenantId,
      sanitizedData: sanitizedBody
    });
  }
);

/**
 * POST /api/v1/dispense
 * Dispenses fuel with strict amountLiters > 0 check
 */
router.post(
  '/dispense',
  validateRequest({ body: dispenseRequestSchema }),
  async (req: Request, res: Response) => {
    const sanitizedBody = req.body;
    const store = getTenantStore();

    res.json({
      success: true,
      message: 'İkmal yetkilendirme isteği doğrulandı.',
      tenantId: store?.tenantId,
      dispenseDetails: sanitizedBody
    });
  }
);

/**
 * POST /api/v1/auth/login
 * User login DTO validation
 */
router.post(
  '/auth/login',
  validateRequest({ body: loginSchema }),
  async (req: Request, res: Response) => {
    const { username } = req.body;
    res.json({
      success: true,
      message: `${username} kullanıcısı için giriş DTO doğrulaması başarılı.`,
      username
    });
  }
);

export default router;
