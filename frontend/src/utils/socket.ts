import { io, Socket } from 'socket.io-client';

/**
 * FE-801: tek bir singleton Socket.io bağlantısı. `auth` bir FONKSİYON
 * olarak veriliyor — her (yeniden) bağlanma denemesinde localStorage'daki
 * GÜNCEL access token'ı okur, böylece token login/refresh ile değiştiğinde
 * (veya eski socket kopup yeniden bağlanmayı denediğinde) her zaman en son
 * token kullanılır.
 *
 * autoConnect: false — bağlantı yalnızca AppContext, kullanıcı authenticated
 * olduğunda `connectSocket()` ile başlatır; sayfa yüklenir yüklenmez veya
 * token yokken bağlanmaya çalışmaz.
 */
export const socket: Socket = io({
  path: '/socket.io',
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  randomizationFactor: 0.5,
  auth: (cb) => {
    cb({ token: localStorage.getItem('YAKIT_ACCESS_TOKEN') });
  }
});

export function connectSocket(): void {
  if (!socket.connected) {
    socket.connect();
  }
}

export function disconnectSocket(): void {
  socket.disconnect();
}
