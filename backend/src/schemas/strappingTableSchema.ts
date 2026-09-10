import { z } from 'zod';

/**
 * FUEL-403.1 — tank daldırma cetveli (strapping table) içe aktarımı.
 *
 * Bilinçli sapma: ticket "csv-parse + Drizzle" öneriyor. Cetvel yalnızca iki
 * SAYISAL sütundur (mm, litre) — tam bir CSV kütüphanesi (tırnaklı alan,
 * kaçış, çok satırlı hücre) gerektirmez; satır bazlı hata mesajı üretmek de
 * elle daha nettir. Bu yüzden hafif, katı bir ayrıştırıcı (parseStrappingCsv)
 * kullanıldı. Drizzle yerine raw-pg + withTenant (proje geneli).
 */

export interface StrappingPointInput {
  levelMm: number;
  volumeLiters: number;
}

export interface CsvParseResult {
  points: StrappingPointInput[];
  errors: Array<{ row: number; message: string }>;
}

/**
 * `mm,litre` satırlarından oluşan bir CSV metnini ayrıştırır. Başlık satırı
 * (ilk satır sayı DEĞİLSE) atlanır. Boş satırlar yok sayılır. Her hatalı
 * satır için `{ row, message }` toplanır — "bozuk cetvel sessizce kabul
 * edilmemeli" (AC). Ayırıcı virgül veya noktalı virgül olabilir.
 */
export function parseStrappingCsv(csv: string): CsvParseResult {
  const points: StrappingPointInput[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  const lines = csv.split(/\r?\n/);

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;
    const rowNum = idx + 1;
    const cols = line.split(/[;,]/).map((c) => c.trim());
    if (cols.length < 2) {
      // İlk satırda tek sütun → muhtemelen başlık; sessiz geç yalnızca ilk satırsa.
      if (idx === 0) return;
      errors.push({ row: rowNum, message: 'Satırda en az 2 sütun (mm, litre) bekleniyor.' });
      return;
    }
    const levelMm = Number(cols[0]);
    const volumeLiters = Number(cols[1]);
    // Başlık satırı: ilk satır ve sayı değil → atla.
    if (idx === 0 && (!Number.isFinite(levelMm) || !Number.isFinite(volumeLiters))) return;

    if (!Number.isFinite(levelMm) || !Number.isInteger(levelMm) || levelMm < 0) {
      errors.push({ row: rowNum, message: `Geçersiz mm seviyesi: "${cols[0]}" (0'dan büyük/eşit tam sayı olmalı).` });
      return;
    }
    if (!Number.isFinite(volumeLiters) || volumeLiters < 0) {
      errors.push({ row: rowNum, message: `Geçersiz litre değeri: "${cols[1]}" (0'dan büyük/eşit sayı olmalı).` });
      return;
    }
    points.push({ levelMm, volumeLiters });
  });

  return { points, errors };
}

const strappingPointSchema = z.object({
  levelMm: z.number().int().nonnegative(),
  volumeLiters: z.number().nonnegative()
});

const cylinderConfigSchema = z.object({
  diameterMm: z.number().int().positive(),
  lengthMm: z.number().int().positive(),
  orientation: z.enum(['HORIZONTAL', 'VERTICAL'])
});

/**
 * POST /tanks/:name/strapping-table gövdesi. ÜÇ girdi biçiminden BİRİ:
 *  - `csvContent`: ham CSV metni (sunucuda parse + doğrulanır)
 *  - `points`: önceden ayrıştırılmış nokta dizisi
 *  - `cylinderConfig`: strapping cetveli OLMAYAN silindirik tank formülü
 */
export const setStrappingTableSchema = z
  .object({
    csvContent: z.string().min(1).max(200_000).optional(),
    points: z.array(strappingPointSchema).min(2).max(5000).optional(),
    cylinderConfig: cylinderConfigSchema.optional(),
    notes: z.string().max(256).optional()
  })
  .refine(
    (v) => [v.csvContent, v.points, v.cylinderConfig].filter((x) => x !== undefined).length === 1,
    { message: 'csvContent, points veya cylinderConfig alanlarından TAM OLARAK biri verilmelidir.' }
  );

export type SetStrappingTableDTO = z.infer<typeof setStrappingTableSchema>;

/**
 * GET /tanks/:name/volume sorgu parametreleri. `levelMm` zorunlu; `tempC`
 * opsiyonel (yoksa 15°C düzeltmesi yapılmaz, "uncorrected" işaretlenir).
 */
export const tankVolumeQuerySchema = z.object({
  levelMm: z.coerce.number({ message: 'levelMm zorunludur.' }).nonnegative(),
  tempC: z.coerce.number().optional(),
  density15: z.coerce.number().positive().optional()
});

export type TankVolumeQueryDTO = z.infer<typeof tankVolumeQuerySchema>;

/**
 * Nokta dizisinin monotonluk / bütünlük denetimi (AC: "monoton olmayan /
 * eksik cetveller satır bazlı hatayla reddedilmeli"). Ayrı bir fonksiyon —
 * hem CSV hem doğrudan `points` yolu buradan geçer.
 */
export function validateMonotonic(points: StrappingPointInput[]): Array<{ row: number; message: string }> {
  const errors: Array<{ row: number; message: string }> = [];
  if (points.length < 2) {
    errors.push({ row: 0, message: 'Cetvel en az 2 nokta içermelidir.' });
    return errors;
  }
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (cur.levelMm <= prev.levelMm) {
      errors.push({
        row: i + 1,
        message: `mm seviyesi kesin artan olmalı: ${cur.levelMm} ≤ önceki ${prev.levelMm}.`
      });
    }
    if (cur.volumeLiters < prev.volumeLiters) {
      errors.push({
        row: i + 1,
        message: `Hacim seviyeyle birlikte AZALAMAZ: ${cur.volumeLiters} L < önceki ${prev.volumeLiters} L (seviye ${cur.levelMm} mm).`
      });
    }
  }
  return errors;
}
