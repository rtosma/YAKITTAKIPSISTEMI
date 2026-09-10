import { pool } from '../db/postgresPool';
import { redisPool } from '../db/redisPool';
import { mqttService } from '../iot/mqttClient';
import { logger } from '../utils/logger';

/**
 * RES-906 — readiness (hazırlık) bağımlılık kontrolleri.
 *
 * Kritik Not 1: "Readiness her çağrıda ağır sorgu ÇALIŞTIRMAMALI; sonuçları
 * kısa süre cache'lemeli." Orkestratör (k8s) readiness probe'unu saniyede
 * bir çalıştırabilir — her seferinde 3 bağımlılığa ağ turu atmak yerine
 * sonuç READINESS_CACHE_MS boyunca cache'lenir.
 *
 * Kritik Not 3: liveness bağımlılıklara BAKMAZ (routes.ts /health/live) —
 * Redis kesintisi sonsuz konteyner yeniden başlatmasına yol açmasın. Bu
 * dosya YALNIZCA readiness içindir.
 *
 * Not: `pool.query('SELECT 1')` — bilinçli olarak withTenant() DIŞINDA (bir
 * sağlık kontrolü, tenant verisi değil; tenant context'i de yok). CI
 * check-no-raw-pool-query allowlist'inde.
 */

const READINESS_CACHE_MS = 3000;

export interface DependencyStatus {
  name: 'postgres' | 'redis' | 'mqtt';
  ok: boolean;
  skipped?: boolean;
  detail?: string;
}

export interface ReadinessResult {
  ready: boolean;
  checkedAt: string;
  dependencies: DependencyStatus[];
}

let cached: { at: number; result: ReadinessResult } | null = null;

async function checkPostgres(): Promise<DependencyStatus> {
  try {
    await pool.query('SELECT 1');
    return { name: 'postgres', ok: true };
  } catch (err) {
    return { name: 'postgres', ok: false, detail: (err as Error).message.slice(0, 160) };
  }
}

async function checkRedis(): Promise<DependencyStatus> {
  try {
    const pong = await redisPool.client.ping();
    return { name: 'redis', ok: pong === 'PONG' };
  } catch (err) {
    return { name: 'redis', ok: false, detail: (err as Error).message.slice(0, 160) };
  }
}

function checkMqtt(): DependencyStatus {
  // MQTT hiç yapılandırılmamışsa (CI: __CI_SKIP__) bağımlılık "atlandı"
  // sayılır ve readiness'i DÜŞÜRMEZ — gerçekten kullanılmıyor.
  if (!mqttService.isEnabled()) {
    return { name: 'mqtt', ok: true, skipped: true, detail: 'MQTT yapılandırılmamış (__CI_SKIP__)' };
  }
  return { name: 'mqtt', ok: mqttService.isConnected() };
}

export async function checkReadiness(force = false): Promise<ReadinessResult> {
  if (!force && cached && Date.now() - cached.at < READINESS_CACHE_MS) {
    return cached.result;
  }

  const [postgres, redis] = await Promise.all([checkPostgres(), checkRedis()]);
  const mqtt = checkMqtt();
  const dependencies = [postgres, redis, mqtt];

  const result: ReadinessResult = {
    ready: dependencies.every((d) => d.ok),
    checkedAt: new Date().toISOString(),
    dependencies
  };

  if (!result.ready) {
    logger.warn({ dependencies }, '⚠️ [RES-906] Readiness başarısız — en az bir bağımlılık erişilemez.');
  }

  cached = { at: Date.now(), result };
  return result;
}

/** Testler / manuel tetikleme için cache'i sıfırlar. */
export function invalidateReadinessCache(): void {
  cached = null;
}
