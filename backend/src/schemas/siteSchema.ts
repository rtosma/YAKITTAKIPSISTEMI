import { z } from 'zod';

export const createSiteSchema = z.object({
  siteName: z.string({ message: 'Şantiye adı zorunludur.' })
    .trim()
    .min(1, 'Şantiye adı zorunludur.'),
  location: z.string().trim().min(1).optional()
});

export type CreateSiteDTO = z.infer<typeof createSiteSchema>;
