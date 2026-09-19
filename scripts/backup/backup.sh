#!/usr/bin/env bash
# ==============================================================================
# OPS-1106 — Günlük TAM yedek (cron: günde 1, örn. 02:15). AC: "günlük otomatik yedek, şifreli".
#
# Bir yedek = { globals.sql (roller), dump.custom (pg_dump -Fc, mantıksal), base.tar.gz (pg_basebackup, fiziksel),
#               manifest (tablo başına satır sayısı + id-md5) } — hepsi AES-256-GCM ile ŞİFRELENİR, AYRI konuma
# (BACKUP_DEST_DIR) yazılır; yalnızca `index.json` (zaman damgası, WAL aralığı, dosya boyut/sha256 — VERİ yok) açıktır.
#  - base.tar.gz + sürekli WAL arşivi → belirli ana geri dönüş (PITR) ve tam felaket kurtarma.
#  - dump.custom → tek tablo/mantıksal geri yükleme ve platformlar arası taşınabilirlik.
# Sayım manifesti ile pg_dump AYNI anlık görüntüde (pg_export_snapshot) alınır: canlı yazma olsa da restore doğrulaması kesin eşitlik arar.
#
# Yedek tamamlanmadan `index.json` YAZILMAZ (yarım yedek geri yüklenemez/seçilemez); yazıldıktan sonra tüm dosyalar
# şifre çözme (GCM etiketi) + sha256 ile DOĞRULANIR. Ardından retansiyon budaması ve isteğe bağlı BACKUP_UPLOAD_CMD.
# ==============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_source

TS="$(date -u +%Y%m%dT%H%M%SZ)"
STARTED_EPOCH="$(date +%s)"
STARTED_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
FINAL="$BACKUP_DEST_DIR/base/$TS"; PART="$FINAL.partial"
mkdir -p "$PART"
cleanup() {
  psql_src -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'yk-backup-snapshot'" >/dev/null 2>&1 || true
  docker exec "$PG_CONTAINER" rm -rf /tmp/yk-bb >/dev/null 2>&1 || true
  rm -rf "$WORK"
  if [ -d "$PART" ]; then rm -rf "$PART"; fi
}
trap cleanup EXIT

log "1/7 — anlık görüntü (snapshot) açılıyor (pg_dump + sayım manifesti aynı andaki veriyi görsün)"
docker exec -i -e PGAPPNAME=yk-backup-snapshot "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -X -At -q -v ON_ERROR_STOP=1 \
  > "$WORK/snap" 2>"$WORK/snap.err" <<<"BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT pg_export_snapshot(); SELECT pg_sleep(1500);" &
SNAP=""
for _ in $(seq 1 60); do
  SNAP="$(head -1 "$WORK/snap" 2>/dev/null || true)"; [ -n "$SNAP" ] && break; sleep 0.5
done
[ -n "$SNAP" ] || fail "snapshot alınamadı: $(cat "$WORK/snap.err" 2>/dev/null)"

log "2/7 — roller (globals), mantıksal döküm ve tablo manifesti"
docker exec "$PG_CONTAINER" pg_dumpall -U "$PG_USER" --globals-only > "$WORK/globals.sql"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc --snapshot="$SNAP" > "$WORK/dump.custom"
table_stats "$PG_CONTAINER" "$PG_USER" "$PG_DB" "$SNAP" > "$WORK/manifest.json"
psql_src -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'yk-backup-snapshot'" >/dev/null 2>&1 || true

log "3/7 — fiziksel taban yedek (pg_basebackup) — PITR için"
docker exec "$PG_CONTAINER" sh -c "rm -rf /tmp/yk-bb && pg_basebackup -U '$PG_USER' -D /tmp/yk-bb -Ft -z -X none --checkpoint=fast -l 'yk-$TS'"
docker cp "$PG_CONTAINER:/tmp/yk-bb/base.tar.gz" "$WORK/base.tar.gz" >/dev/null
docker exec "$PG_CONTAINER" rm -rf /tmp/yk-bb
START_WAL="$(tar -xzOf "$WORK/base.tar.gz" backup_label | sed -n 's/^START WAL LOCATION:.*(file \([0-9A-F]\{24\}\)).*/\1/p')"
[ -n "$START_WAL" ] || fail "backup_label'dan START WAL okunamadı."

log "4/7 — taban yedeğin gerektirdiği WAL arşivlenene kadar bekleniyor (başlangıç: $START_WAL)"
psql_src -c "SELECT pg_switch_wal()" >/dev/null
for _ in $(seq 1 240); do
  pending="$(psql_src -c "SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'")"
  [ "$pending" = "0" ] && break; sleep 1
done
[ "${pending:-1}" = "0" ] || fail "WAL arşivi 240 sn içinde boşalmadı (archive_command çalışıyor mu? docker-compose.backup.yml etkin mi?)."
WAL_UNTIL="$(psql_src -c "SELECT last_archived_wal FROM pg_stat_archiver")"
"$(dirname "${BASH_SOURCE[0]}")/wal-ship.sh"

log "5/7 — şifreleme (AES-256-GCM) ve ayrı konuma yazma"
"${CRYPTO[@]}" encrypt --gzip "$WORK/globals.sql" "$PART/globals.sql.enc"
"${CRYPTO[@]}" encrypt "$WORK/dump.custom" "$PART/dump.custom.enc"
"${CRYPTO[@]}" encrypt "$WORK/base.tar.gz" "$PART/base.tar.gz.enc"
"${CRYPTO[@]}" encrypt --gzip "$WORK/manifest.json" "$PART/manifest.json.enc"
DB_BYTES="$(psql_src -c "SELECT pg_database_size(current_database())")"
PG_VERSION="$(psql_src -c "SHOW server_version")"
FINISHED_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
files_json="{"; first=1
for f in globals.sql.enc dump.custom.enc base.tar.gz.enc manifest.json.enc; do
  sum="$(sha256sum "$PART/$f" | cut -d' ' -f1)"; bytes="$(stat -c %s "$PART/$f")"
  [ $first -eq 1 ] || files_json+=","; first=0
  files_json+="\"$f\":{\"sha256\":\"$sum\",\"bytes\":$bytes}"
done
files_json+="}"
cat > "$PART/index.json" <<JSON
{"format":1,"timestamp":"$TS","startedAt":"$STARTED_ISO","finishedAt":"$FINISHED_ISO","pgVersion":"$PG_VERSION","database":"$PG_DB","dbSizeBytes":$DB_BYTES,"startWal":"$START_WAL","walArchivedUntil":"$WAL_UNTIL","encrypted":true,"cipher":"AES-256-GCM","files":$files_json}
JSON

log "6/7 — bütünlük doğrulaması (sha256 + GCM etiketi)"
for f in globals.sql.enc dump.custom.enc base.tar.gz.enc manifest.json.enc; do
  want="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PART/index.json','utf8')).files['$f'].sha256)")"
  [ "$(sha256sum "$PART/$f" | cut -d' ' -f1)" = "$want" ] || fail "$f sha256 uyuşmuyor."
  "${CRYPTO[@]}" verify "$PART/$f"
done
mv "$PART" "$FINAL"; trap - EXIT; rm -rf "$WORK"

log "7/7 — retansiyon ($RETENTION_DAYS gün; en az 2 yedek korunur) ve yükleme kancası"
mapfile -t BASES < <(ls -1 "$BACKUP_DEST_DIR/base" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort)
cutoff="$(date -u -d "-$RETENTION_DAYS days" +%Y%m%dT%H%M%SZ)"
keep_from=$(( ${#BASES[@]} - 2 )); i=0
for b in "${BASES[@]}"; do
  if [ "$b" \< "$cutoff" ] && [ $i -lt $keep_from ]; then rm -rf "$BACKUP_DEST_DIR/base/$b"; log "eski yedek silindi: $b"; fi
  i=$((i + 1))
done
OLDEST="$(ls -1 "$BACKUP_DEST_DIR/base" | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | head -1)"
OLDEST_WAL="$("${TOOLS[@]}" index-field "$BACKUP_DEST_DIR/base/$OLDEST/index.json" startWal)"
for w in "$BACKUP_DEST_DIR"/wal/*.enc; do
  [ -e "$w" ] || continue; name="$(basename "$w" .enc)"
  if [[ "$name" =~ ^[0-9A-F]{24}$ ]] && [[ "$name" < "$OLDEST_WAL" ]]; then rm -f "$w"; fi
done
date +%s > "$BACKUP_DEST_DIR/base/.last_ok"
if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then log "yükleme kancası çalıştırılıyor"; BACKUP_DEST_DIR="$BACKUP_DEST_DIR" bash -c "$BACKUP_UPLOAD_CMD"; fi
DURATION=$(( $(date +%s) - STARTED_EPOCH ))
echo "{\"backup\":\"$TS\",\"startWal\":\"$START_WAL\",\"dbSizeBytes\":$DB_BYTES,\"durationSeconds\":$DURATION}"
