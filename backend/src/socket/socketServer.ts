import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { verifyAccessToken } from '../services/tokenService';
import { logger } from '../utils/logger';
import { ioTEventBus } from '../iot/mqttClient';

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
    const tenantRoom = `tenant:${socket.data.tenantId}`;
    socket.join(tenantRoom);
    logger.info({ tenantId: socket.data.tenantId, userId: socket.data.userId, socketId: socket.id }, '🔌 [Socket.io] İstemci bağlandı.');

    socket.on('disconnect', (reason) => {
      logger.info({ tenantId: socket.data.tenantId, socketId: socket.id, reason }, '🔌 [Socket.io] İstemci ayrıldı.');
    });
  });

  // MQTT'den gelen telemetri verisini, ilgili kiracının odasına yayınla.
  // ioTEventBus zaten mqttClient.ts'te "ARCH-102'ye hazırlık" olarak var —
  // burada onu gerçekten tüketen ilk abone bu.
  ioTEventBus.on('telemetryData', (payload: { tenantId: string;[key: string]: any }) => {
    io?.to(`tenant:${payload.tenantId}`).emit('telemetry:data', payload);
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
