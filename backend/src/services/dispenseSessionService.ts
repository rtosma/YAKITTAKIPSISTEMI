import { redisPool } from '../db/redisPool';
import { logger } from '../utils/logger';
import { ConflictError, NotFoundError } from '../utils/errors';

/**
 * FUEL-401.2 — devam eden bir ikmalin durumunu tek bir yerde (Redis, TTL'li)
 * tutan state machine. NestJS + BullMQ + ARCH-102 outbox (ticket'ın "Teknik
 * Yığın"ı) bu kod tabanında yok — sunucu yeniden başladığında oturumların
 * "Redis'te yaşamaya devam etmesi" AC'si zaten Redis'in kendisi sunucu
 * process'inden bağımsız olduğu için doğal olarak sağlanıyor, ayrı bir
 * kalıcılık katmanına gerek yok.
 */

export type DispenseSessionState = 'AUTHORIZED' | 'PUMPING' | 'FINALIZING' | 'COMPLETED' | 'ABORTED' | 'TIMED_OUT';

export interface DispenseSession {
  sessionId: string;
  tenantId: string;
  siteName: string;
  deviceId: string;
  vehiclePlate: string;
  driverName: string;
  tankName: string;
  state: DispenseSessionState;
  maxAllowedLiters: number;
  startTotalizerLiters: number | null;
  currentTotalizerLiters: number | null;
  currentFlowRateLpm: number | null;
  createdAt: number;
  lastHeartbeatAt: number;
}

// FUEL-401.2 AC + Teknik Notlar: TTL maksimum ikmal süresinden UZUN olmalı
// (öneri: 30dk) — erken düşerse akış ortada kesilir.
const SESSION_TTL_SECONDS = 30 * 60;
// FUEL-401.3 AC: "15 saniye heartbeat gelmezse oturum düşürülmelidir."
export const HEARTBEAT_TIMEOUT_MS = 15_000;

// Geçerli durum geçişleri — ticket'ın kendi notu: "Geçersiz durum geçişleri
// (örn. COMPLETED → PUMPING) reddedilmelidir; cihaz gecikmiş paket
// gönderebilir." Terminal durumlardan (COMPLETED/ABORTED/TIMED_OUT) hiçbir
// yere geçiş yok.
const VALID_TRANSITIONS: Record<DispenseSessionState, DispenseSessionState[]> = {
  AUTHORIZED: ['PUMPING', 'ABORTED', 'TIMED_OUT'],
  PUMPING: ['FINALIZING', 'ABORTED', 'TIMED_OUT'],
  // FINALIZING'e PUMPING dışında TIMED_OUT'tan da geçilebilir — ticket notu:
  // "TIMED_OUT oturumlar otomatik tamamlanmamalı, operatör onayına
  // düşmelidir." Cihaz bağlantıyı kurtarıp son totalizatör okumasını
  // bildirdiğinde bu KURTARMA yolundan geçer; routes.ts bu durumda
  // finalize'ı zorla 'DOĞRULAMA_BEKLIYOR' olarak işaretler (bkz.
  // finalizeDispenseSession'ın forceManualVerification parametresi).
  FINALIZING: ['COMPLETED', 'ABORTED'],
  COMPLETED: [],
  ABORTED: [],
  TIMED_OUT: ['FINALIZING']
};

function sessionKey(deviceId: string): string {
  return `dispense:session:${deviceId}`;
}

async function readSession(deviceId: string): Promise<DispenseSession | null> {
  const raw = await redisPool.client.get(sessionKey(deviceId));
  return raw ? (JSON.parse(raw) as DispenseSession) : null;
}

async function writeSession(session: DispenseSession): Promise<void> {
  await redisPool.client.set(sessionKey(session.deviceId), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
}

/**
 * FUEL-401.1/401.2 AC: "Aynı pompada eşzamanlı iki oturum açılamamalıdır."
 * O pompa (deviceId) için zaten AKTİF (terminal olmayan) bir oturum varsa
 * reddeder.
 */
export async function createSession(input: {
  tenantId: string;
  siteName: string;
  deviceId: string;
  vehiclePlate: string;
  driverName: string;
  tankName: string;
  maxAllowedLiters: number;
}): Promise<DispenseSession> {
  const existing = await readSession(input.deviceId);
  if (existing && !['COMPLETED', 'ABORTED', 'TIMED_OUT'].includes(existing.state)) {
    throw new ConflictError(
      `'${input.deviceId}' pompasında zaten devam eden bir ikmal oturumu var (durum: ${existing.state}).`,
      { error: 'SESSION_ALREADY_ACTIVE', existingSessionId: existing.sessionId }
    );
  }

  const now = Date.now();
  const session: DispenseSession = {
    sessionId: `dsess-${now}-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: input.tenantId,
    siteName: input.siteName,
    deviceId: input.deviceId,
    vehiclePlate: input.vehiclePlate,
    driverName: input.driverName,
    tankName: input.tankName,
    state: 'AUTHORIZED',
    maxAllowedLiters: input.maxAllowedLiters,
    startTotalizerLiters: null,
    currentTotalizerLiters: null,
    currentFlowRateLpm: null,
    createdAt: now,
    lastHeartbeatAt: now
  };
  await writeSession(session);
  logger.info({ sessionId: session.sessionId, deviceId: input.deviceId, vehiclePlate: input.vehiclePlate }, '🟢 [FUEL-401] İkmal oturumu yetkilendirildi (AUTHORIZED).');
  return session;
}

export async function getSession(deviceId: string, sessionId: string): Promise<DispenseSession> {
  const session = await readSession(deviceId);
  if (!session || session.sessionId !== sessionId) {
    throw new NotFoundError('İkmal oturumu bulunamadı veya süresi doldu.', { error: 'SESSION_NOT_FOUND' });
  }
  return session;
}

function assertTransition(session: DispenseSession, next: DispenseSessionState): void {
  if (!VALID_TRANSITIONS[session.state].includes(next)) {
    throw new ConflictError(
      `Geçersiz oturum durumu geçişi: ${session.state} → ${next}.`,
      { error: 'INVALID_STATE_TRANSITION', from: session.state, to: next }
    );
  }
}

/**
 * FUEL-401.3: her heartbeat'te çağrılır. İlk çağrıda AUTHORIZED→PUMPING'e
 * geçer (ve startTotalizerLiters'ı bu ANDAKİ totalizatör okumasıyla
 * sabitler — ikmalin GERÇEK başlangıç noktası budur). Sonraki çağrılar
 * yalnızca current* alanlarını ve TTL'i tazeler.
 */
export async function recordHeartbeat(
  deviceId: string,
  sessionId: string,
  totalizerLiters: number,
  flowRateLpm: number
): Promise<DispenseSession> {
  const session = await getSession(deviceId, sessionId);

  if (session.state === 'AUTHORIZED') {
    assertTransition(session, 'PUMPING');
    session.state = 'PUMPING';
    session.startTotalizerLiters = totalizerLiters;
  } else if (session.state !== 'PUMPING') {
    // Zaten PUMPING'te kalan heartbeat'ler normal akış; başka bir durumdan
    // (FINALIZING/terminal) gelen bir heartbeat'i gecikmiş/geçersiz say.
    throw new ConflictError(
      `Oturum '${session.state}' durumundayken heartbeat kabul edilmez.`,
      { error: 'INVALID_STATE_TRANSITION', from: session.state }
    );
  }

  session.currentTotalizerLiters = totalizerLiters;
  session.currentFlowRateLpm = flowRateLpm;
  session.lastHeartbeatAt = Date.now();
  await writeSession(session);
  return session;
}

/** Sunucu tarafı ikinci savunma hattı: FUEL-401.3 AC — maksimum litre/süre aşımında otomatik kesme. */
export async function checkLimits(session: DispenseSession): Promise<{ exceeded: boolean; reason?: string }> {
  const litersSoFar = (session.currentTotalizerLiters ?? 0) - (session.startTotalizerLiters ?? 0);
  if (litersSoFar >= session.maxAllowedLiters) {
    return { exceeded: true, reason: 'MAX_LITERS_EXCEEDED' };
  }
  const elapsedMs = Date.now() - session.createdAt;
  const MAX_SESSION_DURATION_MS = SESSION_TTL_SECONDS * 1000;
  if (elapsedMs >= MAX_SESSION_DURATION_MS) {
    return { exceeded: true, reason: 'MAX_DURATION_EXCEEDED' };
  }
  return { exceeded: false };
}

/**
 * FUEL-401.4: sonlandırma sürecine geçiş — finalize ucu bunu ÖNCE çağırır.
 * `wasTimedOut`, dönüşten ÖNCEKİ durumun TIMED_OUT olup olmadığını taşır —
 * routes.ts bunu finalizeDispenseSession'a `forceManualVerification` olarak
 * iletir (ticket notu: zorla kesilmiş bir oturum asla otomatik "doğrulandı"
 * sayılmamalı).
 */
export async function beginFinalize(deviceId: string, sessionId: string): Promise<{ session: DispenseSession; wasTimedOut: boolean }> {
  const session = await getSession(deviceId, sessionId);
  const wasTimedOut = session.state === 'TIMED_OUT';
  assertTransition(session, 'FINALIZING');
  session.state = 'FINALIZING';
  await writeSession(session);
  return { session, wasTimedOut };
}

export async function completeSession(deviceId: string, sessionId: string): Promise<void> {
  const session = await getSession(deviceId, sessionId);
  assertTransition(session, 'COMPLETED');
  session.state = 'COMPLETED';
  // Kısa bir süre (denetim/debug için) tutulur, sonra TTL'iyle kendiliğinden düşer.
  await writeSession(session);
}

/**
 * FUEL-401.3: heartbeat zaman aşımı VEYA limit aşımı nedeniyle sunucu
 * tarafından zorla sonlandırma. TIMED_OUT/ABORTED — "tamamlandı"
 * SAYILMAMALI (ticket notu), operatör onayına düşecek şekilde ayrı
 * işaretlenir (bkz. routes.ts'teki finalize ucu, bu durumdaki bir oturumun
 * kaydını "PARTIAL_CUTOFF" olarak yaratabilir).
 */
export async function forceAbort(deviceId: string, reason: 'TIMED_OUT' | 'ABORTED'): Promise<DispenseSession | null> {
  const session = await readSession(deviceId);
  if (!session) return null;
  if (!VALID_TRANSITIONS[session.state].includes(reason)) return session; // zaten terminal
  session.state = reason;
  await writeSession(session);
  logger.warn({ sessionId: session.sessionId, deviceId, reason }, `🚨 [FUEL-401] Oturum sunucu tarafından zorla sonlandırıldı: ${reason}.`);
  return session;
}

/**
 * IOT-301.1/FUEL-401.3'ün periyodik süpürücüsü — tüm cihazların
 * REGISTERED_HARDWARE_DEVICES listesindeki her biri için heartbeat'in
 * HEARTBEAT_TIMEOUT_MS'i aştığı aktif oturumları TIMED_OUT'a çeker.
 * Döndürdüğü liste, çağıranın (index.ts) FORCE_CUTOFF komutu gönderip
 * Socket.io'da yayınlaması için kullanılır.
 */
export async function sweepTimedOutSessions(deviceIds: string[]): Promise<DispenseSession[]> {
  const timedOut: DispenseSession[] = [];
  for (const deviceId of deviceIds) {
    const session = await readSession(deviceId);
    if (!session) continue;
    if (session.state !== 'AUTHORIZED' && session.state !== 'PUMPING') continue;
    if (Date.now() - session.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
      const aborted = await forceAbort(deviceId, 'TIMED_OUT');
      if (aborted) timedOut.push(aborted);
    }
  }
  return timedOut;
}
