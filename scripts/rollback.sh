#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# OPS-1110 — Tek komutla ÖNCEKİ sürüme geri alma (zero-downtime)
# ==============================================================================
#
#   ./scripts/rollback.sh                    # bir önceki (farklı) sürüme
#   ./scripts/rollback.sh v1.4.2             # kayıtlı belirli bir sürüme
#   ./scripts/rollback.sh --accept-schema-risk [sürüm]   # aşağıya bakın
#   ./scripts/rollback.sh --list             # kayıtlı sürümler (yalnızca listeler)
#
# Nasıl çalışır: zero-downtime-deploy.sh her başarılı dağıtımda imajı
# `$RELEASE_IMAGE_REPO:<sürüm>` olarak etiketler ve $RELEASE_LOG'a yazar. Rollback
# YENİDEN DERLEMEZ (dakikalar sürer ve o anda kaynak kod ağacına bağımlıdır):
# kayıtlı imajı Compose'un backend imajı olarak yeniden etiketler ve AYNI
# blue/green mekanizmasını (SKIP_BUILD=1 SKIP_SCHEMA=1) çalıştırır — yani geri alma
# da sıfır kesintili, readiness doğrulamalı ve drain'lidir. Süre, sonda ölçülüp yazılır.
#
# MİGRASYON GERİ ALMA POLİTİKASI (sınır):
#   * Şema HİÇBİR ZAMAN otomatik geri alınmaz. schema.sql expand-only'dir (OPS-1104:
#     check-migration-safety.mjs) — yeni sütun/tablo/indeks eski kodu bozmaz; bu yüzden
#     ÖNCEKİ UYGULAMA sürümü güncel şemayla çalışır. Geri alma = yalnızca UYGULAMA.
#   * İki sürüm arasında ONAYLI bir contract adımı (`-- MIGRATION-CONTRACT:`; DROP/RENAME/
#     NOT NULL...) varsa uygulama-yalnız geri alma GÜVENSİZDİR: betik REDDEDER (çıkış 3).
#     Seçenekler: (a) ileri düzeltme (hotfix), (b) veritabanını yedekten geri yükleme
#     (docs/BACKUP_RESTORE.md — veri kaybı penceresi RPO ile sınırlı), (c) sonucu bilerek
#     kabul ediyorsanız --accept-schema-risk. Şema bilgisi çözülemezse de aynı şekilde reddedilir.
#   * Geri alma veri geri almaz: yeni sürümün ürettiği veriler (kayıtlar/ikmaller) korunur.
# ==============================================================================

readonly RELEASE_LOG="${RELEASE_LOG:-.deploy/releases.log}"
readonly RELEASE_IMAGE_REPO="${RELEASE_IMAGE_REPO:-yakittakip-backend-release}"
readonly SCHEMA_REL="backend/src/db/schema.sql"

log()  { echo "[rollback] $*"; }
fail() { echo "[rollback] HATA: $*" >&2; exit "${2:-1}"; }

ACCEPT_RISK=0
TARGET=""
LIST=0
for a in "$@"; do
  case "$a" in
    --accept-schema-risk) ACCEPT_RISK=1 ;;
    --list) LIST=1 ;;
    -*) fail "bilinmeyen seçenek: $a" ;;
    *) [ -z "$TARGET" ] || fail "yalnızca tek bir hedef sürüm verilebilir."; TARGET="$a" ;;
  esac
done

command -v docker >/dev/null 2>&1 || fail "docker bulunamadı."
[ -s "$RELEASE_LOG" ] || fail "$RELEASE_LOG boş/yok — bu sunucuda henüz kayıtlı bir dağıtım yok (geri alınacak sürüm bilinmiyor)."

if [ "$LIST" = "1" ]; then
  log "Kayıtlı sürümler (yeniden eskiye) — zaman | tür | sürüm | git-sha | süre:"
  awk -F'\t' '{printf "  %s | %s | %s | %.10s | %ss\n",$1,$2,$3,$4,$7}' "$RELEASE_LOG" | tac
  exit 0
fi

CURRENT=$(tail -n 1 "$RELEASE_LOG" | cut -f3)
CURRENT_SHA=$(tail -n 1 "$RELEASE_LOG" | cut -f4)
if [ -z "$TARGET" ]; then
  # "Önceki" = kayıtta güncelden FARKLI en son sürüm.
  TARGET=$(awk -F'\t' -v cur="$CURRENT" '$3!=cur{v=$3} END{print v}' "$RELEASE_LOG")
  [ -n "$TARGET" ] || fail "Geri dönülecek önceki (farklı) bir sürüm kayıtlı değil."
fi
[ "$TARGET" != "$CURRENT" ] || fail "Hedef sürüm ($TARGET) zaten çalışan sürüm."
TARGET_SHA=$(awk -F'\t' -v t="$TARGET" '$3==t{s=$4} END{print s}' "$RELEASE_LOG")
[ -n "$TARGET_SHA" ] || fail "'$TARGET' sürümü $RELEASE_LOG içinde kayıtlı değil (--list ile bakın)."
docker image inspect "${RELEASE_IMAGE_REPO}:${TARGET}" >/dev/null 2>&1 \
  || fail "'${RELEASE_IMAGE_REPO}:${TARGET}' imajı yerelde yok (son sürümlerin dışında kalıp temizlenmiş olabilir) — bu sürüme yalnızca kaynaktan yeniden dağıtımla (git checkout + zero-downtime-deploy.sh) dönülebilir."
log "Geri alma: $CURRENT → $TARGET"

# --- Migrasyon güvenlik kapısı ------------------------------------------------
# Hedef sürümün schema.sql'i ile ŞU AN çalışanın schema.sql'i karşılaştırılır (git'ten). Aradaki
# HER contract ifadesi → uygulama-yalnız geri alma güvensiz. Çözülemezse muhafazakâr davranılır.
SCHEMA_RISK=""
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if git show "${TARGET_SHA}:${SCHEMA_REL}" > "$tmp/old.sql" 2>/dev/null && git show "${CURRENT_SHA}:${SCHEMA_REL}" > "$tmp/new.sql" 2>/dev/null; then
  rc=0
  node scripts/check-migration-safety.mjs --old "$tmp/old.sql" --new "$tmp/new.sql" --strict || rc=$?
  if [ "$rc" = "3" ]; then SCHEMA_RISK="aradaki şema değişiklikleri geri dönüşsüz (contract) ifade içeriyor"
  elif [ "$rc" != "0" ]; then SCHEMA_RISK="şema karşılaştırması çalıştırılamadı (çıkış $rc)"; fi
else
  SCHEMA_RISK="git geçmişinde $TARGET_SHA / $CURRENT_SHA şema sürümleri bulunamadı (sığ klon?) — şema uyumu doğrulanamadı"
fi
if [ -n "$SCHEMA_RISK" ]; then
  if [ "$ACCEPT_RISK" = "1" ]; then
    log "UYARI: $SCHEMA_RISK — --accept-schema-risk ile BİLEREK devam ediliyor."
  else
    fail "Uygulama-yalnız geri alma GÜVENSİZ: $SCHEMA_RISK. Ne yapmalı: ileri düzeltme (hotfix) veya yedekten geri yükleme (docs/BACKUP_RESTORE.md). Riski bilerek kabul ediyorsanız --accept-schema-risk ekleyin." 3
  fi
fi

# --- Uygula: kayıtlı imajı Compose'un imajı olarak etiketle, AYNI blue/green yolunu çalıştır -----
# Compose'un backend imaj adı: çalışan konteynerin imajından okunur (proje adına bağlı, sabit kodlanmaz).
OLD_ID=$(docker compose ps -q backend | head -n 1)
[ -n "$OLD_ID" ] || fail "Çalışan backend konteyneri yok."
COMPOSE_IMAGE=$(docker inspect --format='{{.Config.Image}}' "$OLD_ID")
docker tag "${RELEASE_IMAGE_REPO}:${TARGET}" "${COMPOSE_IMAGE%%:*}:latest"

start=$(date +%s)
APP_VERSION="$TARGET" GIT_SHA="$TARGET_SHA" SKIP_BUILD=1 SKIP_SCHEMA=1 DEPLOY_KIND=rollback ./scripts/zero-downtime-deploy.sh
log "Geri alma tamamlandı: $CURRENT → $TARGET ($(( $(date +%s) - start )) sn, sıfır kesinti)."
