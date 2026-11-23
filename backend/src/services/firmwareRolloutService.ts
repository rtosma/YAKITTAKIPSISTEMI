import { sendCommandWithAck } from '../iot/commandQueueService';
import { listActiveSessions } from './dispenseSessionService';
import { getFirmwareArtifact, type FirmwareArtifactRecord } from '../db/adminDb';
import {
  selectEligibleDevicesForRollout,
  createFirmwareRollout,
  recordRolloutDeviceDispatch,
  recordRolloutDeviceResult,
  recordRolloutDeviceRollback,
  updateFirmwareRolloutProgress,
  getFirmwareRollout,
  getFirmwareRollouts,
  type FirmwareRolloutRecord
} from '../db/tenantDb';
import { logger } from '../utils/logger';
import { BadRequestError } from '../utils/errors';

/**
 * IOT-306 — kademeli OTA rollout orkestrasyonu.
 *
 * Bilinçli tasarım kararı: NestJS + BullMQ repeatable job (ticket'ın Teknik
 * Yığın'ı) yerine, TÜM aşamalar (%10 → %50 → %100) startFirmwareRollout'un
 * TEK bir çağrısı İÇİNDE, sırayla, senkron işlenir — ayrı bir arka plan
 * süpürücüsü/job kuyruğu YOK. Bu, "başarısızlık eşiği aşılırsa otomatik
 * dur" AC'sini tek bir deterministik fonksiyonda doğrulanabilir kılar; INV-
 * 1504/1505'teki periyodik sweep desenlerinden FARKLI bir seçim, çünkü
 * buradaki "iş" (cihazlara komut gönderip ack beklemek) zaten kendi içinde
 * asenkron/zaman-sınırlı (sendCommandWithAck) — üstüne bir de periyodik
 * sweep eklemek gereksiz bir dolaylama olurdu.
 *
 * Her aşamada cihazlar PARALEL gönderilir (Promise.all) — sıralı gönderim
 * (100 cihaz × ~8sn ack timeout) dakikalarca sürebilirdi.
 */

const STAGE_PCTS = [10, 50, 100] as const;

export interface RolloutStageResult {
  stagePct: number;
  dispatched: number;
  succeeded: number;
  failed: number;
  failureRatePct: number;
  skippedBusyDeviceIds: string[];
}

export interface StartRolloutResult {
  rollout: FirmwareRolloutRecord;
  stages: RolloutStageResult[];
}

async function busyDeviceIdSet(): Promise<Set<string>> {
  const sessions = await listActiveSessions();
  return new Set(sessions.map((s) => s.deviceId));
}

async function dispatchStage(
  rolloutId: string,
  artifact: FirmwareArtifactRecord,
  deviceIds: string[],
  stagePct: number
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;

  await Promise.all(
    deviceIds.map(async (deviceId) => {
      const result = await sendCommandWithAck(deviceId, 'OTA_UPDATE', {
        artifactId: artifact.id,
        version: artifact.version,
        artifactUrl: artifact.artifact_url,
        sha256: artifact.sha256,
        signature: artifact.signature
      });
      await recordRolloutDeviceDispatch(rolloutId, deviceId, stagePct, result.commandId);

      if (result.status === 'ACKED') {
        succeeded++;
        await recordRolloutDeviceResult(rolloutId, deviceId, 'BAŞARILI', null);
      } else {
        failed++;
        const reason = result.status === 'NACKED' ? 'Cihaz güncellemeyi reddetti (NACK).' : 'Ack alınamadı (zaman aşımı).';
        await recordRolloutDeviceResult(rolloutId, deviceId, 'BAŞARISIZ', reason);
      }
    })
  );

  return { succeeded, failed };
}

/**
 * AC: "Cihaz grubuna kademeli dağıtım yapılabilmelidir", "İkmal sırasında
 * güncelleme başlatılmamalıdır", "Başarısızlık eşiği aşıldığında rollout
 * otomatik durmalıdır."
 */
export async function startFirmwareRollout(
  firmwareArtifactId: string,
  siteName: string | null,
  startedByUserId: string
): Promise<StartRolloutResult> {
  const artifact = await getFirmwareArtifact(firmwareArtifactId);

  const eligibleAll = await selectEligibleDevicesForRollout(artifact.hardware_revision, artifact.version, siteName, []);
  if (eligibleAll.length === 0) {
    throw new BadRequestError('Bu firmware sürümü için güncellenmesi gereken uygun cihaz bulunamadı.', { error: 'NO_ELIGIBLE_DEVICES' });
  }

  let rollout = await createFirmwareRollout(
    { firmwareArtifactId, siteName, targetDeviceCount: eligibleAll.length },
    startedByUserId
  );

  const stages: RolloutStageResult[] = [];
  const dispatchedSoFar = new Set<string>();

  for (const stagePct of STAGE_PCTS) {
    const cumulativeTarget = stagePct === 100 ? eligibleAll.length : Math.max(1, Math.ceil((eligibleAll.length * stagePct) / 100));
    const remainingSlots = cumulativeTarget - dispatchedSoFar.size;
    if (remainingSlots <= 0) continue;

    const busy = await busyDeviceIdSet();
    const candidatePool = eligibleAll.filter((id) => !dispatchedSoFar.has(id));
    const skippedBusyDeviceIds = candidatePool.filter((id) => busy.has(id)).slice(0, remainingSlots);
    const toDispatch = candidatePool.filter((id) => !busy.has(id)).slice(0, remainingSlots);

    if (toDispatch.length === 0) {
      logger.warn({ rolloutId: rollout.id, stagePct, skippedBusyDeviceIds }, '⏸️ [IOT-306] Bu aşamada tüm uygun cihazlar ikmal yapıyor, gönderim atlandı.');
      stages.push({ stagePct, dispatched: 0, succeeded: 0, failed: 0, failureRatePct: 0, skippedBusyDeviceIds });
      continue;
    }

    toDispatch.forEach((id) => dispatchedSoFar.add(id));
    const { succeeded, failed } = await dispatchStage(rollout.id, artifact, toDispatch, stagePct);
    const failureRatePct = (failed / toDispatch.length) * 100;
    stages.push({ stagePct, dispatched: toDispatch.length, succeeded, failed, failureRatePct, skippedBusyDeviceIds });

    if (failureRatePct > Number(rollout.failure_threshold_pct)) {
      rollout = await updateFirmwareRolloutProgress(rollout.id, {
        currentStagePct: stagePct,
        status: 'DURDURULDU',
        haltedReason: `Aşama %${stagePct}: başarısızlık oranı %${failureRatePct.toFixed(1)}, eşik %${rollout.failure_threshold_pct}.`
      });
      logger.error({ rolloutId: rollout.id, stagePct, failureRatePct }, `🚨 [IOT-306] Rollout DURDURULDU — başarısızlık eşiği aşıldı.`);
      return { rollout, stages };
    }

    // AC: "kademeli dağıtım" — TAMAMLANDI, nominal aşamanın (%100) kendisine
    // değil, tüm uygun cihazların GERÇEKTEN dağıtılmış olmasına bağlıdır.
    // Küçük cihaz sayılarında (örn. tek cihaz) Math.max(1, ...) yuvarlaması
    // yüzünden set TAMAMEN %10 aşamasında bile dolabilir — bu durumda bile
    // TAMAMLANDI işaretlenmeli, %100 aşamasına ulaşmayı BEKLEMEMELİ.
    const allDispatched = dispatchedSoFar.size >= eligibleAll.length;
    rollout = await updateFirmwareRolloutProgress(rollout.id, {
      currentStagePct: stagePct,
      status: allDispatched ? 'TAMAMLANDI' : 'DEVAM_EDIYOR'
    });
    if (allDispatched) break;
  }

  return { rollout, stages };
}

export async function reportRolloutDeviceRollback(rolloutId: string, deviceId: string, reason: string) {
  return recordRolloutDeviceRollback(rolloutId, deviceId, reason);
}

export { getFirmwareRollout, getFirmwareRollouts };
