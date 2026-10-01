import { z } from 'zod';

/**
 * FE-811 AC: "Acil durdurma onay gerektirmeli ve audit'lenmelidir." Onay
 * (confirm diyaloğu) istemci tarafı bir UX kavramıdır — sunucu tarafında
 * bunun karşılığı, eylemi KASITLI/dikkatli kılan ZORUNLU bir gerekçe
 * metnidir (boş/varsayılan bir "tıkla, hiçbir şey yazmadan dur" akışı yok).
 */
export const emergencyStopSchema = z.object({
  reason: z.string({ message: 'Acil durdurma gerekçesi zorunludur.' }).trim().min(5, 'Gerekçe en az 5 karakter olmalıdır.').max(256)
});

export type EmergencyStopDTO = z.infer<typeof emergencyStopSchema>;
