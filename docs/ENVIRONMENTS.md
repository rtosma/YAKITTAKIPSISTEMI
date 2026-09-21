# Ortamlar ve Dağıtım Pipeline'ı (OPS-1104)

Değişikliklerin canlıya **kontrollü ve geri alınabilir** çıkması için üç ortam ve iki dağıtım yolu tanımlıdır.
Sırların yönetimi: [SECRETS.md](SECRETS.md). Sıfır kesintili geçiş mekaniği: [`scripts/zero-downtime-deploy.sh`](../scripts/zero-downtime-deploy.sh) (OPS-1102).

## 1. Üç ortam

| | **development** | **staging** | **production** |
|---|---|---|---|
| Amaç | Geliştirme, hızlı deneme | Üretimin birebir ön provası; dağıtım + duman testi doğrulaması | Canlı sistem |
| Nerede | Geliştiricinin makinesi (`docker compose up -d`) | Ayrı sunucu (VPS/Cloud) | Ayrı sunucu (VPS/Cloud) |
| Dağıtım | Elle | **Otomatik** — `main`/`master`'a her push (kalite kapıları geçince) | **Onaylı** — `vX.Y.Z` etiketi + GitHub `production` environment onayı |
| `NODE_ENV` | `development` | `production` (aynı kod yolları; placeholder sır doğrulaması aktif) | `production` |
| Sırlar | `.env` (örnek değerler serbest) | **Kendine ait** — GitHub `staging` environment secret'ları | **Kendine ait** — GitHub `production` environment secret'ları |
| Veritabanı | Yerel; `seed_mock_data.sql` demo verisi | `yakittakip_staging`; **yalnızca seed veya maskelenmiş veri** (bkz. §5) | `yakittakip_db`; gerçek veri; **seed uygulanmaz** |
| `LOG_LEVEL` / `TOTP_ENFORCED` | `info` / `false` | `info` / `false` | `warn` / `true` |
| E-posta/SMS | Boş | Sandbox sağlayıcı veya boş (gerçek kullanıcıya ulaşmamalı) | Gerçek sağlayıcı |
| Şablon | `backend/.env.example` | [`deploy/env/staging.env.example`](../deploy/env/staging.env.example) | [`deploy/env/production.env.example`](../deploy/env/production.env.example) |

Şablonlar `backend/.env.example` ile **aynı anahtar kümesini** taşır (CI'da doğrulanır) ve ortama özel `__CHANGE_ME_<ORTAM>_ONLY_…`
placeholder'ları içerir; `NODE_ENV=production` iken **doldurulmamış (`__CHANGE_ME…`) bir sırla uygulama başlamaz**
(`backend/src/config/env.ts`).

### Erişim kısıtları

- Ortam farkları **GitHub Environments**'ta tutulur (`staging`, `production`): aynı isimli secret'lar (`DEPLOY_HOST`, `DEPLOY_USER`,
  `DEPLOY_SSH_KEY`, `DEPLOY_PORT`, `SMOKE_USERNAME`, `SMOKE_PASSWORD`) ve değişkenler (`STAGING_URL`, `PRODUCTION_URL`)
  her ortamda **farklı** değerlerle tanımlanır. Staging'e verilen SSH anahtarı üretim sunucusuna erişemez.
- `production` environment: **Required reviewers** zorunlu (en az 1 kişi; tetikleyen kişi kendini onaylayamasın: "Prevent self-review"),
  **Deployment branches and tags** = yalnızca `v*.*.*` etiketleri.
- `staging` environment: yalnızca `main`/`master`.
- Sunucularda kök `.env` dosyası yalnızca dağıtım kullanıcısının okuyabildiği izinle (`chmod 600`) tutulur.

## 2. Dağıtım akışı

```
PR ──► CI (lint, tip, RLS, migration güvenliği, testler, Trivy, gitleaks)
main'e merge ──► CI ──► deploy-staging (otomatik) ──► duman testi
                                   │
git tag vX.Y.Z && git push --tags ─┴─► CI ──► [ONAY: production reviewers] ──► deploy-production
                                                   ├─ onay kaydı doğrulanır (kim onayladı)
                                                   ├─ zero-downtime-deploy.sh (şema dahil)
                                                   ├─ duman testi ── başarısız ──► önceki etikete OTOMATİK geri alma (job kırmızı)
                                                   └─ başarılı ──► GitHub Release (değişiklik günlüğü + onaylayan)
```

- Hedef sunucu hazır değilse (`DEPLOY_HOST` secret'ı tanımsız) dağıtım/duman adımları **atlanır**, CI kırılmaz. Sunucu hazırlığı (bir kerelik):
  repo klonu, kök dizinde ortam şablonundan üretilmiş gerçek `.env`, `docker compose up -d`.
- Üretime yalnızca **`main`/`master` geçmişindeki** bir commit çıkabilir (etiket dal commit'ine atılırsa dağıtım reddedilir).
- **Onay kaydı:** `deploy-production` işi, GitHub'ın run-approvals kaydından onaylayanı okur, iş özetine ve Release notuna yazar.
  Kayıt yoksa (environment'ta reviewer tanımlı değilse) dağıtım **durur** — koruma yanlışlıkla kapalı kalamaz.
  Etiketi atan (`github.actor`) ve onaylayan ayrı ayrı kayıtlıdır.

## 3. Migration'lar (expand / contract)

Şema (`backend/src/db/schema.sql`) dağıtımın parçasıdır: `zero-downtime-deploy.sh` adım 2b onu **tek transaction'da**, `ON_ERROR_STOP=1`
ile, yeni replika eklenmeden **önce** uygular — hata olursa hiçbir konteynere dokunulmaz ve eski sürüm trafiği almaya devam eder.
Şema idempotenttir (`IF NOT EXISTS` / `DO` blokları; CI ikinci uygulamayı da doğrular). `seed_mock_data.sql` üretimde **uygulanmaz**.

Blue/green geçişte eski replika yeni şemayla bir süre birlikte çalıştığı için şema değişikliği yalnızca **eklemeli** olmalıdır.
CI'daki `scripts/check-migration-safety.mjs` taban sürüme göre **yeni eklenen** ifadeleri tarar ve şunlarda kırmızı yanar:

`DROP TABLE`, `DROP COLUMN`, `RENAME`, `ALTER COLUMN … TYPE`, `ALTER COLUMN … SET NOT NULL`, `DEFAULT`'suz `ADD COLUMN … NOT NULL`,
`TRUNCATE`, `DROP TYPE/INDEX/SCHEMA`, koşulsuz `DELETE FROM`.

**İki aşamalı yol:** (1) *expand* — yeni kolon/tablo ekle (nullable ya da DEFAULT'lu), kodu çift yazacak/okuyacak şekilde dağıt; (2) veriyi taşı;
(3) *contract* — eski kod hiçbir yerde çalışmadığında **ayrı bir dağıtımda** eski yapıyı sil. Bilinçli contract adımı, ifadenin hemen üstüne
`-- MIGRATION-CONTRACT: <en az 15 karakterlik gerekçe / issue>` yazılarak onaylanır (CI onaylıları listeler, kırmaz).
İdempotent yeniden kurulum kalıpları (`DROP POLICY/TRIGGER IF EXISTS`, `REVOKE/GRANT`, `DROP CONSTRAINT IF EXISTS`) yıkıcı sayılmaz.

Expand-only kuralı aynı zamanda **otomatik geri almanın** güvenli olmasını sağlar: önceki sürüm kodu yeni şemayla çalışır, geri alma veri kaybettirmez.

## 4. Sürüm etiketleme ve değişiklik günlüğü

Depo [Conventional Commits](https://www.conventionalcommits.org/) kullanır (`feat(REP-719): …`, `fix(...): …`, `feat!:` / `BREAKING CHANGE:`).

```bash
node scripts/generate-changelog.mjs --next-version      # önerilen sonraki sürüm (semver: breaking→major, feat→minor, aksi→patch)
node scripts/generate-changelog.mjs                     # son etiketten bu yana gruplanmış değişiklik günlüğü (stdout)
node scripts/generate-changelog.mjs --out CHANGELOG.md --prepend
git tag v1.4.0 && git push origin v1.4.0                # ÜRETİM dağıtım talebi (onay bekler)
```

Başarılı üretim dağıtımı aynı günlüğü ve onaylayanı bir **GitHub Release** olarak yayınlar. Etiketi atmak insan kararıdır; script yalnızca önerir.

## 5. Veri politikası — staging ve KVKK

Staging veritabanı **üretim verisinin kopyası olamaz**: kişisel veri (sürücü adı/TC, telefon, e-posta, IP) içeren kopya KVKK ihlalidir.
Kabul edilen kaynaklar: `seed_mock_data.sql` (sentetik) **veya** kişisel alanları geri döndürülemez biçimde maskelenmiş bir kopya
(maskeleme betiği OPS-1106 yedekleme/geri yükleme kapsamında teslim edilecektir). Bugün üretim → staging için **otomatik bir kopyalama
mekanizması yoktur** ve eklenmemelidir; staging'e üretim yedeği elle yüklenmez. Staging sırları üretimden bağımsızdır (§1), böylece
staging'e sızan bir sır üretime erişim vermez.

## 6. Dağıtım sonrası duman testi

[`scripts/smoke-test.mjs`](../scripts/smoke-test.mjs) her dağıtımdan sonra otomatik çalışır (staging ve production); **veri yazmaz**:
`/health` UP · `/health/ready` 200 (DB+Redis+MQTT; ısınma için yeniden denenir) · korumalı uçlar tokensiz **401** · frontend 200 ve HTML ·
`X-Content-Type-Options: nosniff` · (duman kullanıcısı tanımlıysa) giriş 200, rapor kataloğu 200, yönetici dashboard'u 200.
Başarısız kontrol dağıtım adımını kırmızı yapar; üretimde ayrıca önceki etikete otomatik geri alma tetiklenir.

```bash
SMOKE_BASE_URL=https://staging.ornek.com/api/v1 SMOKE_CHECK_FRONTEND=1 SMOKE_CHECK_HEADERS=1 \
SMOKE_USERNAME=... SMOKE_PASSWORD=... node scripts/smoke-test.mjs
```

## 7. Yedekleme

Staging ve production'da `docker-compose.backup.yml` (sürekli WAL arşivi) etkin olmalı ve `deploy/cron/yakittakip-backup.cron` kurulu olmalıdır — RPO 15 dk / RTO 4 saat hedefleri, şifreleme,
PITR ve çeyreklik restore tatbikatı: [BACKUP_RESTORE.md](BACKUP_RESTORE.md). Staging'e üretim yedeği elle yüklenmez (§5); maskeli kopya prosedürü BACKUP_RESTORE.md'ye eklenecektir.

## 8. Gözlemlenebilirlik

Staging ve production'da `docker-compose.monitoring.yml` (Prometheus + Grafana + Loki + Promtail + exporter'lar) etkin olmalı ve `GRAFANA_ADMIN_PASSWORD` (+ üretimde `METRICS_TOKEN`) tanımlanmalıdır. Metrik kataloğu, kardinalite politikası,
dashboard'lar ve log sorguları: [OBSERVABILITY.md](OBSERVABILITY.md). Grafana yalnızca `127.0.0.1:3001`'e bağlanır; uzaktan erişim SSH tüneli veya TLS'li ters proxy ile yapılır.

## 9. Geri alma

```bash
# sunucuda — backend: tek komut, sıfır kesinti, yeniden derleme yok (ayrıntı, sınırlar ve tatbikat: DEPLOY_ROLLBACK.md)
./scripts/rollback.sh            # bir önceki sürüme  ·  ./scripts/rollback.sh vX.Y.Z  ·  ./scripts/rollback.sh --list
# frontend (nginx statik dosyaları) git ağacından gelir:
git fetch origin --tags && git checkout vX.Y.(Z-1) -- frontend nginx && docker compose up -d --build frontend
```

Şema expand-only olduğundan önceki uygulama sürümü yeni şemayla çalışır; **iki sürüm arasında bir *contract* adımı varsa `rollback.sh` reddeder** (yalnızca uygulama geri alınamaz) — o durumda ileri düzeltme
veya yedekten geri yükleme gerekir ([DEPLOY_ROLLBACK.md §5](DEPLOY_ROLLBACK.md), [BACKUP_RESTORE.md](BACKUP_RESTORE.md)).
