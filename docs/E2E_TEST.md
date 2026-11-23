# Uçtan uca (E2E) ikmal döngüsü testleri (TEST-1001)

Sistemin en kritik akışını **gerçek bağımlılıklarla** doğrular: **yetki → akış → sonlandırma → stok → olay tüketicileri → e-İrsaliye → rapor**.

```bash
node scripts/e2e/run-e2e.mjs                                    # tümü, paralel (yalnız Docker ve Node gerekir; npm install yok)
node scripts/e2e/run-e2e.mjs --files e2e_fuel_cycle.ts --keep   # tek dosya; --keep: bitince konteynerleri bırak (hata ayıklama)
node scripts/e2e/run-e2e.mjs --budget-sec 300                   # süre bütçesini sıkılaştır
```

## Ne ayağa kalkar

Her koşuda **rastgele son ekli, tek kullanımlık** bir Docker ağı ve dört konteyner (sabit host portu yayınlanmaz; yalnızca `--browser` kipinde frontend 127.0.0.1'de rastgele portla → paralel koşular/CI çakışmaz):

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

## Tarayıcı E2E (TEST-1004)

Kullanıcının gerçekten yapacağı işlerin **gerçek tarayıcıda** (Playwright, headless Chromium) uçtan uca çalıştığını doğrular. Aynı izole yığın (Postgres + Redis + EMQX + backend) kurulur; ayrıca **frontend üretim derlemesi nginx'te** sunulur ve Playwright ona bağlanır.

```bash
node scripts/e2e/run-e2e.mjs --browser                              # tarayıcı paketi (yalnızca Docker + Node + Playwright Chromium)
node scripts/e2e/run-e2e.mjs --browser --pw-args "--repeat-each=5"  # determinizm ölçümü: her testi 5× tekrarla
cd frontend && npx playwright show-report                            # son koşunun HTML raporu
```

| Dosya (`frontend/e2e/critical/`) | Akış |
|---|---|
| `developer-panel.spec.ts` | Geliştirici: **firma oluştur → modül aç/kapa (+ lisans, sunucuda kalıcı) → cihaz sağlığı** (cihaz MQTT ile ONLINE olur, panel gösterir) |
| `manager-panel.spec.ts` | Yönetici: **iki şantiye → sürücü → araç (aynı plaka reddi) → çapraz alım yetkisi** |
| `site-panel.spec.ts` | Şantiye: **canlı ikmal izleme** (sentetik ikmal enjekte edilir, tank 10000 → 9940 L sayfa yenilenmeden) **→ hareket listesi → rapor indirme** (CSV) |
| `identity.spec.ts` | Kimlik: **geçici parola → zorunlu değişiklik → eski parola geçersiz**; **yetkisiz erişim** (oturumsuz / şantiye yöneticisi / firma sahibi → 403) |

**Kurallar (ticket):**
- **Seçici = yalnızca `data-testid`** — metin/rol-adı/CSS seçici yok (arayüzde ~60 kanca; `scripts/test-test1004.mjs` her CI koşusunda hem bunu hem kancaların arayüzde var olduğunu denetler).
- **Deterministik:** `waitForTimeout`/uyku yok; her bekleme koşula bağlı (yanıt, öznitelik, `expect.poll`). `retries: 0` — yeniden deneme rastgele başarısızlığı maskeler. Canlı akış **sentetik olay enjeksiyonu**dur: cihaz olarak HMAC imzalı tam ikmal döngüsü, tarayıcının WebSocket'i bağlandıktan sonra (`html[data-socket=connected]`) tetiklenir. Tank seviyesi animasyonlu sayaçtan değil ham `data-level-liters` niteliğinden okunur.
- **İzole:** her test kendi taze firmasını API ile kurar; asıl akış arayüzle yapılır. Sunucu durumu API ile ayrıca doğrulanır ("ekranda göründü ama kaydedilmedi" yanlış yeşilini önler).
- **Hata kanıtı (AC):** başarısız testte **ekran görüntüsü + video + trace** `frontend/test-results/` altında; CI `if: always()` ile `playwright-evidence` artifact'ı olarak yükler (HTML rapor dahil).
- **Ne zaman koşar:** merge öncesi (`ci-cd.yml` → `e2e-browser`, dağıtım geçidi) ve **gece** (`e2e-nightly.yml`, her testi 3× tekrar ederek flake avlar) — her PR'da değil (süre yönetimi).

Eski `frontend/e2e/*.spec.ts` (docker-compose yığınına bağlı yerel paket, `npm run test:e2e`) değişmedi; `playwright.config.ts` artık `critical/` dizinini yok sayar.

**Testin bulduğu (düzeltilmeyen) gözlemler:** SUPER_ADMIN girişi `/admin` yerine `/panel`'e iniyor (geliştirici paneline elle gidiliyor); şantiye panelinden çıkış `/santiye-login` yerine `/login`'e yönlendiriyor; site oluşturulurken sunucunun ürettiği geçici parola arayüzde gösterilmiyor (yalnızca API yanıtında var).
