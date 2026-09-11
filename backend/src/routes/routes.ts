import { Router, Request, Response, NextFunction } from 'express';
import { getTenantStore } from '../context/tenantContext';
import { getTenantVehicles, createVehicle, updateVehicle, deleteVehicle, getTenantDrivers, createDriver, updateDriver, deleteDriver, getTenantTanks, createTank, updateTank, deleteTank, getTenantSites, createSiteWithManager, deleteTenantSite, getTenantCompanyProfile, getTenantTransactionsPaginated, createTransaction, getTenantCrossSitePermissions, createCrossSitePermission, updateCrossSitePermissionStatus, changeOwnPassword, getAuditLogs, authorizeDispenseRequest, finalizeDispenseSession, findTransactionByIdempotencyKey, createHardwareDevice, rotateHardwareDeviceSecret, blockHardwareDevice, unblockHardwareDevice, getTenantHardwareDevices, relocateHardwareDevice, createDeviceClaimCode, getTenantClaimCodes, syncOfflineDispenseBatch, requestKFactorCalibration, approveKFactorCalibration, rollbackKFactorCalibration, getCalibrationHistory, recordCalibrationAck, recordCalibrationNack, markCalibrationSent, recordCalibrationTestIntake, getCalibrationTestIntakes, setFailOpenPolicy, getFailOpenPolicies, getEffectiveFailOpenPolicy, recordFailOpenPolicyDelivery, getFailOpenPolicyDeploymentStatus, getOfflineDispenseRatioAlerts, isTenantModuleEnabled, getConsumptionAnomalyReports, prepareDespatchAdvice, getTankNameById, setTankStrappingTable, getTankStrappingTableHistory, getEffectiveTankVolumeModel, computeTankVolume, blockRfidCard, unblockRfidCard, replaceRfidCard, getRfidDenylist, getRfidDenylistForDevice, recordRfidDenylistPull, getRfidDenylistDeploymentStatus, createFuelQuota, getFuelQuotas, getFuelQuota, updateFuelQuota, getQuotaBalance, getQuotaHistory, resetDueQuotasForCurrentTenant, recordFuelIntake, getFuelIntakes, getFuelIntake, computeStockReconciliation, getStockReconciliations, getStockReconciliation, createManualDispenseRequest, getManualDispenseRequests, getManualDispenseRequest, approveManualDispenseRequest, rejectManualDispenseRequest, getManualDispenseRatio, auditSessionRevocation, setSiteWorkingHours, getSiteWorkingHours, runAnomalyDetectionForCurrentTenant, getAnomalyFlags, getAnomalyFlag, reviewAnomalyFlag, getAlarms, getAlarm, updateAlarm, snoozeAlarm, getFalsePositiveFeedback, runAlarmEscalationForCurrentTenant, upsertRecipientTaxpayer, getRecipientTaxpayers, getRecipientTaxpayer, refreshRecipientObligation, setHardwareDeviceTank, getFuelStockSummary, recordMeterReading, getVehicleMeterReadings, recordMeterReadingsBulk, getMissingMeterReadings, remindMissingMeterReadings, getFleetConsumptionReport, getFleetConsumptionComparison, getFleetConsumptionTrend, getVehicleConsumptionAnomaly, scanConsumptionAnomalies, setVehicleFuelLimit, getVehicleFuelLimitBalance, approveTemporaryFuelLimitIncrease, enqueueDespatchAdviceTransmission, getDespatchAdviceTransmissions, getDespatchAdviceTransmission, runDespatchAdviceTransmissionSweepForCurrentTenant, getDespatchAdviceStatus, rejectDespatchAdvice, cancelDespatchAdvice, resubmitDespatchAdvice, createVehicleMaintenanceRecord, getVehicleMaintenanceRecords, getVehicleMaintenanceRecord, getMaintenanceConsumptionImpact, getVehicleTotalCostOfOwnership, getUpcomingMaintenanceReminders, runMaintenanceReminderSweepForCurrentTenant, addVehicleComplianceDeadline, getVehicleComplianceDeadlines, getCurrentVehicleComplianceDeadlines, registerVehicleTire, getVehicleTires, recordTireTreadDepth, getVehicleTireStatus, getFleetComplianceDashboard, runFleetComplianceSweepForCurrentTenant, createInventoryItem, getInventoryItems, getInventoryItem, recordInventoryMovement, recordInventoryCount, getInventoryMovements, getCriticalStockItems, runInventoryCriticalStockSweepForCurrentTenant, createLabSample, getLabSamples, getLabSample, cancelLabSample, recordLabTestResult, getLabTestResults, getNonConformingLabResults } from '../db/tenantDb';
import { streamTransactionsToExcel } from '../services/transactionExportService';
import { generateAndStoreAnomalyReport } from '../services/consumptionAnomalyService';
import { generateAnomalyReportSchema } from '../schemas/consumptionAnomalySchema';
import { generateDespatchAdviceXml } from '../compliance/despatchAdviceXmlService';
import { setStrappingTableSchema, tankVolumeQuerySchema, parseStrappingCsv } from '../schemas/strappingTableSchema';
import { blockRfidCardSchema, replaceRfidCardSchema } from '../schemas/rfidCardSchema';
import { checkReadiness } from '../services/readinessService';
import { createQuotaSchema, updateQuotaSchema } from '../schemas/quotaSchema';
import { createFuelIntakeSchema, listFuelIntakeQuerySchema } from '../schemas/fuelIntakeSchema';
import { createReconciliationSchema, listReconciliationQuerySchema } from '../schemas/stockReconciliationSchema';
import { createManualDispenseSchema, rejectManualDispenseSchema, listManualDispenseQuerySchema, manualDispenseRatioQuerySchema } from '../schemas/manualDispenseSchema';
import { setWorkingHoursSchema, scanAnomalySchema, listAnomalyFlagQuerySchema, reviewAnomalyFlagSchema } from '../schemas/anomalyFlagSchema';
import { updateAlarmSchema, snoozeAlarmSchema, listAlarmQuerySchema } from '../schemas/alarmSchema';
import { validateTaxIdSchema, createRecipientSchema } from '../schemas/recipientSchema';
import { setDeviceTankSchema, fuelStockSummaryQuerySchema } from '../schemas/fuelTypeSchema';
import { recordMeterReadingSchema, bulkMeterReadingSchema, missingMeterQuerySchema, remindMeterSchema } from '../schemas/meterReadingSchema';
import { fleetConsumptionQuerySchema, fleetComparisonQuerySchema, fleetTrendQuerySchema } from '../schemas/fleetConsumptionSchema';
import { vehicleConsumptionAnomalyQuerySchema, consumptionAnomalyScanSchema } from '../schemas/consumptionAnomalySchemaFleet';
import { setVehicleFuelLimitSchema, temporaryFuelLimitIncreaseSchema } from '../schemas/vehicleFuelLimitSchema';
import { enqueueDespatchAdviceTransmissionSchema, despatchAdviceTransmissionListQuerySchema } from '../schemas/despatchAdviceTransmissionSchema';
import { rejectDespatchAdviceSchema, cancelDespatchAdviceSchema } from '../schemas/despatchAdviceDispositionSchema';
import { createVehicleMaintenanceRecordSchema, totalCostOfOwnershipQuerySchema } from '../schemas/vehicleMaintenanceSchema';
import { addVehicleComplianceDeadlineSchema, registerVehicleTireSchema, recordTireTreadDepthSchema } from '../schemas/vehicleComplianceSchema';
import { createInventoryItemSchema, recordInventoryMovementSchema, recordInventoryCountSchema } from '../schemas/inventorySchema';
import { createLabSampleSchema, cancelLabSampleSchema, recordLabTestResultSchema } from '../schemas/labSampleSchema';
import { validateTaxId } from '../compliance/taxIdValidation';
import { getEInvoiceObligation } from '../services/taxpayerRegistryService';
import { totpSetupSchema, totpEnableSchema, totpVerifySchema, totpDisableSchema } from '../schemas/totpSchema';
import { generateTotpSecret, verifyTotp, buildOtpauthUri, generateRecoveryCodes, normalizeRecoveryCode } from '../services/totpService';
import { isServerShuttingDown } from '../utils/shutdown';
import { getAllCompanies, createCompanyWithOwner, updateCompanyAdmin, getAllHardwareDevices, redeemDeviceClaimCode, getUserAuthById, getUserTotp, saveUserTotpSecret, enableUserTotp, deleteUserTotp, setTotpRecoveryHashes, touchTotpLastUsed, insertAuthAuditLog, isPackageLimitReached, getCompanyModuleAddons, addCompanyModuleAddon, removeCompanyModuleAddon, reapplyPackageDefaults, PACKAGE_TIERS } from '../db/adminDb';
import { runLicenseExpiryWarningSweep } from '../services/licenseWarningService';
import { getUsageMeteringHistory, computeUsageMeteringForCurrentTenant } from '../services/usageMeteringService';
import { validateRequest } from '../middleware/validateMiddleware';
import { createVehicleSchema, updateVehicleSchema } from '../schemas/vehicleSchema';
import { createDriverSchema, updateDriverSchema } from '../schemas/driverSchema';
import { createTankSchema, updateTankSchema } from '../schemas/tankSchema';
import { dispenseRequestSchema, transactionQuerySchema, transactionExportQuerySchema, syncBatchSchema } from '../schemas/transactionSchema';
import { dispenseRequestAuthSchema, dispenseHeartbeatSchema, dispenseFinalizeSchema } from '../schemas/dispenseSessionSchema';
import { createCrossSitePermissionSchema, updateCrossSitePermissionStatusSchema } from '../schemas/crossSiteSchema';
import { createCompanySchema, updateCompanySchema, moduleAddonSchema } from '../schemas/companySchema';
import { loginSchema, changePasswordSchema, forgotPasswordSchema, resetPasswordSchema } from '../schemas/authSchema';
import { config } from '../config/env';
import { requestPasswordReset, finalizePasswordReset } from '../services/passwordResetService';
import { createSiteSchema } from '../schemas/siteSchema';
import { createHardwareDeviceSchema, relocateHardwareDeviceSchema, createDeviceClaimCodeSchema, claimDeviceSchema } from '../schemas/hardwareDeviceSchema';
import { requestCalibrationSchema, calibrationAckSchema, testIntakeSchema } from '../schemas/calibrationSchema';
import { setFailOpenPolicySchema } from '../schemas/failOpenPolicySchema';
import { verifyPassword, hashPassword } from '../utils/password';
import { NotFoundError, ForbiddenError, BadRequestError, UnauthorizedError, ConflictError } from '../utils/errors';
import { pool } from '../db/postgresPool';
import {
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  verifyAccessToken,
  generatePendingTwoFactorToken,
  verifyPendingTwoFactorToken,
  listUserSessions,
  revokeSession,
  revokeOtherSessions,
  JwtUserPayload,
  UserRole
} from '../services/tokenService';
import { authenticateJWT, authorizeRoles, AuthenticatedRequest } from '../middleware/authMiddleware';
import { hardwareAuthMiddleware } from '../middleware/hardwareAuthMiddleware';
import { lorawanWebhookAuth } from '../middleware/lorawanWebhookAuthMiddleware';
import { redisPool } from '../db/redisPool';
import { broadcastToTenant } from '../socket/socketServer';
import { logger } from '../utils/logger';
import { loginRateLimiter, refreshRateLimiter, hardwareRateLimiter, lorawanWebhookRateLimiter, passwordResetPerMinuteLimiter, passwordResetPerHourLimiter, passwordResetSubmitLimiter } from '../middleware/rateLimitMiddleware';
import { lorawanUplinkSchema } from '../schemas/lorawanWebhookSchema';
import { ingestLoRaWANUplink } from '../services/lorawanUplinkService';
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
 * @swagger
 * /health/live:
 *   get:
 *     summary: Liveness Probe (RES-906)
 *     description: >
 *       Süreç ayakta mı — bağımlılıklara (DB/Redis/MQTT) BAKMAZ (Kritik Not
 *       3: aksi halde Redis kesintisi sonsuz konteyner restart'ına yol açar).
 *       Kapanma sırasında bile 200 döner (süreç canlı, yalnızca readiness
 *       düşer). index.ts'teki shutdown-503 middleware'i bu yolu muaf tutar.
 *     responses:
 *       200:
 *         description: Süreç canlı.
 */
router.get('/health/live', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'UP', shuttingDown: isServerShuttingDown(), timestamp: new Date().toISOString() });
});

/**
 * @swagger
 * /health/ready:
 *   get:
 *     summary: Readiness Probe (RES-906)
 *     description: >
 *       DB + Redis + MQTT erişilebilir VE sunucu kapanma modunda değilse 200,
 *       aksi halde 503 (bağımlılık bazlı durum gövdededir). Sonuç 3 sn
 *       cache'lenir (Kritik Not 1). SIGTERM alındığında derhal 503 döner ki
 *       orkestratör trafiği bu pod'dan çeksin.
 *     responses:
 *       200:
 *         description: Hazır — trafik alabilir.
 *       503:
 *         description: Hazır değil (bağımlılık erişilemez ya da kapanıyor).
 */
router.get('/health/ready', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (isServerShuttingDown()) {
      res.status(503).json({ ready: false, reason: 'SHUTTING_DOWN', checkedAt: new Date().toISOString() });
      return;
    }
    const result = await checkReadiness();
    res.status(result.ready ? 200 : 503).json(result);
  } catch (error: any) {
    next(error);
  }
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

      // AUTH-207: parola doğru — ama 2FA gerekiyorsa TAM token DEĞİL, yalnızca
      // 5 dk ömürlü bir "kısmi" token dönülür. requires2fa: kullanıcının 2FA'sı
      // zaten kurulu (opt-in, bayraktan bağımsız). requires2faSetup: rol
      // zorunlu (config.TOTP_ENFORCED) ama henüz kurmamış.
      const totpRow = await getUserTotp(dbUser.id);
      if (totpRow?.enabled) {
        return res.json({
          success: true,
          requires2fa: true,
          partialToken: generatePendingTwoFactorToken(dbUser.id, dbUser.tenant_id, 'VERIFY'),
          partialTokenExpiresInSeconds: 300,
          message: 'Parola doğrulandı. İkinci adım: doğrulayıcı uygulamanızdaki 6 haneli kod (POST /auth/2fa/verify).'
        });
      }
      if (REQUIRED_2FA_ROLES.has(dbUser.role) && config.TOTP_ENFORCED) {
        return res.json({
          success: true,
          requires2faSetup: true,
          partialToken: generatePendingTwoFactorToken(dbUser.id, dbUser.tenant_id, 'SETUP'),
          partialTokenExpiresInSeconds: 300,
          message: 'Bu rol için iki adımlı doğrulama zorunludur. POST /auth/2fa/setup ile kurun.'
        });
      }

      // AUTH-208: refresh token ÖNCE üretilir (yeni oturum ailesi) ki access
      // token'a o oturumun sid'i gömülebilsin.
      const newSession = await generateRefreshToken(dbUser.id, dbUser.tenant_id, {
        userAgent: req.headers['user-agent'] ?? null,
        ipAddress: req.ip ?? null
      });
      const refreshToken = newSession.token;
      const accessToken = generateAccessToken({ ...payload, sid: newSession.sessionId });

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

      // AUTH-207: zorunlu bir rol 2FA kurmadan (config.TOTP_ENFORCED açıkken)
      // yenileme yapamaz — mevcut oturumun eski access token'ı 15 dk içinde
      // düşer, sonra yeniden login + kurulum akışına girer.
      if (REQUIRED_2FA_ROLES.has(dbUser.role) && config.TOTP_ENFORCED) {
        const t = await getUserTotp(dbUser.id);
        if (!t?.enabled) return null;
      }

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
    }, { userAgent: req.headers['user-agent'] ?? null, ipAddress: req.ip ?? null });

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
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     summary: Şifre Sıfırlama Talebi (AUTH-206)
 *     description: >
 *       Kullanıcı adı için tek kullanımlık, 30 dk geçerli bir sıfırlama
 *       token'ı üretir (hash'i Redis'te). Kullanıcının var olup olmadığından
 *       BAĞIMSIZ olarak HER ZAMAN aynı 200 mesajı döner (enumeration
 *       koruması). Rate limit: kullanıcı başına 1/dk ve 5/saat. Gerçek
 *       e-posta/SMS iletimi #159'a bağlı — o zamana kadar üretim-dışı
 *       ortamlarda token yanıtta `devResetToken` olarak döner.
 *     security: []
 *     responses:
 *       200:
 *         description: Talep alındı (kullanıcı var olsun olmasın aynı yanıt).
 *       429:
 *         description: Rate limit aşıldı.
 */
router.post(
  '/auth/forgot-password',
  passwordResetPerHourLimiter,
  passwordResetPerMinuteLimiter,
  validateRequest({ body: forgotPasswordSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { username } = req.body as { username: string };
      const resetToken = await requestPasswordReset(username);

      const body: Record<string, unknown> = {
        success: true,
        message: 'Eğer bu kullanıcı adı sistemde kayıtlıysa, şifre sıfırlama talimatları ilgili kanaldan iletilmiştir.'
      };
      // #159 (bildirim kanalı) tamamlanana kadar üretim-DIŞI ortamlarda
      // token'ı doğrudan döndür ki akış uçtan uca kullanılabilir/test
      // edilebilir olsun. Üretimde ASLA sızmaz.
      if (!config.isProduction && resetToken) {
        body.devResetToken = resetToken;
      }
      res.json(body);
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     summary: Şifre Sıfırlamayı Tamamla (AUTH-206)
 *     description: >
 *       Geçerli bir token + yeni parola ile şifreyi günceller. Token TEK
 *       KULLANIMLIK (kullanılır kullanılmaz silinir), 30 dk geçerli.
 *       Başarıda kullanıcının TÜM aktif oturumları (refresh token'ları)
 *       iptal edilir. Geçersiz/kullanılmış token → jenerik 400.
 *     security: []
 *     responses:
 *       200:
 *         description: Parola güncellendi.
 *       400:
 *         description: Geçersiz/süresi dolmuş token veya parola kuralı ihlali.
 *       429:
 *         description: Rate limit aşıldı.
 */
router.post(
  '/auth/reset-password',
  passwordResetSubmitLimiter,
  validateRequest({ body: resetPasswordSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, newPassword } = req.body as { token: string; newPassword: string };
      await finalizePasswordReset(token, newPassword);
      res.json({
        success: true,
        message: 'Şifreniz başarıyla güncellendi. Lütfen yeni şifrenizle giriş yapın.'
      });
    } catch (error: any) {
      next(error);
    }
  }
);

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

// ── AUTH-207: TOTP tabanlı iki adımlı doğrulama (2FA) ───────────────────
const REQUIRED_2FA_ROLES = new Set(['SUPER_ADMIN', 'COMPANY_OWNER']);

interface TwoFactorActor {
  userId: string;
  tenantId: string;
  role?: string;
  viaPartial: boolean;
  partialMode?: 'VERIFY' | 'SETUP';
}

/**
 * 2FA uçları authenticateJWT KULLANMAZ (kısmi token onu geçemez). Aktörü
 * ya tam bir access token'dan (opt-in kurulum / devre dışı bırakma) ya da
 * gövdedeki `partialToken`'dan (login akışının 2. adımı) çözer.
 */
function resolveTwoFactorActor(req: Request): TwoFactorActor {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const p = verifyAccessToken(auth.slice(7)); // pending2fa token'ı için fırlatır
      return { userId: p.userId, tenantId: p.tenantId, role: p.role, viaPartial: false };
    } catch {
      /* tam token değil — partialToken'a düş */
    }
  }
  const partial = (req.body && (req.body as any).partialToken) as string | undefined;
  if (partial) {
    const p = verifyPendingTwoFactorToken(partial); // geçersizse fırlatır
    return { userId: p.userId, tenantId: p.tenantId, viaPartial: true, partialMode: p.mode };
  }
  throw new UnauthorizedError('2FA işlemi için geçerli bir oturum ya da partialToken gerekli.', { error: 'NO_AUTH' });
}

async function buildLoginTokens(req: Request, base: JwtUserPayload): Promise<{ accessToken: string; refreshToken: string; tokenType: string; expiresInSeconds: number }> {
  const session = await generateRefreshToken(base.userId, base.tenantId, {
    userAgent: req.headers['user-agent'] ?? null,
    ipAddress: req.ip ?? null
  });
  return {
    accessToken: generateAccessToken({ ...base, sid: session.sessionId }),
    refreshToken: session.token,
    tokenType: 'Bearer',
    expiresInSeconds: 900
  };
}

async function payloadForUserId(userId: string): Promise<JwtUserPayload | null> {
  const u = await getUserAuthById(userId);
  if (!u) return null;
  const full = await pool.query('SELECT site_name, must_change_password FROM users WHERE id = $1', [userId]);
  return {
    userId: u.id,
    tenantId: u.tenant_id,
    username: u.username,
    role: u.role as UserRole,
    siteName: full.rows[0]?.site_name || undefined,
    mustChangePassword: full.rows[0]?.must_change_password === true
  };
}

/**
 * @swagger
 * /auth/2fa/setup:
 *   post:
 *     summary: TOTP Kurulumunu Başlat (AUTH-207)
 *     description: >
 *       Yeni bir TOTP sırrı + `otpauth://` URI (istemci QR çizer) + 10 tek
 *       kullanımlık kurtarma kodu döner. Kodlar YALNIZCA bu yanıtta gösterilir.
 *       Henüz etkinleştirilmez — POST /auth/2fa/enable ile ilk doğru kod
 *       girilince aktifleşir. Tam token veya login'in `partialToken`'ı ile.
 *     security: []
 */
router.post('/auth/2fa/setup', validateRequest({ body: totpSetupSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = resolveTwoFactorActor(req);
    const user = await getUserAuthById(actor.userId);
    if (!user) throw new NotFoundError('Kullanıcı bulunamadı.');

    const existing = await getUserTotp(actor.userId);
    if (existing?.enabled) {
      throw new ConflictError('2FA zaten etkin. Önce POST /auth/2fa/disable ile kapatın.', { error: 'ALREADY_ENABLED' });
    }

    const secretBase32 = generateTotpSecret();
    const recoveryCodes = generateRecoveryCodes(10);
    const hashes = await Promise.all(recoveryCodes.map((c) => hashPassword(normalizeRecoveryCode(c))));
    await saveUserTotpSecret(actor.userId, actor.tenantId, secretBase32, hashes);
    await insertAuthAuditLog(actor.tenantId, actor.userId, 'TOTP_SETUP_INITIATED', actor.userId, { viaPartial: actor.viaPartial });

    res.json({
      success: true,
      data: {
        secretBase32,
        otpauthUri: buildOtpauthUri(secretBase32, user.username),
        recoveryCodes,
        message: 'Sırrı doğrulayıcı uygulamanıza ekleyin, sonra POST /auth/2fa/enable ile 6 haneli kodu doğrulayın. Kurtarma kodlarını güvenli bir yere kaydedin — tekrar gösterilmez.'
      }
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /auth/2fa/enable:
 *   post:
 *     summary: TOTP'yi Etkinleştir (AUTH-207)
 *     description: >
 *       `{ code }` — kurulumdaki sırdan üretilmiş 6 haneli kod. İlk doğru kodda
 *       2FA aktifleşir. Kurulum akışı `partialToken` (SETUP) ile geldiyse bu
 *       adımda tam token çifti de döner (login tamamlanır).
 *     security: []
 */
router.post('/auth/2fa/enable', validateRequest({ body: totpEnableSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = resolveTwoFactorActor(req);
    const row = await getUserTotp(actor.userId);
    if (!row) throw new BadRequestError('Önce POST /auth/2fa/setup ile kurulum yapın.', { error: 'NOT_SET_UP' });
    if (row.enabled) throw new ConflictError('2FA zaten etkin.', { error: 'ALREADY_ENABLED' });
    if (!verifyTotp(row.secret_base32, req.body.code)) {
      throw new UnauthorizedError('Doğrulama kodu geçersiz. Uygulamanızdaki güncel kodu girin.', { error: 'INVALID_CODE' });
    }
    await enableUserTotp(actor.userId);
    await insertAuthAuditLog(actor.tenantId, actor.userId, 'TOTP_ENABLED', actor.userId, {});

    if (actor.viaPartial && actor.partialMode === 'SETUP') {
      const base = await payloadForUserId(actor.userId);
      if (!base) throw new NotFoundError('Kullanıcı bulunamadı.');
      const tokens = await buildLoginTokens(req, base);
      return res.json({ success: true, enabled: true, message: '2FA etkinleştirildi ve giriş tamamlandı.', ...tokens });
    }
    res.json({ success: true, enabled: true, message: '2FA etkinleştirildi.' });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /auth/2fa/verify:
 *   post:
 *     summary: Login'in 2. Adımı — TOTP veya Kurtarma Kodu (AUTH-207)
 *     description: >
 *       `{ partialToken, code }` VEYA `{ partialToken, recoveryCode }`. Başarılı
 *       olunca tam access + refresh token döner. Kurtarma kodları TEK
 *       KULLANIMLIKTIR (kullanılınca listeden silinir).
 *     security: []
 */
router.post('/auth/2fa/verify', validateRequest({ body: totpVerifySchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = resolveTwoFactorActor(req);
    if (!actor.viaPartial) {
      throw new BadRequestError('Bu uç yalnızca login akışının partialToken\'ı ile kullanılır.', { error: 'FULL_TOKEN_NOT_ALLOWED' });
    }
    const row = await getUserTotp(actor.userId);
    if (!row || !row.enabled) {
      throw new BadRequestError('Bu hesapta etkin bir 2FA yok.', { error: 'TOTP_NOT_ENABLED' });
    }

    let usedRecovery = false;
    let recoveryRemaining = row.recovery_codes_total;

    if (req.body.code) {
      if (!verifyTotp(row.secret_base32, req.body.code)) {
        throw new UnauthorizedError('Doğrulama kodu geçersiz.', { error: 'INVALID_CODE' });
      }
      await touchTotpLastUsed(actor.userId);
    } else {
      const candidate = normalizeRecoveryCode(req.body.recoveryCode);
      let matchIdx = -1;
      for (let i = 0; i < row.recovery_code_hashes.length; i++) {
        if (await verifyPassword(row.recovery_code_hashes[i], candidate)) { matchIdx = i; break; }
      }
      if (matchIdx === -1) {
        throw new UnauthorizedError('Kurtarma kodu geçersiz veya daha önce kullanılmış.', { error: 'INVALID_RECOVERY_CODE' });
      }
      const remaining = row.recovery_code_hashes.filter((_, i) => i !== matchIdx);
      await setTotpRecoveryHashes(actor.userId, remaining);
      usedRecovery = true;
      recoveryRemaining = remaining.length;
      await insertAuthAuditLog(actor.tenantId, actor.userId, 'TOTP_RECOVERY_USED', actor.userId, { remaining: remaining.length });
    }

    const base = await payloadForUserId(actor.userId);
    if (!base) throw new NotFoundError('Kullanıcı bulunamadı.');
    const tokens = await buildLoginTokens(req, base);
    if (!usedRecovery) {
      await insertAuthAuditLog(actor.tenantId, actor.userId, 'TOTP_LOGIN', actor.userId, {});
    }
    res.json({
      success: true,
      message: usedRecovery ? 'Kurtarma kodu ile giriş yapıldı.' : 'İki adımlı doğrulama başarılı.',
      usedRecoveryCode: usedRecovery,
      recoveryCodesRemaining: usedRecovery ? recoveryRemaining : undefined,
      ...tokens
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /auth/2fa/disable:
 *   post:
 *     summary: 2FA'yı Devre Dışı Bırak (AUTH-207)
 *     description: >
 *       Tam token gerektirir; `{ code }` ile yeniden doğrulama ister. Başarılı
 *       olunca 2FA kaldırılır ve kullanıcının DİĞER tüm oturumları kapatılır.
 *     security:
 *       - bearerAuth: []
 */
router.post('/auth/2fa/disable', validateRequest({ body: totpDisableSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = resolveTwoFactorActor(req);
    if (actor.viaPartial) {
      throw new UnauthorizedError('2FA devre dışı bırakma tam bir oturum gerektirir.', { error: 'FULL_TOKEN_REQUIRED' });
    }
    const row = await getUserTotp(actor.userId);
    if (!row || !row.enabled) throw new BadRequestError('Etkin bir 2FA yok.', { error: 'TOTP_NOT_ENABLED' });
    if (!verifyTotp(row.secret_base32, req.body.code)) {
      throw new UnauthorizedError('Doğrulama kodu geçersiz.', { error: 'INVALID_CODE' });
    }
    await deleteUserTotp(actor.userId);
    await revokeAllUserTokens(actor.userId);
    await insertAuthAuditLog(actor.tenantId, actor.userId, 'TOTP_DISABLED', actor.userId, {});
    res.json({ success: true, enabled: false, message: '2FA devre dışı bırakıldı. Güvenlik nedeniyle diğer oturumlar da kapatıldı.' });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /auth/2fa/status:
 *   get:
 *     summary: 2FA Durumu (AUTH-207)
 *     security:
 *       - bearerAuth: []
 */
router.get('/auth/2fa/status', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const row = await getUserTotp(req.user!.userId);
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      data: {
        enabled: !!row?.enabled,
        recoveryCodesRemaining: row ? row.recovery_code_hashes.length : 0,
        requiredForRole: REQUIRED_2FA_ROLES.has(req.user!.role) && config.TOTP_ENFORCED
      }
    });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /auth/2fa/users/{userId}:
 *   delete:
 *     summary: Bir Kullanıcının 2FA'sını Sıfırla (AUTH-207)
 *     description: >
 *       SUPER_ADMIN, aynı firmadaki bir kullanıcının 2FA'sını (cihaz
 *       kaybı/kilitlenme durumunda) kaldırır ve oturumlarını kapatır. Kullanıcı
 *       sonraki girişte yeniden kurmak zorunda kalır.
 *     security:
 *       - bearerAuth: []
 */
router.delete('/auth/2fa/users/:userId', authenticateJWT, authorizeRoles('SUPER_ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const target = await getUserAuthById(req.params.userId);
    if (!target || target.tenant_id !== req.user!.tenantId) {
      throw new NotFoundError('Kullanıcı bu firmada bulunamadı.', { error: 'USER_NOT_FOUND' });
    }
    const removed = await deleteUserTotp(req.params.userId);
    if (!removed) throw new NotFoundError('Bu kullanıcıda kayıtlı 2FA yok.', { error: 'NO_TOTP' });
    await revokeAllUserTokens(req.params.userId);
    await insertAuthAuditLog(req.user!.tenantId, req.user!.userId, 'TOTP_RESET_BY_ADMIN', req.params.userId, { targetUserId: req.params.userId });
    res.json({ success: true, message: 'Kullanıcının 2FA kaydı sıfırlandı ve oturumları kapatıldı.' });
  } catch (error: any) {
    next(error);
  }
});

// ── AUTH-208: aktif oturum/cihaz listesi + uzaktan oturum kapatma ───────
const SESSION_ADMIN_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER'];

/**
 * Hedef kullanıcının çağıranın kendi kullanıcısı mı, yoksa (yetkiliyse) aynı
 * tenant'taki bir kullanıcı mı olduğunu çözer. Yetki yoksa/başka tenant ise
 * hata fırlatır.
 */
async function resolveSessionTargetUserId(req: AuthenticatedRequest): Promise<string> {
  const requested = (req.query.userId as string | undefined) || (req.body?.userId as string | undefined);
  if (!requested || requested === req.user!.userId) return req.user!.userId;
  if (!SESSION_ADMIN_ROLES.includes(req.user!.role)) {
    throw new ForbiddenError('Başka bir kullanıcının oturumlarını görüntüleme/kapatma yetkiniz yok.', { error: 'FORBIDDEN' });
  }
  const r = await pool.query('SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2', [requested, req.user!.tenantId]);
  if (r.rows.length === 0) {
    throw new NotFoundError('Kullanıcı bu firmada bulunamadı.', { error: 'USER_NOT_FOUND' });
  }
  return requested;
}

/**
 * @swagger
 * /auth/sessions:
 *   get:
 *     summary: Aktif Oturum/Cihaz Listesi (AUTH-208)
 *     description: >
 *       Kullanıcının aktif oturumları (refresh token ailesi başına bir satır)
 *       — cihaz etiketi, IP, oluşturulma ve son kullanım zamanı, `current`
 *       bayrağı. `?userId=` ile COMPANY_OWNER/SUPER_ADMIN aynı firmadaki başka
 *       bir kullanıcının oturumlarını görebilir.
 *     security:
 *       - bearerAuth: []
 */
router.get('/auth/sessions', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const targetUserId = await resolveSessionTargetUserId(req);
    const isSelf = targetUserId === req.user!.userId;
    const sessions = await listUserSessions(targetUserId, isSelf ? req.user!.sid : undefined);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, totalCount: sessions.length, data: sessions });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /auth/sessions/logout-others:
 *   post:
 *     summary: Diğer Tüm Oturumları Kapat (AUTH-208)
 *     description: Çağıranın MEVCUT oturumu dışındaki tüm oturumlarını iptal eder.
 *     security:
 *       - bearerAuth: []
 */
router.post('/auth/sessions/logout-others', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.user!.sid) {
      throw new BadRequestError('Bu access token bir oturum kimliği (sid) taşımıyor — lütfen yeniden giriş yapın.', { error: 'NO_SESSION_CONTEXT' });
    }
    const closed = await revokeOtherSessions(req.user!.userId, req.user!.sid);
    await auditSessionRevocation(req.user!.userId, { scope: 'OTHERS', keptSessionId: req.user!.sid, closedCount: closed, by: req.user!.userId });
    res.json({ success: true, message: `${closed} oturum kapatıldı.`, data: { closedCount: closed } });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /auth/sessions/{sessionId}:
 *   delete:
 *     summary: Belirli Bir Oturumu Uzaktan Kapat (AUTH-208)
 *     description: >
 *       Oturumun tüm refresh token'larını iptal eder ve 15 dk boyunca access
 *       token'ını da deny-list'e alır. `?userId=` ile yetkili, başka bir
 *       kullanıcının oturumunu kapatabilir.
 *     security:
 *       - bearerAuth: []
 */
router.delete('/auth/sessions/:sessionId', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const targetUserId = await resolveSessionTargetUserId(req);
    const count = await revokeSession(targetUserId, req.params.sessionId);
    if (count === 0) {
      throw new NotFoundError('Böyle bir aktif oturum bulunamadı.', { error: 'SESSION_NOT_FOUND' });
    }
    await auditSessionRevocation(targetUserId, {
      scope: 'SINGLE',
      sessionId: req.params.sessionId,
      revokedTokenCount: count,
      by: req.user!.userId,
      self: targetUserId === req.user!.userId
    });
    res.json({ success: true, message: 'Oturum kapatıldı.', data: { sessionId: req.params.sessionId, revokedTokenCount: count } });
  } catch (error: any) {
    next(error);
  }
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
 * /usage-metering:
 *   get:
 *     summary: Kullanım/Faturalama Geçmişi (BILL-1704)
 *     description: >
 *       Oturum açan firmanın dönemsel (aylık) kullanım ölçümü kayıtlarını
 *       (aktif cihaz sayısı, cihaz-gün, ikmal sayısı, telemetri paket
 *       sayısı, üretilen e-belge sayısı) en yeniden en eskiye listeler.
 *       Kayıtlar append-only'dir (bir dönem bir kez hesaplanır).
 *     security:
 *       - bearerAuth: []
 */
router.get('/usage-metering', authenticateJWT, authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 24;
    const history = await getUsageMeteringHistory(limit);
    res.json({ success: true, data: history });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /usage-metering/compute-now:
 *   post:
 *     summary: Bir Dönemin Kullanım Ölçümünü Hemen Hesapla (BILL-1704)
 *     description: >
 *       index.ts'teki günlük süpürücünün (bir önceki ay için) yaptığı işi bu
 *       tenant için MANUEL tetikler — ops/test için, ayın bitmesini beklemeden
 *       (`periodLabel` verilmezse bir önceki ay hesaplanır). Aynı dönem için
 *       tekrar çağrılması güvenlidir (append-only, ON CONFLICT DO NOTHING —
 *       zaten hesaplanmış bir dönem SESSİZCE atlanır, `data: null` döner).
 *     security:
 *       - bearerAuth: []
 */
router.post('/usage-metering/compute-now', authenticateJWT, authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const periodLabel = typeof req.body?.periodLabel === 'string'
      ? req.body.periodLabel
      : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const record = await computeUsageMeteringForCurrentTenant(periodLabel);
    res.json({ success: true, data: record });
  } catch (error: any) {
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
      const updated = await updateCompanyAdmin(req.params.id, req.body, req.user!.userId);
      res.json({ success: true, message: 'Firma güncellendi.', data: updated });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /companies/{id}/module-addons:
 *   get:
 *     summary: Firmanın Ek Modül Satın Alımları (BILL-1703, Süper Admin)
 *     description: >
 *       Firmanın PAKETİNDEN bağımsız, tek tek açılmış (satın alınmış) ek
 *       modülleri listeler — paket değişse/yeniden uygulansa bile kaybolmaz.
 *     security:
 *       - bearerAuth: []
 */
router.get('/companies/:id/module-addons', authenticateJWT, authorizeRoles('SUPER_ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const addons = await getCompanyModuleAddons(req.params.id);
    res.json({ success: true, data: addons });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /companies/{id}/module-addons:
 *   post:
 *     summary: Ek Modül Satın Alımı Ekle (BILL-1703, Süper Admin)
 *     description: >
 *       Bir modülü firmanın paketinden bağımsız olarak kalıcı şekilde açar
 *       (etkisi anında başlar) ve audit_logs'a MODULE_ADDON_GRANTED olarak yazar.
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/companies/:id/module-addons',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN'),
  validateRequest({ body: moduleAddonSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await addCompanyModuleAddon(req.params.id, req.body.moduleName, req.user!.userId);
      const addons = await getCompanyModuleAddons(req.params.id);
      res.json({ success: true, message: 'Ek modül eklendi.', data: addons });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /companies/{id}/module-addons/{moduleName}:
 *   delete:
 *     summary: Ek Modül Satın Alımını Kaldır (BILL-1703, Süper Admin)
 *     description: >
 *       Ek modülü kaldırır — firmanın paketi o modülü zaten içeriyorsa erişim
 *       KESİLMEZ, yalnızca paketin varsayılan değerine döner. audit_logs'a
 *       MODULE_ADDON_REVOKED olarak yazar.
 *     security:
 *       - bearerAuth: []
 */
router.delete('/companies/:id/module-addons/:moduleName', authenticateJWT, authorizeRoles('SUPER_ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await removeCompanyModuleAddon(req.params.id, req.params.moduleName, req.user!.userId);
    const addons = await getCompanyModuleAddons(req.params.id);
    res.json({ success: true, message: 'Ek modül kaldırıldı.', data: addons });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /admin/package-defaults/{package}/reapply:
 *   post:
 *     summary: Paket Varsayılanlarını Mevcut Firmalara Yeniden Uygula (BILL-1703, Süper Admin)
 *     description: >
 *       Bir paket tanımı (kodda) DEĞİŞTİĞİNDE o paketteki TÜM firmalara
 *       OTOMATİK yansımaz — bu uç, SUPER_ADMIN'in bilerek tetiklediği
 *       KONTROLLÜ bir yayılım. Her firma için modules = paket varsayılanı +
 *       ek modül satın alımları (addon'lar hep korunur) olarak yeniden
 *       kurulur; daha önceki ad-hoc (addon olmayan) manuel override'lar
 *       KASITLI olarak silinir. Her değişen firma için audit_logs'a
 *       PACKAGE_DEFAULTS_REAPPLIED yazılır.
 *     parameters:
 *       - in: path
 *         name: package
 *         required: true
 *         schema:
 *           type: string
 *           enum: [TEMEL, PROFESYONEL, KURUMSAL]
 *     security:
 *       - bearerAuth: []
 */
router.post('/admin/package-defaults/:package/reapply', authenticateJWT, authorizeRoles('SUPER_ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const packageTier = req.params.package;
    if (!(PACKAGE_TIERS as string[]).includes(packageTier)) {
      throw new BadRequestError(`Geçersiz paket: ${packageTier}. Geçerli değerler: ${PACKAGE_TIERS.join(', ')}`);
    }
    const results = await reapplyPackageDefaults(packageTier as (typeof PACKAGE_TIERS)[number], req.user!.userId);
    res.json({
      success: true,
      data: { packageTier, companiesChecked: results.length, companiesChanged: results.filter((r) => r.changed).length, results }
    });
  } catch (error: any) {
    next(error);
  }
});

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
      // BILL-1702 AC: "limit aşımında yeni kayıt engelleme."
      const deviceLimit = await isPackageLimitReached(req.user!.tenantId, 'devices');
      if (deviceLimit.reached) {
        throw new ConflictError(
          `Paket limitine ulaşıldı: cihaz sayısı (${deviceLimit.current}/${deviceLimit.limit}). Devam etmek için paketinizi yükseltin.`
        );
      }

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
 * @swagger
 * /hardware-devices/{deviceId}/tank:
 *   patch:
 *     summary: Pompa-Tank Eşlemesi (FUEL-407)
 *     description: >
 *       `{ tankName }` — bu pompanın beslendiği tank. Bir tank birden çok
 *       pompaya bağlanabilir. `tankName: null` eşlemeyi kaldırır. Eşleme
 *       varsa request-auth istekteki tankName ile karşılaştırılır.
 *     security:
 *       - bearerAuth: []
 */
router.patch(
  '/hardware-devices/:deviceId/tank',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  validateRequest({ body: setDeviceTankSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await setHardwareDeviceTank(req.params.deviceId, req.body.tankName ?? null);
      res.json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /fuel-stock-summary:
 *   get:
 *     summary: Yakıt Tipi Bazında Stok ve İkmal Özeti (FUEL-407)
 *     description: '?days (varsayılan 30). Tank stoğu + dönem ikmali, yakıt tipi (grup) bazında.'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/fuel-stock-summary',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  validateRequest({ query: fuelStockSummaryQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { days: number };
      res.json({ success: true, data: await getFuelStockSummary(q.days) });
    } catch (error: any) {
      next(error);
    }
  }
);

// ── FLEET-1404 + RES-903: araç sayaç (km / motor-saat) girişi + doğrulama ──
const METER_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;

/**
 * @swagger
 * /vehicles/{id}/meter-readings:
 *   post:
 *     summary: Araç Sayaç Girişi (FLEET-1404)
 *     description: >
 *       `{ value, meterType?, readingAt?, periodLabel?, note?, overrideReason?,
 *       correctsReadingId? }`. RES-903: geri giden / absürt sıçrama / mükerrer
 *       dönem tespit edilirse `overrideReason` (gerekçeli onay) olmadan 409.
 *       Düzeltme için `correctsReadingId` verin (eski satır SİLİNMEZ).
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Araç Sayaç Geçmişi (FLEET-1404 — append-only)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/vehicles/:id/meter-readings',
  authenticateJWT,
  authorizeRoles(...METER_MANAGER_ROLES),
  validateRequest({ body: recordMeterReadingSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await recordMeterReading(req.params.id, req.body, req.user!.userId);
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/vehicles/:id/meter-readings',
  authenticateJWT,
  authorizeRoles(...METER_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const readings = await getVehicleMeterReadings(req.params.id);
      res.json({ success: true, totalCount: readings.length, data: readings });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /meter-readings/bulk:
 *   post:
 *     summary: Toplu Sayaç Girişi (FLEET-1404 — 50 araç)
 *     description: '`{ items: [{ vehiclePlate, value, ... }] }` (1..50). Satır bazlı sonuç döner.'
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/meter-readings/bulk',
  authenticateJWT,
  authorizeRoles(...METER_MANAGER_ROLES),
  validateRequest({ body: bulkMeterReadingSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await recordMeterReadingsBulk(req.body.items, req.user!.userId);
      res.json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /meter-readings/missing:
 *   get:
 *     summary: Eksik Sayaç Girişi Olan Araçlar (FLEET-1404)
 *     description: '?periodLabel=YYYY-AA (zorunlu), ?meterType=KM|MOTOR_SAAT. Şantiye bazında gruplanır.'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/meter-readings/missing',
  authenticateJWT,
  authorizeRoles(...METER_MANAGER_ROLES),
  validateRequest({ query: missingMeterQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { periodLabel: string; meterType?: 'KM' | 'MOTOR_SAAT' };
      res.json({ success: true, data: await getMissingMeterReadings(q.periodLabel, q.meterType) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /meter-readings/missing/remind:
 *   post:
 *     summary: Eksik Girişli Şantiyelere Hatırlatma (FLEET-1404)
 *     description: '`{ periodLabel, meterType? }`. Şantiye bazında audit + WebSocket meter-reading:reminder.'
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/meter-readings/missing/remind',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER'),
  validateRequest({ body: remindMeterSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await remindMissingMeterReadings(req.body.periodLabel, req.body.meterType, req.user!.userId);
      const tenantId = req.user?.tenantId;
      if (tenantId) {
        try {
          for (const s of result.bySite) {
            broadcastToTenant(tenantId, 'meter-reading:reminder', { periodLabel: result.periodLabel, siteName: s.siteName, missingCount: s.missingCount });
          }
        } catch { /* */ }
      }
      res.json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

// ── FLEET-1405: L/100km ve L/motor-saat tüketim hesap motoru ────────────
const FLEET_CONSUMPTION_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;

/**
 * @swagger
 * /fleet/consumption:
 *   get:
 *     summary: Dönemsel Tüketim Raporu — L/100km / L/saat (FLEET-1405)
 *     description: >
 *       `?periodLabel=YYYY-AA` (zorunlu), `?vehicleId=` (verilmezse tüm aktif
 *       filo). Dönem başı/sonu sayaç okuması eksikse veya kullanım
 *       sıfır/negatifse o araç EKSIK_VERI/GECERSIZ_VERI olarak işaretlenip
 *       hesaptan (ortalamalardan) dışlanır — tahmini değer üretilmez (Kritik Not).
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/fleet/consumption',
  authenticateJWT,
  authorizeRoles(...FLEET_CONSUMPTION_ROLES),
  validateRequest({ query: fleetConsumptionQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { periodLabel: string; vehicleId?: string };
      res.json({ success: true, data: await getFleetConsumptionReport(q.periodLabel, q.vehicleId) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /fleet/consumption/comparison:
 *   get:
 *     summary: Araç Tipi/Şantiye Bazında Ortalama + Sapma (FLEET-1405)
 *     description: '?periodLabel=YYYY-AA, ?groupBy=vehicle_type|site_name (varsayılan vehicle_type)'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/fleet/consumption/comparison',
  authenticateJWT,
  authorizeRoles(...FLEET_CONSUMPTION_ROLES),
  validateRequest({ query: fleetComparisonQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { periodLabel: string; groupBy: 'vehicle_type' | 'site_name' };
      res.json({ success: true, data: await getFleetConsumptionComparison(q.periodLabel, q.groupBy) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /fleet/consumption/trend:
 *   get:
 *     summary: Araç Bazlı Dönem Karşılaştırması / Trend (FLEET-1405)
 *     description: '?vehicleId= (zorunlu), ?periods= (2-24, varsayılan 6) — son N ayın peş peşe raporu + % değişim.'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/fleet/consumption/trend',
  authenticateJWT,
  authorizeRoles(...FLEET_CONSUMPTION_ROLES),
  validateRequest({ query: fleetTrendQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { vehicleId: string; periods: number };
      res.json({ success: true, data: await getFleetConsumptionTrend(q.vehicleId, q.periods) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /fleet/consumption/anomaly:
 *   get:
 *     summary: Araç Tüketim Anomalisi Önizleme (AI-503)
 *     description: >
 *       `?vehicleId=&periodLabel=YYYY-AA`. Aracın kendi geçmişine (z-score +
 *       %sapma) ve aynı tipteki benzerlerine (peer, bilgi amaçlı) göre
 *       değerlendirir. Alarm ÜRETMEZ (salt önizleme) — yalnızca
 *       POST /fleet/consumption/anomaly-scan alarm oluşturur. Geçmişi
 *       <3 dönem olan araçlar için anomalous her zaman false (AC).
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/fleet/consumption/anomaly',
  authenticateJWT,
  authorizeRoles(...FLEET_CONSUMPTION_ROLES),
  validateRequest({ query: vehicleConsumptionAnomalyQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { vehicleId: string; periodLabel: string };
      res.json({ success: true, data: await getVehicleConsumptionAnomaly(q.vehicleId, q.periodLabel) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /fleet/consumption/anomaly-scan:
 *   post:
 *     summary: Filo Geneli Tüketim Anomalisi Taraması (AI-503)
 *     description: >
 *       `{ periodLabel }`. Tüm aktif filoyu tarar; tespit edilen anomaliler
 *       AI-507 birleşik alarm yaşam döngüsüne (CONSUMPTION_ANOMALY kategorisi)
 *       akar. Yalnızca SUPER_ADMIN/COMPANY_OWNER.
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/fleet/consumption/anomaly-scan',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER'),
  validateRequest({ body: consumptionAnomalyScanSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await scanConsumptionAnomalies(req.body.periodLabel);
      const tenantId = req.user?.tenantId;
      if (tenantId && result.anomalies > 0) {
        try {
          broadcastToTenant(tenantId, 'consumption-anomaly:scanned', { periodLabel: result.periodLabel, anomalies: result.anomalies });
        } catch { /* */ }
      }
      res.json({ success: true, data: { periodLabel: result.periodLabel, scanned: result.scanned, anomalies: result.anomalies, insufficientData: result.insufficientData, results: result.results } });
    } catch (error: any) {
      next(error);
    }
  }
);

// ── FLEET-1406: araç bazlı dönemsel yakıt limiti ────────────────────────
const VEHICLE_LIMIT_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;
// Geçici artış onayı yalnızca üst düzey — bir SITE_MANAGER kendi koyduğu
// limiti kendine geçici olarak artıramaz (AC: "onay" gerçek bir onay olmalı).
const VEHICLE_LIMIT_APPROVER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER'] as const;

/**
 * @swagger
 * /vehicles/{id}/fuel-limit:
 *   put:
 *     summary: Araç Yakıt Limiti Tanımla/Güncelle (FLEET-1406)
 *     description: >
 *       `{ periodType, limitLiters, enforcement, status? }`. `enforcement`
 *       REJECT ise limit dolunca ikmal reddedilir/kısılır; WARN ise yalnızca
 *       AI-507 alarmı üretilir, ikmal engellenmez. Çapraz şantiye kotasından
 *       (FUEL-402) FARKLI bir kavramdır — ikisi birlikte değerlendirilir, en
 *       kısıtlayıcı olan kazanır.
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Araç Yakıt Limiti + Anlık Kullanım (FLEET-1406)
 *     description: 'Limit tanımlı değilse hasLimit:false döner. 5 sn önbelleklidir.'
 *     security:
 *       - bearerAuth: []
 */
router.put(
  '/vehicles/:id/fuel-limit',
  authenticateJWT,
  authorizeRoles(...VEHICLE_LIMIT_MANAGER_ROLES),
  validateRequest({ body: setVehicleFuelLimitSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const limit = await setVehicleFuelLimit(req.params.id, req.body, req.user!.userId);
      res.json({ success: true, data: limit });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/vehicles/:id/fuel-limit',
  authenticateJWT,
  authorizeRoles(...VEHICLE_LIMIT_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getVehicleFuelLimitBalance(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /vehicles/{id}/fuel-limit/temporary-increase:
 *   post:
 *     summary: Geçici Limit Artışı — Onaylı (FLEET-1406)
 *     description: >
 *       `{ additionalLiters, untilDate, reason }`. Kalıcı limiti DEĞİŞTİRMEZ;
 *       yalnızca belirtilen tarihe kadar geçerli bir ek pay tanımlar. Yalnızca
 *       SUPER_ADMIN/COMPANY_OWNER onaylayabilir (audit'lenir — AC).
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/vehicles/:id/fuel-limit/temporary-increase',
  authenticateJWT,
  authorizeRoles(...VEHICLE_LIMIT_APPROVER_ROLES),
  validateRequest({ body: temporaryFuelLimitIncreaseSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const limit = await approveTemporaryFuelLimitIncrease(req.params.id, req.body, req.user!.userId);
      res.json({ success: true, data: limit });
    } catch (error: any) {
      next(error);
    }
  }
);

const DESPATCH_TRANSMISSION_VIEW_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;
// Kuyruğu manuel süpürmek (normalde her ~1 dk'da bir otomatik çalışan
// setInterval'ı beklemeden) idari bir eylem — AI-503'ün anomaly-scan
// endpoint'iyle AYNI kısıtlama.
const DESPATCH_TRANSMISSION_SWEEP_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER'] as const;

/**
 * @swagger
 * /transactions/{id}/e-irsaliye/transmit:
 *   post:
 *     summary: e-İrsaliyeyi Entegratör İletim Kuyruğuna Al (COMP-602.1)
 *     description: >
 *       Belge no + ETTN tahsis eder (COMP-601 ile idempotent), UBL XML'ini
 *       üretip XSD'ye karşı doğrular ve `despatch_advice_transmissions`
 *       kuyruğuna QUEUED olarak ekler. Alıcı KAĞIT süreçteyse (COMP-605)
 *       409 döner — elektronik iletim kuyruğa alınamaz. Aynı belge için
 *       tekrar çağrılırsa mevcut kuyruk satırı (durumu ne olursa olsun)
 *       döner, yeniden kuyruğa EKLENMEZ.
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/transactions/:id/e-irsaliye/transmit',
  authenticateJWT,
  authorizeRoles(...DESPATCH_TRANSMISSION_VIEW_ROLES),
  validateRequest({ body: enqueueDespatchAdviceTransmissionSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const record = await enqueueDespatchAdviceTransmission(req.params.id, siteScopeFor(req.user!), req.body.recipientTaxId ?? null);
      res.json({ success: true, data: record });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /despatch-advice-transmissions:
 *   get:
 *     summary: e-İrsaliye İletim Kuyruğu/Geçmişi (COMP-602.1)
 *     description: '`?status=&transactionId=` ile filtrelenebilir. En yeni 200 kayıt.'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/despatch-advice-transmissions',
  authenticateJWT,
  authorizeRoles(...DESPATCH_TRANSMISSION_VIEW_ROLES),
  validateRequest({ query: despatchAdviceTransmissionListQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { status?: string; transactionId?: string };
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getDespatchAdviceTransmissions(q) });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/despatch-advice-transmissions/:id',
  authenticateJWT,
  authorizeRoles(...DESPATCH_TRANSMISSION_VIEW_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getDespatchAdviceTransmission(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /despatch-advice-transmissions/sweep:
 *   post:
 *     summary: İletim Kuyruğunu Hemen Süpür (COMP-602.1)
 *     description: >
 *       Otomatik süpürücü (index.ts, her ~1 dk) zaten çalışır; bu endpoint
 *       testler/idari müdahale için AYNI süpürmeyi hemen tetikler. Yalnızca
 *       SUPER_ADMIN/COMPANY_OWNER.
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/despatch-advice-transmissions/sweep',
  authenticateJWT,
  authorizeRoles(...DESPATCH_TRANSMISSION_SWEEP_ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await runDespatchAdviceTransmissionSweepForCurrentTenant() });
    } catch (error: any) {
      next(error);
    }
  }
);

// İptal, red işleminden daha ağır bir hukuki eylem (sertifika üretir) — bu
// yüzden VEHICLE_LIMIT_APPROVER_ROLES/DESPATCH_TRANSMISSION_SWEEP_ROLES ile
// AYNI daha dar rol kümesi. Red/yeniden gönderim ise transmit ile AYNI kapsam.
const DESPATCH_DISPOSITION_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;
const DESPATCH_CANCEL_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER'] as const;

/**
 * @swagger
 * /transactions/{id}/e-irsaliye/status:
 *   get:
 *     summary: e-İrsaliye Yaşam Döngüsü Durumu (COMP-603)
 *     description: 'ISSUED | REJECTED | CANCELLED | SUPERSEDED. Belge yoksa 404.'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/transactions/:id/e-irsaliye/status',
  authenticateJWT,
  authorizeRoles(...DESPATCH_TRANSMISSION_VIEW_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getDespatchAdviceStatus(req.params.id, siteScopeFor(req.user!)) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /transactions/{id}/e-irsaliye/reject:
 *   post:
 *     summary: Alıcı Reddi Kaydet (COMP-603)
 *     description: >
 *       `{ reason }`. Yalnızca GERÇEKTEN gönderilmiş (SENT) bir belge
 *       reddedilebilir. Red sebebi kaydedilir — düzeltme için
 *       POST .../resubmit ile yeni belge numarası alınır.
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/transactions/:id/e-irsaliye/reject',
  authenticateJWT,
  authorizeRoles(...DESPATCH_DISPOSITION_ROLES),
  validateRequest({ body: rejectDespatchAdviceSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await rejectDespatchAdvice(req.params.id, req.body.reason, siteScopeFor(req.user!)) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /transactions/{id}/e-irsaliye/cancel:
 *   post:
 *     summary: Belgeyi İptal Et — Sertifika Üretir (COMP-603)
 *     description: >
 *       `{ reason }`. Yasal iptal süresi (72 saat) aşılmışsa 400. Yalnızca
 *       SUPER_ADMIN/COMPANY_OWNER. Simüle edilmiş bir iptal sertifika
 *       referansı üretir (gerçek HSM/PKI bu ortamda yok — COMP-601 ile
 *       AYNI kapsam sınırı).
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/transactions/:id/e-irsaliye/cancel',
  authenticateJWT,
  authorizeRoles(...DESPATCH_CANCEL_ROLES),
  validateRequest({ body: cancelDespatchAdviceSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await cancelDespatchAdvice(req.params.id, req.body.reason, siteScopeFor(req.user!)) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /transactions/{id}/e-irsaliye/resubmit:
 *   post:
 *     summary: Düzeltip Yeniden Gönder — Yeni Belge No (COMP-603)
 *     description: >
 *       Yalnızca REJECTED veya CANCELLED durumundaki bir belge için. Eski
 *       belge SUPERSEDED olur, YENİ bir belge numarası + ETTN tahsis edilir.
 *       Yeni belge otomatik iletim kuyruğuna EKLENMEZ — ayrıca
 *       POST .../transmit çağrılmalıdır.
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/transactions/:id/e-irsaliye/resubmit',
  authenticateJWT,
  authorizeRoles(...DESPATCH_DISPOSITION_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await resubmitDespatchAdvice(req.params.id, siteScopeFor(req.user!)) });
    } catch (error: any) {
      next(error);
    }
  }
);

const MAINTENANCE_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;
const MAINTENANCE_SCAN_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER'] as const;

/**
 * @swagger
 * /vehicles/{id}/maintenance-records:
 *   post:
 *     summary: Bakım-Servis Kaydı Ekle (FLEET-1407)
 *     description: '`{ maintenanceType, performedAt, odometerValue?, costAmount, operationsDescription, nextDueDate?, nextDueMeterValue? }`. Append-only — düzeltme yeni kayıtla yapılır.'
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Aracın Bakım Geçmişi (FLEET-1407)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/vehicles/:id/maintenance-records',
  authenticateJWT,
  authorizeRoles(...MAINTENANCE_MANAGER_ROLES),
  validateRequest({ body: createVehicleMaintenanceRecordSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const record = await createVehicleMaintenanceRecord(req.params.id, req.body, req.user!.userId);
      res.status(201).json({ success: true, data: record });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/vehicles/:id/maintenance-records',
  authenticateJWT,
  authorizeRoles(...MAINTENANCE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getVehicleMaintenanceRecords(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /vehicles/{id}/total-cost-of-ownership:
 *   get:
 *     summary: Araç Bazlı Toplam Sahip Olma Maliyeti (FLEET-1407)
 *     description: >
 *       `?sinceDate=YYYY-AA-GG` (opsiyonel). Bakım maliyeti (gerçek) + yakıt
 *       maliyeti (fuel_intake_receipts'in litre-ağırlıklı ortalama birim
 *       fiyatıyla TAHMİNİ — ikmal kayıtları birim fiyat taşımıyor).
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/vehicles/:id/total-cost-of-ownership',
  authenticateJWT,
  authorizeRoles(...MAINTENANCE_MANAGER_ROLES),
  validateRequest({ query: totalCostOfOwnershipQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { sinceDate?: string };
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getVehicleTotalCostOfOwnership(req.params.id, q.sinceDate) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /maintenance-records/{id}:
 *   get:
 *     summary: Tekil Bakım Kaydı (FLEET-1407)
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/maintenance-records/:id',
  authenticateJWT,
  authorizeRoles(...MAINTENANCE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getVehicleMaintenanceRecord(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /maintenance-records/{id}/consumption-impact:
 *   get:
 *     summary: Bakım Öncesi/Sonrası Tüketim Karşılaştırması (FLEET-1407)
 *     description: 'Bakım tarihinden önceki/sonraki 30 günlük L/100km (veya L/motor-saat) karşılaştırması.'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/maintenance-records/:id/consumption-impact',
  authenticateJWT,
  authorizeRoles(...MAINTENANCE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getMaintenanceConsumptionImpact(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /fleet/maintenance/upcoming:
 *   get:
 *     summary: Yaklaşan/Geciken Bakımlar (FLEET-1407)
 *     security:
 *       - bearerAuth: []
 * /fleet/maintenance/reminder-scan:
 *   post:
 *     summary: Bakım Hatırlatma Taramasını Şimdi Çalıştır (FLEET-1407)
 *     description: 'Otomatik günlük süpürücü zaten çalışır; bu AI-507 alarmı hemen tetikler. Yalnızca SUPER_ADMIN/COMPANY_OWNER.'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/fleet/maintenance/upcoming',
  authenticateJWT,
  authorizeRoles(...MAINTENANCE_MANAGER_ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getUpcomingMaintenanceReminders() });
    } catch (error: any) {
      next(error);
    }
  }
);

router.post(
  '/fleet/maintenance/reminder-scan',
  authenticateJWT,
  authorizeRoles(...MAINTENANCE_SCAN_ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await runMaintenanceReminderSweepForCurrentTenant() });
    } catch (error: any) {
      next(error);
    }
  }
);

const COMPLIANCE_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;
const COMPLIANCE_SCAN_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER'] as const;

/**
 * @swagger
 * /vehicles/{id}/compliance-deadlines:
 *   post:
 *     summary: Muayene/Egzoz/Sigorta Son Tarihi Ekle (FLEET-1408)
 *     description: '`{ deadlineType, issuedAt, dueDate, referenceNo?, note? }`. Append-only — yenileme yeni kayıtla yapılır.'
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Aracın Yasal Teslim Tarihi Geçmişi (FLEET-1408)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/vehicles/:id/compliance-deadlines',
  authenticateJWT,
  authorizeRoles(...COMPLIANCE_MANAGER_ROLES),
  validateRequest({ body: addVehicleComplianceDeadlineSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const record = await addVehicleComplianceDeadline(req.params.id, req.body, req.user!.userId);
      res.status(201).json({ success: true, data: record });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/vehicles/:id/compliance-deadlines',
  authenticateJWT,
  authorizeRoles(...COMPLIANCE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getVehicleComplianceDeadlines(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/vehicles/:id/compliance-deadlines/current',
  authenticateJWT,
  authorizeRoles(...COMPLIANCE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getCurrentVehicleComplianceDeadlines(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /vehicles/{id}/tires:
 *   post:
 *     summary: Lastik Kaydı/Değişimi (FLEET-1408)
 *     description: >
 *       `{ position, brandModel?, installedAt, installedMeterValue, expectedLifespanKm, treadDepthMm }`.
 *       Aynı konumda aktif bir lastik varsa otomatik "DEĞİŞTİRİLDİ" işaretlenir.
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Aracın Lastikleri (FLEET-1408)
 *     description: '`?includeReplaced=true` ile değiştirilmiş lastikler de listelenir.'
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/vehicles/:id/tires',
  authenticateJWT,
  authorizeRoles(...COMPLIANCE_MANAGER_ROLES),
  validateRequest({ body: registerVehicleTireSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const tire = await registerVehicleTire(req.params.id, req.body, req.user!.userId);
      res.status(201).json({ success: true, data: tire });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/vehicles/:id/tires',
  authenticateJWT,
  authorizeRoles(...COMPLIANCE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getVehicleTires(req.params.id, req.query.includeReplaced === 'true') });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /tires/{id}/tread-depth:
 *   patch:
 *     summary: Diş Derinliği Ölçümü Kaydet (FLEET-1408)
 *     description: '`{ treadDepthMm, measuredAt }`. Sadece AKTİF lastikler için.'
 *     security:
 *       - bearerAuth: []
 */
router.patch(
  '/tires/:id/tread-depth',
  authenticateJWT,
  authorizeRoles(...COMPLIANCE_MANAGER_ROLES),
  validateRequest({ body: recordTireTreadDepthSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const tire = await recordTireTreadDepth(req.params.id, req.body.treadDepthMm, req.body.measuredAt);
      res.json({ success: true, data: tire });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/tires/:id/status',
  authenticateJWT,
  authorizeRoles(...COMPLIANCE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getVehicleTireStatus(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /fleet/compliance/dashboard:
 *   get:
 *     summary: Filo Uygunluk Panosu (FLEET-1408)
 *     description: 'Yaklaşan/geciken muayene-egzoz-sigorta + lastik değişimi ihtiyacı. Geciken kalemler critical:true.'
 *     security:
 *       - bearerAuth: []
 * /fleet/compliance/scan:
 *   post:
 *     summary: Uygunluk Taramasını Şimdi Çalıştır (FLEET-1408)
 *     description: 'Otomatik günlük süpürücü zaten çalışır; bu AI-507 alarmını hemen tetikler. Yalnızca SUPER_ADMIN/COMPANY_OWNER.'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/fleet/compliance/dashboard',
  authenticateJWT,
  authorizeRoles(...COMPLIANCE_MANAGER_ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getFleetComplianceDashboard() });
    } catch (error: any) {
      next(error);
    }
  }
);

router.post(
  '/fleet/compliance/scan',
  authenticateJWT,
  authorizeRoles(...COMPLIANCE_SCAN_ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await runFleetComplianceSweepForCurrentTenant() });
    } catch (error: any) {
      next(error);
    }
  }
);

const INVENTORY_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;
const INVENTORY_SCAN_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER'] as const;

/**
 * @swagger
 * /inventory-items:
 *   post:
 *     summary: Malzeme Kartı Oluştur (INV-1506)
 *     description: '`{ code, name, unit, siteName?, storageLocation?, criticalStockLevel, initialStock? }`.'
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Malzeme Kartlarını Listele (INV-1506)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/inventory-items',
  authenticateJWT,
  authorizeRoles(...INVENTORY_MANAGER_ROLES),
  validateRequest({ body: createInventoryItemSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const item = await createInventoryItem(req.body, req.user!.userId);
      res.status(201).json({ success: true, data: item });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/inventory-items',
  authenticateJWT,
  authorizeRoles(...INVENTORY_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getInventoryItems(siteScopeFor(req.user!)) });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/inventory-items/:id',
  authenticateJWT,
  authorizeRoles(...INVENTORY_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getInventoryItem(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /inventory-items/{id}/movements:
 *   post:
 *     summary: Stok Hareketi Kaydet — Giriş/Çıkış (INV-1506)
 *     description: >
 *       `{ movementType: 'GİRİŞ'|'ÇIKIŞ', quantity, relatedVehicleId?, relatedMaintenanceRecordId?, note? }`.
 *       Stok kritik eşiğe düşer/altına inerse anında AI-507 (INVENTORY_LOW_STOCK) alarmı üretir.
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Malzeme Kartının Hareket Geçmişi (INV-1506)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/inventory-items/:id/movements',
  authenticateJWT,
  authorizeRoles(...INVENTORY_MANAGER_ROLES),
  validateRequest({ body: recordInventoryMovementSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const movement = await recordInventoryMovement(req.params.id, req.body, req.user!.userId);
      res.status(201).json({ success: true, data: movement });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/inventory-items/:id/movements',
  authenticateJWT,
  authorizeRoles(...INVENTORY_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getInventoryMovements(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /inventory-items/{id}/count:
 *   post:
 *     summary: Envanter Sayımı — Fark Otomatik Düzeltme Kaydı (INV-1506)
 *     description: '`{ countedQuantity, note? }`. Fiziksel sayılan miktar girilir; fark SAYIM_DÜZELTME olarak kaydedilir.'
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/inventory-items/:id/count',
  authenticateJWT,
  authorizeRoles(...INVENTORY_MANAGER_ROLES),
  validateRequest({ body: recordInventoryCountSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const movement = await recordInventoryCount(req.params.id, req.body.countedQuantity, req.body.note, req.user!.userId);
      res.status(201).json({ success: true, data: movement });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /inventory/critical-stock:
 *   get:
 *     summary: Kritik Stoktaki Malzemeler (INV-1506)
 *     security:
 *       - bearerAuth: []
 * /inventory/critical-stock-scan:
 *   post:
 *     summary: Kritik Stok Taramasını Şimdi Çalıştır (INV-1506)
 *     description: 'Otomatik günlük süpürücü zaten çalışır; bu AI-507 alarmını hemen tetikler. Yalnızca SUPER_ADMIN/COMPANY_OWNER.'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/inventory/critical-stock',
  authenticateJWT,
  authorizeRoles(...INVENTORY_MANAGER_ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getCriticalStockItems() });
    } catch (error: any) {
      next(error);
    }
  }
);

router.post(
  '/inventory/critical-stock-scan',
  authenticateJWT,
  authorizeRoles(...INVENTORY_SCAN_ROLES),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await runInventoryCriticalStockSweepForCurrentTenant() });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * FUEL-404.1 — K-Factor Uzaktan Kalibrasyon: Komut, Ack, Geri Alma, Geçmiş.
 * Ticket'ın "Teknik Yığın"ı NestJS + IOT-305 komut kuyruğu + Drizzle
 * öneriyor — IOT-305 (genel amaçlı bir komut kuyruğu servisi) bu kod
 * tabanında hiç yok; FUEL-401'de zaten inşa edilen mqttService.publishCommand
 * (FORCE_CUTOFF için kullanılan aynı mekanizma) yeniden kullanıldı. Cihazın
 * ack/nack'ı, sync-batch/dispense-finalize ile AYNI desende bir HMAC
 * korumalı HTTP ucuna (POST /telemetry/calibration-ack) POST edilir — MQTT
 * üzerinden bir "ack topic'i" dinlemek yerine (mqttClient.ts'e yeni bir
 * abonelik + tenant/cihaz eşleştirme mantığı eklemeyi gerektirirdi, IOT-301
 * dayanıklılık testlerini de etkileme riski taşırdı).
 */
router.post(
  '/devices/:deviceId/calibration',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  validateRequest({ body: requestCalibrationSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const command = await requestKFactorCalibration({
        deviceId: req.params.deviceId,
        newKFactor: req.body.newKFactor,
        reason: req.body.reason,
        referenceMeasurement: req.body.referenceMeasurement,
        requestedByUserId: req.user!.userId
      });

      if (command.status === 'BEKLIYOR') {
        mqttService.publishCommand(req.params.deviceId, 'SET_K_FACTOR', { commandId: command.id, newKFactor: command.new_k_factor });
        await markCalibrationSent(command.id);
      }

      res.json({
        success: true,
        message: command.status === 'IKINCI_ONAY_BEKLIYOR'
          ? 'Değişiklik %20 eşiğini aştığından ikinci onay bekleniyor — cihaza HENÜZ gönderilmedi.'
          : 'Kalibrasyon komutu cihaza gönderildi, ack bekleniyor.',
        data: command
      });
    } catch (error: any) {
      next(error);
    }
  }
);

router.post(
  '/devices/:deviceId/calibration/:commandId/approve',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const command = await approveKFactorCalibration(req.params.commandId, req.user!.userId);
      mqttService.publishCommand(req.params.deviceId, 'SET_K_FACTOR', { commandId: command.id, newKFactor: command.new_k_factor });
      await markCalibrationSent(command.id);
      res.json({ success: true, message: 'İkinci onay verildi, kalibrasyon komutu cihaza gönderildi.', data: command });
    } catch (error: any) {
      next(error);
    }
  }
);

router.post(
  '/devices/:deviceId/calibration/rollback',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const command = await rollbackKFactorCalibration(req.params.deviceId, req.user!.userId);
const LAB_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;

/**
 * @swagger
 * /lab-samples:
 *   post:
 *     summary: Laboratuvar Numunesi Kaydet (INV-1507)
 *     description: '`{ sampleType, siteName, location?, referenceNo?, collectedAt, note? }`.'
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Numuneleri Listele (INV-1507)
 *     description: '`?status=&siteName=` filtreleri (SITE_MANAGER kendi şantiyesiyle kısıtlıdır).'
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/lab-samples',
  authenticateJWT,
  authorizeRoles(...LAB_MANAGER_ROLES),
  validateRequest({ body: createLabSampleSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const sample = await createLabSample(req.body, req.user!.userId);
      res.status(201).json({ success: true, data: sample });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/lab-samples',
  authenticateJWT,
  authorizeRoles(...LAB_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      res.json({ success: true, data: await getLabSamples({ siteRestriction: siteScopeFor(req.user!), status }) });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/lab-samples/:id',
  authenticateJWT,
  authorizeRoles(...LAB_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getLabSample(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /lab-samples/{id}/cancel:
 *   post:
 *     summary: Numuneyi İptal Et (INV-1507)
 *     description: '`{ reason }`.'
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/lab-samples/:id/cancel',
  authenticateJWT,
  authorizeRoles(...LAB_MANAGER_ROLES),
  validateRequest({ body: cancelLabSampleSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await cancelLabSample(req.params.id, req.body.reason, req.user!.userId) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /lab-samples/{id}/results:
 *   post:
 *     summary: Test Sonucu Kaydet (INV-1507)
 *     description: >
 *       `{ testType, testedAt, resultValue?, unit?, specMin?, specMax?, conformity?, note? }`.
 *       Append-only. UYGUNSUZ sonuç AI-507'ye (LAB_NONCONFORMING_RESULT, CRITICAL) akar.
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Numunenin Test Sonuçları (INV-1507)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/lab-samples/:id/results',
  authenticateJWT,
  authorizeRoles(...LAB_MANAGER_ROLES),
  validateRequest({ body: recordLabTestResultSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await recordLabTestResult(req.params.id, req.body, req.user!.userId);
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/lab-samples/:id/results',
  authenticateJWT,
  authorizeRoles(...LAB_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getLabTestResults(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /lab/nonconforming-results:
 *   get:
 *     summary: Şartname Dışı (UYGUNSUZ) Sonuçlar — Geçmiş Rapor (INV-1507)
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/lab/nonconforming-results',
  authenticateJWT,
  authorizeRoles(...LAB_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, data: await getNonConformingLabResults(siteScopeFor(req.user!)) });
    } catch (error: any) {
      next(error);
    }
  }
);

      mqttService.publishCommand(req.params.deviceId, 'SET_K_FACTOR', { commandId: command.id, newKFactor: command.new_k_factor });
      await markCalibrationSent(command.id);
      res.json({ success: true, message: 'Bir önceki onaylı kalibrasyona geri alma komutu gönderildi.', data: command });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/devices/:deviceId/calibration-history',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const history = await getCalibrationHistory(req.params.deviceId);
      res.json({ success: true, totalCount: history.length, data: history });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * FUEL-404.2 — Kalibrasyon Test Alımı Sihirbazı (Referans Kap ile Sapma
 * Hesabı). Ticket'ın FE-814 sihirbaz arayüzü kapsam dışı (bu backend-only
 * bir oturum) — burada yalnızca teknisyenin elle girdiği ölçümü işleyip
 * sapma/öneriyi hesaplayan API var. #68 (FW-1304, akışmetre pals sayımı)
 * bir firmware bağımlılığı ve bu proje ESP-IDF firmware içermiyor — test
 * alımının "gerçek" tarafı (cihazın fiilen dispense edip totalizatör
 * okuması) zaten var olan dispense/telemetri altyapısıyla saha teknisyeni
 * tarafından fiziksel olarak yapılır, buradaki uç yalnızca SONUCU
 * (referans hacim + ölçülen hacim) kaydeder.
 */
router.post(
  '/devices/:deviceId/test-intake',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  validateRequest({ body: testIntakeSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await recordCalibrationTestIntake({
        deviceId: req.params.deviceId,
        tankName: req.body.tankName,
        siteName: req.body.siteName,
        referenceVolumeLiters: req.body.referenceVolumeLiters,
        measuredLiters: req.body.measuredLiters,
        ambientTemperatureCelsius: req.body.ambientTemperatureCelsius,
        verifiesCalibrationCommandId: req.body.verifiesCalibrationCommandId,
        requestedByUserId: req.user!.userId
      });
      res.json({
        success: true,
        message: result.basedOnSingleMeasurement
          ? 'Test alımı kaydedildi. Yalnızca tek ölçüme dayanıyor — güvenilir bir öneri için en az bir test alımı daha yapılması önerilir.'
          : 'Test alımı kaydedildi.',
        data: result.intake,
        recommendedKFactor: result.recommendedKFactor,
        basedOnSingleMeasurement: result.basedOnSingleMeasurement
      });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/devices/:deviceId/test-intakes',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const intakes = await getCalibrationTestIntakes(req.params.deviceId);
      res.json({ success: true, totalCount: intakes.length, data: intakes });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * FUEL-410 — Hibrit Fail-Open Politika Motoru. Ticket'ın "Teknik Yığın"ı
 * IOT-305 komut kuyruğu + FW-1310 + Drizzle + REP-711 öneriyor — hiçbiri bu
 * kod tabanında yok. Politika, MQTT/komut kuyruğuyla cihaza İTİLMİYOR;
 * cihaz periyodik olarak GET /telemetry/fail-open-policy ile ÇEKİYOR (mevcut
 * dispense/sync-batch/calibration-ack'in HMAC korumalı HTTP deseniyle
 * tutarlı) — "dağıtım bekliyor" durumu, cihazın en son çektiği politika
 * id'sinin GEÇERLİ id'den farklı olmasıyla izleniyor.
 */
router.post(
  '/policies/fail-open',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  validateRequest({ body: setFailOpenPolicySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const policy = await setFailOpenPolicy({
        siteName: req.body.siteName,
        offlineDispenseAllowed: req.body.offlineDispenseAllowed,
        maxLitersPerVehicle: req.body.maxLitersPerVehicle,
        maxDailyDispensesPerVehicle: req.body.maxDailyDispensesPerVehicle,
        whitelistFreshnessHours: req.body.whitelistFreshnessHours,
        failClose: req.body.failClose,
        updatedByUserId: req.user!.userId
      });
      res.json({ success: true, message: 'Fail-open politikası kaydedildi.', data: policy });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/policies/fail-open',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const policies = await getFailOpenPolicies();
      res.json({ success: true, totalCount: policies.length, data: policies });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/policies/fail-open/deployment-status',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const status = await getFailOpenPolicyDeploymentStatus();
      res.json({ success: true, totalCount: status.length, data: status });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/policies/fail-open/offline-ratio-alerts',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const alerts = await getOfflineDispenseRatioAlerts();
      res.json({ success: true, totalCount: alerts.length, data: alerts });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /ai/consumption-anomaly-reports:
 *   post:
 *     summary: Şoför/Araç Tüketim Anomali Analizi Üret (AI-502)
 *     description: >
 *       Son N gündeki (varsayılan 7) ikmalleri araç/şoför bazında özetleyip
 *       Google Gemini'ye analiz ettirir; sonuç Zod ile doğrulanıp kalıcı
 *       olarak saklanır. Tenant'ta `aiAnomaly` modülü kapalıysa 403,
 *       GEMINI_API_KEY tanımlı değilse 503 döner.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Rapor üretildi ve kaydedildi.
 *       403:
 *         description: aiAnomaly modülü bu tenant için kapalı.
 *       503:
 *         description: GEMINI_API_KEY yapılandırılmamış veya AI servisine ulaşılamadı.
 */
router.post(
  '/ai/consumption-anomaly-reports',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  validateRequest({ body: generateAnomalyReportSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const enabled = await isTenantModuleEnabled('aiAnomaly');
      if (!enabled) {
        throw new ForbiddenError('Tüketim anomali analizi (aiAnomaly) modülü bu firma için kapatılmış.');
      }
      const { periodDays } = req.body as { periodDays: number };
      const report = await generateAndStoreAnomalyReport(periodDays, req.user!.userId);
      res.json({ success: true, data: report });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /ai/consumption-anomaly-reports:
 *   get:
 *     summary: Geçmiş Tüketim Anomali Raporlarını Listele (AI-502)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Rapor geçmişi (en yeniden en eskiye).
 */
router.get(
  '/ai/consumption-anomaly-reports',
  authenticateJWT,
  authorizeRoles(...HARDWARE_DEVICE_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const reports = await getConsumptionAnomalyReports();
      res.json({ success: true, totalCount: reports.length, data: reports });
    } catch (error: any) {
      next(error);
    }
  }
);

// ── AI-504: mesai dışı / kısa aralıklı mükerrer alım tespiti ────────────
const ANOMALY_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;
const ANOMALY_SCAN_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER'] as const;

/**
 * @swagger
 * /sites/{siteName}/working-hours:
 *   get:
 *     summary: Şantiye Mesai Saatleri (AI-504)
 *     description: Tanım yoksa varsayılan (07:00-19:00, Pzt-Cmt, is247:false) döner (isDefault:true).
 *     security:
 *       - bearerAuth: []
 *   put:
 *     summary: Şantiye Mesai Saatleri Tanımla/Güncelle (AI-504)
 *     description: >
 *       `{ startMinute, endMinute, workingDays:[1..7], is247?, rapidRepeatWindowMinutes? }`.
 *       is247:true → şantiye mesai-dışı kuralından TAMAMEN muaf (7/24 / vardiyalı).
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/sites/:siteName/working-hours',
  authenticateJWT,
  authorizeRoles(...ANOMALY_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getSiteWorkingHours(decodeURIComponent(req.params.siteName)) });
    } catch (error: any) {
      next(error);
    }
  }
);

router.put(
  '/sites/:siteName/working-hours',
  authenticateJWT,
  authorizeRoles(...ANOMALY_MANAGER_ROLES),
  validateRequest({ body: setWorkingHoursSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const rec = await setSiteWorkingHours(decodeURIComponent(req.params.siteName), req.body, req.user!.userId);
      res.json({ success: true, data: rec });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /anomaly-flags/scan:
 *   post:
 *     summary: Anomali Taramasını Şimdi Çalıştır (AI-504)
 *     description: >
 *       index.ts'teki saatlik süpürücünün yaptığı işi bu tenant için manuel
 *       tetikler. `{ sinceHours? }` (varsayılan 168). Yeni işaretler için
 *       audit_logs (ANOMALY_SCAN) + WebSocket 'anomaly:flagged'. Yalnızca
 *       SUPER_ADMIN / COMPANY_OWNER.
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/anomaly-flags/scan',
  authenticateJWT,
  authorizeRoles(...ANOMALY_SCAN_ROLES),
  validateRequest({ body: scanAnomalySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await runAnomalyDetectionForCurrentTenant({ sinceHours: req.body.sinceHours });
      const tenantId = req.user?.tenantId;
      if (tenantId && result.newFlags.MESAI_DISI + result.newFlags.KISA_ARALIK_MUKERRER > 0) {
        try {
          broadcastToTenant(tenantId, 'anomaly:flagged', { source: 'manual-scan', ...result });
        } catch (broadcastErr) {
          logger.warn({ err: broadcastErr }, '[AI-504] anomaly:flagged yayını başarısız.');
        }
      }
      res.json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /anomaly-flags:
 *   get:
 *     summary: Anomali İnceleme Kuyruğu (AI-504)
 *     description: '?type (MESAI_DISI|KISA_ARALIK_MUKERRER), ?status (ACIK|INCELENDI|MUAF), ?siteName, ?from, ?to'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/anomaly-flags',
  authenticateJWT,
  authorizeRoles(...ANOMALY_MANAGER_ROLES),
  validateRequest({ query: listAnomalyFlagQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { type?: string; status?: string; siteName?: string; from?: string; to?: string };
      const flags = await getAnomalyFlags(q);
      res.json({ success: true, totalCount: flags.length, data: flags });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/anomaly-flags/:id',
  authenticateJWT,
  authorizeRoles(...ANOMALY_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getAnomalyFlag(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

router.patch(
  '/anomaly-flags/:id',
  authenticateJWT,
  authorizeRoles(...ANOMALY_MANAGER_ROLES),
  validateRequest({ body: reviewAnomalyFlagSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const rec = await reviewAnomalyFlag(req.params.id, req.user!.userId, req.body);
      res.json({ success: true, data: rec });
    } catch (error: any) {
      next(error);
    }
  }
);

// ── AI-507: birleşik alarm yaşam döngüsü ───────────────────────────────
const ALARM_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;

/**
 * @swagger
 * /alarms:
 *   get:
 *     summary: Alarm Kuyruğu (AI-507)
 *     description: >
 *       Varsayılan: RESOLVED/FALSE_POSITIVE ve susturulmuş alarmlar HARİÇ,
 *       CRITICAL ve eskalasyon önce. `?status ?category ?severity ?siteName
 *       ?assigneeId ?includeSnoozed=true ?includeResolved=true`.
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/alarms',
  authenticateJWT,
  authorizeRoles(...ALARM_MANAGER_ROLES),
  validateRequest({ query: listAlarmQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const alarms = await getAlarms(req.query as any);
      res.json({ success: true, totalCount: alarms.length, data: alarms });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /alarms/false-positive-feedback:
 *   get:
 *     summary: Yanlış-Pozitif Geri Beslemesi (AI-507)
 *     description: Kategori bazında FALSE_POSITIVE oranları — eşik kalibrasyonu için.
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/alarms/false-positive-feedback',
  authenticateJWT,
  authorizeRoles(...ALARM_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getFalsePositiveFeedback() });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/alarms/:id',
  authenticateJWT,
  authorizeRoles(...ALARM_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getAlarm(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /alarms/{id}:
 *   patch:
 *     summary: Alarm Durum/Atama/Çözüm Güncelle (AI-507)
 *     description: >
 *       `{ status?, assigneeId?, resolutionNote? }`. RESOLVED / FALSE_POSITIVE
 *       için resolutionNote zorunlu. Değişiklik audit_logs'a (ALARM_UPDATED).
 *     security:
 *       - bearerAuth: []
 */
router.patch(
  '/alarms/:id',
  authenticateJWT,
  authorizeRoles(...ALARM_MANAGER_ROLES),
  validateRequest({ body: updateAlarmSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const alarm = await updateAlarm(req.params.id, req.user!.userId, req.body);
      const tenantId = req.user?.tenantId;
      if (tenantId) {
        try { broadcastToTenant(tenantId, 'alarm:updated', { id: alarm.id, status: alarm.status, assigneeId: alarm.assignee_id }); } catch { /* */ }
      }
      res.json({ success: true, data: alarm });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /alarms/{id}/snooze:
 *   post:
 *     summary: Alarmı Sustur (AI-507)
 *     description: '`{ minutes }` (1..43200). Süre boyunca varsayılan listede ve eskalasyonda görünmez.'
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/alarms/:id/snooze',
  authenticateJWT,
  authorizeRoles(...ALARM_MANAGER_ROLES),
  validateRequest({ body: snoozeAlarmSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const alarm = await snoozeAlarm(req.params.id, req.user!.userId, req.body.minutes);
      res.json({ success: true, data: alarm });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /alarms/run-escalation:
 *   post:
 *     summary: Eskalasyon Turunu Şimdi Çalıştır (AI-507)
 *     description: >
 *       index.ts saatlik süpürücüsünün yaptığı işi bu tenant için manuel
 *       tetikler (ops + entegrasyon testi). Yalnızca SUPER_ADMIN.
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/alarms/run-escalation',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const escalated = await runAlarmEscalationForCurrentTenant();
      const tenantId = req.user?.tenantId;
      if (tenantId && escalated.length > 0) {
        try {
          for (const a of escalated) {
            broadcastToTenant(tenantId, 'alarm:escalated', { id: a.id, title: a.title, escalationLevel: a.escalation_level, siteName: a.site_name });
          }
        } catch { /* */ }
      }
      res.json({ success: true, data: { escalatedCount: escalated.length, escalated } });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /telemetry/fail-open-policy:
 *   get:
 *     summary: Cihazın Şantiyesi İçin Geçerli Fail-Open Politikasını Çekmesi (FUEL-410)
 *     description: >
 *       Cihaz bunu periyodik olarak çeker (önerilen: whitelist tazelik
 *       süresinden daha sık) — sunucuya erişemediği anlarda EN SON çektiği
 *       bu politikayı kendi yerel önbelleğinden uygular.
 *     security: []
 *     responses:
 *       200:
 *         description: Geçerli politika döndü.
 */
router.get(
  '/telemetry/fail-open-policy',
  hardwareRateLimiter,
  hardwareAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    const hw = (req as any).authenticatedHardware as { deviceId: string; siteName: string; tenantId: string };
    try {
      const policy = await runWithTenant({ tenantId: hw.tenantId }, async () => {
        const effective = await getEffectiveFailOpenPolicy(hw.siteName);
        await recordFailOpenPolicyDelivery(hw.deviceId, effective.id);
        return effective;
      });
      res.json({ success: true, data: policy });
    } catch (error: any) {
      next(error);
    }
  }
);

// ── AUTH-210: RFID kart kayıp/blokaj/kara liste ──────────────────────────
const RFID_CARD_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;

/**
 * @swagger
 * /rfid-cards/{cardUid}/block:
 *   post:
 *     summary: RFID Kartını Kara Listeye Al (AUTH-210)
 *     description: >
 *       `{ status: 'LOST'|'BLOCKED', reason? }`. Kart derhal ikmal
 *       yetkilendirmesinde (WHITELIST'ten ÖNCE) reddedilir; Redis denylist
 *       cache'i anında invalide edilir (online cihazlar AC 1: 10 sn içinde).
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/rfid-cards/:cardUid/block',
  authenticateJWT,
  authorizeRoles(...RFID_CARD_MANAGER_ROLES),
  validateRequest({ body: blockRfidCardSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const b = req.body as { status: 'LOST' | 'BLOCKED'; reason?: string };
      const record = await blockRfidCard({ cardUid: req.params.cardUid, status: b.status, reason: b.reason }, req.user!.userId);
      res.status(201).json({ success: true, data: record });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /rfid-cards/{cardUid}/unblock:
 *   post:
 *     summary: RFID Kartını Kara Listeden Çıkar — kart bulundu (AUTH-210)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/rfid-cards/:cardUid/unblock',
  authenticateJWT,
  authorizeRoles(...RFID_CARD_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await unblockRfidCard(req.params.cardUid, req.user!.userId);
      res.json({ success: true, ...result });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /rfid-cards/replace:
 *   post:
 *     summary: RFID Kartı Değiştir — geçmişi yeni karta devret (AUTH-210)
 *     description: >
 *       `{ oldCardUid, newCardUid }`. Eski kart REPLACED olarak kara listeye
 *       alınır; drivers.rfid_card_id / vehicles.rfid_tag yeni uid'e taşınır.
 *       İkmal geçmişi (transactions) sürücü adı/plaka ile anahtarlandığından
 *       otomatik korunur. Yeni kart kendisi kara listedeyse 409.
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/rfid-cards/replace',
  authenticateJWT,
  authorizeRoles(...RFID_CARD_MANAGER_ROLES),
  validateRequest({ body: replaceRfidCardSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const b = req.body as { oldCardUid: string; newCardUid: string };
      const result = await replaceRfidCard(b, req.user!.userId);
      res.json({ success: true, data: { ...b, ...result } });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/rfid-cards/denylist',
  authenticateJWT,
  authorizeRoles(...RFID_CARD_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const denylist = await getRfidDenylist();
      res.json({ success: true, totalCount: denylist.length, data: denylist });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /rfid-cards/denylist-deployment-status:
 *   get:
 *     summary: Denylist Dağıtım Durumu — blok komutunu alamayan cihazlar (AUTH-210 AC 3)
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/rfid-cards/denylist-deployment-status',
  authenticateJWT,
  authorizeRoles(...RFID_CARD_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const status = await getRfidDenylistDeploymentStatus();
      const staleCount = status.filter((s) => s.status === 'DAĞITIM_BEKLIYOR').length;
      res.json({ success: true, totalCount: status.length, staleCount, data: status });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /telemetry/rfid-denylist:
 *   get:
 *     summary: Cihazın RFID Kara Listesini Çekmesi (AUTH-210)
 *     description: >
 *       HMAC-doğrulamalı cihaz, kendi tenant'ının güncel denylist'ini
 *       (sürüm + kart uid'leri) çeker; çekiş zamanı/sürümü kaydedilir
 *       (deployment-status bunu izler). Cihaz bu listeyi yerel olarak
 *       DENYLIST'İ WHITELIST'TEN ÖNCE uygulamalıdır (AC 2, firmware tarafı).
 *     security: []
 *     responses:
 *       200:
 *         description: Güncel denylist döndü.
 */
router.get(
  '/telemetry/rfid-denylist',
  hardwareRateLimiter,
  hardwareAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    const hw = (req as any).authenticatedHardware as { deviceId: string; siteName: string; tenantId: string };
    try {
      const payload = await runWithTenant({ tenantId: hw.tenantId }, async () => {
        const dl = await getRfidDenylistForDevice();
        await recordRfidDenylistPull(hw.deviceId, dl.version);
        return dl;
      });
      res.json({ success: true, data: payload });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /telemetry/calibration-ack:
 *   post:
 *     summary: Cihazın Kalibrasyon Komutunu Onaylaması/Reddetmesi (FUEL-404.1)
 *     description: >
 *       AC: "Cihaz onayı alınmadan değişiklik 'uygulandı' gösterilmemelidir."
 *       hardware_devices.k_factor yalnızca ACK üzerine güncellenir.
 *     security: []
 *     responses:
 *       200:
 *         description: Ack/nack işlendi.
 */
router.post(
  '/telemetry/calibration-ack',
  hardwareRateLimiter,
  hardwareAuthMiddleware,
  validateRequest({ body: calibrationAckSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    const hw = (req as any).authenticatedHardware as { deviceId: string; tenantId: string };
    try {
      const command = await runWithTenant({ tenantId: hw.tenantId }, () =>
        req.body.status === 'ACK'
          ? recordCalibrationAck(hw.deviceId, req.body.commandId, req.body.appliedKFactor)
          : recordCalibrationNack(hw.deviceId, req.body.commandId, req.body.reason)
      );
      res.json({ success: true, message: 'Kalibrasyon durumu kaydedildi.', data: command });
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
      // BILL-1702 AC: "limit aşımında yeni kayıt engelleme" — bu uç hem yeni
      // bir ŞANTİYE hem yeni bir KULLANICI (SITE_MANAGER) oluşturduğu için
      // ikisi de kontrol edilir.
      const siteLimit = await isPackageLimitReached(req.user!.tenantId, 'sites');
      if (siteLimit.reached) {
        throw new ConflictError(
          `Paket limitine ulaşıldı: şantiye sayısı (${siteLimit.current}/${siteLimit.limit}). Devam etmek için paketinizi yükseltin.`
        );
      }
      const userLimit = await isPackageLimitReached(req.user!.tenantId, 'users');
      if (userLimit.reached) {
        throw new ConflictError(
          `Paket limitine ulaşıldı: kullanıcı sayısı (${userLimit.current}/${userLimit.limit}). Devam etmek için paketinizi yükseltin.`
        );
      }

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
      // AUTH-208: parola değişimi sonrası taze token çifti — yeni bir oturum
      // ailesi başlatır (eski refresh token ayrıca rotasyon görmediği için).
      const changeSession = await generateRefreshToken(payload.userId, payload.tenantId, {
        userAgent: req.headers['user-agent'] ?? null,
        ipAddress: req.ip ?? null
      });
      const refreshToken = changeSession.token;
      const accessToken = generateAccessToken({ ...payload, sid: changeSession.sessionId });

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
        vehicle_type: sanitizedBody.type || 'Kamyon',
        rfid_tag: sanitizedBody.rfidTag,
        site_name: sanitizedBody.siteName || sanitizedBody.site_name || 'Gebze Ana Şantiye',
        status: sanitizedBody.status || 'AKTİF',
        fuel_capacity_liters: sanitizedBody.fuelCapacityLiters ?? null,
        assigned_driver_name: sanitizedBody.assignedDriver ?? null,
        fuel_type: sanitizedBody.fuelType ?? null,
        meter_type: sanitizedBody.meterType ?? null
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
      const { plate, brandModel, type, rfidTag, siteName, status, fuelCapacityLiters, assignedDriver, fuelType, meterType } = req.body;
      const updateData = {
        ...(plate && { plate }),
        ...(brandModel && { brand_model: brandModel }),
        ...(type && { vehicle_type: type }),
        ...(rfidTag && { rfid_tag: rfidTag }),
        ...(siteName && { site_name: siteName }),
        ...(status && { status }),
        ...(fuelCapacityLiters !== undefined && { fuel_capacity_liters: fuelCapacityLiters }),
        ...(assignedDriver !== undefined && { assigned_driver_name: assignedDriver }),
        ...(fuelType !== undefined && { fuel_type: fuelType }),
        ...(meterType !== undefined && { meter_type: meterType })
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
 * /tanks/{id}/strapping-table:
 *   post:
 *     summary: Tank Daldırma Cetveli / Silindir Formülü Tanımla (FUEL-403.1)
 *     description: >
 *       csvContent (ham CSV), points (nokta dizisi) veya cylinderConfig
 *       alanlarından TAM OLARAK biri. CSV/points monotonluk (mm kesin artan,
 *       litre azalmayan) denetiminden geçmezse 400 + satır bazlı hatalar.
 *       Her çağrı YENİ bir versiyon yazar (geçmiş silinmez); Redis cache
 *       invalide edilir.
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Tank Cetvel Versiyon Geçmişi (FUEL-403.1)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/tanks/:id/strapping-table',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  validateRequest({ body: setStrappingTableSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const tankName = await getTankNameById(req.params.id);
      const b = req.body as { csvContent?: string; points?: any[]; cylinderConfig?: any; notes?: string };

      let points = b.points as { levelMm: number; volumeLiters: number }[] | undefined;
      if (b.csvContent) {
        const parsed = parseStrappingCsv(b.csvContent);
        if (parsed.errors.length > 0) {
          // setTankStrappingTable'ın monotonluk hatasıyla AYNI şekil: details.rows
          res.status(400).json({
            success: false,
            error: 'STRAPPING_CSV_INVALID',
            message: 'CSV cetveli ayrıştırılamadı — satır bazlı hatalar var.',
            details: { rows: parsed.errors }
          });
          return;
        }
        points = parsed.points;
      }

      const result = await setTankStrappingTable(
        tankName,
        { points, cylinderConfig: b.cylinderConfig, notes: b.notes },
        req.user!.userId
      );
      res.status(201).json({ success: true, data: { tankName, ...result } });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/tanks/:id/strapping-table',
  authenticateJWT,
  authorizeRoles('SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const tankName = await getTankNameById(req.params.id);
      const [effective, history] = await Promise.all([
        getEffectiveTankVolumeModel(tankName),
        getTankStrappingTableHistory(tankName)
      ]);
      res.json({ success: true, data: { tankName, effective, versionCount: history.length, history } });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /tanks/{id}/volume:
 *   get:
 *     summary: Seviye→Hacim (ham + 15°C standart) Hesabı (FUEL-403.2)
 *     description: >
 *       ?levelMm=<int> zorunlu, ?tempC=<num> ve ?density15=<num> opsiyonel.
 *       Cetvel/silindir formülü üzerinden lineer interpolasyonla ham hacim +
 *       ASTM D1250 VCF ile 15°C standart hacim. tempC yoksa
 *       temperatureCorrected:false (ham=standart).
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/tanks/:id/volume',
  authenticateJWT,
  validateRequest({ query: tankVolumeQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const tankName = await getTankNameById(req.params.id);
      const q = req.query as unknown as { levelMm: number; tempC?: number; density15?: number };
      const result = await computeTankVolume(tankName, q.levelMm, q.tempC ?? null, q.density15);
      res.json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

// ── FUEL-408: tank dolum (alım irsaliyesi) girişi + stok artışı ──────────
// Dolum bir mali/stok kaydıdır ve tanker teslimatı şantiye sorumlusu
// gözetiminde tutanaklanır — PUMP_OPERATOR bilinçli olarak hariç.
const INTAKE_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;

/**
 * @swagger
 * /tanks/{id}/intakes:
 *   post:
 *     summary: Tank Dolum Kaydı (FUEL-408)
 *     description: >
 *       Tankere ait alım irsaliyesini kaydeder ve tank stoğunu ARTIRIR (tank
 *       satırı FOR UPDATE ile kilitli). `levelAfterLiters` (+ `levelBeforeLiters`)
 *       verilirse beyan ile fiziksel ölçüm 15 °C'ye düzeltilip karşılaştırılır;
 *       fark `tolerancePct` (varsayılan %0.5) eşiğini aşarsa
 *       EKSİK_TESLİMAT_UYARISI üretilir ve şantiyeye WebSocket uyarısı düşer.
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Tank Dolum Geçmişi (FUEL-408)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/tanks/:id/intakes',
  authenticateJWT,
  authorizeRoles(...INTAKE_ROLES),
  validateRequest({ body: createFuelIntakeSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await recordFuelIntake(req.params.id, req.body, req.user!.userId);
      const tenantId = req.user?.tenantId;
      if (tenantId) {
        try {
          broadcastToTenant(tenantId, 'tank:intake', {
            tankId: result.receipt.tank_id,
            tankName: result.receipt.tank_name,
            siteName: result.receipt.site_name,
            addedLiters: Number(result.receipt.added_liters),
            levelAfter: result.tankLevelAfter,
            status: result.receipt.status
          });
          if (result.shortDeliveryAlert) {
            broadcastToTenant(tenantId, 'tank:intake-alert', {
              tankName: result.receipt.tank_name,
              siteName: result.receipt.site_name,
              waybillNo: result.receipt.waybill_no,
              declaredLiters15c: Number(result.receipt.declared_liters_15c),
              measuredLiters15c: result.receipt.measured_liters_15c === null ? null : Number(result.receipt.measured_liters_15c),
              discrepancyLiters: result.receipt.discrepancy_liters === null ? null : Number(result.receipt.discrepancy_liters),
              discrepancyPct: result.receipt.discrepancy_pct === null ? null : Number(result.receipt.discrepancy_pct)
            });
          }
        } catch (broadcastErr) {
          logger.warn({ err: broadcastErr }, '[FUEL-408] tank:intake yayını başarısız (kayıt yine de oluşturuldu).');
        }
      }
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/tanks/:id/intakes',
  authenticateJWT,
  authorizeRoles(...INTAKE_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const intakes = await getFuelIntakes({ tankId: req.params.id });
      res.json({ success: true, totalCount: intakes.length, data: intakes });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /fuel-intakes:
 *   get:
 *     summary: Dolum Kayıtları (filtreli) (FUEL-408)
 *     description: '?tankId, ?status (KAYITLI|EKSİK_TESLİMAT_UYARISI), ?from, ?to (YYYY-AA-GG)'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/fuel-intakes',
  authenticateJWT,
  authorizeRoles(...INTAKE_ROLES),
  validateRequest({ query: listFuelIntakeQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { tankId?: string; status?: string; from?: string; to?: string };
      const intakes = await getFuelIntakes(q);
      res.json({ success: true, totalCount: intakes.length, data: intakes });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/fuel-intakes/:id',
  authenticateJWT,
  authorizeRoles(...INTAKE_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getFuelIntake(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

// ── FUEL-409: teorik vs fiziksel stok mutabakatı + fire hesabı ──────────
const RECONCILIATION_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;

/**
 * @swagger
 * /tanks/{id}/reconciliations:
 *   post:
 *     summary: Stok Mutabakatı Hesapla & Kaydet (FUEL-409)
 *     description: >
 *       teorik = açılış bakiyesi + dolumlar (FUEL-408) − ikmaller − kalibrasyon
 *       test alımları; fiziksel = `physicalLiters` (gerçek kurulumda sensör
 *       anlık görüntüsü). Fark `tolerancePct` (varsayılan ±%1) eşiğini aşarsa
 *       MUTABAKAT_ALARMI + WebSocket uyarısı. Fark, dönem uzunluğuna ölçeklenen
 *       doğal buharlaşma payıyla kıyaslanıp sınıflandırılır (TOLERANS_İÇİ /
 *       BUHARLAŞMA / ÖLÇÜM_HATASI / AÇIKLANAMAYAN). Açılış bakiyesi verilmezse
 *       bu tankın bir önceki mutabakatının fiziksel değeri kullanılır; hiç
 *       yoksa openingBookLiters zorunludur.
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Tank Mutabakat Geçmişi (FUEL-409 / REP-714)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/tanks/:id/reconciliations',
  authenticateJWT,
  authorizeRoles(...RECONCILIATION_ROLES),
  validateRequest({ body: createReconciliationSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await computeStockReconciliation(req.params.id, req.body, req.user!.userId);
      const tenantId = req.user?.tenantId;
      if (tenantId && result.alarm) {
        try {
          const r = result.reconciliation;
          broadcastToTenant(tenantId, 'stock:reconciliation-alert', {
            tankId: r.tank_id,
            tankName: r.tank_name,
            siteName: r.site_name,
            periodType: r.period_type,
            closingBookLiters: Number(r.closing_book_liters),
            physicalLiters: Number(r.physical_liters),
            varianceLiters: Number(r.variance_liters),
            variancePct: Number(r.variance_pct),
            classification: r.classification
          });
        } catch (broadcastErr) {
          logger.warn({ err: broadcastErr }, '[FUEL-409] stock:reconciliation-alert yayını başarısız (kayıt yine de oluşturuldu).');
        }
      }
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/tanks/:id/reconciliations',
  authenticateJWT,
  authorizeRoles(...RECONCILIATION_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const recs = await getStockReconciliations({ tankId: req.params.id });
      res.json({ success: true, totalCount: recs.length, data: recs });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /stock-reconciliations:
 *   get:
 *     summary: Stok Mutabakat Kayıtları (filtreli) (FUEL-409 / REP-714)
 *     description: '?tankId, ?status (NORMAL|MUTABAKAT_ALARMI), ?from, ?to (YYYY-AA-GG)'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/stock-reconciliations',
  authenticateJWT,
  authorizeRoles(...RECONCILIATION_ROLES),
  validateRequest({ query: listReconciliationQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { tankId?: string; status?: string; from?: string; to?: string };
      const recs = await getStockReconciliations(q);
      res.json({ success: true, totalCount: recs.length, data: recs });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/stock-reconciliations/:id',
  authenticateJWT,
  authorizeRoles(...RECONCILIATION_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getStockReconciliation(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

// ── FUEL-405: manuel ikmal girişi (cihaz arızası) + çift onay ───────────
const MANUAL_DISPENSE_APPROVER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;
const MANUAL_DISPENSE_CREATE_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR'] as const;

/**
 * @swagger
 * /manual-dispense-requests:
 *   post:
 *     summary: Manuel İkmal Girişi Oluştur (FUEL-405)
 *     description: >
 *       Cihaz arızası/elle pompa kullanımı durumunda ikmali kayıt altına alır.
 *       Kayıt ONAY_BEKLIYOR durumunda açılır; İKİ FARKLI yetkilinin (bir
 *       SITE_MANAGER + bir COMPANY_OWNER/SUPER_ADMIN) onayı olmadan
 *       kesinleşmez. Geriye dönük tarih en fazla 7 gün.
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Manuel İkmal Kayıtları (FUEL-405)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/manual-dispense-requests',
  authenticateJWT,
  authorizeRoles(...MANUAL_DISPENSE_CREATE_ROLES),
  validateRequest({ body: createManualDispenseSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const rec = await createManualDispenseRequest(req.body, req.user!.userId);
      res.status(201).json({ success: true, data: rec });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/manual-dispense-requests',
  authenticateJWT,
  authorizeRoles(...MANUAL_DISPENSE_APPROVER_ROLES),
  validateRequest({ query: listManualDispenseQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { status?: string; siteName?: string };
      const recs = await getManualDispenseRequests(q);
      res.json({ success: true, totalCount: recs.length, data: recs });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /manual-dispense-requests/ratio:
 *   get:
 *     summary: Şantiye Bazlı Manuel İkmal Oranı + Eşik Uyarısı (FUEL-405)
 *     description: '?siteName, ?days (varsayılan 30), ?thresholdPct (varsayılan 10)'
 *     security:
 *       - bearerAuth: []
 */
router.get(
  '/manual-dispense-requests/ratio',
  authenticateJWT,
  authorizeRoles(...MANUAL_DISPENSE_APPROVER_ROLES),
  validateRequest({ query: manualDispenseRatioQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as { siteName?: string; days: number; thresholdPct: number };
      const result = await getManualDispenseRatio(q);
      res.json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/manual-dispense-requests/:id',
  authenticateJWT,
  authorizeRoles(...MANUAL_DISPENSE_APPROVER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getManualDispenseRequest(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /manual-dispense-requests/{id}/approve:
 *   post:
 *     summary: Manuel İkmal Onayı (FUEL-405)
 *     description: >
 *       İlk onay kaydı ONAY_BEKLIYOR bırakır; ikinci (farklı kullanıcı) onay,
 *       roller birlikte SITE_MANAGER + COMPANY_OWNER/SUPER_ADMIN kuralını
 *       karşılıyorsa kaydı ONAYLANDI yapar, stoğu düşer ve gerçek bir
 *       transactions kaydı üretir (data.transactionId).
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/manual-dispense-requests/:id/approve',
  authenticateJWT,
  authorizeRoles(...MANUAL_DISPENSE_APPROVER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await approveManualDispenseRequest(req.params.id, req.user!.userId, req.user!.role);
      const tenantId = req.user?.tenantId;
      if (tenantId && result.finalized) {
        try {
          broadcastToTenant(tenantId, 'manual-dispense:finalized', {
            id: result.request.id,
            transactionId: result.transactionId,
            vehiclePlate: result.request.vehicle_plate,
            tankName: result.request.tank_name,
            liters: Number(result.request.liters)
          });
        } catch (broadcastErr) {
          logger.warn({ err: broadcastErr }, '[FUEL-405] manual-dispense:finalized yayını başarısız.');
        }
      }
      res.json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

router.post(
  '/manual-dispense-requests/:id/reject',
  authenticateJWT,
  authorizeRoles(...MANUAL_DISPENSE_APPROVER_ROLES),
  validateRequest({ body: rejectManualDispenseSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const rec = await rejectManualDispenseRequest(req.params.id, req.user!.userId, req.body.reason);
      res.json({ success: true, data: rec });
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
 * /transactions/export:
 *   get:
 *     summary: İkmal Geçmişi Excel Dışa Aktarımı (REP-701)
 *     description: >
 *       RLS kurallarına göre oturum açmış firmanın (ve varsa şantiye
 *       kısıtlamasının) ikmal geçmişini, aynı filtrelerle, bellek dostu
 *       stream ile .xlsx olarak indirir. Sayfalama yoktur — filtreye uyan
 *       TÜM kayıtlar tek dosyada, sonunda dinamik bir GENEL TOPLAM
 *       satırıyla birlikte döner.
 *     security:
 *       - bearerAuth: []
 *     parameters:
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
 *         schema: { type: string, enum: [Otomatik, Manuel, Çapraz Şantiye, Çevrimdışı Senkron] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: .xlsx dosyası stream olarak döner.
 */
router.get(
  '/transactions/export',
  authenticateJWT,
  validateRequest({ query: transactionExportQuerySchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as unknown as {
        startDate?: string;
        endDate?: string;
        siteName?: string;
        driverName?: string;
        pumpStatus?: string;
        type?: string;
        search?: string;
      };

      await streamTransactionsToExcel(res, q, siteScopeFor(req.user!));
    } catch (error: any) {
      // Header'lar zaten gönderilmişse (stream başlamışsa) Express'in
      // varsayılan hata middleware'i devreye giremez — bağlantıyı olduğu
      // gibi keserek yarım/bozuk bir .xlsx indirmeyi önlüyoruz.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      next(error);
    }
  }
);

/**
 * @swagger
 * /transactions/{id}/e-irsaliye:
 *   get:
 *     summary: İkmal İçin UBL 2.1 DespatchAdvice (e-İrsaliye Taslağı) XML'i (COMP-601)
 *     description: >
 *       Belge no (boşluksuz sıralı) + ETTN (kalıcı UUID) tahsis eder; VKN,
 *       firma adı/adres, Plaka, Şoför TC, Sevk Tarihi ve yakıt tipine göre
 *       çözülen GTIP kodunu gerçek OASIS UBL 2.1 DespatchAdvice şemasına göre
 *       üretip o şemaya karşı doğrular. Aynı ikmal için tekrar çağrılırsa AYNI
 *       belge no + ETTN döner. GİB'in tam UBL-TR profili/Schematron/XAdES
 *       imzası bu kapsamda DEĞİLDİR (COMP-602).
 *     headers:
 *       X-Despatch-Advice-Number: { schema: { type: string } }
 *       X-Despatch-Advice-ETTN: { schema: { type: string } }
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: XML dosyası döner.
 *       400:
 *         description: Firma VKN'si veya sürücü TC'si tanımsız — üretilemez.
 *       404:
 *         description: İkmal kaydı bulunamadı.
 */
router.get(
  '/transactions/:id/e-irsaliye',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const recipientTaxId = typeof req.query.recipientTaxId === 'string' ? req.query.recipientTaxId : undefined;
      const prep = await prepareDespatchAdvice(req.params.id, siteScopeFor(req.user!), recipientTaxId);
      // COMP-605: alıcı e-İrsaliye mükellefi değilse (deliveryMode KAGIT)
      // elektronik XML üretme — kağıt süreç uyarısını JSON döndür.
      if (req.query.format === 'json' || prep.deliveryMode === 'KAGIT') {
        res.set('Cache-Control', 'no-store');
        res.status(prep.deliveryMode === 'KAGIT' ? 409 : 200).json({
          success: prep.deliveryMode !== 'KAGIT',
          error: prep.deliveryMode === 'KAGIT' ? 'RECIPIENT_NOT_EINVOICE_OBLIGATED' : undefined,
          data: {
            documentNumber: prep.documentNumber,
            ettn: prep.ettn,
            reusedExisting: prep.reusedExisting,
            deliveryMode: prep.deliveryMode,
            recipientTaxId: prep.recipientTaxId,
            recipientTitle: prep.recipientTitle,
            recipientObligated: prep.recipientObligated,
            warnings: prep.recipientWarnings
          }
        });
        return;
      }
      const xml = generateDespatchAdviceXml(prep);
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="e-irsaliye-${prep.documentNumber}.xml"`);
      res.setHeader('X-Despatch-Advice-Number', prep.documentNumber);
      res.setHeader('X-Despatch-Advice-ETTN', prep.ettn);
      res.setHeader('X-Delivery-Mode', prep.deliveryMode);
      res.send(xml);
    } catch (error: any) {
      next(error);
    }
  }
);

// ── COMP-605: mükellef (VKN/TCKN) doğrulama + alıcı bilgisi ─────────────
const RECIPIENT_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;

/**
 * @swagger
 * /taxpayers/validate:
 *   post:
 *     summary: VKN/TCKN Algoritmik Doğrulama + Mükellefiyet Sorgusu (COMP-605)
 *     description: '`{ taxId }` → { valid, kind (VKN|TCKN), obligation }. Mükellefiyet 24 sa önbelleklidir.'
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/taxpayers/validate',
  authenticateJWT,
  validateRequest({ body: validateTaxIdSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const v = validateTaxId(req.body.taxId);
      let obligation = null;
      if (v.ok) {
        const o = await getEInvoiceObligation(v.normalized);
        obligation = { obligated: o.obligated, source: o.source, checkedAt: o.checkedAt };
      }
      res.json({ success: true, data: { valid: v.ok, kind: v.kind, normalized: v.normalized, reason: v.reason, obligation } });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /recipients:
 *   post:
 *     summary: Alıcı Mükellef Kaydı (COMP-605)
 *     description: >
 *       `{ taxId, title?, address?, taxOffice?, status? }`. VKN/TCKN geçersizse
 *       400. Kayıt oluşur ama zorunlu alan(lar) eksikse `warnings` ile döner.
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Alıcı Mükellef Listesi (COMP-605)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/recipients',
  authenticateJWT,
  authorizeRoles(...RECIPIENT_MANAGER_ROLES),
  validateRequest({ body: createRecipientSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await upsertRecipientTaxpayer(req.body, req.user!.userId);
      res.status(201).json({ success: true, data: result });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/recipients',
  authenticateJWT,
  authorizeRoles(...RECIPIENT_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const recs = await getRecipientTaxpayers();
      res.json({ success: true, totalCount: recs.length, data: recs });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get(
  '/recipients/:id',
  authenticateJWT,
  authorizeRoles(...RECIPIENT_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await getRecipientTaxpayer(req.params.id) });
    } catch (error: any) {
      next(error);
    }
  }
);

router.post(
  '/recipients/:id/refresh-obligation',
  authenticateJWT,
  authorizeRoles(...RECIPIENT_MANAGER_ROLES),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await refreshRecipientObligation(req.params.id) });
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

// ── FUEL-402.1: araç/şantiye/dönem bazlı yakıt kotası ────────────────────
const QUOTA_MANAGER_ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'] as const;

/**
 * @swagger
 * /quotas:
 *   post:
 *     summary: Yakıt Kotası Tanımla (FUEL-402.1)
 *     description: >
 *       `{ vehiclePlate?, siteName?, periodType, limitLiters, carryoverPolicy?,
 *       validFrom?, validUntil? }`. Kapsam alanları boşsa kota tenant
 *       genelidir. Dönem penceresi periodType'a göre Europe/Istanbul
 *       sınırlarıyla hesaplanır.
 *     security:
 *       - bearerAuth: []
 *   get:
 *     summary: Kotaları Listele (FUEL-402.1)
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/quotas',
  authenticateJWT,
  authorizeRoles(...QUOTA_MANAGER_ROLES),
  validateRequest({ body: createQuotaSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const b = req.body as any;
      const q = await createFuelQuota(b, req.user!.userId);
      res.status(201).json({ success: true, data: q });
    } catch (error: any) {
      next(error);
    }
  }
);

router.get('/quotas', authenticateJWT, authorizeRoles(...QUOTA_MANAGER_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const quotas = await getFuelQuotas();
    res.json({ success: true, totalCount: quotas.length, data: quotas });
  } catch (error: any) {
    next(error);
  }
});

router.get('/quotas/:id', authenticateJWT, authorizeRoles(...QUOTA_MANAGER_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await getFuelQuota(req.params.id) });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /quotas/{id}/balance:
 *   get:
 *     summary: Kalan Kota (FUEL-402.1)
 *     description: >
 *       kalan = efektif limit (limit + devir) − tamamlanan (mevcut dönem
 *       transactions'ı) − rezerve (AKTİF dispense oturumları). Sonuç 5 sn
 *       cache'lenir.
 *     security:
 *       - bearerAuth: []
 */
router.get('/quotas/:id/balance', authenticateJWT, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await getQuotaBalance(req.params.id) });
  } catch (error: any) {
    next(error);
  }
});

router.get('/quotas/:id/history', authenticateJWT, authorizeRoles(...QUOTA_MANAGER_ROLES), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const history = await getQuotaHistory(req.params.id);
    res.json({ success: true, totalCount: history.length, data: history });
  } catch (error: any) {
    next(error);
  }
});

router.patch(
  '/quotas/:id',
  authenticateJWT,
  authorizeRoles(...QUOTA_MANAGER_ROLES),
  validateRequest({ body: updateQuotaSchema }),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = await updateFuelQuota(req.params.id, req.body, req.user!.userId);
      res.json({ success: true, data: q });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /quotas/reset-due:
 *   post:
 *     summary: Süresi Dolan Kotaları Şimdi Sıfırla (FUEL-402.1)
 *     description: >
 *       index.ts'teki saatlik otomatik süpürücünün yaptığı işi bu tenant için
 *       MANUEL tetikler — dönemi bitmiş AKTİF kotaları fuel_quota_history'ye
 *       arşivler, devir (carryover) politikasını uygular ve pencereyi bir
 *       sonraki döneme kaydırır. Ops ekibinin uzlaşma öncesi elle çalıştırması
 *       ve entegrasyon testleri için. Yalnızca SUPER_ADMIN.
 *     security:
 *       - bearerAuth: []
 */
router.post('/quotas/reset-due', authenticateJWT, authorizeRoles('SUPER_ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await resetDueQuotasForCurrentTenant();
    res.json({ success: true, data: result });
  } catch (error: any) {
    next(error);
  }
});

/**
 * @swagger
 * /admin/license-expiry-sweep:
 *   post:
 *     summary: Lisans Süresi Uyarı Turunu Şimdi Tetikle (BILL-1702)
 *     description: >
 *       index.ts'teki günlük otomatik süpürücünün yaptığı işi (lisansı
 *       30/15/7 gün içinde dolacak TÜM firmalar için alarm + Socket.io
 *       uyarısı) MANUEL tetikler — `resetDueQuotasForCurrentTenant`'ın
 *       aksine tek bir tenant'a değil TÜM platforma bakar (SUPER_ADMIN'e
 *       özel). Ops ekibi ve testler için — 24 saati beklemeden.
 *     security:
 *       - bearerAuth: []
 */
router.post('/admin/license-expiry-sweep', authenticateJWT, authorizeRoles('SUPER_ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await runLicenseExpiryWarningSweep();
    res.json({ success: true, data: result });
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
 * @swagger
 * /lorawan/uplink:
 *   post:
 *     summary: ChirpStack/TTN LoRaWAN Uplink Webhook'u (IOT-302.1)
 *     description: >
 *       LoRaWAN ağ sunucusunun (ChirpStack v4 / TTN v3 / düz normalize gövde)
 *       HTTP integration'ından gelen tek bir uplink'i alır, sensör modeline
 *       göre çözer ve mevcut telemetri hattına aktarır (MQTT `data` yoluyla
 *       aynı). İnternete açık — `Authorization: Bearer <LORAWAN_WEBHOOK_TOKEN>`
 *       zorunludur (yoksa/yanlışsa 401; token hiç yapılandırılmamışsa 503,
 *       fail-closed). Bozuk/eksik paketler 202 içinde `accepted:false` ile
 *       izole edilir — ağ sunucusu retry'a girmesin ve hat durmasın diye
 *       gövde hatası yine 2xx döner (yalnızca auth/limit hataları 4xx).
 *     security:
 *       - lorawanWebhookToken: []
 *     responses:
 *       202:
 *         description: Uplink alındı (accepted true/false, decoded değerler payload'da).
 *       401:
 *         description: Eksik/geçersiz webhook token'ı.
 *       503:
 *         description: LORAWAN_WEBHOOK_TOKEN yapılandırılmamış (fail-closed).
 */
router.post(
  '/lorawan/uplink',
  lorawanWebhookRateLimiter,
  lorawanWebhookAuth,
  validateRequest({ body: lorawanUplinkSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await ingestLoRaWANUplink(req.body);
      // 202: alındı ve işlendi/izole edildi. accepted alanı sonucu taşır.
      res.status(202).json({ success: true, ...result });
    } catch (error: any) {
      next(error);
    }
  }
);

/**
 * @swagger
 * /telemetry/sync-batch:
 *   post:
 *     summary: Çevrimdışı Biriken İkmallerin Toplu Senkronizasyonu (IOT-303.1)
 *     description: >
 *       Bağlantısı kesilen bir cihazın biriktirdiği ikmal kayıtlarını tek
 *       istekte (en fazla 5000 kayıt) kabul eder. (device_id, localSequenceId)
 *       ikilisi veritabanı seviyesinde benzersizdir — aynı batch'in tekrar
 *       gönderimi ikinci bir mali kayıt YARATMAZ. Yanıt kayıt bazlıdır:
 *       her kayıt ACCEPTED / DUPLICATE_SKIPPED / ERROR durumlarından biriyle
 *       döner, cihaz yalnızca ACCEPTED+DUPLICATE_SKIPPED olanları kendi
 *       kuyruğundan silmelidir.
 *     security: []
 *     responses:
 *       200:
 *         description: Batch işlendi (kısmi başarı da 200 döner — hata payload içindedir).
 */
router.post(
  '/telemetry/sync-batch',
  hardwareRateLimiter,
  hardwareAuthMiddleware,
  validateRequest({ body: syncBatchSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    const hw = (req as any).authenticatedHardware as { deviceId: string; tenantId: string };
    try {
      const results = await runWithTenant({ tenantId: hw.tenantId }, () =>
        syncOfflineDispenseBatch(hw.deviceId, req.body.records)
      );

      const summary = {
        totalReceived: results.length,
        accepted: results.filter((r) => r.status === 'ACCEPTED').length,
        duplicateSkipped: results.filter((r) => r.status === 'DUPLICATE_SKIPPED').length,
        failed: results.filter((r) => r.status === 'ERROR').length
      };

      try {
        const freshTanks = await runWithTenant({ tenantId: hw.tenantId }, () => getTenantTanks());
        broadcastToTenant(hw.tenantId, 'dispense:completed', { batchSummary: summary, tanks: freshTanks });
      } catch (broadcastErr) {
        logger.warn({ err: broadcastErr }, '⚠️ [Socket.io] sync-batch sonrası dispense:completed yayını başarısız oldu.');
      }

      // IOT-303.2 AC: "Negatif stok... mutabakat uyarısı üretilmesi." Veri
      // katmanı (tenantDb.ts) zaten reddedip audit_logs'a kalıcı bir alarm
      // yazdı — burada ayrıca canlı panele (varsa) anlık bir uyarı düşer.
      const negativeStockAlarms = results.filter((r) => r.status === 'ERROR' && r.error === 'NEGATIVE_STOCK_DETECTED');
      if (negativeStockAlarms.length > 0) {
        broadcastToTenant(hw.tenantId, 'tank:negative-stock-alarm', {
          deviceId: hw.deviceId,
          count: negativeStockAlarms.length,
          localSequenceIds: negativeStockAlarms.map((r) => r.localSequenceId)
        });
      }

      res.json({ success: true, message: 'Batch işlendi.', summary, results });
    } catch (error: any) {
      next(error);
    }
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
          deviceSiteName: hw.siteName,
          deviceId: hw.deviceId
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
