# İstemci ve sunucu hata izleme — Sentry (RES-907)

> Amaç: sahada kullanıcının gördüğü hatanın, ekip tekrar üretmeye çalışmadan görülebilmesi. **Kapalı gelir** (`SENTRY_DSN` boş); açmak için DSN girmek yeterlidir.
> İlgili: [OBSERVABILITY.md](OBSERVABILITY.md) (metrik/log), [KVKK_ENVANTER.md](KVKK_ENVANTER.md) (kişisel veri kuralları), [DEPLOY_ROLLBACK.md](DEPLOY_ROLLBACK.md) (sürüm etiketi).
>
> **Kapsam uyarlaması:** yalnızca **hata** izleme açılır. Performans izi (tracing), oturum tekrarı (replay) ve OpenTelemetry oto-enstrümantasyonu bilinçli **kapalı**:
> replay/ekran görüntüsü kişisel veri taşır, OTel oto-enstrümantasyonu esbuild ile tek dosyaya paketlenen sunucuda kırılgandır ve istek/SQL gövdesi toplar. Trace korelasyonu Sentry
> performans izi ile değil, projenin kendi **`X-Trace-ID`**'siyle yapılır (loglar + hata yanıtı + Sentry `trace_id` etiketi).

## 1. Açma

Kök `.env` / backend ortamı (`deploy/env/*.env.example`):

| Değişken | Anlamı |
|---|---|
| `SENTRY_DSN` | Proje DSN'i. **Boş = kapalı** (backend olay göndermez, tarayıcı tüneli 204 döner). |
| `SENTRY_ERROR_SAMPLE_RATE` | Hata olaylarının yüzdesi (0–1, varsayılan 1) — **maliyet kontrolü**. |
| `SENTRY_TRACES_SAMPLE_RATE` | Performans izi oranı (varsayılan **0 = kapalı**). |
| `SENTRY_ENVIRONMENT` | Ortam adı (boşsa `NODE_ENV`). |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_URL` (self-hosted), `SENTRY_AUTH_TOKEN` | Yalnızca **frontend derlemesinde** source map yüklemek için (§4). Token derleme **sırrıdır**. |

Ardından `zero-downtime-deploy.sh` (backend) ve `docker compose up -d --build frontend` (tarayıcı paketi DSN + sürümü derleme anında gömer) çalıştırılır. Sürüm etiketi (`release`) her iki tarafta **aynıdır**: `APP_VERSION`
(OPS-1110; backend imajından, frontend `VITE_APP_VERSION` build-arg'ından; `/api/v1/health` → `version` ile aynı değer).

## 2. Trace korelasyonu (AC: backend ve frontend olayları trace_id ile eşleşir)

1. Frontend her API çağrısı için bir `X-Trace-ID` üretir (`utils/api.ts`); backend bunu **korur** (`traceMiddleware`), `pino` loglarına, hata yanıtının `traceId` alanına ve yanıt başlığına yazar.
2. Sunucuda beklenmeyen hata (500/502, yakalanmamış istisna) olursa `errorHandler` olayı Sentry'ye `trace_id` etiketiyle gönderir (+ `tenant_id`, `service=yakittakip-backend`).
3. Aynı API çağrısı istemcide 5xx/ağ hatasıyla bittiğinde tarayıcı olayı **aynı `trace_id`** etiketiyle gider (`app=yakittakip-frontend`). Pencere hataları (`window.onerror`) son API isteğinin id'sini `last_api_trace_id` olarak taşır.
4. Sentry'de tek arama: `trace_id:<değer>` → tarayıcı + sunucu olayı; aynı değer Loki'de `{service="backend"} |= "<değer>"` ile loglara götürür. Kullanıcıya hata ekranında/`traceId` alanında gösterilen kodla destek bu zinciri izler.

`trace_id` etiketi yalnızca `[A-Za-z0-9._-]{8,64}` ise kabul edilir (etiket enjeksiyonu engeli).

## 3. Kişisel veri ve token temizliği (AC: olay gövdesinde kişisel veri yok)

Aynı kural motoru (`privacy/piiScrub.ts`, COMP-606) **iki yerde** uygulanır ve sunucudaki yetkilidir:

- **Backend SDK `beforeSend` + `beforeBreadcrumb`** (`observability/sentryScrub.ts`).
- **Tarayıcı tüneli** `POST /api/v1/monitoring/sentry-tunnel` — tarayıcı olayları doğrudan Sentry'ye gitmez; sunucuda **yeniden temizlenir**, sonra iletilir. Bu yüzden eski/ele geçirilmiş bir istemci bile PII sızdıramaz.

Temizlenenler: TCKN (geçerli sağlama toplamı), telefon, e-posta, JWT, `Bearer` token → maske; `tcNo/phone/email/password/token/authorization/cookie…` alanları → `[PII]`; **kullanıcı yalnızca `id`** (e-posta/kullanıcı adı/IP atılır);
istek yalnızca method + **sorgusuz URL** + beyaz liste başlıklar (gövde, çerez, `Authorization` yok); stack frame yerel değişkenleri (`vars`) atılır; breadcrumb gövdeleri ve kullanıcı girdisi mesajları atılır; konsol/DOM/XHR breadcrumb'ları kapalı.
Tünel ayrıca **ek dosya, replay ve profil öğelerini atar** (yalnızca `event/transaction/session/client_report` iletilir).

### Tünelin güvenliği
Açık röle değildir: yalnızca yapılandırılmış DSN'in **anahtar + proje + host** üçlüsüne sahip zarflar kabul edilir (aksi 403); gövde ≤ 256 KB (413); IP başına dakikada 120 (429); DSN yoksa 204. Sentry erişilemezse tarayıcıya
yine 200 döner (istemci retry fırtınası olmaz), sunucu loguna uyarı yazılır. CSP `connect-src 'self'` **gevşetilmez**; reklam engelleyiciler tüneli kesmez.

## 4. Source map (AC: frontend hataları source map ile okunabilir)

- Vite `build.sourcemap: 'hidden'`: `.map` dosyaları üretilir ama pakette `sourceMappingURL` yorumu **yoktur** (tarayıcı/son kullanıcı kaynak kodu göremez).
- `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` tanımlıysa `@sentry/vite-plugin` haritaları **`release = VITE_APP_VERSION`** adıyla Sentry'ye yükler ve yüklemeden sonra siler. Token, Docker'a ARG/ENV değil **BuildKit secret**
  olarak geçer (imaj katmanlarında/`docker history`'de görünmez): `docker-compose.yml → secrets.sentry_auth_token` (ortam değişkeni kaynaklı).
- Token yoksa yükleme atlanır; `.map` dosyaları her durumda `Dockerfile`'da imaja girmeden **silinir** (ayrıca nginx `*.map` → 404).
- **Doğrulama (CI):** `node scripts/test-res907.mjs --build` paketi derler, her `.js` için `.map` üretildiğini ve `sourceMappingURL` olmadığını doğrular ve pakette bir konumu (`SOURCEMAP_PROBE`) `.map` ile **`src/utils/sentry.ts` satır 18'e geri çözer**.
- Yükleme yapılmadıysa Sentry'deki frontend stack'leri minify halde görünür — release'in yüklendiğini Sentry → Releases → Artifacts'ten teyit edin (canlı yükleme, kimlik bilgisi gerektiği için **manuel** doğrulanır).

## 5. Sürüm / release takibi

`release` = `APP_VERSION` (etiket: `vX.Y.Z` veya `git describe`). Aynı sürümde backend ve frontend olayları birlikte filtrelenir; geri almada (`rollback.sh`) eski sürümün etiketi döner, böylece "hangi sürümde başladı" sorusu Sentry'de
doğrudan görülür. CI'ın SSH dağıtım adımları frontend derlemesine `APP_VERSION`'ı geçirir (geri almada geri alınan etiket).

## 6. Örnekleme ve maliyet

Hata olayları `SENTRY_ERROR_SAMPLE_RATE` ile örneklenir (elenenler yalnızca sayaç olarak bildirilir); tarayıcı için `VITE_SENTRY_SAMPLE_RATE` (derlemede `SENTRY_ERROR_SAMPLE_RATE`'ten). Tracing ve replay kapalı olduğundan
asıl maliyet kalemi hata hacmidir. Sentry `dedupe` entegrasyonu art arda aynı hatayı bir kez gönderir. **Raporlanmayanlar:** 4xx istemci hataları ve beklenen 503'ler (AI anahtarı yok, DB meşgul) — gürültü olmasın diye.

## 7. Elle doğrulama (ticket "Test Notu")

1. DSN'i ayarlayıp dağıtın. 2. Panelde kasıtlı bir sunucu hatası üretin (ör. geçici bozuk bir uç) — ekrandaki/yanıttaki `traceId`'yi not edin.
3. Sentry'de `trace_id:<değer>` arayın: **iki olay** (frontend + backend) görünmeli, ikisi de aynı `release`'te; frontend stack'i source map ile okunaklı olmalı; olayların hiçbirinde TCKN/telefon/e-posta/token bulunmamalı.
4. Sonucu aşağıya tarih ve yapan kişiyle işleyin.

| Tarih | Yapan | Ortam | Sonuç |
|---|---|---|---|
| _(canlı Sentry hesabı gerektirir — henüz yapılmadı)_ | | | |
