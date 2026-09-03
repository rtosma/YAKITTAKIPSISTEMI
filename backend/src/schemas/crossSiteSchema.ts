import { z } from 'zod';
import { TURKISH_PLATE_REGEX } from './vehicleSchema';

export const createCrossSitePermissionSchema = z.object({
  vehiclePlate: z.string({ message: 'Araç plakası zorunludur.' })
    .regex(TURKISH_PLATE_REGEX, { message: 'Geçersiz Türkiye plaka formatı.' }),
  driverName: z.string().optional(),
  homeSite: z.string({ message: 'Aracın kendi şantiyesi zorunludur.' }).min(1),
  targetSite: z.string({ message: 'İkmal alınacak şantiye zorunludur.' }).min(1),
  allowedLiters: z.coerce.number({ message: 'İzin verilen miktar zorunludur.' })
    .positive('İzin verilen miktar 0\'dan büyük olmalıdır.'),
  expiryDate: z.string({ message: 'Son geçerlilik tarihi zorunludur.' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Tarih YYYY-MM-DD formatında olmalıdır.')
});

export const updateCrossSitePermissionStatusSchema = z.object({
  status: z.enum(['AKTİF', 'SÜRESİ_DOLDU', 'KULLANILDI'])
});

export type CreateCrossSitePermissionDTO = z.infer<typeof createCrossSitePermissionSchema>;
