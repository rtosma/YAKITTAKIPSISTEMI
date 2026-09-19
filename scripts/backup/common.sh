#!/usr/bin/env bash
# ==============================================================================
# OPS-1106 — yedek/geri yükleme betikleri için ortak yapılandırma ve yardımcılar (source edilir).
#
# Yapılandırma (ortam değişkenleri; cron için BACKUP_ENV=/etc/yakittakip/backup.env dosyası da okunur):
#   BACKUP_DEST_DIR              ZORUNLU — AYRI konum (uzak depolama bağlama noktası veya ayrı disk). Yalnızca ŞİFRELİ dosyalar yazılır.
#   BACKUP_ENCRYPTION_KEY[_FILE] ZORUNLU — 64 hex (scripts/lib/backupCrypto.mjs genkey). Yedek konumunda BULUNMAZ.
#   PG_CONTAINER                 varsayılan: `docker compose ps -q postgres`
#   PG_USER / PG_DB              varsayılan: konteynerin POSTGRES_USER / POSTGRES_DB değişkenleri
#   PG_IMAGE                     geri yükleme imajı (varsayılan: kaynak konteynerin imajı, yoksa postgres:16-alpine)
#   WAL_ARCHIVE_DIR              konteyner içi arşiv dizini (varsayılan /wal_archive)
#   BACKUP_RETENTION_DAYS        varsayılan 14
#   BACKUP_UPLOAD_CMD            isteğe bağlı: yedek sonrası çalışan kanca (örn. rclone sync "$BACKUP_DEST_DIR" uzak:kova)
#   RPO_TARGET_SECONDS (900) / RTO_TARGET_SECONDS (14400) / WAL_ARCHIVE_TIMEOUT_SECONDS (300) / WAL_SHIP_INTERVAL_SECONDS (300)
# ==============================================================================
set -euo pipefail

BK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -n "${BACKUP_ENV:-}" ] && [ -f "$BACKUP_ENV" ] && { set -a; . "$BACKUP_ENV"; set +a; }

CRYPTO=(node "$BK_ROOT/scripts/lib/backupCrypto.mjs")
TOOLS=(node "$BK_ROOT/scripts/lib/backupTools.mjs")
WAL_DIR="${WAL_ARCHIVE_DIR:-/wal_archive}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
RPO_TARGET_SECONDS="${RPO_TARGET_SECONDS:-900}"
RTO_TARGET_SECONDS="${RTO_TARGET_SECONDS:-14400}"
WAL_ARCHIVE_TIMEOUT_SECONDS="${WAL_ARCHIVE_TIMEOUT_SECONDS:-300}"
WAL_SHIP_INTERVAL_SECONDS="${WAL_SHIP_INTERVAL_SECONDS:-300}"

log()  { echo "[$(basename "${0:-backup}")] $*" >&2; }
fail() { echo "[$(basename "${0:-backup}")] HATA: $*" >&2; exit 1; }

require_dest() {
  : "${BACKUP_DEST_DIR:?BACKUP_DEST_DIR tanımlı değil (AYRI yedek konumu zorunlu)}"
  mkdir -p "$BACKUP_DEST_DIR"
  [ -n "${BACKUP_ENCRYPTION_KEY:-}${BACKUP_ENCRYPTION_KEY_FILE:-}" ] || fail "BACKUP_ENCRYPTION_KEY (veya _FILE) tanımlı değil — şifresiz yedek ALINMAZ."
}

require_source() {
  require_dest
  command -v docker >/dev/null 2>&1 || fail "docker bulunamadı."
  PG_CONTAINER="${PG_CONTAINER:-$(cd "$BK_ROOT" && docker compose ps -q postgres 2>/dev/null | head -1 || true)}"
  [ -n "$PG_CONTAINER" ] || fail "postgres konteyneri bulunamadı (PG_CONTAINER verin veya 'docker compose up -d')."
  PG_USER="${PG_USER:-$(docker exec "$PG_CONTAINER" printenv POSTGRES_USER)}"
  PG_DB="${PG_DB:-$(docker exec "$PG_CONTAINER" printenv POSTGRES_DB)}"
  PG_IMAGE="${PG_IMAGE:-$(docker inspect -f '{{.Config.Image}}' "$PG_CONTAINER")}"
}

# Kaynak DB'de sorgu (superuser → RLS'i atlar; yedek/sayım tüm tenant'ları kapsar).
psql_src() { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -X -At "$@"; }

# Tablo başına (satır sayısı | id-md5) — aynı SQL kaynakta (manifest) ve geri yüklenen DB'de (doğrulama) kullanılır.
# $1=konteyner $2=kullanıcı $3=veritabanı $4=(isteğe bağlı) pg_export_snapshot kimliği
table_stats() {
  local c="$1" u="$2" d="$3" snap="${4:-}" gen sql pre=""
  gen="SELECT string_agg(format('SELECT %L AS tbl, count(*)::bigint AS n, %s AS h FROM %I.%I', c.relname, CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = n.nspname AND k.table_name = c.relname AND k.column_name = 'id') THEN 'md5(COALESCE(string_agg(id::text, '','' ORDER BY id::text), ''''))' ELSE 'NULL::text' END, n.nspname, c.relname), ' UNION ALL ' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname = 'public'"
  sql=$(docker exec "$c" psql -U "$u" -d "$d" -v ON_ERROR_STOP=1 -X -At -c "$gen")
  [ -n "$sql" ] || { echo '{}'; return; }
  if [ -n "$snap" ]; then pre="BEGIN ISOLATION LEVEL REPEATABLE READ; SET TRANSACTION SNAPSHOT '$snap';"; fi
  docker exec -i "$c" psql -U "$u" -d "$d" -v ON_ERROR_STOP=1 -X -At -q -F'|' <<<"${pre}${sql};" | "${TOOLS[@]}" stats-json
}
