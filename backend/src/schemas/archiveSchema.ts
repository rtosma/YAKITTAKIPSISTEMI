import { z } from 'zod';

/**
 * REP-702 — periyot 7/15/30/90 gün ile SABİT (companies.archive_period_days'in
 * schema.sql'deki CHECK kısıtlamasıyla AYNI küme) — istemci farklı bir sayı
 * göndermeye çalışırsa whitelist dışı olduğundan reddedilir.
 */
const ARCHIVE_PERIOD_ENUM = z.union([z.literal(7), z.literal(15), z.literal(30), z.literal(90)], {
  message: 'Periyot 7, 15, 30 veya 90 gün olmalıdır.'
});

export const archiveSettingsSchema = z.object({
  periodDays: ARCHIVE_PERIOD_ENUM.nullable()
});

export const createArchiveSchema = z.object({
  periodDays: z.coerce.number().pipe(ARCHIVE_PERIOD_ENUM)
});

export const archiveIdParamsSchema = z.object({
  archiveId: z.string().min(1).max(64)
});

export const archiveDownloadParamsSchema = z.object({
  archiveId: z.string().min(1).max(64),
  token: z.string().min(32).max(128)
});
