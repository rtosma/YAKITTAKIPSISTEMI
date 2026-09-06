# TEST-1002 — k6 Yük ve Stres Testi

**Kabul Kriteri (`ISSUES_ROADMAP.md` #308):**
> 100 eşzamanlı pompadan saniyede 1.000 telemetri paketi gönderildiğinde
> **HTTP P95 yanıt süresi < 200 ms** ve **Node.js event loop lag < 50 ms** kalmalıdır.

## Dosyalar

```
scripts/load-test/
├── run.sh                 ← orkestratör (bunu çalıştır)
├── Dockerfile.sidecar     ← backend imajı + lag-sidecar.cjs + provision-devices.mjs
├── lag-sidecar.cjs        ← derlenmiş backend'i AYNI process'te çalıştırıp
│                            perf_hooks.monitorEventLoopDelay ile ölçer
├── telemetry-k6.js        ← k6 senaryosu (constant-arrival-rate + handleSummary)
├── provision-devices.mjs  ← AC koşusu için geçici LOADTEST-* cihazları (JSON → stdout)
├── cleanup-devices.mjs    ← o cihazları siler (doğrudan SQL — host'ta çalışır)
└── verdict.mjs            ← k6 özeti + lag örneklerinden PASS/FAIL
```

## Neden bu kadar dolambaçlı

Bu makinede iki kısıt var:
1. **Host firewall'ı** docker bridge → host portu bağlantılarını düşürüyor →
   k6 konteyneri host'taki bir sunucuya erişemiyor.
2. **NFS/Kerberos** `docker run -v <host-path>` bind-mount'larını "Permission
   denied" ile kırıyor (bkz. `docker-compose.yml` postgres notu).

Çözüm: **her şey compose ağında konteyner** (container↔container, firewall yok)
ve script'ler bind-mount yerine **build context ile imaja kopyalanır**
(`Dockerfile.sidecar`).

- **Yük hedefi:** `POST /api/v1/telemetry/hardware-data` — gerçek telemetri
  ingest yolu (AUTH-202 HMAC-SHA256; k6 imzayı `crypto.hmac` ile üretir). Gövde
  mutasyonu / satır büyümesi yok → tekrarlanabilir.
- **Event loop lag** ayrı process'ten tahmin edilmez: `lag-sidecar.cjs`,
  `loadtest-sidecar` konteynerinde `require('/app/dist/server.cjs')` ile
  backend'i **kendi process'i içinde** başlatıp `monitorEventLoopDelay`
  histogramını okur. Ölçülen, testteki sunucunun gerçek event loop'udur.
  **Backend kaynak koduna hiç dokunulmaz** (TEST-1002 tamamen `scripts/` altında).
- Sidecar compose ağında: PostgreSQL `postgres:5432`, Redis `redis:6379`,
  MQTT `__CI_SKIP__` (atlanır). Sırlar repo kökündeki `.env`'den — **docker
  yığınının `.env`'i ile aynı olmalı** (yoksa `hardware_devices.encrypted_secret`
  çözülemez).

## Ön koşullar

- Docker yığını ayakta: `docker compose up -d`
- `docker` (grafana/k6 ve curlimages/curl imajları otomatik çekilir)
- Node.js (yalnızca `verdict.mjs` ve küçük yardımcılar için — host'ta)
- Repo kökünde geçerli `.env`

## Çalıştırma

### Smoke (hızlı sağlık kontrolü — 3 seed cihaz, ~12 rps)

```bash
scripts/load-test/run.sh
```

Rate limitin (cihaz başına 300/dk = 5/sn) altında kaldığı için provisioning
gerektirmez. Boru hattının uçtan uca çalıştığını doğrular.

### Tam AC koşusu — 1.000 rps

1.000 rps için **≥ 250 cihaz** gerekir. `DEVICE_COUNT` verildiğinde ve
`.devices.json` yoksa `run.sh` provisioning'i kendi yapar:

```bash
TARGET_RPS=1000 DEVICE_COUNT=300 DURATION=120s VUS=200 scripts/load-test/run.sh
node scripts/load-test/cleanup-devices.mjs   # bitince cihazları temizle
```

> Provisioning ~2×`DEVICE_COUNT` `audit_logs` satırı bırakır (append-only tasarım
> gereği silinmez) — bilinçlidir.

### Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `TARGET_RPS` | `12` | Toplam istek/sn (AC: `1000`) |
| `DURATION` | `60s` | k6 senaryo süresi |
| `VUS` | `100` | preAllocated/max sanal kullanıcı |
| `DEVICE_COUNT` | (yok) | verilirse provisioning yapılır |
| `P95_MS` | `200` | `http_req_duration` p(95) eşiği |
| `SKIP_BUILD` | `0` | `1` → backend imajı derlemeyi atla |

## Çıktılar — `scripts/load-test/results/` (git'e girmez)

| Dosya | İçerik |
|---|---|
| `k6-summary.json` | k6 `handleSummary` (tek satır, marker'lı) |
| `k6.log` / `k6.stdout.log` | k6 stderr / stdout |
| `eventloop-lag.jsonl` | 2 sn'lik lag örnekleri (`p50/p90/p99/max`, **nominal üstü ms**) |

Son satır **`TEST-1002 : PASS ✅ / FAIL ❌`** — çıkış kodu 0/1.

### Referans koşu sonucu (tam AC — 1000 rps, 300 cihaz, 90s)

```
Toplam HTTP isteği     : 90.001   (999.99 istek/sn — 90s sürdürüldü)
HTTP P95 yanıt süresi  : 3.32 ms      (AC < 200)   ✅
HTTP hata oranı        : 0.27 %       (< 1)        ✅   (rate-limit sınırındaki birkaç 429)
Event loop p99 lag     : 6.83 ms      (AC < 50)    ✅   (46 örnek, koşu penceresi)
TEST-1002 : PASS ✅
```
`POST /telemetry/hardware-data` hafif bir yoldur (nonce SET + tek indeksli
SELECT + echo); 1000 rps'de bile sunucu rahat, marj yüksek.

## Yorum

- **HTTP P95** → k6 `http_req_duration` p(95).
- **Event loop lag** → `monitorEventLoopDelay` histogramı; `resolution` (10 ms)
  çıkarılır (boşta ≈ 0). Yalnızca k6 koşusu penceresindeki örnekler sayılır
  (açılış/warmup spike'ları hariç).
- `http_req_failed` > %1 → FAIL: genelde cihaz sayısı yetersiz (429 rate limit).

## Bilinen sınırlar

- k6 MQTT konuşmaz; "telemetri paketi" HTTP eşdeğeriyle modellenir. Gerçek MQTT
  broker yükü ayrı bir araç (`emqtt_bench`) işidir.
- Sidecar tek instance'tır. Çoklu replika davranışı için compose'u
  `--scale backend=N` + nginx ile test etmek gerekir (bu script kapsamı dışında).
- CI entegrasyonu ayrıdır (ağır job) — `ci-cd.yml`'ye `workflow_dispatch`
  tetiklemeli bir adım olarak eklenmesi önerilir.
