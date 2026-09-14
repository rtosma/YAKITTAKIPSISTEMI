import { UserRole } from '../services/tokenService';

/**
 * REP-703 — Ortak rapor çatısı (GitHub #166).
 *
 * AMAÇ: "13 raporun her birini sıfırdan yazmak yerine ortak bir çatıdan
 * üretmek" (REP-711..REP-723, hepsi bu ticket'a bağımlı). Her rapor kendi
 * `buildXFilterClause`/`getXPaginated` çiftini yazmak yerine (bkz.
 * tenantDb.ts'teki REP-701 öncesi desen — hâlâ orada, kasıtlı olarak
 * DOKUNULMADI, bkz. reportEngine.ts başındaki not), TEK bir
 * `ReportDefinition` kaydıyla üretilir; filtre motoru, sayfalama ve export
 * (CSV/PDF) motoru hepsi reportEngine.ts'te, TÜM raporlar için ORTAK.
 *
 * GÜVENLİK (AC: "Filtreler SQL injection'a kapalı olmalıdır"): bir rapor
 * tanımındaki her `ReportFilterDef.column` sunucu kodunda SABİT yazılıdır —
 * istemciden gelen HİÇBİR değer asla bir sütun/tablo adı olarak kullanılmaz,
 * sadece parametreli sorgu ($n) DEĞERİ olarak. İstemci bir filtre anahtarı
 * (`key`) gönderir; bu anahtar `def.filters` listesinde YOKSA sessizce yok
 * sayılır (whitelist — check-no-raw-pool-query.mjs'in zorladığı "hiçbir
 * kullanıcı girdisi SQL'e enjekte edilmez" ilkesiyle aynı ruh). Her tanım
 * ayrıca `withTenant()` üzerinden çalışmak ZORUNDADIR (RLS'in app_user +
 * app.current_tenant_id ile devrede olduğu tek yol) — bu, tanımın kendisinde
 * değil, reportEngine.ts'in tek giriş noktasında garanti edilir.
 */

export type ReportFilterType = 'exact' | 'ilike' | 'dateFrom' | 'dateToExclusiveNextDay' | 'in';

export interface ReportFilterDef {
  /** İstemcinin query string'de kullanacağı anahtar (örn. ?siteName=...). */
  key: string;
  /** GERÇEK, sabit kodlu SQL sütun adı (gerekirse tablo alias'lı) — istemciden asla gelmez. */
  column: string;
  type: ReportFilterType;
  label: string;
}

export interface ReportColumnDef {
  /** SELECT'in döndürdüğü satırdaki (ya da alias'lı) anahtar. */
  key: string;
  header: string;
  /** PDF export'ta oransal sütun genişliği (CSV'de yok sayılır). */
  width?: number;
  /** CSV/PDF'te gösterim biçimi (örn. tarih/sayı formatlama). Yoksa String(value). */
  format?: (value: unknown) => string;
}

export interface ReportAggregateDef {
  key: string;
  column: string;
  fn: 'SUM' | 'COUNT';
  label: string;
}

export interface ReportRunResult {
  data: Record<string, unknown>[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  aggregates: Record<string, number>;
}

export interface ReportDefinition {
  id: string;
  title: string;
  description: string;
  /**
   * FROM sonrası tablo/JOIN ifadesi — SABİT kodlu, istemciden asla gelmez.
   * Tek tablo için `'transactions'`, join gerekiyorsa
   * `'transactions t JOIN vehicles v ON v.plate = t.vehicle_plate'` gibi
   * alias'lı bir ifade olabilir (o zaman filters/columns de alias'lı
   * sütun adı kullanır, örn. `t.vehicle_plate`).
   */
  table: string;
  columns: ReportColumnDef[];
  filters: ReportFilterDef[];
  aggregates?: ReportAggregateDef[];
  /** AC: "Kullanıcı yalnızca yetkili olduğu raporları listeleyebilmeli." */
  allowedRoles: UserRole[];
  defaultSort: { column: string; direction: 'ASC' | 'DESC' };
  /**
   * SITE_MANAGER kısıtlaması bu sütuna uygulanır (siteScopeFor(req.user) ile
   * aynı desen — AUTH-201.4). Rapor bir şantiye kavramı taşımıyorsa undefined.
   */
  siteScopeColumn?: string;
  /** PDF export CPU-yoğun ve kuyruksuz (bkz. reportEngine.ts) — bu satır sınırının üstünde 409 döner. */
  maxPdfRows?: number;
}
