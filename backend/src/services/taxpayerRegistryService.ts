import { redisPool } from '../db/redisPool';
import { logger } from '../utils/logger';

/**
 * COMP-605 — e-İrsaliye mükellefiyet sorgusu.
 *
 * Bilinçli sapma: gerçek GİB / özel entegratör mükellefiyet sorgusu COMP-602
 * adaptörü olmadan yapılamaz. Bu servis DETERMİNİSTİK bir taklittir:
 *   - Bilinen (sabit) mükellef listesindeyse → obligated.
 *   - Değilse: rakam toplamı çift olan VKN/TCKN'ler mükellef sayılır (kararlı,
 *     tekrar edilebilir bir kural — testler ve demo için).
 * Sonuç `taxpayer:oblig:<taxId>` anahtarında 24 saat önbelleklenir (Kritik
 * Not: "önbellek TTL'i makul olmalı — öneri 24 saat"). COMP-602 gelince
 * yalnızca `queryRegistry` gövdesi değişir.
 */

const OBLIGATION_CACHE_TTL_SECONDS = 24 * 60 * 60;

// Seed firmalarının VKN'leri + birkaç örnek — hepsi "e-İrsaliye mükellefi".
const KNOWN_OBLIGATED_TAX_IDS = new Set<string>([
  '2381092831', // comp-camsa
  '4820193841', // comp-kusak
  '9182301928'  // comp-avrasya
]);

export interface ObligationResult {
  taxId: string;
  obligated: boolean;
  source: 'CACHE' | 'KNOWN_LIST' | 'MOCK_RULE';
  checkedAt: string;
}

function cacheKey(taxId: string): string {
  return `taxpayer:oblig:${taxId}`;
}

function queryRegistry(taxId: string): { obligated: boolean; source: 'KNOWN_LIST' | 'MOCK_RULE' } {
  if (KNOWN_OBLIGATED_TAX_IDS.has(taxId)) return { obligated: true, source: 'KNOWN_LIST' };
  const digitSum = taxId.split('').reduce((a, c) => a + (Number(c) || 0), 0);
  return { obligated: digitSum % 2 === 0, source: 'MOCK_RULE' };
}

export async function getEInvoiceObligation(taxId: string, forceRefresh = false): Promise<ObligationResult> {
  if (!forceRefresh) {
    try {
      const cached = await redisPool.cacheGetJson<ObligationResult>(cacheKey(taxId));
      if (cached) return { ...cached, source: 'CACHE' };
    } catch (err) {
      logger.warn({ err, taxId }, '[COMP-605] mükellefiyet önbellek okuması başarısız, canlı sorguya düşülüyor.');
    }
  }

  const { obligated, source } = queryRegistry(taxId);
  const result: ObligationResult = { taxId, obligated, source, checkedAt: new Date().toISOString() };
  try {
    await redisPool.cacheSetJson(cacheKey(taxId), result, OBLIGATION_CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, taxId }, '[COMP-605] mükellefiyet önbelleğe yazılamadı (yok sayıldı).');
  }
  return result;
}
