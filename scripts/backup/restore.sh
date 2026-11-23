#!/usr/bin/env bash
# ==============================================================================
# OPS-1106 — Yedekten TEMİZ bir Postgres konteynerine geri yükleme (kaynak DB'ye ASLA dokunmaz).
#
#   restore.sh --mode pitr [--backup latest|TS] [--target-time 'YYYY-MM-DD HH:MM:SS+00' | latest] [--name yk-restore-x]
#   restore.sh --mode dump [--backup latest|TS] [--name yk-restore-x]
#
#  pitr : fiziksel taban yedek (pg_basebackup) + şifreli WAL arşivi → belirli ana (recovery_target_time) veya
#         arşivin sonuna kadar (latest) geri dönüş. Hedef zamandan ÖNCE tamamlanmış en yeni taban yedek seçilir.
#         Bu yol TimescaleDB hypertable'ları dahil her şeyi olduğu gibi geri getirir (fiziksel kopya).
#  dump : mantıksal döküm (pg_dump -Fc) + roller (globals) → boş kümeye pg_restore. (Timescale kullanılırsa bu yolda
#         timescaledb_pre_restore()/post_restore() gerekir — bkz. docs/BACKUP_RESTORE.md.)
#
# Güvenlik: HER şifreli dosya (taban yedek ve kullanılacak her WAL segmenti) çözülmeden önce GCM etiketiyle doğrulanır;
# bozuk/değiştirilmiş/yanlış anahtarlı dosyada geri yükleme DURUR (doğrulanmamış veri kullanılmaz).
# Hedef konteyner `--network none` ile açılır (yanlışlıkla üretim bağlantısı/e-posta/MQTT tetiklenemez).
# Çıktının son satırı: {"container":"...","volume":"...","backup":"...","mode":"...","seconds":N}
# ==============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_dest

MODE=""; BACKUP="latest"; TARGET_TIME="latest"; NAME="yk-restore-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --backup) BACKUP="$2"; shift 2 ;;
    --target-time) TARGET_TIME="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    *) fail "bilinmeyen argüman: $1" ;;
  esac
done
[ "$MODE" = "pitr" ] || [ "$MODE" = "dump" ] || fail "--mode pitr|dump gerekli."

START_EPOCH="$(date +%s)"
BASE_DIR="$BACKUP_DEST_DIR/base"
if [ "$MODE" = "pitr" ] && [ "$TARGET_TIME" != "latest" ] && [ "$BACKUP" = "latest" ]; then
  # Hedef zaman ISO'ya çevrilir (Date.parse için).
  TARGET_ISO="$(date -u -d "$TARGET_TIME" +%Y-%m-%dT%H:%M:%SZ)"
  BK="$("${TOOLS[@]}" pick-base "$BASE_DIR" latest "$TARGET_ISO")"
else
  BK="$("${TOOLS[@]}" pick-base "$BASE_DIR" "$BACKUP")"
fi
IDX="$BASE_DIR/$BK/index.json"
[ -f "$IDX" ] || fail "index.json yok: $IDX"
PG_DB_NAME="$("${TOOLS[@]}" index-field "$IDX" database)"
START_WAL="$("${TOOLS[@]}" index-field "$IDX" startWal)"
IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PG_USER_R="${PG_USER:-postgres}"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
VOL="$NAME-data"; WALVOL="$NAME-wal"; HELPER="$NAME-helper"
cleanup() {
  local rc=$?
  docker rm -f "$HELPER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  # Başarısız geri yüklemede yarım kalan konteyner/volume BIRAKILMAZ (doğrulanmamış veriyle çalışan bir DB kalmasın, disk sızmasın).
  if [ "$rc" -ne 0 ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm -f "$VOL" "$WALVOL" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
log "yedek: $BK (mod: $MODE)"

# Konteynere dosya yazma: `docker cp` rootless Docker'da konak UID'sini konteynere chown etmeye çalışıp
# ("failed to Lchown ... invalid argument") başarısız olur — stdin ile akıtmak her kurulumda çalışır.
put() { docker exec -i "$1" sh -c "cat > '$3'" < "$2"; }

# İndirilen her dosyanın sha256'sı index.json'daki değerle karşılaştırılır (GCM etiketi ayrıca çözmede doğrulanır).
check_sha() {
  local f="$1" want
  want="$(node -e "console.log((JSON.parse(require('fs').readFileSync('$IDX','utf8')).files['$f']||{}).sha256||'')")"
  [ -n "$want" ] && [ "$(sha256sum "$BASE_DIR/$BK/$f" | cut -d' ' -f1)" = "$want" ] || fail "$f sha256 uyuşmuyor — yedek değiştirilmiş/bozulmuş."
}

wait_ready() {
  local tries="${1:-1800}"
  for _ in $(seq 1 "$tries"); do
    # Konteyner çöktüyse (örn. hedef zamana WAL arşivi yetmiyor: "recovery ended before configured recovery target") beklemeyi kes.
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
      docker logs --tail 25 "$NAME" >&2 || true
      fail "geri yükleme başarısız: Postgres kurtarma sırasında durdu (hedef zaman arşivlenmiş WAL'ın ötesinde olabilir — RPO penceresi)."
    fi
    if docker exec "$NAME" pg_isready -U "$PG_USER_R" -d "$2" >/dev/null 2>&1; then
      rec="$(docker exec "$NAME" psql -U "$PG_USER_R" -d "$2" -X -At -c 'SELECT pg_is_in_recovery()' 2>/dev/null || echo t)"
      [ "$rec" = "f" ] && return 0
    fi
    sleep 1
  done
  docker logs --tail 40 "$NAME" >&2 || true
  fail "geri yüklenen veritabanı $tries sn içinde hazır olmadı."
}

if [ "$MODE" = "pitr" ]; then
  check_sha base.tar.gz.enc
  "${CRYPTO[@]}" decrypt "$BASE_DIR/$BK/base.tar.gz.enc" "$WORK/base.tar.gz"
  docker volume create "$VOL" >/dev/null; docker volume create "$WALVOL" >/dev/null
  docker run -d --name "$HELPER" --network none -u root -v "$VOL:/restore/data" -v "$WALVOL:/restore/wal" "$IMAGE" sleep 86400 >/dev/null
  put "$HELPER" "$WORK/base.tar.gz" /tmp/base.tar.gz
  docker exec "$HELPER" sh -c 'tar -xzf /tmp/base.tar.gz -C /restore/data && rm -f /tmp/base.tar.gz'
  rm -f "$WORK/base.tar.gz"

  copied=0
  for enc in "$BACKUP_DEST_DIR"/wal/*.enc; do
    [ -e "$enc" ] || continue
    seg="$(basename "$enc" .enc)"
    # Yalnızca taban yedeğin başlangıç segmentinden SONRAKİ segmentler (ve zaman çizgisi .history dosyaları) gerekir.
    if [[ "$seg" =~ ^[0-9A-F]{24}$ ]] && [[ "$seg" < "$START_WAL" ]]; then continue; fi
    "${CRYPTO[@]}" decrypt "$enc" "$WORK/$seg"
    put "$HELPER" "$WORK/$seg" "/restore/wal/$seg"; rm -f "$WORK/$seg"; copied=$((copied + 1))
  done
  log "$copied WAL segmenti doğrulanıp yüklendi"

  if [ "$TARGET_TIME" = "latest" ]; then TARGET_LINE="# hedef yok: arşivin sonuna kadar"; else TARGET_LINE="recovery_target_time = '$TARGET_TIME'"; fi
  docker exec "$HELPER" sh -c "chown -R 70:70 /restore/data /restore/wal && chmod 700 /restore/data && touch /restore/data/recovery.signal && cat >> /restore/data/postgresql.auto.conf <<'CONF'
restore_command = 'cp /restore/wal/%f %p'
recovery_target_action = 'promote'
$TARGET_LINE
CONF
chown 70:70 /restore/data/postgresql.auto.conf"
  docker rm -f "$HELPER" >/dev/null
  docker run -d --name "$NAME" --network none -v "$VOL:/var/lib/postgresql/data" -v "$WALVOL:/restore/wal" "$IMAGE" >/dev/null
  wait_ready 1800 "$PG_DB_NAME"
else
  check_sha dump.custom.enc; check_sha globals.sql.enc
  "${CRYPTO[@]}" decrypt "$BASE_DIR/$BK/dump.custom.enc" "$WORK/dump.custom"
  "${CRYPTO[@]}" decrypt "$BASE_DIR/$BK/globals.sql.enc" "$WORK/globals.sql"
  docker volume create "$VOL" >/dev/null
  docker run -d --name "$NAME" --network none -e POSTGRES_PASSWORD=restore-only -e POSTGRES_USER="$PG_USER_R" -e POSTGRES_DB=postgres -v "$VOL:/var/lib/postgresql/data" "$IMAGE" >/dev/null
  for _ in $(seq 1 120); do docker exec "$NAME" pg_isready -U "$PG_USER_R" >/dev/null 2>&1 && sleep 2 && docker exec "$NAME" pg_isready -U "$PG_USER_R" >/dev/null 2>&1 && break; sleep 1; done
  put "$NAME" "$WORK/globals.sql" /tmp/globals.sql
  put "$NAME" "$WORK/dump.custom" /tmp/dump.custom
  # globals'taki `CREATE ROLE postgres` zaten var olduğundan hata verir (beklenen); ON_ERROR_STOP kullanılmaz.
  docker exec "$NAME" psql -U "$PG_USER_R" -d postgres -X -q -f /tmp/globals.sql >/dev/null 2>&1 || true
  docker exec "$NAME" psql -U "$PG_USER_R" -d postgres -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$PG_DB_NAME\""
  docker exec "$NAME" pg_restore -U "$PG_USER_R" -d "$PG_DB_NAME" --exit-on-error /tmp/dump.custom
  docker exec "$NAME" rm -f /tmp/dump.custom /tmp/globals.sql
fi

SECONDS_TOTAL=$(( $(date +%s) - START_EPOCH ))
echo "{\"container\":\"$NAME\",\"volume\":\"$VOL\",\"walVolume\":\"$WALVOL\",\"backup\":\"$BK\",\"mode\":\"$MODE\",\"database\":\"$PG_DB_NAME\",\"user\":\"$PG_USER_R\",\"seconds\":$SECONDS_TOTAL}"
