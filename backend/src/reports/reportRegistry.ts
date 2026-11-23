import { UserRole } from '../services/tokenService';
import { ReportDefinition } from './reportTypes';

/**
 * REP-703 — rapor katalogu. `registerReport()` process başlatılırken
 * (bkz. reports/index.ts'in side-effect import'ları) her tanımı burada
 * kaydeder; route handler'ları bu registry dışında hiçbir rapora doğrudan
 * erişmez (AC: "yeni bir rapor yalnızca tanım eklenerek üretilebilmeli").
 */
const registry = new Map<string, ReportDefinition>();

export function registerReport(def: ReportDefinition): void {
  if (registry.has(def.id)) {
    throw new Error(`Rapor tanımı çift kayıt: '${def.id}' zaten kayıtlı (programlama hatası).`);
  }
  registry.set(def.id, def);
}

export function getReportDefinition(id: string): ReportDefinition | undefined {
  return registry.get(id);
}

/** AC: "Kullanıcı yalnızca yetkili olduğu raporları listeleyebilmeli." */
export function listReportsForRole(role: UserRole): Array<Pick<ReportDefinition, 'id' | 'title' | 'description' | 'filters' | 'columns'>> {
  return [...registry.values()]
    .filter((def) => def.allowedRoles.includes(role))
    .map((def) => ({ id: def.id, title: def.title, description: def.description, filters: def.filters, columns: def.columns }));
}

/** Testler için: registry'yi sıfırlar (yalnızca test dosyalarında kullanılmalı). */
export function __resetRegistryForTests(): void {
  registry.clear();
}
