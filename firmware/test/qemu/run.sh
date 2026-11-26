#!/usr/bin/env bash
# FW-1314 / FW-1303 — donanımsız açılış testi.
#
# Derlenmiş imajı ESP-IDF'in ESP32 QEMU'sunda, önceden hazırlanmış NVS içerikleriyle
# başlatır ve açılış log'unu doğrular: röle kapalı başlar, HMAC öz-testi cihaz
# mimarisinde geçer, K-faktörü/totalizatör NVS'ten okunur, yarım kalan ikmal
# kurtarılır, bozuk kayıt silinir; ikinci açılışta NVS'e yazılanlar kalıcıdır.
#
#   . "$IDF_PATH/export.sh" && bash firmware/test/qemu/run.sh /tmp/fw-build
set -euo pipefail

BUILD=${1:?kullanım: run.sh <idf build dizini>}
HERE=$(cd "$(dirname "$0")" && pwd)
CORE="$HERE/../../components/yt_core"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

NVS_OFFSET=0x9000 # partitions.csv ile aynı
NVS_SIZE=0x6000

gcc -std=c11 -I"$CORE/include" -o "$WORK/mkmarker" "$HERE/mkmarker.c" "$CORE/yt_persist.c" "$CORE/yt_session.c" -lm
(cd "$BUILD" && python -m esptool --chip esp32 merge_bin --fill-flash-size 4MB -o "$WORK/blank.bin" @flash_args > /dev/null)
K_HEX=$(python3 -c 'import struct; print(struct.pack("<d", 512.25).hex())')

# $1 = imaj adı, $2 = oturum kaydı (hex, boş = yok)
make_image() {
  {
    echo "key,type,encoding,value"
    echo "yt,namespace,,"
    echo "tot_ml,data,u64,1234567"
    echo "k_factor,data,hex2bin,$K_HEX"
    if [ -n "$2" ]; then echo "sess,data,hex2bin,$2"; fi
  } > "$WORK/$1.csv"
  python "$IDF_PATH/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py" \
    generate "$WORK/$1.csv" "$WORK/$1-nvs.bin" "$NVS_SIZE" > /dev/null
  cp "$WORK/blank.bin" "$WORK/$1.bin"
  dd if="$WORK/$1-nvs.bin" of="$WORK/$1.bin" bs=1 seek=$((NVS_OFFSET)) conv=notrunc status=none
}

# QEMU flash dosyasına yazar: aynı imajla ikinci açılış, ilkinin NVS yazmalarını görür.
boot() {
  timeout 10 qemu-system-xtensa -nographic -machine esp32 -m 4M \
    -drive file="$WORK/$1.bin",if=mtd,format=raw 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "$WORK/$2.log" || true
}

fail=0
expect() {
  if grep -qF -- "$2" "$WORK/$1.log"; then echo "  ✅ $1: \"$2\""; else echo "  ❌ $1: beklenen \"$2\" yok"; fail=1; fi
}
reject() {
  if grep -qF -- "$2" "$WORK/$1.log"; then echo "  ❌ $1: beklenmeyen \"$2\""; fail=1; else echo "  ✅ $1: \"$2\" yok"; fi
}
common() {
  expect "$1" "KAPALI başlatıldı"
  expect "$1" "HMAC öz-testi geçti"
  expect "$1" "akışmetre GPIO"
  reject "$1" "Guru Meditation"
  reject "$1" "task_wdt"
  reject "$1" "abort()"
}

echo "▶ İlk kurulum (boş NVS)"
boot blank blank
common blank
expect blank "Totalizatör kaydı yok"
expect blank "K-faktörü kayıtlı değil"

echo "▶ İkmal sürerken güç kesildi"
make_image active "$("$WORK/mkmarker" dsess-qemu-1 active)"
boot active active1
common active1
expect active1 "K-faktörü 512.250 pals/L, totalizatör 1234.567 L"
expect active1 "oturum dsess-qemu-1 kurtarıldı"
boot active active2
expect active2 "oturum dsess-qemu-1 kurtarıldı" # kayıt FINALIZING+ABNORMAL olarak yeniden yazıldı

echo "▶ İkmal bitti, finalize sunucuya ulaşmadan yeniden başlandı"
make_image finalizing "$("$WORK/mkmarker" dsess-qemu-2 finalizing)"
boot finalizing finalizing
common finalizing
expect finalizing "dsess-qemu-2 (FLOW_STOPPED) yeniden gönderilecek"
reject finalizing "kurtarıldı"

echo "▶ Bozuk oturum kaydı"
make_image corrupt "$("$WORK/mkmarker" dsess-qemu-3 active corrupt)"
boot corrupt corrupt1
common corrupt1
expect corrupt1 "Oturum kaydı bozuk/uyumsuz"
boot corrupt corrupt2
reject corrupt2 "bozuk"
reject corrupt2 "kurtarıldı"
expect corrupt2 "totalizatör 1234.567 L"

if [ "$fail" -ne 0 ]; then
  echo "QEMU açılış testi BAŞARISIZ — log'lar:"
  for f in "$WORK"/*.log; do echo "----- $(basename "$f")"; grep -E "yakittakip|yt_|Guru|wdt|abort" "$f" || true; done
  exit 1
fi
echo "QEMU açılış testi geçti"
