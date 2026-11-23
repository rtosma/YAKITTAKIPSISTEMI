import { redisPool } from '../db/redisPool';

/**
 * IOT-305 — Cihaz Shadow'u (device shadow).
 *
 * AWS IoT'deki "device shadow" kavramının sadeleştirilmiş hali: her cihaz
 * için iki taraflı, son-durum JSON belgesi.
 *  - `desired`: sunucunun cihazdan istediği son durum (ör. en son gönderilen
 *    komut) — commandQueueService.ts her komut denemesinde günceller.
 *  - `reported`: cihazın DOĞRULADIĞI (ack ettiği) son durum —
 *    commandQueueService.ts bir ack alındığında günceller.
 *
 * Kalıcılık Redis'te (schema.sql'e dokunulmaz — mevcut theftDetectionService.ts
 * / dispenseSessionService.ts ile aynı desen). TTL uzun tutuldu (30 gün):
 * shadow "son bilinen durum" niteliğinde, cihaz uzun süre sessiz kalsa da
 * bir sonraki komutta sıfırdan başlamamalı.
 */

export interface DeviceShadowState {
  desired: Record<string, unknown>;
  desiredUpdatedAt: string | null;
  reported: Record<string, unknown>;
  reportedUpdatedAt: string | null;
}

const SHADOW_TTL_SECONDS = 30 * 24 * 60 * 60;

function shadowKey(deviceId: string): string {
  return `iot:shadow:${deviceId}`;
}

const EMPTY_SHADOW: DeviceShadowState = { desired: {}, desiredUpdatedAt: null, reported: {}, reportedUpdatedAt: null };

async function readShadow(deviceId: string): Promise<DeviceShadowState> {
  const raw = await redisPool.client.get(shadowKey(deviceId));
  if (!raw) return { ...EMPTY_SHADOW, desired: {}, reported: {} };
  try {
    return JSON.parse(raw) as DeviceShadowState;
  } catch {
    return { ...EMPTY_SHADOW, desired: {}, reported: {} };
  }
}

async function writeShadow(deviceId: string, shadow: DeviceShadowState): Promise<void> {
  await redisPool.client.set(shadowKey(deviceId), JSON.stringify(shadow), 'EX', SHADOW_TTL_SECONDS);
}

export async function getDeviceShadow(deviceId: string): Promise<DeviceShadowState> {
  return readShadow(deviceId);
}

export async function updateDesired(deviceId: string, patch: Record<string, unknown>): Promise<DeviceShadowState> {
  const shadow = await readShadow(deviceId);
  shadow.desired = { ...shadow.desired, ...patch };
  shadow.desiredUpdatedAt = new Date().toISOString();
  await writeShadow(deviceId, shadow);
  return shadow;
}

export async function updateReported(deviceId: string, patch: Record<string, unknown>): Promise<DeviceShadowState> {
  const shadow = await readShadow(deviceId);
  shadow.reported = { ...shadow.reported, ...patch };
  shadow.reportedUpdatedAt = new Date().toISOString();
  await writeShadow(deviceId, shadow);
  return shadow;
}
