import { RedisStore } from 'rate-limit-redis';
import type { ClientRateLimitInfo, IncrementResponse } from 'express-rate-limit';

/**
 * rate-limit-redis, Lua betiklerini YALNIZCA `init()`'te bir kez yükler (SCRIPT LOAD)
 * ve sonucu bir Promise olarak saklar. O ilk yükleme başarısız olursa — örn. backend
 * açılışında olay döngüsü meşgulken redisPool'un 1 sn'lik commandTimeout'u dolarsa
 * ("express-rate-limit: async error during store initialization. Error: Command
 * timed out") — Promise KALICI olarak reddedilmiş kalır. Kütüphane yalnızca
 * `NOSCRIPT` hatasında yeniden yükler; bu durumda her `increment` aynı hatayla düşer
 * ve `passOnStoreError: true` yüzünden istek SESSİZCE geçer. Sonuç: giriş/refresh/
 * cihaz rate limit'leri ve AUTH-209 korumaları o süreç yeniden başlayana dek kapalı
 * kalıyordu (entegrasyon testlerinde ara sıra görüldü: 11. hatalı giriş 429 yerine 401).
 *
 * Bu alt sınıf her çağrıdan önce betik Promise'lerine bakar ve reddedilmişse yeniden
 * yükler: Redis tekrar yanıt verdiği ilk istekte limitler kendiliğinden geri gelir.
 * Sağlıklı durumda maliyet, çözülmüş bir Promise'i beklemekten ibarettir.
 */
const isFulfilled = (p: Promise<unknown> | undefined): Promise<boolean> =>
  p ? p.then(() => true, () => false) : Promise.resolve(false);

export class ResilientRedisStore extends RedisStore {
  private async ensureScripts(): Promise<void> {
    if (!(await isFulfilled(this.incrementScriptSha))) {
      this.incrementScriptSha = this.loadIncrementScript();
    }
    if (!(await isFulfilled(this.getScriptSha))) {
      this.getScriptSha = this.loadGetScript();
    }
    // Yeniden yükleme yine başarısız olursa ve o anda kimse beklemiyorsa (ör. get hiç
    // çağrılmadı) "unhandled rejection" olmasın; reddedilmiş durum korunur, bir sonraki
    // çağrı yeniden dener.
    this.incrementScriptSha.catch(() => undefined);
    this.getScriptSha.catch(() => undefined);
  }

  async increment(key: string): Promise<IncrementResponse> {
    await this.ensureScripts();
    return super.increment(key);
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    await this.ensureScripts();
    return super.get(key);
  }
}
