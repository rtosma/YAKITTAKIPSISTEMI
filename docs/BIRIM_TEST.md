# Birim test altyapısı (TEST-1006)

```bash
npm test                      # kökten: backend + frontend birim testleri (vitest, paralel)
npm run test:coverage         # + v8 coverage; EŞİK ALTINDA sıfır olmayan çıkış kodu (CI build'i kırılır)
npm --prefix backend run test:watch        # geliştirirken
npm run test:unit:typecheck   # backend/unit + test-support tip denetimi
```

> **KAPSAM UYARLAMASI:** ticket `pnpm test` ve "workspace" varsayar; bu depo npm ile kurulu ve workspace kullanmıyor. Karşılığı kökteki `npm test` / `npm run test:coverage` betikleridir (iki paketi sırayla koşar).

## İki test katmanı (karıştırmayın)

| Katman | Nerede | Ne ister | Araç | CI işi |
|---|---|---|---|---|
| **Birim** | `backend/unit/**`, `frontend/src/**/*.test.*` | DB/Redis/ağ **yok**, saniyeler, paralel | vitest | `quality-and-tests` |
| **Entegrasyon** | `backend/test/**` (tsx betikleri) | gerçek Postgres/Redis/HTTP | tsx | `auth-integration-test` |
| **Uçtan uca** | `backend/test/e2e/**`, `frontend/e2e/**` | tüm yığın | tsx / Playwright | `e2e-fuel-cycle` ([E2E_TEST.md](E2E_TEST.md)) |

## Coverage eşiği — neden farklı farklı?

Tüm koda aynı eşik anlamsızdır: DB'ye bağlı `tenantDb.ts`/`routes.ts` entegrasyon testleriyle kapsanır; sayfa/bileşenler Playwright ile. Bu yüzden:

| Kapsam | Eşik | Nerede |
|---|---|---|
| **Backend hesap motorları** (hacim/strapping, kota dönemi, sayaç doğrulama, yakıt tipi, maliyet, vergi no, GTIP) | **%90** satır/fonksiyon/dal/ifade, **dosya başına** | `backend/vitest.config.ts` → `ENGINE_FILES` |
| Backend kapsamdaki tüm dosyalar (KVKK maskeleme, hata sınıfları, retention kataloğu …) | **%70** | aynı dosya → `UNIT_SCOPE` |
| Frontend mantık modülleri (api istemcisi, yetki matrisi, doğrulama, Sentry) | **%70** dosya başına | `frontend/vitest.config.ts` |
| Frontend genel (arayüz dahil) | **%20 taban** (ölçüm ≈ %24) — yalnızca çöküşü yakalar; **yükseltilir, düşürülmez** | aynı |

- Backend kapsamı **bilerek dardır** (`coverage.include`): yalnızca saf modüller. Yeni bir saf modül eklerseniz `UNIT_SCOPE`'a ekleyin.
- `backend/src/fuel/` ve `backend/src/fleet/` altına eklenen **her dosya** `ENGINE_FILES`'a girmek zorundadır — `scripts/test-test1006.mjs` bunu dayatır; yeni bir hesap motoru testsiz eşikten kaçamaz.
- Ölçüm anında backend kapsamı ≈ %99,7 (133 test, < 1 sn).

## Test veri fabrikaları

`test-support/factories.ts` (repo kökü) — backend ve frontend **aynı dosyayı** `@test-support/factories` takma adıyla kullanır. Sıfır bağımlılık; şekil = **veritabanı satırı** (snake_case, `schema.sql` ile aynı).

```ts
import { vehicleFactory, tankFactory, strappingTable, validTckn, toCamel } from '@test-support/factories';

const arac = vehicleFactory.build({ status: 'PASİF' });          // yalnızca ilgilendiğin alanı ez
const tanklar = tankFactory.buildMany(3, (i) => ({ current_level_liters: (i + 1) * 1000 }));
const cetvel = strappingTable(5, 100, 250);                       // (0,0)(100,250)…(400,1000)
const gorunum = toCamel(arac);                                    // ön yüz için camelCase
```

- **Neden:** her testte elle nesne kurmak testleri kırılgan yapar; şemaya zorunlu sütun eklenince onlarca test elle düzelir. Fabrika geçerli varsayılan üretir, tek yer güncellenir.
- **Deterministik:** kimlikler sayaçtan gelir (`veh-1`, `veh-2` …), rastgelelik yok; sayaç test **dosyası** başına sıfırlanır (vitest her dosyayı izole çalıştırır → paralel güvenli).
- **Geçerli kimlik numaraları:** `validTckn()` / `validVkn()` gerçek sağlama algoritmasıyla üretir. Uyduramazsınız: tohum firmaların VKN'leri (`2381092831` vb.) algoritmadan **geçmez**.
- Saat: `FIXED_NOW`, `istanbul('2026-03-15T00:00')` (UTC+3 → UTC).

## Eşik davranışı nasıl kanıtlanıyor?

`scripts/test-test1006.mjs` her CI koşusunda küçük bir "probe" projesiyle vitest'i **gerçekten** çalıştırır: yeterli coverage → çıkış 0; eşik altı → çıkış ≠ 0; aynı coverage genel %50 eşikle geçer ama hesap-motoru dosyasına %90 eşik konunca kırılır. Böylece "eşik altında build kırılır" iddiası konfigürasyon okunarak değil, davranışla sınanır.

## Yeni birim test yazmak

1. Saf mantığı DB/ağdan ayırın (örn. `compliance/gtip.ts` bu ticketle `despatchAdviceXmlService.ts`'ten ayrıldı — native XML kütüphanesi birim testi bozuyordu).
2. `backend/unit/<alan>/<modül>.test.ts`; beklenen değerleri **elle hesaplayıp** yorumda yazın; fabrikaları kullanın.
3. Modülü `UNIT_SCOPE`'a (hesap motoruysa `ENGINE_FILES`'a) ekleyin.
