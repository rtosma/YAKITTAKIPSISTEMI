import { ReportDefinition, ReportPiiKind, ReportViewer } from './reportTypes';

/**
 * REP-720 (#177) — rapor çıktılarında kişisel veri (KVKK / COMP-606) maskesi.
 *
 * KAPSAM UYARLAMASI: ticket "COMP-606 maskeleme" der; ayrı bir COMP-606
 * servisi bu kod tabanında yok — mevcut desen `routes.ts`'teki
 * `maskTcNoForRole` (yetkisiz role kısmi gösterim). Aynı ruh burada rapor
 * çatısına taşındı: maske MOTORDA uygulanır (tek geçiş noktası), böylece JSON,
 * CSV ve PDF aynı veriyi maskeli/maskesiz TUTARLI üretir ve yeni bir rapor
 * yalnızca sütununa `pii` yazarak korunur.
 *
 * Kişi adı maskesi: her sözcüğün ilk harfi + SABİT `***` (uzunluk sızmaz):
 * "Ahmet Yılmaz" → "A*** Y***". Boş/NULL değerler olduğu gibi kalır.
 */
export function maskPersonName(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const s = String(value).trim();
  if (s === '') return value;
  return s
    .split(/\s+/)
    .map((w) => `${Array.from(w)[0]}***`)
    .join(' ');
}

export function maskPii(kind: ReportPiiKind, value: unknown): unknown {
  switch (kind) {
    case 'name':
      return maskPersonName(value);
  }
}

/** PII'yi maskesiz görebilir mi? Görüntüleyici yoksa (zamanlanmış/arşiv/dahili) HAYIR — fail-closed. */
export function isPiiVisible(def: ReportDefinition, viewer?: ReportViewer): boolean {
  if (!viewer) return false;
  return (def.piiViewerRoles ?? []).includes(viewer.role);
}

/** Satırların pii sütunlarını (gerekiyorsa) maskeler; yeni satır nesneleri döner, girdiyi değiştirmez. */
export function maskRowsForViewer(def: ReportDefinition, rows: Record<string, unknown>[], piiVisible: boolean): Record<string, unknown>[] {
  if (piiVisible) return rows;
  const piiColumns = def.columns.filter((c) => c.pii);
  if (piiColumns.length === 0) return rows;
  return rows.map((row) => {
    const masked = { ...row };
    for (const c of piiColumns) masked[c.key] = maskPii(c.pii!, row[c.key]);
    return masked;
  });
}
