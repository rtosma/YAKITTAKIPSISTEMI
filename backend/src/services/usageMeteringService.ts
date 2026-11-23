import { PoolClient } from 'pg';
import { withTenant } from '../db/withTenant';
import { runWithTenant } from '../context/tenantContext';
import { getAllTenantIds } from '../db/adminDb';
import { redisPool } from '../db/redisPool';
import { generateId } from '../utils/id';
import { logger } from '../utils/logger';

/**
 * BILL-1704 — Kullanım Ölçümü (Metering) ve Faturalama Verisi.
 *
 * Ticket "TimescaleDB continuous aggregates + BullMQ" öneriyor — bu kod
 * tabanında ikisi de yok. Bunun yerine index.ts'teki diğer süpürücülerle
 * (FUEL-402.1, AI-502, licenseWarningService.ts) AYNI setInterval deseni +
 * düz, APPEND-ONLY bir tablo (usage_metering_records, schema.sql).
 *
 * `withTenant()`'ı DOĞRUDAN `db/withTenant.ts`'ten import ediyor —
 * tenantDb.ts'e (bu oturumda birden fazla eşzamanlı işin ortak dosyası)
 * hiç dokunmadan tenant-scoped/RLS'li sorgu yazabilmek için.
 */

export interface UsageMeteringRecord {
  id: string;
  tenantId: string;
  periodLabel: string;
  activeDeviceCount: number;
  deviceDays: number;
  dispenseCount: number;
  telemetryPacketCount: number;
  edocumentCount: number;
  computedAt: string;
}

function mapRow(row: any): UsageMeteringRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    periodLabel: row.period_label,
    activeDeviceCount: row.active_device_count,
    deviceDays: row.device_days,
    dispenseCount: row.dispense_count,
    telemetryPacketCount: row.telemetry_packet_count,
    edocumentCount: row.edocument_count,
    computedAt: row.computed_at
  };
}

/** 'YYYY-MM' dönem etiketinin kaç güne (o ayın gün sayısına) karşılık geldiği. */
function daysInPeriod(periodLabel: string): number {
  const [year, month] = periodLabel.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function periodBounds(periodLabel: string): { start: Date; end: Date } {
  const [year, month] = periodLabel.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

/**
 * mqttClient.ts'in her başarıyla işlenmiş telemetri 'data' paketinde
 * çağırdığı sayaç — RAM'de/DB'de değil Redis'te (mevcut cache-aside/sayaç
 * desenleriyle, ör. FUEL-402.1 kota bakiyesiyle AYNI), TTL'siz (dönem
 * sonunda süpürücü tarafından okunup kalıcı kayda dönüştürülene kadar
 * kaybolmamalı). Anahtar cari AY'a göre otomatik döner — sweep bir önceki
 * TAMAMLANMIŞ ay için çalıştığından, geçen ayın anahtarı süpürücü tarafından
 * okunduğunda hâlâ yerinde durur (yeni ay için yeni bir anahtar üretilmiş olur).
 */
export function telemetryPacketCounterKey(tenantId: string, periodLabel: string): string {
  return `metering:telemetry:${tenantId}:${periodLabel}`;
}

export async function incrementTelemetryPacketCounter(tenantId: string): Promise<void> {
  const periodLabel = new Date().toISOString().slice(0, 7);
  try {
    await redisPool.client.incr(telemetryPacketCounterKey(tenantId, periodLabel));
  } catch (err) {
    // Sayaç kaybı bir metering ayrıntısını eksik bırakır ama telemetri işleme
    // hattını ASLA kesmemeli — theftDetectionService.ts'teki hata izolasyonuyla aynı gerekçe.
    logger.warn({ err, tenantId }, '⚠️ [BILL-1704] Telemetri paket sayacı artırılamadı.');
  }
}

/**
 * Bir tenant + dönem için ölçümü hesaplayıp KALICI olarak kaydeder (append-only
 * — aynı (tenant_id, period_label) için ikinci çağrı ON CONFLICT DO NOTHING
 * ile no-op'tur, günlük süpürücünün aynı ayı tekrar tekrar denemesini güvenli kılar).
 */
export async function computeUsageMeteringForPeriod(
  client: PoolClient,
  tenantId: string,
  periodLabel: string
): Promise<UsageMeteringRecord | null> {
  const { start, end } = periodBounds(periodLabel);

  const [deviceRes, dispenseRes, edocRes] = await Promise.all([
    client.query(`SELECT COUNT(*)::int AS cnt FROM hardware_devices WHERE tenant_id = $1 AND status != 'BLOKE'`, [tenantId]),
    client.query(`SELECT COUNT(*)::int AS cnt FROM transactions WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`, [tenantId, start.toISOString(), end.toISOString()]),
    client.query(`SELECT COUNT(*)::int AS cnt FROM despatch_advice_documents WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`, [tenantId, start.toISOString(), end.toISOString()])
  ]);

  const activeDeviceCount = deviceRes.rows[0].cnt;
  const deviceDays = activeDeviceCount * daysInPeriod(periodLabel);
  const dispenseCount = dispenseRes.rows[0].cnt;
  const edocumentCount = edocRes.rows[0].cnt;

  const telemetryPacketCountRaw = await redisPool.client.get(telemetryPacketCounterKey(tenantId, periodLabel));
  const telemetryPacketCount = telemetryPacketCountRaw ? parseInt(telemetryPacketCountRaw, 10) : 0;

  const id = generateId('meter');
  const inserted = await client.query(
    `INSERT INTO usage_metering_records
       (id, tenant_id, period_label, active_device_count, device_days, dispense_count, telemetry_packet_count, edocument_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, period_label) DO NOTHING
     RETURNING *`,
    [id, tenantId, periodLabel, activeDeviceCount, deviceDays, dispenseCount, telemetryPacketCount, edocumentCount]
  );

  return inserted.rows.length > 0 ? mapRow(inserted.rows[0]) : null;
}

/** Tenant-scoped: oturum açmış firmanın KENDİ kullanım geçmişi (bkz. GET /usage-metering). */
export async function getUsageMeteringHistory(limit = 24): Promise<UsageMeteringRecord[]> {
  return withTenant(async (client, tenantId) => {
    const res = await client.query(
      'SELECT * FROM usage_metering_records WHERE tenant_id = $1 ORDER BY period_label DESC LIMIT $2',
      [tenantId, limit]
    );
    return res.rows.map(mapRow);
  });
}

/** Oturum açmış tenant için TEK bir dönemi hemen hesaplar (bkz. POST /usage-metering/compute-now). */
export async function computeUsageMeteringForCurrentTenant(periodLabel: string): Promise<UsageMeteringRecord | null> {
  return withTenant((client, tenantId) => computeUsageMeteringForPeriod(client, tenantId, periodLabel));
}

/**
 * TÜM tenant'lar için bir önceki TAMAMLANMIŞ ayı hesaplar — index.ts'teki
 * günlük süpürücüden çağrılır. Cari ay kasıtlı olarak HİÇ hesaplanmaz (henüz
 * tamamlanmamış bir dönemin "kesin" faturalama kaydı olmaz).
 */
export async function runUsageMeteringSweepForPreviousMonth(): Promise<{ tenantsProcessed: number; recordsComputed: number }> {
  const now = new Date();
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodLabel = prevMonth.toISOString().slice(0, 7);

  const tenantIds = await getAllTenantIds();
  let recordsComputed = 0;
  for (const tenantId of tenantIds) {
    try {
      const record = await runWithTenant({ tenantId }, () => withTenant((client, tid) => computeUsageMeteringForPeriod(client, tid, periodLabel)));
      if (record) recordsComputed++;
    } catch (err) {
      // Bir tenant'ın hesabının başarısız olması DİĞERLERİNİN turunu
      // ENGELLEMEMELİ — index.ts'teki diğer süpürücülerle aynı gerekçe.
      logger.error({ err, tenantId, periodLabel }, '🚨 [BILL-1704] Kullanım ölçümü hesaplanamadı.');
    }
  }
  return { tenantsProcessed: tenantIds.length, recordsComputed };
}
