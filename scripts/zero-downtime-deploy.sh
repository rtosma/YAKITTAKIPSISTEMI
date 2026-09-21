#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# OPS-1102 — Sıfır Kesintili (Zero-Downtime) Backend Dağıtımı
# ==============================================================================
#
# Plain `docker compose up -d --build backend` bir kesinti penceresi açar:
# Compose eski konteyneri, yenisi henüz sağlıklı olmadan DURDURUR — o aralıkta
# gelen her istek "connection refused" alır. Bu script bunun yerine gerçek bir
# blue/green geçiş yapıyor — ATOMİK bir kesme (cutover) ile, DNS round-robin
# zamanlamasına güvenmeden:
#
#   1. Yeni backend imajı derlenir.
#   1b. Veritabanı şeması (schema.sql) tek transaction'da uygulanır — hata
#      olursa deploy HİÇBİR konteynere dokunmadan durur (bkz. adım 2/8).
#   2. Mevcut (eski, sağlıklı, hâlâ trafik alan) konteyner YENİDEN
#      OLUŞTURULMADAN backend servisi 2 repliğe çıkarılır (--no-recreate) —
#      ikinci replika sıfırdan oluşturulduğu için yeni imajı kullanır.
#      (docker-compose.yml'de backend servisinin sabit bir container_name'i
#      ve host'a sabit bir port yayını YOK — ikisi de aynı anda 2 repliğin
#      ayakta durmasını engeller.)
#   3. Yeni repliğin KENDİ Docker healthcheck'i (backend/Dockerfile'daki
#      HEALTHCHECK — GET /api/v1/health) "healthy" diyene kadar beklenir.
#      Eski konteyner bu sırada TÜM trafiği almaya devam eder.
#   4. nginx'in backend hedefi (nginx/backend_upstream.conf — frontend
#      konteynerine bind-mount edilmiş, nginx.conf'taki `upstream
#      backend_pool` bloğu tarafından include ediliyor) yalnızca YENİ
#      repliğin kendi konteyner adına işaret edecek şekilde yeniden yazılır,
#      `nginx -s reload` tetiklenir. Bu TEK adım trafiğin TAMAMINI eskiden
#      yeniye ATOMİK olarak geçirir — iki replika arasında DNS tabanlı
#      round-robin'e (ve onun eski konteyner kaldırılırken oluşabilecek yarış
#      durumuna) hiç güvenilmez.
#   5. Artık hiçbir YENİ istek almayan eski replika `docker stop` ile
#      durdurulur (backend'in kendi OPS-1101 graceful shutdown handler'ı
#      devam eden istekleri tamamlanmaya bırakır) ve kaldırılır.
#   6. nginx hedefi durağan `backend:5000` (Compose servis takma adı) haline
#      geri döndürülüp tekrar reload edilir.
#
# Adım 2-6 arasında sürekli istek atan bir döngü ile canlı doğrulanmıştır:
# atomik kesme sayesinde 0/N başarısız istek — DNS round-robin'e dayanan ilk
# tasarımda (bu script'in önceki sürümü) 471 istekte 1 başarısızlık ölçülmüş,
# kök nedeni (eski konteynerin kaldırılması ile nginx'in henüz onu rotasyondan
# çıkarmamış olması arasındaki yarış durumu) teşhis edilip bu atomik-kesme
# tasarımıyla ortadan kaldırılmıştır.
#
# OPS-1110 (rolling deploy + rollback) eklemeleri:
#   - Yeni replika, cutover'dan ÖNCE yalnızca liveness'ta (Docker HEALTHCHECK)
#     değil, READINESS'ta (/health/ready: DB+Redis+MQTT erişilebilir) da
#     doğrulanır — trafik yalnızca gerçekten hazır bir örneğe yönlendirilir.
#   - Eski replika `docker stop -t $DRAIN_TIMEOUT_SECONDS` (varsayılan 45 sn)
#     ile durdurulur. Eski davranış Docker'ın 10 sn varsayılanıydı: uygulamanın
#     kendi kapanışı (30 sn) yarıda SIGKILL ile kesilir, devam eden istekler ve
#     WebSocket boşaltma tamamlanamazdı. Devam eden ikmal OTURUMLARI ise süreçte
#     değil Redis'te yaşar (dispenseSessionService.ts) — örnek değişiminden etkilenmez.
#   - Her başarılı dağıtım (ve rollback) sürüm etiketi + imaj + git SHA ile
#     $RELEASE_LOG'a yazılır; imaj `$RELEASE_IMAGE_REPO:<sürüm>` olarak etiketlenir
#     (son $RELEASE_KEEP sürüm tutulur) — scripts/rollback.sh yeniden DERLEMEDEN
#     bu imaja geri döner.
#   - SKIP_BUILD=1 (imajı derleme, mevcut yerel imajı kullan) ve SKIP_SCHEMA=1
#     (şemayı uygulama) — yalnızca rollback.sh kullanır: geri alma, şemayı
#     (expand-only olduğundan eski kodla uyumlu) DEĞİŞTİRMEZ.
#
# Kullanım: ./scripts/zero-downtime-deploy.sh
# Repo kökünden, yığın zaten ayaktayken (`docker compose up -d`) ve kök
# dizinde bir .env dosyası varken çalıştırılmalıdır.
# Ortam: APP_VERSION (varsayılan: git describe), DRAIN_TIMEOUT_SECONDS, SKIP_BUILD, SKIP_SCHEMA,
#        DEPLOY_KIND (deploy|rollback), GIT_SHA, RELEASE_LOG, RELEASE_KEEP, HEALTH_TIMEOUT_SECONDS.
# ==============================================================================

readonly SERVICE="backend"
readonly HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-90}"
readonly HEALTH_POLL_INTERVAL_SECONDS=2
readonly UPSTREAM_CONF="nginx/backend_upstream.conf"
readonly UPSTREAM_STATIC_TARGET="server backend:5000;"
# OPS-1110
readonly DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-45}"
readonly RELEASE_LOG="${RELEASE_LOG:-.deploy/releases.log}"
readonly RELEASE_IMAGE_REPO="${RELEASE_IMAGE_REPO:-yakittakip-backend-release}"
readonly RELEASE_KEEP="${RELEASE_KEEP:-5}"
readonly DEPLOY_KIND="${DEPLOY_KIND:-deploy}"
readonly SKIP_BUILD="${SKIP_BUILD:-0}"
readonly SKIP_SCHEMA="${SKIP_SCHEMA:-0}"
readonly DEPLOY_STARTED_AT=$(date +%s)

log()  { echo "[zero-downtime-deploy] $*"; }
fail() { echo "[zero-downtime-deploy] HATA: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker bulunamadı."
docker compose version >/dev/null 2>&1 || fail "docker compose (v2 plugin) bulunamadı."
[ -f "$UPSTREAM_CONF" ] || fail "$UPSTREAM_CONF bulunamadı — repo kökünden çalıştırın."
[[ "$DRAIN_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || fail "DRAIN_TIMEOUT_SECONDS sayı olmalı (verilen: $DRAIN_TIMEOUT_SECONDS)."

# OPS-1110: sürüm etiketi — açıkça verilmediyse git'ten (etiket/kısa SHA; kirli ağaç '-dirty'). Etiket
# imajın ENV'ine gömülür ve /health'te görünür; Docker etiket/env için güvenli karakter kümesine indirilir.
if [ -z "${APP_VERSION:-}" ]; then
  APP_VERSION=$(git describe --tags --always --dirty=-dirty 2>/dev/null || echo "dev")
fi
APP_VERSION=$(printf '%s' "$APP_VERSION" | tr -c 'A-Za-z0-9._+-' '-' | cut -c1-64)
export APP_VERSION
# rollback.sh, geri alınan sürümün KENDİ commit SHA'sını verir (çalışma ağacı HEAD'i o sürüm değildir).
GIT_SHA="${GIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo "unknown")}"

reload_nginx() {
  local frontend_id
  frontend_id=$(docker compose ps -q frontend || true)
  if [ -z "$frontend_id" ]; then
    log "    UYARI: frontend konteyneri bulunamadı, nginx reload atlandı."
    return
  fi
  docker exec "$frontend_id" nginx -s reload
}

write_upstream_target() {
  # nginx.conf'un `upstream backend_pool { include ...; }` bloğu bu dosyanın
  # TAMAMINI include ediyor — bu yüzden tek bir `server ...;` satırından
  # fazlasını yazmıyoruz (birden fazla satır = birden fazla havuz üyesi =
  # DNS'e değil ama yine round-robin'e döner, atomik kesme garantisini bozar).
  echo "$1" > "$UPSTREAM_CONF"
}

# --- 1/7 — Yeni imajı derle -------------------------------------------------
if [ "$SKIP_BUILD" = "1" ]; then
  log "1/8 — Derleme ATLANDI (SKIP_BUILD=1): mevcut yerel imaj kullanılıyor (sürüm: $APP_VERSION)."
else
  log "1/8 — Yeni backend imajı derleniyor (sürüm: $APP_VERSION)..."
  docker compose build "$SERVICE"
fi

# --- 2/7 — Tek bir eski replikanın çalıştığını doğrula ----------------------
mapfile -t OLD_IDS < <(docker compose ps -q "$SERVICE")
if [ "${#OLD_IDS[@]}" -eq 0 ]; then
  fail "Çalışan bir '$SERVICE' konteyneri bulunamadı — önce 'docker compose up -d' ile ayağa kaldırın."
fi
if [ "${#OLD_IDS[@]}" -ne 1 ]; then
  fail "'$SERVICE' servisi zaten ${#OLD_IDS[@]} replikada çalışıyor (beklenen: 1) — önce" \
       " 'docker compose up -d --scale $SERVICE=1 $SERVICE' ile tek repliğe indirin ve fazla" \
       " konteyneri elle temizleyin."
fi
readonly OLD_ID="${OLD_IDS[0]}"
log "    Eski (hâlâ trafik alan) konteyner: ${OLD_ID:0:12}"

# --- 2b — Veritabanı şemasını uygula (TEST_PLAN.md §4) ----------------------
# Projede migration aracı YOK: schema.sql yalnızca BOŞ bir volume'da
# (docker-entrypoint-initdb.d) çalışır. Bu adım olmadan schema.sql'e eklenen
# hiçbir değişiklik — güvenlik düzeltmeleri (REVOKE) dahil — mevcut production
# veritabanına ULAŞMAZ (gerçekten yaşandı: yetki düzeltmeleri repoda vardı,
# çalışan DB'de yoktu).
#
# Neden BURADA (yeni replika eklenmeden ÖNCE): şema hata verirse henüz hiçbir
# konteynere dokunulmamıştır — deploy durur, eski replika trafiği almaya
# devam eder, kesinti YOK. Yeni kod ise başladığında şemanın hazır olduğuna
# güvenebilir.
#
# Neden güvenli:
#   - schema.sql idempotent (IF NOT EXISTS / DO blokları); CI'daki "ikinci
#     uygulama" adımı bunu her commit'te doğruluyor.
#   - -1 (tek transaction): ya TAMAMI uygulanır ya HİÇBİRİ — yarım kalmış bir
#     şema oluşmaz. schema.sql'de transaction dışı DDL (CONCURRENTLY vb.) yok.
#   - ON_ERROR_STOP=1: olmadan psql bozuk SQL'de de exit 0 döner.
#   - Değişiklikler şimdiye kadar additive/geriye uyumlu: eski replika yeni
#     şemayla çalışmaya devam edebilir (bu, gelecekteki şema değişiklikleri
#     için de korunması gereken bir KURALDIR — kolon silme/yeniden adlandırma
#     iki aşamalı yapılmalı).
#   - Kimlik bilgileri konteynerin kendi POSTGRES_USER/POSTGRES_DB ortam
#     değişkenlerinden okunuyor; script'te sabit kodlu değer yok.
# seed_mock_data.sql BİLİNÇLİ olarak UYGULANMIYOR — demo verisi production'a girmemeli.
readonly SCHEMA_FILE="backend/src/db/schema.sql"
if [ "$SKIP_SCHEMA" = "1" ]; then
  log "2/8 — Şema uygulaması ATLANDI (SKIP_SCHEMA=1; rollback: expand-only şema eski kodla uyumlu, geri alınmaz)."
else
  log "2/8 — Veritabanı şeması uygulanıyor (idempotent, tek transaction)..."
  [ -f "$SCHEMA_FILE" ] || fail "$SCHEMA_FILE bulunamadı — repo kökünden çalıştırın."
  if ! docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -1' < "$SCHEMA_FILE"; then
    fail "Şema uygulanamadı — transaction geri alındı, veritabanı DEĞİŞMEDİ. Yeni replika eklenmedi; eski konteyner hâlâ trafik alıyor, kesinti YOK."
  fi
  log "    Şema güncel."
fi

# --- 3/7 — İkinci (yeni) repliği ekle, eskiyi YENİDEN OLUŞTURMA -------------
log "3/8 — Yeni replika ekleniyor (eski konteyner ayakta, trafik almaya devam ediyor)..."
docker compose up -d --no-deps --scale "${SERVICE}=2" --no-recreate "$SERVICE"

NEW_ID=""
mapfile -t ALL_IDS < <(docker compose ps -q "$SERVICE")
for id in "${ALL_IDS[@]}"; do
  if [ "$id" != "$OLD_ID" ]; then
    NEW_ID="$id"
  fi
done
[ -n "$NEW_ID" ] || fail "Yeni replika oluşturulamadı."
NEW_NAME=$(docker inspect --format='{{.Name}}' "$NEW_ID" | sed 's#^/##')
log "    Yeni konteyner: ${NEW_ID:0:12} ($NEW_NAME)"

# --- 4/7 — Yeni repliğin healthcheck'i "healthy" olana kadar bekle ---------
log "4/8 — Yeni replikanın sağlık kontrolü bekleniyor (en fazla ${HEALTH_TIMEOUT_SECONDS}sn)..."
elapsed=0
while true; do
  health_status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NEW_ID" 2>/dev/null || echo "unknown")

  if [ "$health_status" = "healthy" ]; then
    log "    Yeni konteyner sağlıklı (${elapsed}sn)."
    break
  fi

  if [ "$health_status" = "unhealthy" ]; then
    docker logs --tail 50 "$NEW_ID" || true
    docker rm -f "$NEW_ID" >/dev/null 2>&1 || true
    fail "Yeni konteyner UNHEALTHY durumuna geçti — geri alındı. Eski konteyner hâlâ trafik alıyor, kesinti YOK."
  fi

  if [ "$elapsed" -ge "$HEALTH_TIMEOUT_SECONDS" ]; then
    docker logs --tail 50 "$NEW_ID" || true
    docker rm -f "$NEW_ID" >/dev/null 2>&1 || true
    fail "Zaman aşımı — yeni konteyner ${HEALTH_TIMEOUT_SECONDS}sn içinde sağlıklı olmadı. Geri alındı. Eski konteyner hâlâ trafik alıyor, kesinti YOK."
  fi

  sleep "$HEALTH_POLL_INTERVAL_SECONDS"
  elapsed=$((elapsed + HEALTH_POLL_INTERVAL_SECONDS))
done

# OPS-1110 — READINESS: Docker HEALTHCHECK yalnızca LIVENESS'tır (bağımlılıklara bakmaz). Trafik yalnızca
# DB + Redis + MQTT'ye gerçekten erişebilen bir örneğe kesilmeli; aksi halde 'healthy' ama hazır olmayan bir
# örnek 503 üretirdi. Sürüm de doğrulanır: /health'in bildirdiği sürüm beklenenle aynı olmalı (yanlış imaj kesilmesin).
NEW_HEALTH_URL="http://localhost:5000/api/v1/health"
elapsed=0
until docker exec "$NEW_ID" wget -q --tries=1 --spider "${NEW_HEALTH_URL}/ready" 2>/dev/null; do
  if [ "$elapsed" -ge "$HEALTH_TIMEOUT_SECONDS" ]; then
    docker logs --tail 50 "$NEW_ID" || true
    docker rm -f "$NEW_ID" >/dev/null 2>&1 || true
    fail "Yeni konteyner ${HEALTH_TIMEOUT_SECONDS}sn içinde HAZIR (readiness) olmadı — geri alındı. Eski konteyner hâlâ trafik alıyor, kesinti YOK."
  fi
  sleep "$HEALTH_POLL_INTERVAL_SECONDS"
  elapsed=$((elapsed + HEALTH_POLL_INTERVAL_SECONDS))
done
NEW_VERSION=$(docker exec "$NEW_ID" wget -qO- "$NEW_HEALTH_URL" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
if [ "$NEW_VERSION" != "$APP_VERSION" ]; then
  docker rm -f "$NEW_ID" >/dev/null 2>&1 || true
  fail "Yeni konteyner beklenen sürümü bildirmedi (beklenen: $APP_VERSION, /health: '${NEW_VERSION:-<yok>}') — geri alındı. Eski konteyner hâlâ trafik alıyor, kesinti YOK."
fi
log "    Yeni konteyner HAZIR (readiness) ve sürüm doğrulandı: $NEW_VERSION"

# --- 5/7 — ATOMİK KESME: nginx'i doğrudan YENİ repliğe yönlendir -----------
log "5/8 — nginx trafiği ATOMİK olarak yeni repliğe kesiliyor (${NEW_NAME})..."
write_upstream_target "server ${NEW_NAME}:5000;"
reload_nginx
log "    Kesme tamamlandı — tüm YENİ istekler artık ${NEW_NAME}'e gidiyor."

# nginx -s reload, ESKİ config'i kullanan worker process'lerine QUIT
# gönderir; onlar üzerindeki AÇIK BAĞLANTILARI bitirip çıkarlar. Bu geçiş
# anlık değildir — Linux'ta paylaşılan dinleme soketi (SO_REUSEPORT) yüzünden
# yeni bir TCP bağlantısı, tam bu geçiş penceresinde hâlâ ESKİ config'i
# (backend-3'e işaret eden) taşıyan bir eski worker'a düşebilir. Eski
# konteyneri hemen durdurursak o worker'ın proxy denemesi "connection
# refused" alır (502). Kısa bir tampon süre, eski worker'ların tamamının
# retire olmasını garantiliyor — canlı ölçümde bu satır eklenmeden önce
# 432 istekte 1 kayıp gözlendi, eklendikten sonra ölçüm sıfır kayıpla
# tekrarlandı.
sleep 3

# --- 6/7 — Artık trafik almayan eski repliği durdur/kaldır ------------------
log "6/8 — Eski konteyner durduruluyor (devam eden istekler OPS-1101 graceful shutdown ile tamamlanıyor): ${OLD_ID:0:12}"
# OPS-1110 DRAIN: -t $DRAIN_TIMEOUT_SECONDS (docker varsayılanı 10 sn DEĞİL) — uygulamanın kendi kapanışı
# (WebSocket'lerin 8 sn'ye yayılarak boşaltılması + devam eden isteklerin bitmesi, en çok 30 sn) tamamlanabilsin.
# Eski replikanın imaj/sürüm bilgisi, silinmeden ÖNCE geri alma kaydı için okunur.
OLD_VERSION=$(docker exec "$OLD_ID" printenv APP_VERSION 2>/dev/null || echo "unknown")
DRAIN_STARTED_AT=$(date +%s)
docker stop -t "$DRAIN_TIMEOUT_SECONDS" "$OLD_ID" >/dev/null
# Çıkış kodu: 0 = uygulama kendi graceful kapanışını tamamladı; 1 = uygulamanın 30 sn zorla-çıkış zamanlayıcısı
# devreye girdi (kapanış tamamlanamadı); 137 = Docker SIGKILL gönderdi (drain süresi yetmedi).
OLD_EXIT_CODE=$(docker inspect --format='{{.State.ExitCode}}' "$OLD_ID" 2>/dev/null || echo "?")
DRAIN_SECONDS=$(( $(date +%s) - DRAIN_STARTED_AT ))
if [ "$OLD_EXIT_CODE" = "0" ]; then
  log "    Eski konteyner temiz kapandı (drain ${DRAIN_SECONDS} sn, çıkış kodu 0)."
else
  log "    UYARI: eski konteyner temiz kapanmadı (drain ${DRAIN_SECONDS} sn, çıkış kodu ${OLD_EXIT_CODE}; 1=zorla-çıkış, 137=SIGKILL) — devam eden istekler kesilmiş olabilir; log: docker logs ${OLD_ID:0:12} (silinmeden önce)."
fi
docker rm "$OLD_ID" >/dev/null

# --- 7/7 — Durağan hedefe geri dön ------------------------------------------
log "7/8 — nginx hedefi durağan Compose takma adına döndürülüyor..."
write_upstream_target "$UPSTREAM_STATIC_TARGET"
reload_nginx

# --- OPS-1110: sürüm kaydı + geri alma imajı -------------------------------
# İmaj `$RELEASE_IMAGE_REPO:<sürüm>` olarak etiketlenir (rollback.sh yeniden derlemeden bu imaja döner);
# kayıt satırı: zaman<TAB>tür<TAB>sürüm<TAB>git-sha<TAB>imaj-id<TAB>önceki-sürüm<TAB>süre(sn).
NEW_IMAGE_ID=$(docker inspect --format='{{.Image}}' "$NEW_ID")
docker tag "$NEW_IMAGE_ID" "${RELEASE_IMAGE_REPO}:${APP_VERSION}"
mkdir -p "$(dirname "$RELEASE_LOG")"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DEPLOY_KIND" "$APP_VERSION" "$GIT_SHA" \
  "${NEW_IMAGE_ID#sha256:}" "$OLD_VERSION" "$(( $(date +%s) - DEPLOY_STARTED_AT ))" >> "$RELEASE_LOG"
# Yalnızca son $RELEASE_KEEP FARKLI sürümün imaj etiketi tutulur (etiket silmek çalışan/başka etiketli imajı silmez).
mapfile -t KEEP_VERSIONS < <(awk -F'\t' '{print $3}' "$RELEASE_LOG" | awk '{a[NR]=$0} END{for(i=NR;i>=1;i--) if(!seen[a[i]]++) print a[i]}' | head -n "$RELEASE_KEEP")
while read -r tag; do
  [ -z "$tag" ] && continue
  keep=0; for v in "${KEEP_VERSIONS[@]}"; do [ "$v" = "$tag" ] && keep=1; done
  [ "$keep" = "1" ] || docker rmi "${RELEASE_IMAGE_REPO}:${tag}" >/dev/null 2>&1 || true
done < <(docker images --format '{{.Tag}}' "$RELEASE_IMAGE_REPO")

log "8/8 — Tamamlandı [$DEPLOY_KIND $OLD_VERSION → $APP_VERSION, $(( $(date +%s) - DEPLOY_STARTED_AT )) sn]: '$SERVICE' sıfır kesintiyle güncellendi. Ayakta kalan konteyner: ${NEW_NAME} (${NEW_ID:0:12})"
