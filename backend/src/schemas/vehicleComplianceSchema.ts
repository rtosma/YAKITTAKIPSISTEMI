import { z } from 'zod';
import { isoDateString } from './common/dateString';

/**
 * FLEET-1408 — muayene/egzoz/sigorta son tarihi kaydı.
 */
export const addVehicleComplianceDeadlineSchema = z.object({
  deadlineType: z.enum(['MUAYENE', 'EGZOZ', 'SİGORTA', 'DİĞER'], {
    message: 'deadlineType MUAYENE/EGZOZ/SİGORTA/DİĞER olmalıdır.'
  }),
  issuedAt: isoDateString('issuedAt YYYY-AA-GG olmalıdır.'),
  dueDate: isoDateString('dueDate YYYY-AA-GG olmalıdır.'),
  referenceNo: z.string().trim().max(64).optional(),
  note: z.string().trim().max(1000).optional()
});
export type AddVehicleComplianceDeadlineDTO = z.infer<typeof addVehicleComplianceDeadlineSchema>;

/**
 * FLEET-1408 — lastik kaydı. `expectedLifespanKm` AC'nin "KM bazlı ömür"
 * gereğini karşılamak için zorunlu.
 */
export const registerVehicleTireSchema = z.object({
  position: z.enum(['SOL_ON', 'SAG_ON', 'SOL_ARKA', 'SAG_ARKA', 'DIGER'], {
    message: 'position SOL_ON/SAG_ON/SOL_ARKA/SAG_ARKA/DIGER olmalıdır.'
  }),
  brandModel: z.string().trim().max(128).optional(),
  installedAt: isoDateString('installedAt YYYY-AA-GG olmalıdır.'),
  installedMeterValue: z.coerce.number({ message: 'installedMeterValue zorunludur.' }).nonnegative(),
  expectedLifespanKm: z.coerce.number({ message: 'expectedLifespanKm zorunludur.' }).positive(),
  treadDepthMm: z.coerce.number({ message: 'treadDepthMm zorunludur.' }).positive().max(20)
});
export type RegisterVehicleTireDTO = z.infer<typeof registerVehicleTireSchema>;

export const recordTireTreadDepthSchema = z.object({
  treadDepthMm: z.coerce.number({ message: 'treadDepthMm zorunludur.' }).nonnegative().max(20),
  measuredAt: isoDateString('measuredAt YYYY-AA-GG olmalıdır.')
});
export type RecordTireTreadDepthDTO = z.infer<typeof recordTireTreadDepthSchema>;
