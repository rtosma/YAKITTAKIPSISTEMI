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

// 'numberGte'/'numberLte' (REP-712/717): `column >= / <= $n::numeric` — sayısal alt/üst sınır filtreleri için.
export type ReportFilterType = 'exact' | 'ilike' | 'dateFrom' | 'dateToExclusiveNextDay' | 'in' | 'numberGte' | 'numberLte';

export interface ReportFilterDef {
  /** İstemcinin query string'de kullanacağı anahtar (örn. ?siteName=...). */
  key: string;
  /** GERÇEK, sabit kodlu SQL sütun adı (gerekirse tablo alias'lı) — istemciden asla gelmez. */
  column: string;
  type: ReportFilterType;
  label: string;
  /**
   * REP-716: `true` ise koşul dış sorguya DEĞİL, `table`'ın içindeki
   * SOURCE_WHERE_MARKER işaretçisine (reportEngine.ts; `WHERE TRUE <işaretçi>`
   * biçiminde) enjekte edilir — GRUPLAMADAN ÖNCE uygulanması gereken filtreler
   * (tarih aralığı gibi) için. `column` bu durumda `table` İÇİNDEKİ kaynak
   * sorgunun sütunudur.
   */
  beforeAggregation?: boolean;
  /**
   * REP-720: filtre KİŞİSEL VERİ sütunu üzerindeyse (örn. sürücü adı) `true` —
   * PII'yi görme yetkisi OLMAYAN görüntüleyici bu filtreyi gönderirse 403 alır.
   * Sebep: maskeli bir sütunda serbest filtre bir ORAKÜL'dür ("adı 'Ah' ile
   * başlayan var mı?" → satır geldi/gelmedi → maskenin arkasındaki değer sızar).
   */
  requiresPiiAccess?: boolean;
}

/**
 * REP-720: raporu isteyen kullanıcının bağlamı. Motor bu bilgiyle PII maskesine
 * karar verir. VERİLMEZSE (zamanlanmış gönderim, arşiv, dahili çağrılar)
 * görüntüleyici "yetkisiz" sayılır → maske UYGULANIR (fail-closed).
 */
export interface ReportViewer {
  role: UserRole;
}

/** 'name': kişi adı → "A*** Y***" (bkz. piiMask.ts). */
export type ReportPiiKind = 'name';

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
  /**
   * REP-720: kişisel veri sütunu. `def.piiViewerRoles` dışındaki (ya da
   * görüntüleyicisi bilinmeyen) her tüketici için değer, `format`'tan ÖNCE
   * maskelenir — tek geçiş noktası motor olduğundan JSON, CSV ve PDF birebir
   * aynı maskeyi görür.
   */
  pii?: ReportPiiKind;
}

export interface ReportAggregateDef {
  key: string;
  column: string;
  // 'AVG' (REP-716): eşleşen satır yoksa 0 döner — n'yi ayrıca bir COUNT/SUM toplamıyla verin.
  fn: 'SUM' | 'COUNT' | 'AVG';
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
  /**
   * REP-717 — istek-zamanı PARAMETRE JETONLARI: `table` içinde
   * `{{filterKey::sqlTipi|varsayılan SQL}}` yazılırsa, istemci o filtre anahtarını
   * gönderdiyse `$n::sqlTipi` (PARAMETRELİ — değer asla SQL'e gömülmez), yoksa
   * `varsayılan SQL` yerine geçer. Sonuç `def.filters`'ta tanımlı OLMASA da
   * çalışır (ör. pencere başlangıcı/bitişi hesabın İÇİNDE kullanılır).
   * `varsayılan SQL` ve `sqlTipi` sunucu kodunda sabittir, istemciden gelmez.
   */
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
  /**
   * REP-720: `pii` sütunlarını MASKESİZ görebilen roller. Tanımda `pii`
   * sütunu varsa ve bu liste yoksa herkes için maskelenir (güvenli varsayılan).
   */
  piiViewerRoles?: UserRole[];
  /**
   * REP-720: `true` ise bu raporun HER dışa aktarımı (CSV/PDF) `audit_logs`'a
   * `REPORT_EXPORT` olarak yazılır — akış BAŞLAMADAN önce, aynı istek içinde;
   * denetim kaydı yazılamazsa veri hiç gönderilmez (AUTH-203 ilkesi).
   */
  auditExport?: boolean;
  /**
   * REP-722: `true` ise raporun JSON GÖRÜNTÜLEMESİ de (sayfa başına bir kez) `audit_logs`'a
   * `REPORT_VIEW` olarak yazılır — `auditExport` ile aynı ilkeler (veri çıkmadan önce, yazılamazsa
   * veri yok). Yalnızca erişimin kendisi hassas olan raporlar için (denetim raporu).
   */
  auditAccess?: boolean;
  /** PDF export CPU-yoğun ve kuyruksuz (bkz. reportEngine.ts) — bu satır sınırının üstünde 409 döner. */
  maxPdfRows?: number;
}
