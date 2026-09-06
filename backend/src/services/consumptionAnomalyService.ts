import { GoogleGenAI } from '@google/genai';
import { config } from '../config/env';
import { ServiceUnavailableError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  anomalyAnalysisResultSchema,
  type AnomalyAnalysisResult
} from '../schemas/consumptionAnomalySchema';
import {
  aggregateVehicleConsumption,
  saveConsumptionAnomalyReport,
  type VehicleConsumptionStat,
  type ConsumptionAnomalyReportRecord
} from '../db/tenantDb';

/**
 * AI-502 — Google Gemini SDK ile şoför/araç tüketim anomali analizi.
 *
 * Gerçek stack: ticket "Node.js Scheduled Cron" öneriyor ama bu kod
 * tabanında BullMQ/agenda/@nestjs/schedule yok — mevcut desen (bkz.
 * index.ts'teki dispense/kalibrasyon zaman aşımı süpürücüleri) düz bir
 * `setInterval`; haftalık otomatik tetikleme de aynı deseni kullanıyor
 * (bkz. index.ts). Bu dosya yalnızca TEK BİR tenant için "şimdi analiz et"
 * mantığını içerir — hem manuel POST /ai/consumption-anomaly-reports hem
 * haftalık süpürücü aynı fonksiyonu (bir tenant context'i içinde) çağırır.
 */

const GEMINI_MODEL = 'gemini-2.0-flash';

// Gemini'nin "structured output" özelliği (responseMimeType: 'application/json'
// + responseSchema) modelin JSON DIŞINDA bir şey üretme ihtimalini büyük
// ölçüde azaltır — ama AC'nin istediği doğrulama BUNA rağmen, DÖNEN metin
// üzerinde ayrıca (bkz. anomalyAnalysisResultSchema) yapılır; bir LLM'in
// "structured output" garantisi bile mutlak değildir (bkz. Google'ın kendi
// dokümantasyonundaki uyarı).
const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    anomalies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          vehiclePlate: { type: 'string' },
          driverName: { type: 'string', nullable: true },
          totalLiters: { type: 'number' },
          dispenseCount: { type: 'integer' },
          riskLevel: { type: 'string', enum: ['DÜŞÜK', 'ORTA', 'YÜKSEK'] },
          reason: { type: 'string' }
        },
        required: ['vehiclePlate', 'driverName', 'totalLiters', 'dispenseCount', 'riskLevel', 'reason']
      }
    }
  },
  required: ['anomalies']
};

/**
 * Saf fonksiyon — hiçbir I/O yapmaz, ağ/DB olmadan birim test edilebilir.
 * İstatistikler zaten sunucu tarafında hesaplanmış sayılardır; Gemini'den
 * beklenen tek şey bu sayıları YORUMLAMASI (hangisi "anomali" sayılır,
 * neden) — ham transactions verisini modele hiç göndermiyoruz, yalnızca
 * özet istatistikleri (daha az token, daha az sızdırılabilecek veri).
 */
export function buildAnomalyPrompt(stats: VehicleConsumptionStat[], periodDays: number): string {
  const rows = stats
    .map((s) => `- Plaka: ${s.vehiclePlate} | Şoför: ${s.driverName ?? 'Bilinmiyor'} | Toplam: ${s.totalLiters.toFixed(2)} L | İkmal Sayısı: ${s.dispenseCount} | Ortalama: ${s.avgLitersPerDispense.toFixed(2)} L/ikmal | Farklı Şantiye: ${s.distinctSites}`)
    .join('\n');

  return [
    `Aşağıda son ${periodDays} günlük yakıt ikmali istatistikleri (araç/şoför bazında) listelenmiştir.`,
    'Filo yöneticisi için bir akaryakıt tüketim anomali analizi yap: aşırı yakan iş makinelerini ve şüpheli şoför tüketim örüntülerini (örn. ortalamanın çok üzerinde tek seferlik alım, alışılmadık sayıda ikmal, çok sayıda farklı şantiyede alım) tespit et.',
    'Yalnızca gerçekten dikkat çekici olan araç/şoför çiftlerini listele — sıradan/normal tüketimi anomali olarak işaretleme.',
    'Her biri için riskLevel (DÜŞÜK/ORTA/YÜKSEK) ve KISA, somut bir Türkçe gerekçe (reason) ver.',
    '',
    rows.length > 0 ? rows : '(Bu dönemde hiç ikmal kaydı yok.)'
  ].join('\n');
}

export interface AnomalyAnalysisDeps {
  /** Test/birim test enjeksiyonu — verilirse gerçek Gemini API'sine HİÇ
   *  gidilmez. Prod kod yolunda bu her zaman undefined'dır. */
  generateContent?: (prompt: string) => Promise<string>;
}

/**
 * GEMINI_API_KEY yoksa (bu sandbox'ta da öyle — gerçek bir ücretli API
 * anahtarı yok) ServiceUnavailableError fırlatır; `deps.generateContent`
 * enjekte edilmişse anahtar hiç gerekmez (test yolu).
 */
export async function requestAnomalyAnalysis(
  stats: VehicleConsumptionStat[],
  periodDays: number,
  deps: AnomalyAnalysisDeps = {}
): Promise<AnomalyAnalysisResult> {
  const prompt = buildAnomalyPrompt(stats, periodDays);

  let rawText: string;
  if (deps.generateContent) {
    rawText = await deps.generateContent(prompt);
  } else {
    if (!config.GEMINI_API_KEY) {
      throw new ServiceUnavailableError(
        'GEMINI_API_KEY yapılandırılmamış — tüketim anomali analizi şu anda kullanılamıyor.'
      );
    }
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    let response;
    try {
      response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_RESPONSE_SCHEMA
        }
      });
    } catch (err) {
      logger.error({ err }, '🚨 [AI-502] Gemini API çağrısı başarısız.');
      throw new ServiceUnavailableError('AI analiz servisine şu anda ulaşılamıyor, lütfen daha sonra tekrar deneyin.');
    }
    rawText = response.text ?? '';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    logger.error({ rawText }, '🚨 [AI-502] AI modelinin çıktısı geçerli JSON değil.');
    throw new ServiceUnavailableError('AI modelinin çıktısı işlenemedi (geçersiz JSON).');
  }

  // AC: "Yapay zeka çıktıları JSON schema formatında doğrulanıp dashboard'a
  // sunulmalıdır." — Gemini'nin responseSchema garantisine rağmen burada
  // AYRICA doğrulanıyor; modelin ürettiği bir alan eksikliği/yanlış tipi
  // sessizce DB'ye ya da dashboard'a sızmamalı.
  const validation = anomalyAnalysisResultSchema.safeParse(parsed);
  if (!validation.success) {
    logger.error({ issues: validation.error.issues, parsed }, '🚨 [AI-502] AI çıktısı beklenen şemaya uymuyor.');
    throw new ServiceUnavailableError('AI modelinin çıktısı beklenen şemaya uymuyor.');
  }

  return validation.data;
}

/**
 * Tek bir tenant için (AKTİF tenant context'i içinde çağrılmalı — bkz.
 * routes.ts POST handler'ı ve index.ts'teki haftalık süpürücünün
 * runWithTenant sarmalayıcısı) uçtan uca akış: topla → (varsa) analiz et →
 * kalıcı kaydet. Hiç ikmal kaydı yoksa Gemini'ye HİÇ gidilmez (gereksiz
 * API maliyeti/gecikme) — boş bir rapor kaydedilir.
 */
export async function generateAndStoreAnomalyReport(
  periodDays: number,
  generatedBy: string,
  deps: AnomalyAnalysisDeps = {}
): Promise<ConsumptionAnomalyReportRecord> {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const stats = await aggregateVehicleConsumption(periodDays);

  const analysis: AnomalyAnalysisResult = stats.length > 0
    ? await requestAnomalyAnalysis(stats, periodDays, deps)
    : { anomalies: [] };

  return saveConsumptionAnomalyReport({
    periodDays,
    periodStart,
    periodEnd,
    vehicleCount: stats.length,
    anomalies: analysis.anomalies,
    modelName: deps.generateContent ? 'test-double' : GEMINI_MODEL,
    generatedBy
  });
}
