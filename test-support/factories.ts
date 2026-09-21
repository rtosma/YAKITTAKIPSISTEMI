/**
 * TEST-1006 — Ortak test veri fabrikaları (backend + frontend birim testleri aynı dosyayı kullanır).
 *
 * NEDEN: her testte elle nesne kurmak testleri kırılgan yapar — şemaya bir zorunlu sütun eklenince onlarca test elle düzeltilir. Fabrika
 * GEÇERLİ bir varsayılan nesne üretir; test yalnızca KENDİ ilgilendiği alanı ezer: `buildVehicle({ status: 'PASİF' })`. Şema değişince tek yer
 * (burası) güncellenir.
 *
 * KURALLAR
 *  - Sıfır bağımlılık, saf TypeScript; ne vitest ne DB ne ağ (her iki paket de import edebilsin).
 *  - Şekil = VERİTABANI SATIRI (snake_case, schema.sql ile aynı; sayısal sütunlar NUMERIC olduğu için pg'nin verdiği gibi metin DEĞİL sayı —
 *    birim testler ham metin dönüşümünü değil iş mantığını sınar). Ön yüz camelCase istiyorsa `toCamel(...)`.
 *  - Deterministik: kimlikler koşuya özgü rastgelelik DEĞİL sayaçtan gelir → hata çıktısı tekrarlanabilir, snapshot'lar sabit.
 *    Sayaç test DOSYASI başına sıfırdan başlar (vitest her dosyayı ayrı izole çalıştırır) → paralel dosyalar birbirini etkilemez.
 *  - Geçerli kimlik numaraları: `validTckn` / `validVkn` gerçek sağlama algoritmasıyla üretir (uydurma 11 haneli sayı doğrulayıcıdan geçmez).
 */

let counter = 0;
/** Sıradaki sayı (dosya başına 1'den). Kimlik/plaka/ad üretiminde kullanılır. */
export const nextSeq = (): number => ++counter;
export const resetFactorySequence = (): void => { counter = 0; };

export type Overrides<T> = Partial<T>;
export interface Factory<T> {
  /** Varsayılan geçerli nesne + ezmeler. */
  build(overrides?: Overrides<T>): T;
  /** n adet; `each(i)` her biri için ezme döndürebilir (örn. farklı plaka). */
  buildMany(n: number, each?: (index: number) => Overrides<T>): T[];
}

export function defineFactory<T>(base: (seq: number) => T): Factory<T> {
  const build = (overrides: Overrides<T> = {}): T => ({ ...base(nextSeq()), ...overrides });
  return { build, buildMany: (n, each) => Array.from({ length: n }, (_v, i) => build(each ? each(i) : {})) };
}

// ── Geçerli kimlik numaraları ──────────────────────────────────────────────────
/** İlk 9 haneden (100000000–999999999) GİB algoritmasıyla geçerli VKN üretir. */
export function validVkn(first9: string | number = 238109283): string {
  const s = String(first9).padStart(9, '0').slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const c1 = (Number(s[i]) + (9 - i)) % 10;
    let c2 = (c1 * 2 ** (9 - i)) % 9;
    if (c1 !== 0 && c2 === 0) c2 = 9;
    sum += c2;
  }
  return s + String((10 - (sum % 10)) % 10);
}

/** İlk 9 haneden (ilk hane 1–9) geçerli TCKN üretir. */
export function validTckn(first9: string | number = 100000001): string {
  const s = String(first9).padStart(9, '1').slice(0, 9);
  const d = s.split('').map(Number);
  const d10 = ((((d[0] + d[2] + d[4] + d[6] + d[8]) * 7) - (d[1] + d[3] + d[5] + d[7])) % 10 + 10) % 10;
  const d11 = (d.reduce((a, b) => a + b, 0) + d10) % 10;
  return `${s}${d10}${d11}`;
}

// ── Varlık fabrikaları (DB satırı şekli) ─────────────────────────────────────────
export interface TenantRow { id: string; name: string; tax_number: string; code: string; city: string; license_status: string; package: 'TEMEL' | 'PROFESYONEL' | 'KURUMSAL'; modules: Record<string, boolean> }
export const tenantFactory = defineFactory<TenantRow>((n) => ({
  id: `tenant-${n}`, name: `Test Firma ${n}`, tax_number: validVkn(100000000 + n), code: `T-${n}`, city: 'Kocaeli / Gebze', license_status: 'AKTİF', package: 'KURUMSAL',
  modules: { aiAnomaly: true, eInvoice: true, smartWarehouse: true, maintenanceTrack: true, driverScore: true, crossSiteAuth: true }
}));

export interface VehicleRow { id: string; tenant_id: string; plate: string; brand_model: string; vehicle_type: string; rfid_tag: string; site_name: string; status: 'AKTİF' | 'PASİF'; assigned_driver_name: string | null; fuel_type: string | null }
export const vehicleFactory = defineFactory<VehicleRow>((n) => ({
  id: `veh-${n}`, tenant_id: 'tenant-1', plate: `34 TST ${String(n).padStart(2, '0')}`, brand_model: 'Test Kamyon', vehicle_type: 'Kamyon', rfid_tag: `TAG-${n}`,
  site_name: 'Test Şantiye', status: 'AKTİF', assigned_driver_name: null, fuel_type: 'Motorin'
}));

export interface DriverRow { id: string; tenant_id: string; name: string; tc_no: string; phone: string; license_type: string; rfid_card_id: string; site_name: string; status: 'AKTİF' | 'SAHADA' | 'İZİNLİ' | 'PASİF' }
export const driverFactory = defineFactory<DriverRow>((n) => ({
  id: `drv-${n}`, tenant_id: 'tenant-1', name: `Test Sürücü ${n}`, tc_no: validTckn(100000000 + n), phone: `0532 000 ${String(n).padStart(2, '0')} ${String(n).padStart(2, '0')}`,
  license_type: 'CE', rfid_card_id: `CARD-${n}`, site_name: 'Test Şantiye', status: 'SAHADA'
}));

export interface TankRow { id: string; tenant_id: string; name: string; capacity_liters: number; current_level_liters: number; fuel_type: string; site_name: string; status: 'GÜVENLİ' | 'UYARI' | 'KRİTİK'; low_stock_threshold_liters: number | null }
export const tankFactory = defineFactory<TankRow>((n) => ({
  id: `tank-${n}`, tenant_id: 'tenant-1', name: `Test Tank ${n}`, capacity_liters: 20000, current_level_liters: 10000, fuel_type: 'Motorin (Euro Diesel)', site_name: 'Test Şantiye', status: 'GÜVENLİ', low_stock_threshold_liters: null
}));

export interface TransactionRow { id: string; tenant_id: string; site_name: string; vehicle_plate: string; driver_name: string; tank_name: string; amount_liters: number; total_cost: number | null; type: string; created_at: string; verification_status: string; idempotency_key: string | null }
export const transactionFactory = defineFactory<TransactionRow>((n) => ({
  id: `tx-${n}`, tenant_id: 'tenant-1', site_name: 'Test Şantiye', vehicle_plate: '34 TST 01', driver_name: 'Test Sürücü 1', tank_name: 'Test Tank 1', amount_liters: 50, total_cost: null,
  type: 'RFID', created_at: '2026-03-15T10:00:00.000Z', verification_status: 'DOĞRULANDI', idempotency_key: `idem-${n}`
}));

export interface HardwareDeviceRow { device_id: string; tenant_id: string; name: string; site_name: string; status: 'AKTİF' | 'BLOKE' }
export const hardwareDeviceFactory = defineFactory<HardwareDeviceRow>((n) => ({ device_id: `DEV-${n}`, tenant_id: 'tenant-1', name: `Test Cihaz ${n}`, site_name: 'Test Şantiye', status: 'AKTİF' }));

export interface TelemetryEvent { tenantId: string; siteId: string; deviceType: string; deviceId: string; data: Record<string, unknown>; timestamp: string }
export const telemetryFactory = defineFactory<TelemetryEvent>((n) => ({ tenantId: 'tenant-1', siteId: 'site-1', deviceType: 'tank', deviceId: `DEV-${n}`, data: { levelLiters: 1000 }, timestamp: '2026-03-15T10:00:00.000Z' }));

export interface JwtUserPayload { userId: string; tenantId: string; username: string; role: 'SUPER_ADMIN' | 'COMPANY_OWNER' | 'SITE_MANAGER' | 'PUMP_OPERATOR' | 'DRIVER'; siteName?: string }
export const userFactory = defineFactory<JwtUserPayload>((n) => ({ userId: `usr-${n}`, tenantId: 'tenant-1', username: `kullanici${n}`, role: 'COMPANY_OWNER' }));

export interface StrappingPoint { levelMm: number; volumeLiters: number }
/** Doğrusal artan cetvel: seviye `stepMm` mm'de bir, her adımda `litersPerStep` litre (0 mm = 0 L'den başlar). */
export function strappingTable(points = 5, stepMm = 100, litersPerStep = 250): StrappingPoint[] {
  return Array.from({ length: points }, (_v, i) => ({ levelMm: i * stepMm, volumeLiters: i * litersPerStep }));
}

// ── Yardımcılar ────────────────────────────────────────────────────────────────────
const camel = (k: string): string => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
/** DB satırı (snake_case) → ön yüz/API gösterimi (camelCase); iç içe nesne/dizi dahil. */
export function toCamel<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => toCamel(v)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [camel(k), toCamel(v)])) as T;
  }
  return value as T;
}

/** Sabit "şimdi" — zamana bağlı hesapların testleri saat farkından bağımsız olsun. */
export const FIXED_NOW = new Date('2026-03-15T09:00:00.000Z');
/** UTC+3 (İstanbul) duvar saatinden UTC Date: `istanbul('2026-03-15T00:00')` → 2026-03-14T21:00:00Z. */
export const istanbul = (local: string): Date => new Date(new Date(`${local}:00Z`).getTime() - 3 * 3600 * 1000);
