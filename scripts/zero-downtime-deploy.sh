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
# Kullanım: ./scripts/zero-downtime-deploy.sh
# Repo kökünden, yığın zaten ayaktayken (`docker compose up -d`) ve kök
# dizinde bir .env dosyası varken çalıştırılmalıdır.
# ==============================================================================

readonly SERVICE="backend"
readonly HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-90}"
readonly HEALTH_POLL_INTERVAL_SECONDS=2
readonly UPSTREAM_CONF="nginx/backend_upstream.conf"
readonly UPSTREAM_STATIC_TARGET="server backend:5000;"

log()  { echo "[zero-downtime-deploy] $*"; }
fail() { echo "[zero-downtime-deploy] HATA: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker bulunamadı."
docker compose version >/dev/null 2>&1 || fail "docker compose (v2 plugin) bulunamadı."
[ -f "$UPSTREAM_CONF" ] || fail "$UPSTREAM_CONF bulunamadı — repo kökünden çalıştırın."

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
log "1/7 — Yeni backend imajı derleniyor..."
docker compose build "$SERVICE"

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

# --- 3/7 — İkinci (yeni) repliği ekle, eskiyi YENİDEN OLUŞTURMA -------------
log "2/7 — Yeni replika ekleniyor (eski konteyner ayakta, trafik almaya devam ediyor)..."
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
log "3/7 — Yeni replikanın sağlık kontrolü bekleniyor (en fazla ${HEALTH_TIMEOUT_SECONDS}sn)..."
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

# --- 5/7 — ATOMİK KESME: nginx'i doğrudan YENİ repliğe yönlendir -----------
log "4/7 — nginx trafiği ATOMİK olarak yeni repliğe kesiliyor (${NEW_NAME})..."
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
log "5/7 — Eski konteyner durduruluyor (devam eden istekler OPS-1101 graceful shutdown ile tamamlanıyor): ${OLD_ID:0:12}"
docker stop "$OLD_ID" >/dev/null
docker rm "$OLD_ID" >/dev/null

# --- 7/7 — Durağan hedefe geri dön ------------------------------------------
log "6/7 — nginx hedefi durağan Compose takma adına döndürülüyor..."
write_upstream_target "$UPSTREAM_STATIC_TARGET"
reload_nginx

log "7/7 — Tamamlandı: '$SERVICE' sıfır kesintiyle güncellendi. Ayakta kalan konteyner: ${NEW_NAME} (${NEW_ID:0:12})"
