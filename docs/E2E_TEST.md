# Uçtan uca (E2E) ikmal döngüsü testleri (TEST-1001)

Sistemin en kritik akışını **gerçek bağımlılıklarla** doğrular: **yetki → akış → sonlandırma → stok → olay tüketicileri → e-İrsaliye → rapor**.

```bash
node scripts/e2e/run-e2e.mjs                                    # tümü, paralel (yalnız Docker ve Node gerekir; npm install yok)
node scripts/e2e/run-e2e.mjs --files e2e_fuel_cycle.ts --keep   # tek dosya; --keep: bitince konteynerleri bırak (hata ayıklama)
node scripts/e2e/run-e2e.mjs --budget-sec 300                   # süre bütçesini sıkılaştır
```

## Ne ayağa kalkar

Her koşuda **rastgele son ekli, tek kullanımlık** bir Docker ağı ve dört konteyner (sabit host portu yayınlanmaz → paralel koşular/CI çakışmaz):

| Konteyner | İmaj | Not |
|---|---|---|
| PostgreSQL | `postgres:16-alpine` | Üretimle aynı; şema (2×) + tohum verisi uygulanır |
| Redis | `redis:7-alpine` | Oturum, nonce, rate limit, presence, hırsızlık motoru örnekleri |
| EMQX | `docker/emqx` (5.8) | **Üretimle aynı** parola-tabanlı kimlik doğrulama; anonim erişim yok |
| Backend | `backend/` builder imajı, `tsx src/bootstrap.ts` | Gerçek MQTT/Redis/Postgres'e bağlı gerçek süreç |

Bitince (başarı, hata, Ctrl-C) hepsi silinir. Sonunda aşama ve dosya süreleri tablosu basılır.

> **KAPSAM UYARLAMASI** — ticket vitest + `@testcontainers/*` + TimescaleDB öneriyor. Bu depoda testler `tsx` betikleridir (vitest yok), şema düz PostgreSQL'dir (**TimescaleDB/hypertable kullanılmıyor**) ve ortamlar zaten Docker'dadır. Testcontainers'ın verdiği şey — izole, tek kullanımlık gerçek bağımlılıklar ve kesin temizlik — bağımlılık eklemeden doğrudan `docker` CLI ile yapılır.

## Testler

| Dosya | Ne doğrular |
|---|---|
| `e2e_fuel_cycle.ts` (10) | Cihaz MQTT ile ONLINE (Redis presence + WebSocket) · yetkisiz kart/yanlış HMAC reddi · tam döngü (AUTHORIZED → PUMPING → finalize, 60 L, DOĞRULANDI) · **stok düşümü** (10000 → 9940 L) · **WebSocket** canlı olaylar (`dispense:session`, `dispense:completed` + taze tank) · **hırsızlık motoru**: tutarlı ikmalde alarm yok, pompa kapalıyken 10 L düşüşte `STATIC_THEFT_DETECTED` · idempotent yeniden finalize · **e-İrsaliye** kuyruk → süpürme → `SENT` (XML'de plaka + miktar) · rep-711 raporu |
| `e2e_tenant_isolation.ts` (7) | İki tenant **eşzamanlı** tam döngü: stok, kayıt, API listeleri (RLS), WebSocket olayları, cihaz sırrı/kart sınırı ve raporlar birbirine sızmaz |

Sentetik cihaz istemcisi firmware'in yaptığını yapar: HMAC imzalı HTTP (`X-Hardware-Signature`) + MQTT v5 telemetri (`telemetry/v1/{tenant}/{site}/{tip}/{cihaz}/data|status`); panel tarafı gerçek `socket.io` istemcisidir. Tüm beklenen değerler el ile hesaplanmıştır (test başlıklarında).

## İzolasyon kuralı (AC: "testler birbirinden izole")

- Her dosya **kendi taze tenant'ını** (`createTenant`: firma, kullanıcı, iki şantiye, tank, sürücü + kart, araç, üç cihaz) yaratır ve yalnız ona dokunur; **tohum firmalarına/cihazlarına hiç referans verilmez** (`scripts/test-test1001.mjs` bunu her CI koşusunda denetler).
- Tüm kimlikler koşuya özgü rastgele son ek (`tag`) taşır → paralel dosyalar ve tekrar koşular çakışmaz.
- Temizlik yalnız kendi tenant'ını siler (`companies` cascade).
- Tüketiciyle senkron **gözlemle** yapılır, `sleep` ile şansa bırakılmaz: yayınlanan telemetrinin Redis'e işlendiği beklenir (`waitForSamples`). Hırsızlık motoru örnekleri *işlenme* anında damgalar; ilk MQTT mesajı (doğrulama worker'ı ısınması) sonrakinden geç işlenirse sıra bozulabilir ve tutarlı bir ikmalde bile yanlış `STATIC_THEFT_DETECTED` üretilebilir — bu, testin ilk halinde gerçekten yakalandı.

## Süre (AC: CI'da 10 dakikanın altında)

- CI'da `e2e-fuel-cycle` **ayrı ve paralel** bir iştir (uzun sıralı `auth-integration-test` işiyle eşzamanlı; toplam süreye eklenmez), `timeout-minutes: 10` ve orkestratör `--budget-sec 540` ile: aşarsa **başarısız** olur.
- Yerelde (önbellekli imajlar) toplam ≈ 1 dk: imaj hazırlama ~13 sn, bağımlılıklar ~8 sn, şema+tohum ~19 sn, backend ~6 sn, testler ~6 sn (dosyalar paralel).
- E2E kırmızıyken staging/production dağıtımı **yapılmaz** (`needs`).

## Yeni E2E testi eklemek

`backend/test/e2e/e2e_<ad>.ts` oluşturun, `createTenant` ile kendi tenant'ınızı yaratın, `Reporter` ile bitirin (`finish(minChecks)`); orkestratör `e2e_*.ts` dosyalarını otomatik paralel koşar. Tohum verisine dokunmayın (sözleşme testi başarısız olur).
