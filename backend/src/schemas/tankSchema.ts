import { z } from 'zod';

export const createTankSchema = z.object({
  name: z.string({ message: 'Tank adı zorunludur.' })
    .min(2, 'Tank adı en az 2 karakter olmalıdır.')
    .max(128, 'Tank adı çok uzun.'),
  capacityLiters: z.number({ message: 'Tank kapasitesi zorunludur.' })
    .positive('Tank kapasitesi 0\'dan büyük bir sayı olmalıdır.'),
  currentLevelLiters: z.number({ message: 'Güncel seviye zorunludur.' })
    .nonnegative('Güncel seviye negatif olamaz.'),
  fuelType: z.string().optional(),
  siteName: z.string().optional(),
  status: z.string().optional()
}).refine(
  (data) => data.currentLevelLiters <= data.capacityLiters,
  {
    message: 'Güncel seviye, tank kapasitesini aşamaz.',
    path: ['currentLevelLiters']
  }
);

export const updateTankSchema = z.object({
  name: z.string().min(2, 'Tank adı en az 2 karakter olmalıdır.').max(128, 'Tank adı çok uzun.').optional(),
  capacityLiters: z.number().positive('Tank kapasitesi 0\'dan büyük bir sayı olmalıdır.').optional(),
  currentLevelLiters: z.number().nonnegative('Güncel seviye negatif olamaz.').optional(),
  fuelType: z.string().optional(),
  siteName: z.string().optional(),
  status: z.string().optional()
}).refine(
  (data) => data.capacityLiters === undefined || data.currentLevelLiters === undefined || data.currentLevelLiters <= data.capacityLiters,
  {
    message: 'Güncel seviye, tank kapasitesini aşamaz.',
    path: ['currentLevelLiters']
  }
);

export type CreateTankDTO = z.infer<typeof createTankSchema>;
export type UpdateTankDTO = z.infer<typeof updateTankSchema>;
