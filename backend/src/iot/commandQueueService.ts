import crypto from 'crypto';
import { redisPool } from '../db/redisPool';
import { logger } from '../utils/logger';
import { ioTEventBus, mqttService } from './mqttClient';
import { updateDesired, updateReported } from './deviceShadow';

/**
 * IOT-305 — Uzaktan Komut Kuyruğu (ack/timeout/retry)
 *
 * mqttClient.ts'in `publishCommand()`'ı (FUEL-401.3'ten beri) salt YAYIN —
 * cihazın komutu aldığını doğrulamıyor. Bu servis onun üzerine güvenilirlik
 * katmanı ekliyor:
 *   1. Her komuta bir `commandId` (UUID) atanır, Redis'te PENDING olarak
 *      izlenir ve `command/v1/{deviceId}` üzerinden payload'a eklenerek
 *      yayınlanır.
 *   2. Cihaz `command/v1/{deviceId}/ack` topic'ine `{ commandId, status }`
 *      ile yanıt verirse (mqttClient.ts bunu ayrıştırıp `ioTEventBus`'a
 *      'commandAck' olarak emit eder) komut ACKED/NACKED'e geçer.
 *   3. Ack zamanında gelmezse (varsayılan 8sn) periyodik bir "sweep"
 *      (1sn'de bir) komutu yeniden yayınlar; `maxAttempts` (varsayılan 3)
 *      denemeden sonra FAILED'e düşer.
 *
 * Çoklu replika (OPS-1102 zero-downtime deploy, scale=2) güvenliği: Redis TEK
 * doğruluk kaynağı. Sweep her replikada bağımsız çalışır ama her komut için
 * `SET NX` kilidi (theftDetectionService.ts'teki cooldown deseniyle aynı
 * fikir) aynı tick'te yalnızca bir replikanın yeniden yayın yapmasını
 * garanti eder. Ack hangi replikaya düşerse düşsün Redis kaydını günceller,
 * bu yüzden `sendCommandWithAck()`'in Promise'i (Redis polling ile) hangi
 * replikada çağrıldığından bağımsız doğru sonucu görür.
 *
 * Bilinçli sınır: dispenseSessionService.ts / theftDetectionService.ts ile
 * aynı yaklaşım — kalıcı bir DB tablosu (komut geçmişi) YOK, tüm durum
 * Redis'te (TTL'li). Kalıcı denetim izi gerekirse ayrı bir follow-up.
 */

export type CommandStatus = 'PENDING' | 'ACKED' | 'NACKED' | 'FAILED';

interface CommandRecord {
  commandId: string;
  deviceId: string;
  command: string;
  payload: Record<string, unknown>;
  status: CommandStatus;
  attempts: number;
  maxAttempts: number;
  ackTimeoutMs: number;
  createdAt: string;
  lastSentAt: string;
  ackedAt?: string;
}

const DEFAULT_ACK_TIMEOUT_MS = 8000;
const DEFAULT_MAX_ATTEMPTS = 3;
const SWEEP_INTERVAL_MS = 1000;
const RECORD_TTL_SECONDS = 24 * 60 * 60;
const PENDING_ZSET_KEY = 'iot:cmd:pending';

function recordKey(commandId: string): string {
  return `iot:cmd:${commandId}`;
}
function lockKey(commandId: string): string {
  return `iot:cmd:lock:${commandId}`;
}

async function readRecord(commandId: string): Promise<CommandRecord | null> {
  const raw = await redisPool.client.get(recordKey(commandId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CommandRecord;
  } catch {
    return null;
  }
}

async function writeRecord(record: CommandRecord): Promise<void> {
  await redisPool.client.set(recordKey(record.commandId), JSON.stringify(record), 'EX', RECORD_TTL_SECONDS);
}

async function publishAttempt(record: CommandRecord): Promise<void> {
  record.attempts += 1;
  record.lastSentAt = new Date().toISOString();
  await writeRecord(record);

  const deadline = Date.now() + record.ackTimeoutMs;
  await redisPool.client.zadd(PENDING_ZSET_KEY, deadline, record.commandId);

  mqttService.publishCommand(record.deviceId, record.command, { ...record.payload, commandId: record.commandId });

  await updateDesired(record.deviceId, {
    lastCommand: record.command,
    lastCommandId: record.commandId,
    lastCommandAt: record.lastSentAt,
    lastCommandAttempt: record.attempts
  });
}

/**
 * Yeni bir komut oluşturur, ilk denemeyi yayınlar ve komut terminal bir
 * duruma (ACKED/NACKED/FAILED) ulaşana ya da güvenlik zaman aşımına kadar
 * Redis kaydını yoklayarak sonucu döndürür (bkz. yukarıdaki çoklu-replika notu).
 */
export async function sendCommandWithAck(
  deviceId: string,
  command: string,
  payload: Record<string, unknown> = {},
  opts?: { ackTimeoutMs?: number; maxAttempts?: number }
): Promise<{ commandId: string; status: CommandStatus; attempts: number }> {
  const commandId = crypto.randomUUID();
  const ackTimeoutMs = opts?.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const record: CommandRecord = {
    commandId,
    deviceId,
    command,
    payload,
    status: 'PENDING',
    attempts: 0,
    maxAttempts,
    ackTimeoutMs,
    createdAt: new Date().toISOString(),
    lastSentAt: new Date().toISOString()
  };
  await publishAttempt(record);

  const safetyDeadline = Date.now() + ackTimeoutMs * (maxAttempts + 1) + SWEEP_INTERVAL_MS * 3;
  while (Date.now() < safetyDeadline) {
    const current = await readRecord(commandId);
    if (current && current.status !== 'PENDING') {
      return { commandId, status: current.status, attempts: current.attempts };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const finalRecord = await readRecord(commandId);
  return { commandId, status: finalRecord?.status ?? 'FAILED', attempts: finalRecord?.attempts ?? record.attempts };
}

export async function getCommandStatus(commandId: string): Promise<CommandRecord | null> {
  return readRecord(commandId);
}

interface CommandAckEvent {
  deviceId: string;
  commandId?: string;
  status?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

async function handleAck(evt: CommandAckEvent): Promise<void> {
  if (!evt.commandId) return;
  const record = await readRecord(evt.commandId);
  if (!record || record.status !== 'PENDING') return; // bilinmeyen ya da zaten sonuçlanmış komut

  record.status = evt.status === 'NACK' ? 'NACKED' : 'ACKED';
  record.ackedAt = evt.timestamp;
  await writeRecord(record);
  await redisPool.client.zrem(PENDING_ZSET_KEY, evt.commandId);

  await updateReported(evt.deviceId, {
    lastAckedCommand: record.command,
    lastAckedCommandId: record.commandId,
    lastAckedStatus: record.status,
    lastAckedAt: evt.timestamp
  });

  logger.info(
    { commandId: evt.commandId, deviceId: evt.deviceId, command: record.command, status: record.status, attempts: record.attempts },
    `📨 [IOT-305] Komut ack alındı: ${record.command} → ${evt.deviceId} (${record.status})`
  );
}

async function sweepOnce(): Promise<void> {
  const now = Date.now();
  const overdue = await redisPool.client.zrangebyscore(PENDING_ZSET_KEY, 0, now);
  for (const commandId of overdue) {
    const gotLock = await redisPool.client.set(lockKey(commandId), '1', 'EX', 5, 'NX');
    if (gotLock !== 'OK') continue; // başka bir replika bu tick'i zaten aldı

    const record = await readRecord(commandId);
    if (!record || record.status !== 'PENDING') {
      await redisPool.client.zrem(PENDING_ZSET_KEY, commandId);
      continue;
    }

    if (record.attempts >= record.maxAttempts) {
      record.status = 'FAILED';
      await writeRecord(record);
      await redisPool.client.zrem(PENDING_ZSET_KEY, commandId);
      logger.error(
        { commandId, deviceId: record.deviceId, command: record.command, attempts: record.attempts },
        `🚨 [IOT-305] Komut ack alınamadı, tüm denemeler tükendi: ${record.command} → ${record.deviceId}`
      );
      continue;
    }

    logger.warn(
      { commandId, deviceId: record.deviceId, nextAttempt: record.attempts + 1, maxAttempts: record.maxAttempts },
      `⏱️  [IOT-305] Ack zaman aşımı, yeniden deneniyor: ${record.command} → ${record.deviceId}`
    );
    await publishAttempt(record);
  }
}

let started = false;
let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Motoru `ioTEventBus`'a bağlar ve sweep döngüsünü başlatır. Birden fazla
 * kez çağrılması güvenlidir (idempotent).
 */
export function startCommandQueueEngine(): void {
  if (started) return;
  started = true;
  ioTEventBus.on('commandAck', (payload: CommandAckEvent) => {
    void handleAck(payload);
  });
  sweepTimer = setInterval(() => {
    void sweepOnce();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  logger.info('📮 [IOT-305] Komut kuyruğu motoru etkin (ack/timeout/retry).');
}
