import { z } from 'zod';

/**
 * REP-724 — AI aylık yönetim raporu şemaları.
 *
 * `monthlyNarrativeSchema`: Gemini'nin DÖNDÜRDÜĞÜ metnin JSON.parse'tan sonra doğrulandığı şema (AI-502'deki anomali şemasıyla
 * aynı ilke: LLM çıktısına kör güvenilmez). Bu yalnızca BİÇİM doğrulamasıdır; İÇERİĞİN sistem verisiyle uyumu ayrıca ve
 * ZORUNLU olarak `verifyNarrative` (services/monthlyManagementReportService.ts) ile yapılır — biçimi geçerli bir yorum
 * içeriği yanlış olabilir (uydurma sayı), asıl "çapraz doğrulama" AC'si oradadır.
 */
export const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

const evidenceSchema = z.object({
  metric: z.string().min(1).max(160),
  value: z.number()
});

export const narrativeItemSchema = z.object({
  text: z.string().min(1).max(700),
  // Bulgu/risk için ZORUNLU (servis doğrular); öneride isteğe bağlıdır.
  evidence: z.array(evidenceSchema).max(8).default([])
});

export const monthlyNarrativeSchema = z.object({
  summary: z.string().max(900),
  findings: z.array(narrativeItemSchema).max(8),
  risks: z.array(narrativeItemSchema).max(8),
  recommendations: z.array(narrativeItemSchema).max(8)
});

export type NarrativeItem = z.infer<typeof narrativeItemSchema>;
export type MonthlyNarrative = z.infer<typeof monthlyNarrativeSchema>;

export const monthParamsSchema = z.object({
  month: z.string().regex(MONTH_REGEX, "month 'YYYY-MM' biçiminde olmalıdır (örn. 2026-02).")
});

export const generateMonthlyReportBodySchema = z.object({
  month: z.string().regex(MONTH_REGEX, "month 'YYYY-MM' biçiminde olmalıdır (örn. 2026-02).").optional(),
  regenerate: z.boolean().default(false),
  sendEmail: z.boolean().default(false)
});

export type GenerateMonthlyReportDTO = z.infer<typeof generateMonthlyReportBodySchema>;
