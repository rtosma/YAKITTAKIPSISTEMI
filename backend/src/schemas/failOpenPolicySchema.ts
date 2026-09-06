import { z } from 'zod';

/**
 * FUEL-410 — POST /policies/fail-open. siteName verilmezse tenant geneli
 * varsayılan olarak kaydedilir (bkz. tenantDb.ts setFailOpenPolicy).
 */
export const setFailOpenPolicySchema = z.object({
  siteName: z.string().min(1).optional(),
  offlineDispenseAllowed: z.boolean({ message: 'offlineDispenseAllowed zorunludur.' }),
  maxLitersPerVehicle: z.coerce.number({ message: 'maxLitersPerVehicle zorunludur.' }).positive(),
  maxDailyDispensesPerVehicle: z.coerce.number({ message: 'maxDailyDispensesPerVehicle zorunludur.' }).int().positive(),
  whitelistFreshnessHours: z.coerce.number({ message: 'whitelistFreshnessHours zorunludur.' }).int().positive(),
  // AC: "Yüksek riskli tenant'lar için tam fail-close seçeneği de
  // desteklenmelidir." true ise offlineDispenseAllowed'ı geçersiz kılar.
  failClose: z.boolean().default(false)
});
