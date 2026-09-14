import { z } from 'zod';

/**
 * REP-703 — rapor filtreleri RAPOR TANIMINA göre DİNAMİK olduğundan (her
 * rapor kendi `filters` listesini taşır, bkz. reports/reportTypes.ts),
 * burada her filtre alanı için ayrı bir şema YAZILAMAZ/YAZILMAZ — asıl
 * güvenlik sınırı reportEngine.ts'teki ÇALIŞMA ZAMANI whitelist'tir (bir
 * anahtar `def.filters`'ta yoksa sessizce yok sayılır, hiçbir zaman SQL'e
 * gitmez). Bu şema yalnızca İKİNCİL bir savunma katmanıdır: `page`/`pageSize`
 * biçimini zorlar ve `.catchall` ile gelen HER filtre değerinin en fazla 200
 * karakterlik bir metin olduğunu garanti eder (aşırı büyük bir query string
 * ile sorguyu/parametre listesini şişirmeyi önler).
 */
export const reportRunQuerySchema = z
  .object({
    page: z.coerce.number({ message: 'Sayfa numarası geçerli bir sayı olmalıdır.' }).int().positive().default(1),
    pageSize: z.coerce.number({ message: 'Sayfa boyutu geçerli bir sayı olmalıdır.' }).int().positive().max(100, 'Sayfa boyutu en fazla 100 olabilir.').default(20),
    // Asıl güvenlik sınırı reportEngine.ts'teki whitelist'tir (sortBy, o
    // raporun GERÇEK bir sütun anahtarı DEĞİLSE sessizce defaultSort'a
    // düşer) — burada yalnızca biçim (uzunluk/değer kümesi) sınırlanıyor.
    sortBy: z.string().max(64).optional(),
    sortDir: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional()
  })
  .catchall(z.string().max(200).optional());

export const reportExportQuerySchema = reportRunQuerySchema.extend({
  format: z.enum(['csv', 'pdf'], { message: "format 'csv' veya 'pdf' olmalıdır." })
});

export const reportIdParamsSchema = z.object({
  reportId: z.string().min(1).max(64)
});
