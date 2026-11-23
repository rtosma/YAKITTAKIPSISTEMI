import { Pool } from 'pg';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export const pool = new Pool({
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  database: config.POSTGRES_DB,
  max: 10,
  idleTimeoutMillis: 30000,
  // TEST_PLAN §7 havuz doygunluğu tatbikatı (test_db_pool_saturation.ts):
  // hiçbir zaman aşımı yokken tek bir tenant'ın kilitli tank satırını bekleyen
  // 14 ikmal isteği havuzun 10 bağlantısını SÜRESİZ tuttu ve BAŞKA tenant'ın
  // alakasız GET /vehicles isteği de yanıt alamadı (tüm platform durdu).
  // - lock_timeout: satır/advisory kilit bekleyişi 5 sn'de düşer (normal
  //   FOR UPDATE tutma süreleri ms mertebesinde).
  // - connectionTimeoutMillis: havuz boş bağlantı veremezse istek sonsuza
  //   dek beklemez; errorHandler bunları yeniden denenebilir 503'e çevirir.
  // - statement_timeout: kaçak sorgu üst sınırı (dışa aktarma/raporlar dahil
  //   gözlemlenen en uzun sorgunun çok üstünde).
  // - idle_in_transaction_session_timeout: sızmış (COMMIT/ROLLBACK'siz)
  //   transaction'ın bağlantıyı ve kilitleri sonsuza dek tutmasını önler.
  connectionTimeoutMillis: 10_000,
  lock_timeout: 5_000,
  statement_timeout: 60_000,
  idle_in_transaction_session_timeout: 60_000
});

pool.on('error', (err) => {
  logger.error({ err }, '🚨 [Postgres] Havuz beklenmeyen hata!');
});
