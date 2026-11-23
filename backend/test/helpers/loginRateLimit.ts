import Redis from 'ioredis';

/**
 * TEST_PLAN.md §0.3 — test paketi genelinde login rate-limit hijyeni.
 *
 * SORUN: `loginRateLimiter` IP bazlıdır (10 deneme / 15 dakika, bkz.
 * middleware/rateLimitMiddleware.ts) ve test paketindeki TÜM dosyalar aynı
 * IP'den gelir. CI'da ~50 test adımı arka arkaya koşuyor; her biri birkaç
 * giriş yapınca limit tükeniyor ve SONRAKİ testler 429 alıp YANLIŞLIKLA
 * kırılıyor — testin kendisinde hiçbir sorun olmamasına rağmen.
 *
 * Bu, gerçek bir olayla doğrulandı: yeni eklenen iki test limiti tüketince
 * `test_auth201` ve `test_195_tenant_isolation` kırıldı; ikisi de TEK BAŞINA
 * %100 geçiyordu. Aynı şekilde `test_arch108` 17/17 geçerken paket içinde
 * 16/17'ye düşüyordu.
 *
 * ÇÖZÜM: Testler zaten bu deseni kullanıyordu (52 login yapan dosyadan 40'ı
 * kendi içinde `rl:auth-login:*` anahtarlarını siliyordu) — ama her dosya
 * kendi kopyasını yazmıştı ve 12 dosyada eksikti. Burası o ortak deseni tek
 * bir yere taşıyor.
 *
 * NEDEN rate limiter'ı test ortamında DEVRE DIŞI BIRAKMIYORUZ: o zaman
 * production'da aktif olan bir güvenlik kontrolü test ortamında hiç
 * çalışmazdı — testlerin ürettiği güvence gerçeği yansıtmazdı. Anahtarları
 * temizlemek davranışı değiştirmez, yalnızca testler arası birikimi siler.
 *
 * NEDEN her çağrıda yeni bağlantı: modül seviyesinde tutulan kalıcı bir
 * ioredis bağlantısı, testin process'inin sonlanmasını engeller (her dosyada
 * ayrıca bir `quit()` çağrısı gerektirirdi). Aç-kapa maliyeti milisaniye
 * mertebesinde ve hiçbir çağrı noktasında temizlik sorumluluğu doğurmuyor.
 */
export async function resetLoginRateLimit(): Promise<void> {
  const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    // Redis erişilemezse test akışını saniyelerce bekletme.
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    lazyConnect: false
  });

  try {
    const keys = await redis.keys('rl:auth-login:*');
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // Redis erişilemiyorsa testi burada DURDURMUYORUZ: bu bir yardımcı,
    // testin kendi doğrulama noktası değil. Gerçek sorun varsa test zaten
    // kendi assertion'ında başarısız olur.
  } finally {
    await redis.quit().catch(() => {});
  }
}
