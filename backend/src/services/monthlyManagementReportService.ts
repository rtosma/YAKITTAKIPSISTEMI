import { GoogleGenAI } from '@google/genai';
import { config } from '../config/env';
import { withTenant } from '../db/withTenant';
import { getTenantId } from '../context/tenantContext';
import { isTenantModuleEnabled } from '../db/tenantDb';
import { rep724MonthlyManagement, assertValidMonth } from '../reports/definitions/rep724MonthlyManagement';
import { streamReportExport } from '../reports/reportEngine';
import { buildMonthlyReportPdfBuffer, MonthlyReportPdfInput, PdfFacts, PdfNarrative } from '../reports/monthlyManagementPdf';
import { sendEmail, deriveHtmlFromText } from '../notifications/emailChannel';
import { monthlyNarrativeSchema, MonthlyNarrative, NarrativeItem } from '../schemas/monthlyManagementReportSchema';
import { generateId } from '../utils/id';
import { writeAuditLog } from '../utils/auditLog';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * REP-724 (#210) — AI destekli aylık yönetim raporu.
 *
 * KATMANLAR (AC: "Model yorumları ile ölçülen veriler ayrı gösterilmelidir"):
 *  1) ÖLÇÜLEN VERİ: `compileMonthlyFacts` — REP-703 kayıtlı raporu rep-724'ün çıktısından (aynı motor/aynı SQL: JSON, CSV,
 *     XLSX, PDF hep buradan) + en çok tüketen araçlar. Yapay zekâ bu sayıları ÜRETMEZ.
 *  2) YORUM: Gemini bu sayıları yorumlar (AI-502 altyapısı: aynı SDK/anahtar/model, structured output).
 *  3) ÇAPRAZ DOĞRULAMA (AC: "Model çıktısının sistem verisiyle çapraz doğrulanması"): `verifyNarrative` — modelin her bulgu/risk
 *     iddiası (a) dayandığı ölçümü (`evidence: {metric, value}`) adıyla belirtmek ve değeri sistem verisiyle EŞLEŞTİRMEK,
 *     (b) metindeki birimli her sayı (L, ₺, %, ikmal, alarm…) gerçek bir ölçümün yuvarlanmışı olmak, (c) metinde geçen plaka
 *     ölçülen en çok tüketen araçlardan biri olmak zorundadır. Geçemeyen ifade RAPORDAN ÇIKARILIR ve `ai_rejected`'a nedenle
 *     yazılır (sessizce düzeltilmez, sessizce gösterilmez).
 *
 * "MODEL ERİŞİLEMEZSE RAPOR YİNE ÜRETİLİR" (AC): anahtar yok / çağrı hatası / zaman aşımı / bozuk çıktı → `ai_status` bunu söyler,
 * rapor ölçülen veri bölümüyle KAYDEDİLİR ve gönderilir; PDF'te yorum kutusu "üretilemedi" der.
 *
 * KİŞİSEL VERİ (COMP-606): modele sürücü/personel adı HİÇ gitmez — yalnızca şantiye adları, araç plakaları (kurumsal varlık
 * tanımlayıcısı) ve toplamlar. (AI-502'deki pseudonymize gerekmiyor; veri baştan kişisiz.)
 *
 * ROL GÖRÜNÜRLÜĞÜ (AC): SUPER_ADMIN/COMPANY_OWNER firma geneli veriyi + yorumu görür. SITE_MANAGER yalnızca KENDİ şantiyesinin
 * ölçülen verisini görür; yorum firma geneli veriyle yazıldığından (başka şantiyeleri anar) ona GÖSTERİLMEZ.
 *
 * TETİK: `runMonthlyManagementReportSweepForCurrentTenant` (index.ts saatlik süpürücü; REP-705/AI-502 ile aynı düz setInterval
 * deseni — BullMQ yok). Her ayın 1'inde (Europe/Istanbul sabit UTC+3, REP-705 ile aynı sadeleştirme) 08:00'dan itibaren bir ÖNCEKİ ayın
 * raporu üretilir ve e-postalanır; UNIQUE(tenant, ay) → tekrar tur yeni rapor üretmez, e-posta teslim izi ile yalnızca eksik
 * alıcılara/başarısızlar için yeniden dener (en çok 3 deneme).
 */

const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_TIMEOUT_MS = 45_000;
const MAX_EMAIL_ATTEMPTS = 3;
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
const SEND_HOUR_LOCAL = 8;
const TOP_VEHICLES = 5;
const EVIDENCE_ABS_TOLERANCE = 0.01;

export const AI_STATUS = ['URETILDI', 'KISMEN_DOGRULANDI', 'DOGRULANAMADI', 'MODEL_ERISILEMEDI', 'GECERSIZ_CIKTI', 'MODUL_KAPALI', 'VERI_YOK'] as const;
export type AiStatus = typeof AI_STATUS[number];

const trn = (v: number, d = 2): string => v.toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const round = (v: number, d: number): number => { const f = 10 ** d; return Math.round((v + Number.EPSILON) * f) / f; };

// ───────────────────────── 1) ÖLÇÜLEN VERİ ─────────────────────────

export interface MonthlyFacts extends PdfFacts {}

export function shiftMonth(month: string, delta: number): string {
  assertValidMonth(month);
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Süpürücünün hedef ayı: (Istanbul yerel) bulunulan ayın bir öncesi. */
export function previousMonthOf(now: Date): string {
  const local = new Date(now.getTime() + ISTANBUL_OFFSET_MS);
  return shiftMonth(`${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`, -1);
}

/** Yerel (Istanbul) 1. gün ve 08:00 geçildi mi — geçildiyse önceki ayın raporu ZAMANI gelmiştir (ayın geri kalanında da yakalanır). */
export function isMonthlyReportDue(now: Date): boolean {
  const local = new Date(now.getTime() + ISTANBUL_OFFSET_MS);
  return local.getUTCDate() > 1 || local.getUTCHours() >= SEND_HOUR_LOCAL;
}

export async function compileMonthlyFacts(month: string, siteScope: string | undefined): Promise<MonthlyFacts> {
  assertValidMonth(month);
  const rows: Record<string, unknown>[] = [];
  const { aggregates } = await streamReportExport(rep724MonthlyManagement, { month }, siteScope, (batch) => { rows.push(...batch); });

  const vehicles = await withTenant(async (client) => {
    const params: unknown[] = [month];
    let scope = '';
    if (siteScope !== undefined) { params.push(siteScope); scope = `AND site_name = $2`; }
    const res = await client.query(
      `SELECT vehicle_plate, SUM(amount_liters)::numeric AS liters, COUNT(*)::int AS dispenses
         FROM transactions
        WHERE created_at >= to_date($1 || '-01', 'YYYY-MM-DD') AND created_at < (to_date($1 || '-01', 'YYYY-MM-DD') + interval '1 month')
          AND vehicle_plate IS NOT NULL ${scope}
        GROUP BY vehicle_plate ORDER BY liters DESC, vehicle_plate ASC`,
      params
    );
    return res.rows as Array<{ vehicle_plate: string; liters: string; dispenses: number }>;
  });

  const liters = round(aggregates.total_liters, 2);
  const cost = round(aggregates.total_cost, 2);
  const prevLiters = round(aggregates.total_prev_liters, 2);
  const prevCost = round(aggregates.total_prev_cost, 2);
  const change = (cur: number, prev: number): number | null => (prev > 0 ? round(((cur - prev) / prev) * 100, 1) : null);

  return {
    month,
    scope: siteScope === undefined ? 'TENANT' : 'SITE',
    site: siteScope ?? null,
    totals: {
      liters, cost, dispenses: aggregates.total_dispenses, alarms: aggregates.total_alarms, prevLiters, prevCost,
      litersChangePct: change(liters, prevLiters), costChangePct: change(cost, prevCost), vehicleCount: vehicles.length
    },
    sites: rows.map((r) => ({
      site: String(r.site_name), liters: Number(r.liters), cost: Number(r.cost), dispenses: Number(r.dispenses), prevLiters: Number(r.prev_liters),
      prevCost: Number(r.prev_cost), changePct: r.change_pct === null || r.change_pct === undefined ? null : Number(r.change_pct), alarms: Number(r.alarms)
    })),
    topVehicles: vehicles.slice(0, TOP_VEHICLES).map((v) => ({ plate: v.vehicle_plate, liters: round(Number(v.liters), 2), dispenses: v.dispenses }))
  };
}

/** Modelin atıf yapabileceği TÜM ölçümler — `verifyNarrative` ve istem (prompt) AYNI listeyi kullanır. */
export function flattenFacts(facts: MonthlyFacts): Record<string, number> {
  const m: Record<string, number> = {
    total_liters: facts.totals.liters, total_cost: facts.totals.cost, dispense_count: facts.totals.dispenses,
    alarm_count: facts.totals.alarms, vehicle_count: facts.totals.vehicleCount,
    prev_total_liters: facts.totals.prevLiters, prev_total_cost: facts.totals.prevCost
  };
  if (facts.totals.litersChangePct !== null) m.liters_change_pct = facts.totals.litersChangePct;
  if (facts.totals.costChangePct !== null) m.cost_change_pct = facts.totals.costChangePct;
  for (const s of facts.sites) {
    m[`site:${s.site}:liters`] = s.liters; m[`site:${s.site}:cost`] = s.cost; m[`site:${s.site}:dispenses`] = s.dispenses;
    m[`site:${s.site}:prev_liters`] = s.prevLiters; m[`site:${s.site}:alarms`] = s.alarms;
    if (s.changePct !== null) m[`site:${s.site}:change_pct`] = s.changePct;
  }
  for (const v of facts.topVehicles) { m[`vehicle:${v.plate}:liters`] = v.liters; m[`vehicle:${v.plate}:dispenses`] = v.dispenses; }
  return m;
}

// ───────────────────────── 2) İSTEM + MODEL ─────────────────────────

const GEMINI_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    evidence: { type: 'array', items: { type: 'object', properties: { metric: { type: 'string' }, value: { type: 'number' } }, required: ['metric', 'value'] } }
  },
  required: ['text', 'evidence']
};
const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: GEMINI_ITEM_SCHEMA },
    risks: { type: 'array', items: GEMINI_ITEM_SCHEMA },
    recommendations: { type: 'array', items: GEMINI_ITEM_SCHEMA }
  },
  required: ['summary', 'findings', 'risks', 'recommendations']
};

/** Saf fonksiyon (I/O yok). Modele yalnızca ölçüm adı=değer satırları gider — kişi adı yok. */
export function buildMonthlyPrompt(facts: MonthlyFacts): string {
  const metrics = Object.entries(flattenFacts(facts)).map(([k, v]) => `- ${k} = ${v}`).join('\n');
  return [
    `Aşağıda bir şantiye firmasının ${facts.month} ayı yakıt tüketim ÖLÇÜMLERİ listelenmiştir (litre, ₺, adet; değişim yüzdeleri önceki aya göre).`,
    'Üst yönetim için Türkçe, kısa ve somut bir aylık yönetim yorumu yaz: summary (2-3 cümle), findings (öne çıkan bulgular), risks (riskler), recommendations (öneriler).',
    'KURALLAR: (1) YALNIZCA aşağıdaki ölçümlere dayan; listede olmayan hiçbir sayı, şantiye veya plaka UYDURMA. (2) Her finding ve risk için evidence dizisine dayandığın ölçümü listedeki ADIYLA ve DEĞERİYLE yaz. (3) Metinde sayı kullanırsan birimini yaz (L, ₺, %) ve ölçümdeki değeri kullan. (4) Kişi adı anma. (5) Emin olmadığın çıkarım yapma; veri yetersizse bunu söyle.',
    '',
    'ÖLÇÜMLER:',
    metrics
  ].join('\n');
}

export interface MonthlyAiDeps {
  /** Test enjeksiyonu — verilirse gerçek Gemini'ye HİÇ gidilmez. */
  generateContent?: (prompt: string) => Promise<string>;
}

class ModelUnavailableError extends Error {}
class InvalidModelOutputError extends Error {}

async function callModel(prompt: string, deps: MonthlyAiDeps): Promise<string> {
  const run = async (): Promise<string> => {
    if (deps.generateContent) return deps.generateContent(prompt);
    if (!config.GEMINI_API_KEY) throw new ModelUnavailableError('GEMINI_API_KEY yapılandırılmamış.');
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    const response = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt, config: { responseMimeType: 'application/json', responseSchema: GEMINI_RESPONSE_SCHEMA } });
    return response.text ?? '';
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error(`model ${GEMINI_TIMEOUT_MS / 1000} sn içinde yanıt vermedi`)), GEMINI_TIMEOUT_MS); })
    ]);
  } catch (err) {
    if (err instanceof ModelUnavailableError) throw err;
    throw new ModelUnavailableError((err as Error).message);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ───────────────────────── 3) ÇAPRAZ DOĞRULAMA ─────────────────────────

const METRIC_LABELS: Record<string, [string, 'L' | '₺' | '%' | '#']> = {
  total_liters: ['Toplam yakıt', 'L'], total_cost: ['Toplam tutar', '₺'], dispense_count: ['İkmal sayısı', '#'], alarm_count: ['Alarm sayısı', '#'],
  vehicle_count: ['Farklı araç sayısı', '#'], prev_total_liters: ['Önceki ay toplam yakıt', 'L'], prev_total_cost: ['Önceki ay toplam tutar', '₺'],
  liters_change_pct: ['Yakıt değişimi (önceki aya göre)', '%'], cost_change_pct: ['Tutar değişimi (önceki aya göre)', '%']
};
const SUFFIX_LABELS: Record<string, [string, 'L' | '₺' | '%' | '#']> = {
  liters: ['yakıt', 'L'], cost: ['tutar', '₺'], dispenses: ['ikmal sayısı', '#'], prev_liters: ['önceki ay yakıt', 'L'], alarms: ['alarm sayısı', '#'], change_pct: ['değişim (önceki aya göre)', '%']
};

/** Dayanak ölçümü yöneticinin okuyacağı biçimde: "Yakıt değişimi (önceki aya göre) = +50,1 %" (ham metrik adı PDF/e-postada gösterilmez). */
export function describeEvidence(metric: string, value: number): string {
  let label = metric;
  let unit: 'L' | '₺' | '%' | '#' = '#';
  if (metric in METRIC_LABELS) [label, unit] = METRIC_LABELS[metric];
  else {
    const m = /^(site|vehicle):(.+):([a-z_]+)$/.exec(metric);
    if (m && m[3] in SUFFIX_LABELS) { label = `${m[2]} — ${SUFFIX_LABELS[m[3]][0]}`; unit = SUFFIX_LABELS[m[3]][1]; }
  }
  const text = unit === '#' ? String(Math.round(value)) : trn(value, unit === '%' ? 1 : 2);
  return `${label} = ${unit === '%' && value > 0 ? '+' : ''}${text}${unit === '#' ? '' : ` ${unit}`}`;
}

export interface RejectedStatement { section: 'summary' | 'findings' | 'risks' | 'recommendations'; text: string; reason: string }
export interface VerifiedNarrative {
  summary: string | null;
  findings: Array<{ text: string; evidence: string[] }>;
  risks: Array<{ text: string; evidence: string[] }>;
  recommendations: Array<{ text: string; evidence: string[] }>;
}

/** "1.234,5" / "1234.5" / "12,5" → sayı. */
export function parseTrNumber(raw: string): number {
  let s = raw.trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return Number(s);
}

const NUM = String.raw`\d+(?:[.,]\d+)*`;
const QUANTITY_RE = new RegExp(String.raw`%\s?(${NUM})|(${NUM})\s?(?:%|L(?![\p{L}])|lt(?![\p{L}])|litre|₺|TL(?![\p{L}])|adet|ikmal|alarm)`, 'giu');
const PLATE_RE = /\b\d{2}\s?[A-ZÇĞİÖŞÜ]{1,3}\s?\d{2,4}\b/gu;

function decimalsOf(raw: string): number {
  if (raw.includes(',')) return raw.split(',')[1].length;
  if (/^\d{1,3}(\.\d{3})+$/.test(raw)) return 0;
  return raw.includes('.') ? raw.split('.')[1].length : 0;
}

/** Yazılan sayı, gerçek ölçümün (yazıldığı ondalık basamağa) YUVARLANMIŞ hali mi? Yüzde/azalış için işaret önemsiz. */
function matchesRounded(written: number, decimals: number, actual: number): boolean {
  const a = Math.abs(actual);
  return round(a, decimals) === round(written, decimals) || Math.abs(a - written) < 10 ** -(decimals + 3);
}

export function verifyNarrative(facts: MonthlyFacts, narrative: MonthlyNarrative): { verified: VerifiedNarrative; rejected: RejectedStatement[] } {
  const metrics = flattenFacts(facts);
  const values = Object.values(metrics);
  const plates = new Set(facts.topVehicles.map((v) => v.plate.replace(/\s/g, '').toUpperCase()));
  const rejected: RejectedStatement[] = [];

  /** null → doğrulandı; string → red nedeni. */
  const textProblem = (text: string): string | null => {
    for (const m of text.matchAll(QUANTITY_RE)) {
      const raw = (m[1] ?? m[2]) as string;
      const written = parseTrNumber(raw);
      if (!Number.isFinite(written)) continue;
      const d = decimalsOf(raw);
      if (!values.some((v) => matchesRounded(written, d, v))) return `TEXT_NUMBER_UNVERIFIED:${raw}`;
    }
    for (const m of text.matchAll(PLATE_RE)) {
      if (!plates.has(m[0].replace(/\s/g, '').toUpperCase())) return `UNKNOWN_VEHICLE:${m[0]}`;
    }
    return null;
  };

  const verifyItem = (section: 'findings' | 'risks' | 'recommendations', item: NarrativeItem, requireEvidence: boolean): { text: string; evidence: string[] } | null => {
    let problem: string | null = null;
    if (requireEvidence && item.evidence.length === 0) problem = 'NO_EVIDENCE';
    const shown: string[] = [];
    for (const ev of item.evidence) {
      if (problem) break;
      if (!(ev.metric in metrics)) { problem = `UNKNOWN_METRIC:${ev.metric}`; break; }
      const actual = metrics[ev.metric];
      if (Math.abs(ev.value - actual) > EVIDENCE_ABS_TOLERANCE) { problem = `EVIDENCE_MISMATCH:${ev.metric} (iddia ${ev.value}, gerçek ${actual})`; break; }
      shown.push(describeEvidence(ev.metric, actual));
    }
    if (!problem) problem = textProblem(item.text);
    if (problem) { rejected.push({ section, text: item.text, reason: problem }); return null; }
    return { text: item.text, evidence: shown };
  };

  let summary: string | null = null;
  if (narrative.summary.trim()) {
    const p = textProblem(narrative.summary);
    if (p) rejected.push({ section: 'summary', text: narrative.summary, reason: p }); else summary = narrative.summary.trim();
  }
  const keep = (section: 'findings' | 'risks' | 'recommendations', requireEvidence: boolean) =>
    narrative[section].map((i) => verifyItem(section, i, requireEvidence)).filter((x): x is { text: string; evidence: string[] } => x !== null);

  return { verified: { summary, findings: keep('findings', true), risks: keep('risks', true), recommendations: keep('recommendations', false) }, rejected };
}

export interface AiCommentary {
  status: AiStatus;
  narrative: VerifiedNarrative | null;
  rejected: RejectedStatement[];
  error: string | null;
  modelName: string | null;
}

const isEmptyNarrative = (n: VerifiedNarrative): boolean => !n.summary && n.findings.length + n.risks.length + n.recommendations.length === 0;

export async function produceAiCommentary(facts: MonthlyFacts, deps: MonthlyAiDeps = {}): Promise<AiCommentary> {
  const modelName = deps.generateContent ? 'test-double' : GEMINI_MODEL;
  if (facts.totals.dispenses === 0 && facts.totals.alarms === 0) {
    return { status: 'VERI_YOK', narrative: null, rejected: [], error: null, modelName: null };
  }
  if (!(await isTenantModuleEnabled('aiAnomaly'))) {
    return { status: 'MODUL_KAPALI', narrative: null, rejected: [], error: null, modelName: null };
  }
  let raw: string;
  try {
    raw = await callModel(buildMonthlyPrompt(facts), deps);
  } catch (err) {
    logger.error({ err }, '🚨 [REP-724] AI modeline ulaşılamadı; rapor yorumsuz (yalnızca ölçülen veri) üretilecek.');
    return { status: 'MODEL_ERISILEMEDI', narrative: null, rejected: [], error: (err as Error).message.slice(0, 300), modelName };
  }
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new InvalidModelOutputError('çıktı geçerli JSON değil'); }
    const v = monthlyNarrativeSchema.safeParse(parsed);
    if (!v.success) throw new InvalidModelOutputError(`çıktı beklenen şemaya uymuyor: ${v.error.issues[0]?.path.join('.')}`);
    const { verified, rejected } = verifyNarrative(facts, v.data);
    if (isEmptyNarrative(verified)) return { status: 'DOGRULANAMADI', narrative: null, rejected, error: 'Modelin hiçbir ifadesi sistem verisiyle doğrulanamadı.', modelName };
    return { status: rejected.length > 0 ? 'KISMEN_DOGRULANDI' : 'URETILDI', narrative: verified, rejected, error: null, modelName };
  } catch (err) {
    logger.error({ err }, '🚨 [REP-724] AI çıktısı işlenemedi.');
    return { status: 'GECERSIZ_CIKTI', narrative: null, rejected: [], error: (err as Error).message.slice(0, 300), modelName };
  }
}

// ───────────────────────── Kayıt / okuma ─────────────────────────

export interface MonthlyReportRecord {
  id: string; tenant_id: string; period_month: string; facts: MonthlyFacts; ai_status: AiStatus; ai_narrative: VerifiedNarrative | null;
  ai_rejected: RejectedStatement[]; ai_error: string | null; model_name: string | null; generated_by: string; email_status: string;
  email_attempts: number; emailed_user_ids: string[]; emailed_at: string | null; last_email_error: string | null; created_at: string; updated_at: string;
}

export async function getMonthlyReportRecord(month: string): Promise<MonthlyReportRecord | null> {
  assertValidMonth(month);
  return withTenant(async (client) => {
    const r = await client.query(`SELECT * FROM monthly_management_reports WHERE period_month = $1`, [month]);
    return r.rows[0] ?? null;
  });
}

export async function listMonthlyReportRecords(): Promise<Array<Pick<MonthlyReportRecord, 'id' | 'period_month' | 'ai_status' | 'email_status' | 'email_attempts' | 'emailed_at' | 'created_at'>>> {
  return withTenant(async (client) => {
    const r = await client.query(`SELECT id, period_month, ai_status, email_status, email_attempts, emailed_at, created_at FROM monthly_management_reports ORDER BY period_month DESC LIMIT 60`);
    return r.rows;
  });
}

export async function generateMonthlyManagementReport(
  month: string,
  opts: { generatedBy: string; regenerate?: boolean; deps?: MonthlyAiDeps }
): Promise<{ record: MonthlyReportRecord; created: boolean }> {
  assertValidMonth(month);
  const existing = await getMonthlyReportRecord(month);
  if (existing && !opts.regenerate) return { record: existing, created: false };

  const facts = await compileMonthlyFacts(month, undefined);
  const ai = await produceAiCommentary(facts, opts.deps);
  const emptyMonth = ai.status === 'VERI_YOK';

  const record = await withTenant(async (client, tenantId) => {
    const res = await client.query(
      `INSERT INTO monthly_management_reports
         (id, tenant_id, period_month, facts, ai_status, ai_narrative, ai_rejected, ai_error, model_name, generated_by, email_status)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, period_month) DO UPDATE SET
         facts = EXCLUDED.facts, ai_status = EXCLUDED.ai_status, ai_narrative = EXCLUDED.ai_narrative, ai_rejected = EXCLUDED.ai_rejected,
         ai_error = EXCLUDED.ai_error, model_name = EXCLUDED.model_name, generated_by = EXCLUDED.generated_by, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [generateId('mgmtrep'), tenantId, month, JSON.stringify(facts), ai.status, ai.narrative ? JSON.stringify(ai.narrative) : null, JSON.stringify(ai.rejected), ai.error, ai.modelName, opts.generatedBy, emptyMonth ? 'ATLANDI_BOŞ' : 'BEKLIYOR']
    );
    await writeAuditLog(client, { action: 'MONTHLY_MANAGEMENT_REPORT_GENERATED', targetType: 'monthly_management_report', targetId: res.rows[0].id, afterValue: { month, aiStatus: ai.status, regenerate: !!existing } });
    return res.rows[0] as MonthlyReportRecord;
  });
  return { record, created: !existing };
}

// ───────────────────────── PDF ─────────────────────────

const AI_NOTICES: Record<AiStatus, string | null> = {
  URETILDI: null,
  KISMEN_DOGRULANDI: null,
  DOGRULANAMADI: 'Yapay zekâ yorumu üretildi ancak hiçbir ifadesi sistem verisiyle doğrulanamadığı için rapora alınmadı.',
  MODEL_ERISILEMEDI: 'Yapay zekâ servisine bu ay ulaşılamadığı için yorum bölümü üretilemedi.',
  GECERSIZ_CIKTI: 'Yapay zekâ servisinin çıktısı işlenemediği için yorum bölümü üretilemedi.',
  MODUL_KAPALI: 'Yapay zekâ yorumu bu firmanın paketinde etkin değil.',
  VERI_YOK: 'Bu ay için ikmal ya da alarm kaydı olmadığından yorum üretilmedi.'
};

async function companyName(): Promise<string> {
  return withTenant(async (client, tenantId) => {
    const r = await client.query(`SELECT name FROM companies WHERE id = $1`, [tenantId]);
    return r.rows[0]?.name ?? tenantId;
  });
}

export function pdfInputFor(record: MonthlyReportRecord, facts: MonthlyFacts, includeAi: boolean, name: string): MonthlyReportPdfInput {
  const narrative: PdfNarrative | null = includeAi && record.ai_narrative ? { summary: record.ai_narrative.summary, findings: record.ai_narrative.findings, risks: record.ai_narrative.risks, recommendations: record.ai_narrative.recommendations } : null;
  const aiNotice = !includeAi ? 'Yapay zekâ yorumu firma geneli veriyle üretildiği için şantiye kapsamlı raporda gösterilmez; firma yöneticisi raporunda yer alır.' : AI_NOTICES[record.ai_status];
  return { companyName: name, facts, narrative, aiNotice, rejectedCount: includeAi ? record.ai_rejected.length : 0, generatedAt: new Date(record.updated_at ?? record.created_at) };
}

/** Görüntüleyiciye göre PDF: firma geneli (yorumlu) ya da tek şantiye (yalnızca ölçülen veri). */
export async function buildMonthlyReportPdfForViewer(month: string, siteScope: string | undefined): Promise<Buffer> {
  const record = await getMonthlyReportRecord(month);
  if (!record) throw new NotFoundError('Bu ay için yönetim raporu henüz üretilmedi.', { error: 'REPORT_NOT_GENERATED', month });
  const facts = siteScope === undefined ? record.facts : await compileMonthlyFacts(month, siteScope);
  return buildMonthlyReportPdfBuffer(pdfInputFor(record, facts, siteScope === undefined, await companyName()));
}

// ───────────────────────── E-posta ─────────────────────────

function emailText(facts: MonthlyFacts, aiStatus: AiStatus, includeAi: boolean): string {
  const t = facts.totals;
  const ai = !includeAi ? 'Yapay zekâ yorumu yalnızca firma geneli raporda yer alır.' : AI_NOTICES[aiStatus] ?? 'Yapay zekâ yorumu ekteki raporun B bölümündedir (model çıktısıdır, ölçüm değildir).';
  return [
    `${facts.month} ayı yönetim raporu ekte (PDF).${facts.scope === 'SITE' ? ` Kapsam: ${facts.site}` : ''}`,
    '',
    `Toplam yakıt: ${trn(t.liters)} L · Tutar: ${trn(t.cost)} ₺ · İkmal: ${t.dispenses} · Alarm: ${t.alarms}`,
    ai
  ].join('\n');
}

export interface DeliveryResult { status: string; sent: number; failed: number; recipients: number }

/**
 * Alıcılar: e-postası olan COMPANY_OWNER'lar (firma geneli + yorum) ve SITE_MANAGER'lar (yalnızca kendi şantiyesi, yorumsuz).
 * Teslim izi (`emailed_user_ids`) → yeniden deneme yalnızca teslim edilmeyenlere gider.
 */
export async function deliverMonthlyManagementReport(month: string): Promise<DeliveryResult> {
  const record = await getMonthlyReportRecord(month);
  if (!record) throw new NotFoundError('Bu ay için yönetim raporu henüz üretilmedi.', { error: 'REPORT_NOT_GENERATED', month });
  if (record.email_status === 'GÖNDERILDI' || record.email_status === 'ATLANDI_BOŞ' || record.email_status === 'KALICI_BAŞARISIZ') {
    return { status: record.email_status, sent: 0, failed: 0, recipients: 0 };
  }

  const users = await withTenant(async (client) => {
    const r = await client.query(`SELECT id, email, role, site_name FROM users WHERE email IS NOT NULL AND email <> '' AND role IN ('COMPANY_OWNER', 'SITE_MANAGER') ORDER BY id`);
    return r.rows as Array<{ id: string; email: string; role: string; site_name: string | null }>;
  });
  const recipients = users.filter((u) => u.role === 'COMPANY_OWNER' || !!u.site_name);
  if (recipients.length === 0) {
    await withTenant((c) => c.query(`UPDATE monthly_management_reports SET email_status = 'ALICI_YOK', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [record.id]));
    return { status: 'ALICI_YOK', sent: 0, failed: 0, recipients: 0 };
  }

  const name = await companyName();
  const delivered = new Set<string>(record.emailed_user_ids);
  const errors: string[] = [];
  const pdfCache = new Map<string, Buffer>();
  let sent = 0;
  let failed = 0;

  for (const u of recipients) {
    if (delivered.has(u.id)) continue;
    const site = u.role === 'SITE_MANAGER' ? (u.site_name as string) : undefined;
    try {
      const key = site ?? '*';
      let pdf = pdfCache.get(key);
      const facts = site === undefined ? record.facts : await compileMonthlyFacts(month, site);
      if (!pdf) { pdf = await buildMonthlyReportPdfBuffer(pdfInputFor(record, facts, site === undefined, name)); pdfCache.set(key, pdf); }
      const text = emailText(facts, record.ai_status, site === undefined);
      await sendEmail({
        to: u.email, subject: `Aylık Yönetim Raporu — ${month}`, text, html: deriveHtmlFromText(text),
        attachments: [{ filename: `yonetim-raporu-${month}${site ? `-${site.replace(/[^\p{L}\p{N}]+/gu, '_')}` : ''}.pdf`, content: pdf, contentType: 'application/pdf' }]
      });
      delivered.add(u.id);
      sent++;
    } catch (err) {
      failed++;
      errors.push(`${u.id}: ${(err as Error).message}`.slice(0, 200));
      logger.error({ err, userId: u.id, month }, '🚨 [REP-724] Aylık yönetim raporu e-postası gönderilemedi.');
    }
  }

  const allDone = recipients.every((u) => delivered.has(u.id));
  const attempts = record.email_attempts + (failed > 0 ? 1 : 0);
  const status = allDone ? 'GÖNDERILDI' : attempts >= MAX_EMAIL_ATTEMPTS ? 'KALICI_BAŞARISIZ' : delivered.size > 0 ? 'KISMEN_GÖNDERILDI' : 'BEKLIYOR';
  await withTenant(async (client) => {
    await client.query(
      `UPDATE monthly_management_reports SET email_status = $2::varchar, email_attempts = $3, emailed_user_ids = $4::jsonb,
         emailed_at = CASE WHEN $2::varchar = 'GÖNDERILDI' THEN NOW() ELSE emailed_at END, last_email_error = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [record.id, status, attempts, JSON.stringify([...delivered]), errors.length > 0 ? errors.join(' | ').slice(0, 900) : null]
    );
    if (sent > 0) await writeAuditLog(client, { action: 'MONTHLY_MANAGEMENT_REPORT_EMAILED', targetType: 'monthly_management_report', targetId: record.id, afterValue: { month, sent, failed, status } });
  });
  return { status, sent, failed, recipients: recipients.length };
}

// ───────────────────────── Süpürücü ─────────────────────────

export async function runMonthlyManagementReportSweepForCurrentTenant(
  now: Date = new Date(),
  deps: MonthlyAiDeps = {}
): Promise<{ month: string; generated: boolean; delivery: DeliveryResult | null }> {
  if (!getTenantId()) throw new Error('runMonthlyManagementReportSweepForCurrentTenant: ambient tenant context yok.');
  const month = previousMonthOf(now);
  if (!isMonthlyReportDue(now)) return { month, generated: false, delivery: null };

  const { record, created } = await generateMonthlyManagementReport(month, { generatedBy: 'system-monthly-scheduler', deps });
  const pending = ['BEKLIYOR', 'KISMEN_GÖNDERILDI'].includes(record.email_status);
  const delivery = pending ? await deliverMonthlyManagementReport(month) : null;
  return { month, generated: created, delivery };
}
