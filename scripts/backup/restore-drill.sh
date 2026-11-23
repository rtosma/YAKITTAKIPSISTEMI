#!/usr/bin/env bash
# ==============================================================================
# OPS-1106 — RESTORE TATBİKATI: "Test edilmemiş yedek, yedek sayılmaz."
#
# Yedek konumundan (üretim sunucusundan BAĞIMSIZ, temiz Docker ortamına) İKİ yolla geri yükler, veriyi doğrular,
# SÜRELERİ ölçer, RPO/RTO hedefleriyle karşılaştırır ve dokümante eder (docs/restore-drills/<tarih>.md).
#   1. dump yolu : pg_restore → manifestle KESİN eşitlik (tablo başına satır sayısı + id-md5).
#   2. PITR yolu : taban yedek + tüm WAL arşivi (latest) → veritabanı açılır, tüm tablolar okunur, satır sayısı manifestin
#                  altına DÜŞMEZ (yedekten sonraki WAL yazmaları sayıyı artırabilir; azalması veri kaybıdır).
# RTO = PITR yolunun (birincil felaket kurtarma yolu) ölçülen geri yükleme + doğrulama süresi. RPO = son başarılı WAL gönderiminden
# bu yana geçen süre + archive_timeout (en kötü durumda kaybedilecek pencere).
# Çeyrekte en az bir kez çalıştırın (cron: deploy/cron/yakittakip-backup.cron). Çıkış 0: doğrulama + hedefler tamam; 1: başarısız.
#
# Kullanım: BACKUP_DEST_DIR=... BACKUP_ENCRYPTION_KEY=... scripts/backup/restore-drill.sh [--report yol.md] [--label "staging"]
# ==============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_dest

REPORT="$BK_ROOT/docs/restore-drills/$(date -u +%Y-%m-%d).md"; LABEL="${DRILL_ENV:-bilinmiyor}"
while [ $# -gt 0 ]; do
  case "$1" in --report) REPORT="$2"; shift 2 ;; --label) LABEL="$2"; shift 2 ;; *) fail "bilinmeyen argüman: $1" ;; esac
done
WORK="$(mktemp -d)"; chmod 700 "$WORK"
CREATED=()
cleanup() {
  for c in "${CREATED[@]:-}"; do [ -n "$c" ] && { docker rm -f "$c" >/dev/null 2>&1 || true; docker volume rm -f "$c-data" "$c-wal" >/dev/null 2>&1 || true; }; done
  rm -rf "$WORK"
}
trap cleanup EXIT

DRILL_START="$(date +%s)"; DRILL_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BK="$("${TOOLS[@]}" pick-base "$BACKUP_DEST_DIR/base" latest)"
IDX="$BACKUP_DEST_DIR/base/$BK/index.json"
DB_BYTES="$("${TOOLS[@]}" index-field "$IDX" dbSizeBytes)"
FINISHED="$("${TOOLS[@]}" index-field "$IDX" finishedAt)"
BACKUP_AGE=$(( DRILL_START - $(date -d "$FINISHED" +%s) ))
"${CRYPTO[@]}" decrypt "$BACKUP_DEST_DIR/base/$BK/manifest.json.enc" "$WORK/manifest.json"
FAILS=()

verify_stats() { # $1=konteyner $2=kullanıcı $3=db $4=mod
  local out="$WORK/restored-$4.json"
  table_stats "$1" "$2" "$3" > "$out"
  "${TOOLS[@]}" compare "$WORK/manifest.json" "$out" "$4"
}

log "1/2 — dump yolu (mantıksal) geri yükleme"
T0=$(date +%s)
R1="$("$(dirname "${BASH_SOURCE[0]}")/restore.sh" --mode dump --backup "$BK" | tail -1)"
C1="$(node -pe "JSON.parse(process.argv[1]).container" "$R1")"; CREATED+=("$C1")
U1="$(node -pe "JSON.parse(process.argv[1]).user" "$R1")"; D1="$(node -pe "JSON.parse(process.argv[1]).database" "$R1")"
if V1="$(verify_stats "$C1" "$U1" "$D1" exact 2>&1)"; then V1_OK=1; else V1_OK=0; FAILS+=("dump doğrulaması: $V1"); fi
DUMP_SECONDS=$(( $(date +%s) - T0 ))
docker rm -f "$C1" >/dev/null 2>&1 || true

log "2/2 — PITR yolu (taban yedek + WAL arşivi → latest) geri yükleme"
T0=$(date +%s)
R2="$("$(dirname "${BASH_SOURCE[0]}")/restore.sh" --mode pitr --backup "$BK" --target-time latest | tail -1)"
C2="$(node -pe "JSON.parse(process.argv[1]).container" "$R2")"; CREATED+=("$C2")
U2="$(node -pe "JSON.parse(process.argv[1]).user" "$R2")"; D2="$(node -pe "JSON.parse(process.argv[1]).database" "$R2")"
if V2="$(verify_stats "$C2" "$U2" "$D2" atleast 2>&1)"; then V2_OK=1; else V2_OK=0; FAILS+=("PITR doğrulaması: $V2"); fi
PITR_SECONDS=$(( $(date +%s) - T0 ))

# RPO: son başarılı WAL gönderimi + archive_timeout (en kötü durumda kaybedilecek pencere)
HB=0; [ -f "$BACKUP_DEST_DIR/wal/.heartbeat" ] && HB="$(cat "$BACKUP_DEST_DIR/wal/.heartbeat")"
if [ "$HB" -gt 0 ]; then WAL_LAG=$(( $(date +%s) - HB )); else WAL_LAG=-1; fi
if [ "$WAL_LAG" -ge 0 ]; then RPO_OBSERVED=$(( WAL_LAG + WAL_ARCHIVE_TIMEOUT_SECONDS )); else RPO_OBSERVED=-1; fi
RPO_DESIGN=$(( WAL_ARCHIVE_TIMEOUT_SECONDS + WAL_SHIP_INTERVAL_SECONDS ))
RTO="$PITR_SECONDS"
[ "$V1_OK" = 1 ] && [ "$V2_OK" = 1 ] || true
[ "$RPO_OBSERVED" -ge 0 ] && [ "$RPO_OBSERVED" -le "$RPO_TARGET_SECONDS" ] || FAILS+=("RPO hedefi karşılanmıyor: gözlenen ${RPO_OBSERVED}s, hedef ${RPO_TARGET_SECONDS}s (WAL gönderimi durmuş olabilir).")
[ "$RTO" -le "$RTO_TARGET_SECONDS" ] || FAILS+=("RTO hedefi aşıldı: ${RTO}s > ${RTO_TARGET_SECONDS}s.")
[ "$RPO_DESIGN" -le "$RPO_TARGET_SECONDS" ] || FAILS+=("Tasarım RPO'su (archive_timeout + gönderim aralığı = ${RPO_DESIGN}s) hedefi aşıyor.")

MB=$(( DB_BYTES / 1048576 )); [ "$MB" -ge 1 ] || MB=1
RATE=$(awk -v mb="$MB" -v s="$(( PITR_SECONDS > 0 ? PITR_SECONDS : 1 ))" 'BEGIN{printf "%.2f", mb/s}')
proj() { awk -v gb="$1" -v r="$RATE" 'BEGIN{printf "%d", (gb*1024)/r/60}'; }
RESULT="BAŞARILI"; [ ${#FAILS[@]} -eq 0 ] || RESULT="BAŞARISIZ"

mkdir -p "$(dirname "$REPORT")"
{
  echo "# Restore Tatbikatı — $(date -u +%Y-%m-%d)"
  echo
  echo "**Sonuç: $RESULT** · Ortam/etiket: \`$LABEL\` · Yapan: \`$(whoami)@$(hostname)\` · Başlangıç: $DRILL_ISO"
  echo
  echo "## Girdi"
  echo "- Kullanılan yedek: \`$BK\` (tamamlanma: $FINISHED, tatbikat anında yaşı: $((BACKUP_AGE / 60)) dk)"
  echo "- Veritabanı boyutu: $MB MB · Yedek konumu: ayrı depo (yalnızca şifreli dosyalar; anahtar depoda YOK)"
  echo "- Geri yükleme ortamı: temiz Docker konteyneri (\`--network none\`), üretim sunucusundan bağımsız"
  echo
  echo "## Ölçümler"
  echo "| Yol | Süre | Doğrulama |"
  echo "|---|---|---|"
  echo "| dump (mantıksal, pg_restore) | ${DUMP_SECONDS} sn | $([ "$V1_OK" = 1 ] && echo "tablo başına satır sayısı + id-md5 KESİN eşit" || echo "BAŞARISIZ") |"
  echo "| PITR (taban yedek + WAL, latest) | ${PITR_SECONDS} sn | $([ "$V2_OK" = 1 ] && echo "açıldı, tüm tablolar okundu, satır sayıları ≥ yedek anı" || echo "BAŞARISIZ") |"
  echo
  echo "## Hedefler"
  echo "| Hedef | Değer | Ölçülen | Durum |"
  echo "|---|---|---|---|"
  echo "| RTO | ≤ ${RTO_TARGET_SECONDS} sn ($((RTO_TARGET_SECONDS / 3600)) sa) | ${RTO} sn (PITR geri yükleme + doğrulama) | $([ "$RTO" -le "$RTO_TARGET_SECONDS" ] && echo KARŞILANDI || echo AŞILDI) |"
  echo "| RPO (gözlenen) | ≤ ${RPO_TARGET_SECONDS} sn ($((RPO_TARGET_SECONDS / 60)) dk) | $([ "$RPO_OBSERVED" -ge 0 ] && echo "${RPO_OBSERVED} sn (son WAL gönderimi ${WAL_LAG} sn önce + archive_timeout ${WAL_ARCHIVE_TIMEOUT_SECONDS} sn)" || echo "heartbeat YOK") | $([ "$RPO_OBSERVED" -ge 0 ] && [ "$RPO_OBSERVED" -le "$RPO_TARGET_SECONDS" ] && echo KARŞILANDI || echo AŞILDI) |"
  echo "| RPO (tasarım) | ≤ ${RPO_TARGET_SECONDS} sn | ${RPO_DESIGN} sn (archive_timeout ${WAL_ARCHIVE_TIMEOUT_SECONDS} + gönderim aralığı ${WAL_SHIP_INTERVAL_SECONDS}) | $([ "$RPO_DESIGN" -le "$RPO_TARGET_SECONDS" ] && echo KARŞILANDI || echo AŞILDI) |"
  echo
  echo "## Boyut ekstrapolasyonu"
  echo "Bu tatbikatta geri yükleme hızı ≈ ${RATE} MB/sn (küçük veri seti; sabit maliyetler — konteyner başlatma, WAL yeniden oynatma — süreyi baskılar). Doğrusal tahmin: 10 GB ≈ $(proj 10) dk, 100 GB ≈ $(proj 100) dk. Üretim boyutuna ulaşıldığında tatbikat ÜRETİM BOYUTUNDA tekrarlanmalı ve bu tablo güncellenmelidir."
  if [ ${#FAILS[@]} -gt 0 ]; then echo; echo "## Başarısızlıklar"; for f in "${FAILS[@]}"; do echo "- $f"; done; fi
} > "$REPORT"

log "rapor yazıldı: $REPORT"
echo "{\"result\":\"$RESULT\",\"backup\":\"$BK\",\"dumpSeconds\":$DUMP_SECONDS,\"pitrSeconds\":$PITR_SECONDS,\"rpoObservedSeconds\":$RPO_OBSERVED,\"rtoSeconds\":$RTO}"
[ ${#FAILS[@]} -eq 0 ] || { for f in "${FAILS[@]}"; do echo "$f" >&2; done; exit 1; }
