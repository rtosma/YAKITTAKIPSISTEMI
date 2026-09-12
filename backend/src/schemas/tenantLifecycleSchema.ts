import { z } from 'zod';

/**
 * ARCH-108 — tenant dondurma/silme planlaması gerekçesi. Bu kadar geri
 * döndürülemez bir işlem için (özellikle silme) anlamlı bir gerekçe
 * zorunlu — audit_logs/insertCompanyAuditLog'a KALICI olarak yazılır.
 */
export const tenantLifecycleReasonSchema = z.object({
  reason: z.string().trim().min(5, 'reason en az 5 karakter olmalıdır.').max(1000)
});
export type TenantLifecycleReasonDTO = z.infer<typeof tenantLifecycleReasonSchema>;
