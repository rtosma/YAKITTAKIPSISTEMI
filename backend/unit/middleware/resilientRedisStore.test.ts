import { describe, expect, it } from 'vitest';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { ResilientRedisStore } from '../../src/middleware/resilientRedisStore';

/**
 * Backend açılışında rate limit betiğinin ilk yüklemesi zaman aşımına uğrarsa
 * (redisPool commandTimeout=1sn, açılışta olay döngüsü meşgul) kütüphane o
 * Promise'i kalıcı reddedilmiş tutuyor ve limitler süreç ömrü boyunca kapalı
 * kalıyordu (passOnStoreError). Sahte bir Redis ile: ilk SCRIPT LOAD düşer.
 */
function fakeRedis(failFirstLoads: number) {
  let remainingFailures = failFirstLoads;
  const hits = new Map<string, number>();
  const sendCommand = async (...args: string[]): Promise<RedisReply> => {
    if (args[0] === 'SCRIPT' && args[1] === 'LOAD') {
      if (remainingFailures > 0) { remainingFailures--; throw new Error('Command timed out'); }
      return `sha-${args[2].length}`;
    }
    if (args[0] === 'EVALSHA') {
      const key = args[3];
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      return [n, 60_000];
    }
    throw new Error(`beklenmeyen komut: ${args.join(' ')}`);
  };
  return { sendCommand };
}

async function initQuietly(store: RedisStore): Promise<void> {
  // express-rate-limit init hatasını yakalayıp loglar; burada da yutulur.
  await store.init({ windowMs: 60_000 } as Parameters<RedisStore['init']>[0]).catch(() => undefined);
}

describe('ResilientRedisStore', () => {
  it('HATA KANITI: düz RedisStore, ilk betik yüklemesi düşünce sonraki her increment\'te de düşer (Redis iyileşmiş olsa bile)', async () => {
    const store = new RedisStore(fakeRedis(1));
    await initQuietly(store);
    await expect(store.increment('ip-1')).rejects.toThrow('Command timed out');
    await expect(store.increment('ip-1')).rejects.toThrow('Command timed out');
  });

  it('ilk betik yüklemesi düşse de Redis yanıt verdiği ilk istekte kendini toparlar ve saymaya başlar', async () => {
    const store = new ResilientRedisStore(fakeRedis(1));
    await initQuietly(store);
    expect((await store.increment('ip-1')).totalHits).toBe(1);
    expect((await store.increment('ip-1')).totalHits).toBe(2);
  });

  it('Redis hâlâ yanıt vermiyorsa o istek hata alır (passOnStoreError devreye girer), sonraki istek yeniden dener', async () => {
    const store = new ResilientRedisStore(fakeRedis(3)); // init'te 2 yükleme + 1 yeniden deneme düşer
    await initQuietly(store);
    await expect(store.increment('ip-1')).rejects.toThrow('Command timed out');
    expect((await store.increment('ip-1')).totalHits).toBe(1);
  });

  it('sağlıklı durumda davranış düz RedisStore ile aynı', async () => {
    const store = new ResilientRedisStore(fakeRedis(0));
    await initQuietly(store);
    expect((await store.increment('a')).totalHits).toBe(1);
    expect((await store.increment('b')).totalHits).toBe(1);
    expect((await store.increment('a')).totalHits).toBe(2);
  });
});
