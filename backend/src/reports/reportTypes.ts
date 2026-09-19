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

// 'numberGte' (REP-712): `column >= $n::numeric` — sapma eşiği gibi sayısal alt sınır filtreleri için.
export type ReportFilterType = 'exact' | 'ilike' | 'dateFrom' | 'dateToExclusiveNextDay' | 'in' | 'numberGte';

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
  /**
   * CSV/PDF'te gösterim biçimi (örn. tarih/sayı formatlama). Yoksa String(value).
   * `row` (REP-712, opsiyonel): hücrenin anlamı SATIRIN başka alanına bağlıysa
   * (örn. "veri eksik" durumunda boş yerine açık bir metin) — eski, tek
   * argümanlı format fonksiyonları etkilenmez.
   */
  format?: (value: unknown, row?: Record<string, unknown>) => string;
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
  /** İstemcinin `sortBy`/`sortDir`'i geçerliyse uygulanan, değilse `defaultSort`'a düşen GERÇEK sıralama. */
  sort: { column: string; direction: 'ASC' | 'DESC' };
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
  /**
   * REP-715: bir satırın İKİ şantiyeyle ilgili olduğu raporlar (kaynak + çeken
   * şantiye) — SITE_MANAGER, `siteScopeColumn` VEYA bunlardan biri kendi
   * şantiyesiyse satırı görür. Yalnızca GENİŞLETİR, asla tek başına kullanılmaz.
   */
  siteScopeAltColumns?: string[];
  /** PDF export CPU-yoğun ve kuyruksuz (bkz. reportEngine.ts) — bu satır sınırının üstünde 409 döner. */
  maxPdfRows?: number;
}
