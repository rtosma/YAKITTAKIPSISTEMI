import { Server } from 'http';
import { logger } from './logger';

export interface GracefulShutdownOptions {
  timeoutMs?: number;
  onShutdown?: () => Promise<void> | void;
}

let isShuttingDown = false;

export function isServerShuttingDown(): boolean {
  return isShuttingDown;
}

/**
 * Setup Graceful Shutdown listeners for SIGTERM and SIGINT signals
 */
export function setupGracefulShutdown(server: Server, options: GracefulShutdownOptions = {}): void {
  const timeoutMs = options.timeoutMs || 30000; // Default 30s timeout

  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) {
      logger.warn({ signal }, `[Shutdown] Kapanma zaten devam ediyor, ikinci sinyal yok sayıldı.`);
      return;
    }

    isShuttingDown = true;
    logger.info({ signal, timeoutMs }, `🛑 [Graceful Shutdown] ${signal} sinyali alındı. Sunucu güvenli bir şekilde kapatılıyor...`);

    // Set a hard timeout to force exit if active connections do not close within timeout
    const forceExitTimer = setTimeout(() => {
      logger.error({ timeoutMs }, `⚠️ [Shutdown] Graceful shutdown zamanaşımına uğradı (${timeoutMs}ms). Güçlü kapatma uygulanıyor.`);
      process.exit(1);
    }, timeoutMs);

    // Prevent timer from keeping event loop active unnecessarily if server closes sooner
    if (typeof forceExitTimer.unref === 'function') {
      forceExitTimer.unref();
    }

    // Step 1: Stop accepting new HTTP connections
    server.close(async (err) => {
      if (err) {
        logger.error({ err }, `❌ [Shutdown] HTTP sunucusu kapatılırken hata oluştu.`);
      } else {
        logger.info(`✅ [Shutdown] HTTP sunucusu yeni bağlantıları kapattı.`);
      }

      // Step 2: Run custom cleanup (e.g. database pool end, redis disconnect)
      try {
        if (options.onShutdown) {
          logger.info(`🧹 [Shutdown] Eknak kaynak temizliği çalıştırılıyor...`);
          await options.onShutdown();
          logger.info(`✅ [Shutdown] Eknak kaynaklar başarıyla kapatıldı.`);
        }
      } catch (cleanupErr) {
        logger.error({ err: cleanupErr }, `❌ [Shutdown] Temizlik sırasında hata oluştu.`);
      } finally {
        clearTimeout(forceExitTimer);
        logger.info(`👋 [Shutdown] Sunucu başarıyla kapatıldı. Çıkış yapılıyor (0).`);
        process.exit(0);
      }
    });
  };

  // Register signal listeners
  process.once('SIGTERM', () => handleShutdown('SIGTERM'));
  process.once('SIGINT', () => handleShutdown('SIGINT'));
}
