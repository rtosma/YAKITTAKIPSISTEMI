import Redlock from 'redlock';
import { redisPool } from '../db/redisPool';
import { logger } from '../utils/logger';
import { ConflictError } from '../utils/errors';

/**
 * FUEL-402.2 AC/Teknik Yığın: "redlock + ioredis ... `lock:quota:{permissionId}`
 * anahtarıyla Redlock dağıtık kilidi."
 *
 * Asıl yarış NEREDE? cross_site_permissions.used_liters'ın kendisi zaten
 * Postgres `FOR UPDATE` ile korunuyor (createTransaction/finalizeDispenseSession
 * — bkz. o fonksiyonlardaki yorumlar). AMA yetkilendirme akışı (authorize
 * DispenseRequest → dispenseSessionService.createSession) İKİ AYRI sistem
 * (Postgres + Redis) arasında, TEK bir DB transaction'ıyla kapatılamayan bir
 * "bakiye oku → rezerve et" adımı içeriyor: authorizeDispenseRequest kalan
 * kotayı SADECE DB'deki used_liters'a göre hesaplıyordu, henüz FINALIZE
 * OLMAMIŞ (AUTHORIZED/PUMPING durumundaki) diğer aktif oturumların rezerve
 * ettiği miktarı GÖRMÜYORDU — ticket'ın uç durum notu: "500 litrelik kotayla
 * 3 araç aynı anda başlayabilir." fuel_quotas (FUEL-402.1) tarafı bunu
 * `getQuotaBalance()`'ta `listActiveSessions()` ile ZATEN doğru yapıyordu;
 * cross_site_permissions tarafı yapmıyordu — bu dosya + tenantDb.ts'teki
 * çağıran taraf bu boşluğu kapatıyor.
 *
 * Tek bir Redis örneği var (docker-compose) ama Redlock TEK istemciyle de
 * doğru çalışır (ticket notu: "tek Redis örneğinde de doğru davranmalı, çok
 * düğümlü kuruluma hazır olmalı") — birden fazla backend replikası aynı
 * cross_site_permissions satırına eşzamanlı yetkilendirme denemesi
 * yaptığında bu kilit onları serialize eder.
 */
const redlock = new Redlock([redisPool.client], {
  retryCount: 5,
  retryDelay: 100,
  retryJitter: 50
});

redlock.on('clientError', (err) => {
  logger.warn({ err }, '⚠️ [FUEL-402.2] Redlock istemci hatası (arka plan — kilit alma denemesini bloke etmez).');
});

// Ticket notu: "Kilit süresi (TTL) yetki kontrolünün tamamlanma süresinden
// uzun ama kısa olmalı (öneri: 3 saniye); uzun kilit tüm şantiyeyi bekletir."
const QUOTA_LOCK_TTL_MS = 3000;

/**
 * `lock:quota:{permissionId}` kilidi altında `fn`'i çalıştırır. Kilit
 * alınamazsa (retryCount tükendiğinde) ConflictError fırlatır — çağıran
 * (authorizeDispenseRequest) bunu diğer hata yollarıyla aynı şekilde 409
 * olarak cihaza döndürür (ticket notu: "kilit alınamazsa ... zaman aşımı
 * davranışı").
 */
export async function withQuotaLock<T>(permissionId: string, fn: () => Promise<T>): Promise<T> {
  let lock;
  try {
    lock = await redlock.lock(`lock:quota:${permissionId}`, QUOTA_LOCK_TTL_MS);
  } catch (err) {
    logger.error({ err, permissionId }, '🚨 [FUEL-402.2] Kota kilidi alınamadı (yeniden denemeler tükendi).');
    throw new ConflictError('Kota şu anda başka bir işlem tarafından kullanılıyor, lütfen tekrar deneyin.', { error: 'QUOTA_LOCK_UNAVAILABLE' });
  }
  try {
    return await fn();
  } finally {
    // Kilit sahibi çökse/unlock() ağa ulaşamasa bile TTL ile kendiliğinden
    // düşer (ticket notu: "kalıcı kilit/deadlock oluşmamalı") — bu yüzden
    // unlock() hatası burada YUTULUR, yukarı fırlatılmaz.
    await lock.unlock().catch((err: Error) => {
      logger.warn({ err, permissionId }, '⚠️ [FUEL-402.2] Kota kilidi serbest bırakılamadı (TTL ile kendiliğinden düşecek).');
    });
  }
}
