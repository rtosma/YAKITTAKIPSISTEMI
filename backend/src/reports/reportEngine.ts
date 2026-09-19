import { PoolClient } from 'pg';
import { withTenant } from '../db/withTenant';
import { BadRequestError } from '../utils/errors';
import { ReportDefinition, ReportFilterDef, ReportRunResult } from './reportTypes';

/**
 * REP-703 — filtre/sayfalama/export motoru, TÜM raporlar için ortak.
 *
 * BİLİNÇLİ SAPMA: `tenantDb.ts`'teki `buildTransactionFilterClause` /
 * `getTenantTransactionsPaginated` / `streamTenantTransactionsForExport`
 * (REP-701) BURAYA taşınıp bu motora göç ETTİRİLMEDİ. Sebep: REP-701'in
 * kendi export'unda dinamik GENEL TOPLAM satırı ve REP-701'e özgü .xlsx
 * biçimlendirmesi var; onu bu genel motora zorlamak hem regresyon riski
 * (mevcut, mutasyonla doğrulanmış testleri kırma riski) hem de kod
 * kalabalığı (özel bir davranışı genel bir arayüze sıkıştırmak) yaratırdı.
 * Bu motor, REP-711'den başlayarak BUNDAN SONRAKİ raporlar için tek
 * doğruluk kaynağıdır; REP-701 kendi başına kalır.
 *
 * `page`/`pageSize` sınırları FE-802/REP-701 ile AYNI (pageSize ≤ 100) —
 * tutarlı bir sözleşme, ayrıca tek bir sayfada sınırsız satır çekilip
 * bellek/CPU'yu zorlamasın diye.
 */
export const SOURCE_WHERE_MARKER = '/*SRC_WHERE*/';
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PDF_ROWS = 2000;

export interface ReportQueryParams {
  page?: number;
  pageSize?: number;
  [filterKey: string]: unknown;
}

/**
 * Bir filtre tanımını + istemciden gelen ham değeri parametreli bir SQL
 * koşuluna çevirir. `def.column` SUNUCU tanımından gelir, istemciden asla —
 * bu fonksiyonun aldığı TEK istemci girdisi filtrenin DEĞERİDİR ve her
 * zaman $n parametresi olarak eklenir, hiçbir zaman string'e gömülmez.
 */
function applyFilter(filter: ReportFilterDef, rawValue: unknown, conditions: string[], params: unknown[]): void {
  if (rawValue === undefined || rawValue === null || rawValue === '') return;
  const value = String(rawValue).slice(0, 200); // aşırı uzun bir değerle sorguyu şişirmeyi önle

  switch (filter.type) {
    case 'exact':
      params.push(value);
      conditions.push(`${filter.column} = $${params.length}`);
      break;
    case 'ilike':
      params.push(`%${value}%`);
      conditions.push(`${filter.column} ILIKE $${params.length}`);
      break;
    case 'dateFrom':
      params.push(value);
      conditions.push(`${filter.column} >= $${params.length}::date`);
      break;
    case 'dateToExclusiveNextDay':
      params.push(value);
      conditions.push(`${filter.column} < ($${params.length}::date + INTERVAL '1 day')`);
      break;
    case 'numberGte': {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      params.push(n);
      conditions.push(`${filter.column} >= $${params.length}::numeric`);
      break;
    }
    case 'in': {
      const values = String(rawValue).split(',').map((v) => v.trim()).filter(Boolean).slice(0, 50);
      if (values.length === 0) return;
      params.push(values);
      conditions.push(`${filter.column} = ANY($${params.length})`);
      break;
    }
  }
}

/**
 * AC: "Filtreler SQL injection'a kapalı olmalıdır." — istemcinin gönderdiği
 * her `key`, `def.filters` içinde TANIMLI olan anahtarlarla eşleştirilir;
 * eşleşmeyen (whitelist dışı) her anahtar SESSİZCE yok sayılır. `siteScope`
 * verilirse (SITE_MANAGER kısıtlaması, AUTH-201.4 ile aynı desen) istemcinin
 * kendi filtre değerini EZER — istemci girdisine güvenilmez.
 */
function buildWhereClause(def: ReportDefinition, query: ReportQueryParams, siteScope?: string): { whereClause: string; params: unknown[]; table: string } {
  const conditions: string[] = [];
  const sourceConditions: string[] = [];
  const params: unknown[] = [];

  for (const filter of def.filters) {
    if (def.siteScopeColumn && filter.column === def.siteScopeColumn && siteScope !== undefined) {
      continue; // siteScope aşağıda ayrıca ve önce eklenir, istemci değeri yok sayılır
    }
    applyFilter(filter, query[filter.key], filter.beforeAggregation ? sourceConditions : conditions, params);
  }

  // beforeAggregation filtreleri table içindeki işaretçiye enjekte edilir (aynı params dizisi → $n numaraları tutarlı).
  let table = def.table;
  if (table.includes(SOURCE_WHERE_MARKER)) {
    table = table.replace(SOURCE_WHERE_MARKER, sourceConditions.length > 0 ? ` AND ${sourceConditions.join(' AND ')}` : '');
  } else if (def.filters.some((f) => f.beforeAggregation)) {
    throw new Error(`Rapor tanımı '${def.id}' beforeAggregation filtresi kullanıyor ama table içinde ${SOURCE_WHERE_MARKER} işaretçisi yok (programlama hatası).`);
  }
  if (def.siteScopeColumn && siteScope !== undefined) {
    params.push(siteScope);
    const scopeColumns = [def.siteScopeColumn, ...(def.siteScopeAltColumns ?? [])];
    const scopeCondition = scopeColumns.map((c) => `${c} = $${params.length}`).join(' OR ');
    conditions.unshift(scopeColumns.length > 1 ? `(${scopeCondition})` : scopeCondition);
  }

  return { whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params, table };
}

function parsePagination(query: ReportQueryParams): { page: number; pageSize: number } {
  const page = Number(query.page);
  const pageSize = Number(query.pageSize);
  return {
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(Math.floor(pageSize), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
  };
}

/**
 * AC: "Sunucu taraflı sayfalama VE sıralama" — istemci `sortBy`/`sortDir`
 * gönderebilir, ama `sortBy` yalnızca `def.columns`'ta GERÇEKTEN var olan bir
 * anahtarsa kabul edilir (aynı whitelist disiplini: sütun adı asla doğrudan
 * istemciden SQL'e gitmez). Geçersiz/eksik bir değer sessizce
 * `def.defaultSort`'a düşer — 400 ile reddetmek yerine (bu, tek bir yanlış
 * yazılmış sort parametresiyle tüm listeyi kırmaktan daha kullanıcı dostu).
 *
 * BİLİNÇLİ SAPMA: export (CSV/PDF) akışı bu sıralamayı KULLANMAZ, her zaman
 * `def.defaultSort` ile sabit kalır — keyset export'un doğruluğu (bkz.
 * streamReportExport) `id` ile tekilleştirilmiş TEK bir kararlı sıralama
 * sütununa dayanır; istemcinin ekran sıralamasını export'a taşımak bu
 * garantiyi (ve büyük export'larda O(sayfa) maliyetini) bozardı. Bu, rapor/
 * export araçlarında yaygın bir tercihtir (ekranda sıralı, dışa aktarımda
 * kanonik sıra).
 */
function resolveSort(def: ReportDefinition, query: ReportQueryParams): { column: string; direction: 'ASC' | 'DESC' } {
  const requestedColumn = typeof query.sortBy === 'string' ? query.sortBy : undefined;
  const column = requestedColumn && def.columns.some((c) => c.key === requestedColumn) ? requestedColumn : def.defaultSort.column;

  const requestedDir = typeof query.sortDir === 'string' ? query.sortDir.toUpperCase() : undefined;
  const direction: 'ASC' | 'DESC' = requestedDir === 'ASC' || requestedDir === 'DESC' ? requestedDir : def.defaultSort.direction;

  return { column, direction };
}

async function runAggregates(client: PoolClient, def: ReportDefinition, table: string, whereClause: string, params: unknown[]): Promise<{ totalCount: number; aggregates: Record<string, number> }> {
  const selectParts = ['COUNT(*)::int AS __count'];
  for (const agg of def.aggregates ?? []) {
    selectParts.push(`COALESCE(${agg.fn}(${agg.column}), 0)::numeric AS ${agg.key}`);
  }
  const result = await client.query(`SELECT ${selectParts.join(', ')} FROM ${table} ${whereClause}`, params);
  const row = result.rows[0] ?? {};
  const aggregates: Record<string, number> = {};
  for (const agg of def.aggregates ?? []) {
    aggregates[agg.key] = Number(row[agg.key] ?? 0);
  }
  return { totalCount: row.__count ?? 0, aggregates };
}

/** AC: "Sunucu taraflı sayfalama ve sıralama" — tek rapor tanımından tek çağrıyla çalışır. */
export async function runReport(def: ReportDefinition, query: ReportQueryParams, siteScope?: string): Promise<ReportRunResult> {
  const { page, pageSize } = parsePagination(query);
  const { whereClause, params, table } = buildWhereClause(def, query, siteScope);
  const sort = resolveSort(def, query);
  const columnList = def.columns.map((c) => c.key).join(', ');

  return withTenant(async (client) => {
    const { totalCount, aggregates } = await runAggregates(client, def, table, whereClause, params);

    const offset = (page - 1) * pageSize;
    const dataParams = [...params, pageSize, offset];
    const dataResult = await client.query(
      `SELECT ${columnList} FROM ${table} ${whereClause} ORDER BY ${sort.column} ${sort.direction} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      dataParams
    );

    return {
      data: dataResult.rows,
      page,
      pageSize,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
      aggregates,
      sort
    };
  });
}

const EXPORT_BATCH_SIZE = 2000;

/**
 * Export akışı — keyset sayfalama (OFFSET DEĞİL, REP-701'deki AYNI gerekçe:
 * OFFSET O(N) maliyetlidir, keyset her zaman O(sayfa boyutu)). `def.table`
 * tek başına yeterli olmadığından (keyset için stabil bir sıralama sütunu
 * gerekir) sıralama her zaman `def.defaultSort.column` + tekilleştirici
 * olarak `id` üzerinden yapılır — bu yüzden her rapor tanımı sonuç
 * kümesinde bir `id` sütunu döndürmelidir (rapor tanımı testinde denetlenir).
 */
export async function streamReportExport(
  def: ReportDefinition,
  query: ReportQueryParams,
  siteScope: string | undefined,
  onBatch: (rows: Record<string, unknown>[]) => Promise<void> | void
): Promise<{ totalCount: number; aggregates: Record<string, number> }> {
  if (!def.columns.some((c) => c.key === 'id')) {
    throw new Error(`Rapor tanımı '${def.id}' export için gereken 'id' sütununu içermiyor (programlama hatası).`);
  }
  const { whereClause, params, table } = buildWhereClause(def, query, siteScope);
  const columnList = def.columns.map((c) => c.key).join(', ');
  const { direction } = def.defaultSort;
  const cmp = direction === 'DESC' ? '<' : '>';

  return withTenant(async (client) => {
    const { totalCount, aggregates } = await runAggregates(client, def, table, whereClause, params);

    let cursor: { sortValue: unknown; id: unknown } | null = null;
    while (true) {
      const cursorConditions = [...(whereClause ? [whereClause.slice(6)] : [])];
      const cursorParams = [...params];
      if (cursor) {
        cursorParams.push(cursor.sortValue, cursor.id);
        cursorConditions.push(`(${def.defaultSort.column}, id) ${cmp} ($${cursorParams.length - 1}, $${cursorParams.length})`);
      }
      const where = cursorConditions.length > 0 ? `WHERE ${cursorConditions.join(' AND ')}` : '';
      cursorParams.push(EXPORT_BATCH_SIZE);
      const result = await client.query(
        `SELECT ${columnList} FROM ${table} ${where} ORDER BY ${def.defaultSort.column} ${direction}, id ${direction} LIMIT $${cursorParams.length}`,
        cursorParams
      );
      if (result.rows.length === 0) break;
      await onBatch(result.rows);
      const last = result.rows[result.rows.length - 1];
      cursor = { sortValue: last[def.defaultSort.column], id: last.id };
      if (result.rows.length < EXPORT_BATCH_SIZE) break;
    }

    return { totalCount, aggregates };
  });
}

export function assertPdfRowLimit(def: ReportDefinition, totalCount: number): void {
  const limit = def.maxPdfRows ?? DEFAULT_MAX_PDF_ROWS;
  if (totalCount > limit) {
    throw new BadRequestError(
      `Bu rapor PDF için çok büyük (${totalCount} satır, sınır ${limit}). Büyük raporlar için CSV kullanın.`,
      { error: 'PDF_EXPORT_TOO_LARGE', totalCount, limit }
    );
  }
}
