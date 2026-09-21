import { Server } from 'http';
import { logger } from './logger';

export interface GracefulShutdownOptions {
  timeoutMs?: number;
  /**
   * OPS-1110: `server.close()` ile AYNI ANDA (bekletilmeden) başlar — uzun ömürlü
   * bağlantıları (WebSocket) kademeli boşaltmak için. `server.close()` açık bir
   * WebSocket bağlantısı kaldığı sürece ASLA tamamlanmaz; bu kanca olmadan her
   * dağıtım 30 sn'lik zorla-çıkış zamanlayıcısına takılır ve tüm istemciler aynı
   * anda düşerdi. Hata fırlatırsa kapanma yine devam eder.
   */
  onShutdownStart?: () => Promise<void> | void;
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
    let idleSweep: NodeJS.Timeout | undefined;
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

    // OPS-1110: kademeli soket boşaltma, server.close()'un tamamlanmasını beklemeden başlar.
    if (options.onShutdownStart) {
      Promise.resolve()
        .then(() => options.onShutdownStart!())
        .catch((startErr) => logger.error({ err: startErr }, `❌ [Shutdown] onShutdownStart hatası (kapanma sürüyor).`));
    }

    // Step 1: Stop accepting new HTTP connections
    server.close(async (err) => {
      clearInterval(idleSweep);
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

    // OPS-1110: server.close() yalnızca YENİ bağlantıları keser; nginx'in canlı tuttuğu
    // (keep-alive) BOŞTA bağlantılar açık kalır ve close callback'i geciktirir. Boşta
    // olanları periyodik kapat (istek işleyen bağlantılara DOKUNMAZ — devam eden
    // istekler tamamlanır).
    server.closeIdleConnections();
    idleSweep = setInterval(() => server.closeIdleConnections(), 1000);
    idleSweep.unref();
  };

  // Register signal listeners
  process.once('SIGTERM', () => handleShutdown('SIGTERM'));
  process.once('SIGINT', () => handleShutdown('SIGINT'));
}
