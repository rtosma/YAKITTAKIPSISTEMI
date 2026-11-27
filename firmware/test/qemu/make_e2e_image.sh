#!/usr/bin/env bash
# Uçtan uca test için sahaya kurulmuş gibi yapılandırılmış flash imajı üretir:
# sdkconfig.qemu ile derlenmiş imaj + NVS'te cihaz kimliği/secret, sunucu adresi ve tank.
#
#   . "$IDF_PATH/export.sh"
#   E2E_DEVICE_ID=ESP32-PUMP-01 E2E_DEVICE_SECRET=... \
#   E2E_SERVER_URL=http://10.0.2.2:5000/api/v1 E2E_TANK_NAME="Gebze Ana Tank (T-1)" \
#     bash firmware/test/qemu/make_e2e_image.sh /tmp/fw-build-qemu /tmp/fw-e2e.bin
#
# MQTT (opsiyonel): E2E_MQTT_URL=mqtt://10.0.2.2:1883 E2E_MQTT_USER E2E_MQTT_PASS
#                   E2E_TENANT_ID E2E_SITE_ID — verilmezse cihaz MQTT'siz çalışır.
# 10.0.2.2 = QEMU kullanıcı ağında ana makine. Secret yalnızca bu dosyaya yazılır.
set -euo pipefail

BUILD=${1:?kullanım: make_e2e_image.sh <qemu build dizini> <çıktı.bin>}
OUT=${2:?çıktı dosyası}
: "${E2E_DEVICE_ID:?}" "${E2E_DEVICE_SECRET:?}" "${E2E_SERVER_URL:?}" "${E2E_TANK_NAME:?}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

grep -q '^CONFIG_YT_DEV_CONSOLE=y' "$BUILD/sdkconfig" || {
  echo "Bu derleme sdkconfig.qemu ile yapılmamış (geliştirme konsolu kapalı)" >&2
  exit 1
}

csv_field() { # virgül/tırnak içeren değerleri CSV için kaçır
  printf '"%s"' "${1//\"/\"\"}"
}

{
  echo "key,type,encoding,value"
  echo "yt_sec,namespace,,"
  echo "dev_id,data,string,$(csv_field "$E2E_DEVICE_ID")"
  echo "secret,data,string,$(csv_field "$E2E_DEVICE_SECRET")"
  if [ -n "${E2E_MQTT_PASS:-}" ]; then echo "mqtt_pass,data,string,$(csv_field "$E2E_MQTT_PASS")"; fi
  echo "yt_cfg,namespace,,"
  echo "srv_url,data,string,$(csv_field "$E2E_SERVER_URL")"
  echo "tank_name,data,string,$(csv_field "$E2E_TANK_NAME")"
  if [ -n "${E2E_MQTT_URL:-}" ]; then
    echo "mqtt_url,data,string,$(csv_field "$E2E_MQTT_URL")"
    if [ -n "${E2E_MQTT_USER:-}" ]; then echo "mqtt_user,data,string,$(csv_field "$E2E_MQTT_USER")"; fi
    echo "tenant_id,data,string,$(csv_field "${E2E_TENANT_ID:?MQTT için E2E_TENANT_ID gerekli}")"
    echo "site_id,data,string,$(csv_field "${E2E_SITE_ID:?MQTT için E2E_SITE_ID gerekli}")"
  fi
} > "$WORK/nvs.csv"

python "$IDF_PATH/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py" \
  generate "$WORK/nvs.csv" "$WORK/nvs.bin" 0x6000 > /dev/null
(cd "$BUILD" && python -m esptool --chip esp32 merge_bin --fill-flash-size 4MB -o "$OUT" @flash_args > /dev/null)
dd if="$WORK/nvs.bin" of="$OUT" bs=1 seek=$((0x9000)) conv=notrunc status=none
echo "uçtan uca imaj hazır: $OUT"
