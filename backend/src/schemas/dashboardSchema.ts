import { z } from 'zod';

/** REP-723: `days` = trend/ilk-10 penceresi (gün); KPI kartları bundan bağımsızdır (bugün / içinde bulunulan ay). */
export const executiveDashboardQuerySchema = z.object({
  days: z.coerce.number({ message: 'days geçerli bir sayı olmalıdır.' }).int().min(1, 'days en az 1 olmalıdır.').max(90, 'days en fazla 90 olabilir.').default(30)
});
