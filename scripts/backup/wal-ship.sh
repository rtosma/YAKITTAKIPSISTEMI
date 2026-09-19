#!/usr/bin/env bash
# ==============================================================================
# OPS-1106 — Sürekli WAL arşivini AYRI yedek konumuna, ŞİFRELİ olarak taşır (cron: her 5 dk).
#
# Postgres archive_command'ı segmentleri konteynerdeki `wal_archive` volume'una atomik yazar
# (docker-compose.backup.yml). Bu betik her yeni segmenti gzip + AES-256-GCM ile şifreler, ŞİFRESİ
# ÇÖZÜLEREK doğrulandıktan SONRA yedek konumuna alır ve ancak o zaman volume'dan siler (veri kaybı
# penceresi yok; gönderim başarısızsa segment yerinde kalır ve bir sonraki turda yeniden denenir).
# İdempotent: konumda zaten olan segment yalnızca volume'dan temizlenir.
# `DEST/wal/.heartbeat` her başarılı turda güncellenir — RPO ölçümü ve alarm (OPS-1108) bunu kullanır.
# Çıkış: 0 başarılı; 1 hata; 2 geri kalan (gönderilemeyen) segment var.
# ==============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require_source
mkdir -p "$BACKUP_DEST_DIR/wal"
WORK="$(mktemp -d)"; chmod 700 "$WORK"; trap 'rm -rf "$WORK"' EXIT

shipped=0; failed=0
mapfile -t FILES < <(docker exec "$PG_CONTAINER" sh -c "ls -1 '$WAL_DIR' 2>/dev/null | grep -v '\.tmp\$' | sort" || true)
for f in "${FILES[@]}"; do
  [ -n "$f" ] || continue
  target="$BACKUP_DEST_DIR/wal/$f.enc"
  if [ ! -f "$target" ]; then
    if docker cp "$PG_CONTAINER:$WAL_DIR/$f" "$WORK/$f" >/dev/null \
       && "${CRYPTO[@]}" encrypt --gzip "$WORK/$f" "$target.tmp" \
       && "${CRYPTO[@]}" verify "$target.tmp" \
       && mv "$target.tmp" "$target"; then
      shipped=$((shipped + 1))
    else
      log "UYARI: $f gönderilemedi — volume'da kalıyor, sonraki turda yeniden denenecek."
      rm -f "$target.tmp" "$WORK/$f"; failed=$((failed + 1)); continue
    fi
    rm -f "$WORK/$f"
  fi
  docker exec "$PG_CONTAINER" rm -f "$WAL_DIR/$f"
done

if [ "$failed" -eq 0 ]; then date +%s > "$BACKUP_DEST_DIR/wal/.heartbeat"; fi
log "$shipped segment gönderildi, $failed başarısız."
[ "$failed" -eq 0 ] || exit 2
