import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { verifyAccessToken } from '../services/tokenService';
import { logger } from '../utils/logger';
import { ioTEventBus } from '../iot/mqttClient';
import { runWithTenant } from '../context/tenantContext';
import { isServerShuttingDown } from '../utils/shutdown';

/**
 * FE-801: Socket.io İstemcisi ile Canlı Pompa ve Tank Telemetrisi
 *
 * Her socket, bağlantı sırasında (aynı JWT access token'ıyla, HTTP auth ile
 * birebir aynı doğrulama) kendi tenant'ının odasına (`tenant:{tenantId}`)
 * katılır — bir kiracının canlı verisi asla başka bir kiracıya sızmaz (RLS'in
 * gerçek zamanlı kanaldaki karşılığı).
 */

let io: SocketIOServer | null = null;

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    path: '/socket.io',
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  // Handshake-time JWT doğrulaması — HTTP route'larındaki authenticateJWT ile
  // aynı token/secret'ı kullanır. Token geçersiz/eksikse bağlantı reddedilir.
  io.use((socket: Socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) {
        return next(new Error('UNAUTHORIZED: Token gerekli.'));
      }
      const payload = verifyAccessToken(token);
      socket.data.tenantId = payload.tenantId;
      socket.data.userId = payload.userId;
      socket.data.role = payload.role;
      next();
    } catch (err) {
      next(new Error('UNAUTHORIZED: Geçersiz veya süresi dolmuş token.'));
    }
  });

  io.on('connection', (socket: Socket) => {
    // ARCH-101.4: AsyncLocalStorage, io.use() handshake middleware'inde
    // (senkron olarak) çalıştırılsa bile bu 'connection' event'ine ve onun
    // altındaki socket.on(...) event handler'larına OTOMATİK taşınmaz —
    // Socket.io'nun kendi EventEmitter zinciri, ALS.run()'ın senkron çağrı
    // yığınının DIŞINDadır (bkz. ARCH-101.1 ticket notu: "üçüncü parti event
    // emitter'larda kopabilir"). Bu yüzden her socket-scoped handler kendi
    // tenant context'ini burada, socket doğrulaması sırasında JWT'den
    // çıkarılan tenantId/userId ile açıkça kurar — böylece bu handler'lardan
    // ileride çağrılabilecek tenantDb.ts fonksiyonları (withTenant/getTenantId)
    // doğru kiracıyı görür.
    const tenantStore = { tenantId: socket.data.tenantId, userId: socket.data.userId };
    const tenantRoom = `tenant:${socket.data.tenantId}`;
    socket.join(tenantRoom);
    logger.info({ tenantId: socket.data.tenantId, userId: socket.data.userId, socketId: socket.id }, '🔌 [Socket.io] İstemci bağlandı.');

    // OPS-1110: kapanma sırasında (drain penceresi içinde) gelen GEÇ bağlantılar da kademeli
    // koparılır — aksi halde server.close() bu soketi beklerdi. Handshake'te REDDETMEK yerine
    // bağlanıp koparıyoruz: middleware hatası istemcide OTOMATİK yeniden bağlanmayı durdurur.
    if (isServerShuttingDown()) {
      closeTransportLater(socket, 500 + Math.random() * 2500);
    }

    socket.on('disconnect', (reason) => {
      runWithTenant(tenantStore, () => {
        logger.info({ tenantId: socket.data.tenantId, socketId: socket.id, reason }, '🔌 [Socket.io] İstemci ayrıldı.');
      });
    });
  });

  // MQTT'den gelen telemetri verisini, ilgili kiracının odasına yayınla.
  // ioTEventBus zaten mqttClient.ts'te "ARCH-102'ye hazırlık" olarak var —
  // burada onu gerçekten tüketen ilk abone bu. mqttClient.ts kendi tarafında
  // bu emit()'i zaten ilgili tenant'ın AsyncLocalStorage context'i içinde
  // yapıyor (bkz. mqttClient.ts) — EventEmitter.emit() senkron çalıştığı için
  // bu listener da aynı context'i (görsel olarak farklı bir dosyada tanımlı
  // olsa da) miras alır.
  ioTEventBus.on('telemetryData', (payload: { tenantId: string;[key: string]: any }) => {
    io?.to(`tenant:${payload.tenantId}`).emit('telemetry:data', payload);
  });

  // IOT-301.2 AC: "Cihaz durumu değişimi canlı olarak arayüze yansımalıdır."
  // mqttClient.ts yalnızca GERÇEK bir ONLINE/OFFLINE geçişinde bu olayı
  // fırlatır (bkz. redisPool.setDeviceState'in `changed` dönüşü) — her
  // telemetri paketinde değil, bu yüzden burada ek bir debounce/filtreleme
  // gerekmiyor.
  ioTEventBus.on('deviceStatusChanged', (payload: { tenantId: string;[key: string]: any }) => {
    io?.to(`tenant:${payload.tenantId}`).emit('device:status', payload);
  });

  logger.info('🔌 [Socket.io] Sunucu başlatıldı (path: /socket.io).');
  return io;
}

/**
 * Bir kiracının tüm bağlı socket'lerine bir olay yayınlar (örn. bir ikmal
 * tamamlandığında tank seviyelerinin anında güncellenmesi için). io henüz
 * başlatılmamışsa (örn. testler) sessizce no-op'tur.
 */
export function broadcastToTenant(tenantId: string, event: string, payload: unknown): void {
  io?.to(`tenant:${tenantId}`).emit(event, payload);
}

/**
 * OPS-1110: Bağlantıyı, istemcide OTOMATİK YENİDEN BAĞLANMAYI tetikleyecek şekilde keser.
 * `socket.disconnect(true)` kullanılmaz: istemciye "io server disconnect" nedeni gider ve
 * socket.io-client bu durumda ARTIK yeniden bağlanmaz (canlı tatbikatta ölçüldü: 20/20
 * istemci kalıcı olarak düştü). Alttaki taşıma katmanını (engine) kapatmak ise istemcide
 * "transport close" olarak görünür — frontend/src/utils/socket.ts'in sonsuz üstel
 * geri çekilmeli reconnect'i devreye girer ve nginx üzerinden YENİ örneğe bağlanır.
 */
function closeTransportLater(socket: Socket, delayMs: number): void {
  const timer = setTimeout(() => socket.conn.close(), delayMs);
  timer.unref?.();
}

/**
 * OPS-1110: Kapanma sırasında bağlı tüm socket'leri TEK SEFERDE değil, `windowMs`
 * penceresine JİTTER'LI dağıtarak koparır. Hepsi aynı anda düşse tüm istemciler
 * aynı saniyede yeni örneğe yeniden bağlanır ("thundering herd": el sıkışma +
 * JWT doğrulama + oda katılımı yükü). İstemci tarafı (frontend/src/utils/socket.ts)
 * zaten sonsuz reconnect + üstel gecikme/jitter yapar; sunucu tarafı bunu
 * tamamlar. Sıra rastgele karıştırılır ki bir kiracının tüm istemcileri aynı
 * dilimde düşmesin. Dönüş: koparılan socket sayısı (log/test için).
 */
export function drainSocketClients(windowMs: number): Promise<number> {
  const server = io;
  if (!server) return Promise.resolve(0);
  const sockets = Array.from(server.sockets.sockets.values());
  // Fisher–Yates
  for (let i = sockets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sockets[i], sockets[j]] = [sockets[j], sockets[i]];
  }
  const total = sockets.length;
  if (total === 0) return Promise.resolve(0);
  logger.info({ sockets: total, windowMs }, '🔌 [Socket.io] Kapanma: istemciler kademeli koparılıyor.');
  return new Promise((resolve) => {
    let remaining = total;
    sockets.forEach((socket, index) => {
      // Eşit aralıklı dilim + dilim içinde jitter: dağılım hem düzgün hem tahmin edilemez.
      const slot = (index / total) * windowMs;
      const jitter = Math.random() * (windowMs / total);
      const timer = setTimeout(() => {
        socket.conn.close();
        if (--remaining === 0) resolve(total);
      }, Math.min(windowMs, slot + jitter));
      timer.unref?.();
    });
  });
}
