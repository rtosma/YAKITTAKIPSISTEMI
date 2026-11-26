/**
 * ARCH-106 — tenant bazlı modül kapısı (saf mantık; DB/Express bağımlılığı yok).
 *
 * `companies.modules` (JSONB) her firmanın fiilen ETKİN modüllerinin tek
 * doğruluk kaynağı (BILL-1701 paket varsayılanları + BILL-1703 ek modüller,
 * bkz. adminDb.ts). Önceden bu değer yalnızca saklanıp panelde gösteriliyordu;
 * backend yalnızca TEK bir uçta (POST /ai/consumption-anomaly-reports)
 * uyguluyordu — TEMEL paketli bir firma e-İrsaliye, çapraz şantiye yetkisi vb.
 * satın almadığı modülleri API üzerinden kullanabiliyordu.
 *
 * Uygulama tek yerde: authenticateJWT, lisans kapısıyla AYNI firma satırı
 * okumasıyla (ek sorgu/önbellek yok, değişiklik bir sonraki istekte etkili)
 * isteğin yolunu aşağıdaki kurallarla eşleştirir ve kapalı modülde
 * `403 MODULE_DISABLED` döner. Kapsam bilinçli olarak dar: yalnızca bütünüyle
 * o modüle ait özellikler kapatılır; araç/tank/ikmal/hareket gibi çekirdek
 * işlevler her pakette açıktır. Kapatılan modülün geçmiş verisi silinmez.
 */

export const MODULE_NAMES = ['aiAnomaly', 'eInvoice', 'smartWarehouse', 'maintenanceTrack', 'driverScore', 'crossSiteAuth'] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

/** Kullanıcıya gösterilen ad (frontend TenantDetailModal/ModulesPage ile aynı). */
export const MODULE_LABELS: Record<ModuleName, string> = {
  aiAnomaly: 'AI Hırsızlık & Anomali Motoru',
  eInvoice: 'e-İrsaliye Entegrasyonu',
  smartWarehouse: 'Akıllı Ambar & Depo',
  maintenanceTrack: 'Bakım & Arıza Takibi',
  driverScore: 'Şoför Performans Skoru',
  crossSiteAuth: 'Çapraz Şantiye İkmal Yetkisi'
};

/**
 * Yol (router'a göre, /api/v1 öneki OLMADAN — authenticateJWT'deki req.path)
 * → modül. İlk eşleşen kural geçerli. Yeni bir modül uç noktası eklerken
 * buraya da eklenmeli; test_arch106_module_gate.ts ve unit testi her kuralı
 * en az bir gerçek yolla sınar.
 */
export const MODULE_ROUTE_RULES: ReadonlyArray<{ module: ModuleName; pattern: RegExp }> = [
  // e-İrsaliye (COMP-601…605): belge üretimi/iletimi, GİB durumu, alıcı mükellefler, VKN doğrulama, durum raporu
  { module: 'eInvoice', pattern: /^\/transactions\/[^/]+\/e-irsaliye(\/|$)/ },
  { module: 'eInvoice', pattern: /^\/despatch-advice-(transmissions|documents)(\/|$)/ },
  { module: 'eInvoice', pattern: /^\/recipients(\/|$)/ },
  { module: 'eInvoice', pattern: /^\/taxpayers(\/|$)/ },
  { module: 'eInvoice', pattern: /^\/reports\/rep-721(\/|$)/ },
  // AI anomali (AI-502/503/504): Gemini analizi, tüketim anomalisi, mesai dışı/mükerrer alım işaretleri
  { module: 'aiAnomaly', pattern: /^\/ai(\/|$)/ },
  { module: 'aiAnomaly', pattern: /^\/anomaly-flags(\/|$)/ },
  { module: 'aiAnomaly', pattern: /^\/fleet\/consumption\/anomaly/ },
  // Akıllı ambar (INV-1506): yedek parça/malzeme stoku ve kritik stok
  { module: 'smartWarehouse', pattern: /^\/inventory-items(\/|$)/ },
  { module: 'smartWarehouse', pattern: /^\/inventory\// },
  // Bakım & arıza (FLEET-1407/1408): bakım kayıtları, muayene/sigorta takvimi, lastikler
  { module: 'maintenanceTrack', pattern: /^\/vehicles\/[^/]+\/(maintenance-records|compliance-deadlines|tires)(\/|$)/ },
  { module: 'maintenanceTrack', pattern: /^\/maintenance-records(\/|$)/ },
  { module: 'maintenanceTrack', pattern: /^\/tires(\/|$)/ },
  { module: 'maintenanceTrack', pattern: /^\/fleet\/(maintenance|compliance)(\/|$)/ },
  // Şoför skoru (AI-506)
  { module: 'driverScore', pattern: /^\/drivers\/(behavior-scores|[^/]+\/behavior-scores)(\/|$)/ },
  // Çapraz şantiye yetkisi (FUEL-402): yetki tanımları ve mahsuplaşma raporu
  { module: 'crossSiteAuth', pattern: /^\/cross-site-permissions(\/|$)/ },
  { module: 'crossSiteAuth', pattern: /^\/reports\/rep-715(\/|$)/ }
];

export function moduleForPath(path: string): ModuleName | null {
  for (const rule of MODULE_ROUTE_RULES) if (rule.pattern.test(path)) return rule.module;
  return null;
}

/**
 * `isTenantModuleEnabled` ile AYNI anlam: yalnızca açıkça `false` olan modül
 * kapalıdır. Anahtar hiç yoksa (eski bir satır / yeni eklenen bir modül) açık
 * sayılır — kapatmak için bilinçli bir `false` gerekir.
 */
export function isModuleOn(modules: Record<string, unknown> | null | undefined, module: ModuleName): boolean {
  return modules?.[module] !== false;
}

export function moduleDisabledBody(module: ModuleName): { success: false; error: 'MODULE_DISABLED'; module: ModuleName; message: string } {
  return {
    success: false,
    error: 'MODULE_DISABLED',
    module,
    message: `"${MODULE_LABELS[module]}" modülü firmanız için etkin değil. Paketinizi yükseltmek için platform yöneticinizle iletişime geçin.`
  };
}
