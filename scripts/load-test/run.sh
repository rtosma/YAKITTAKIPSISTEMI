#!/usr/bin/env bash
# ============================================================================
# TEST-1002 — k6 Yük ve Stres Testi orkestratörü.
#
# Bu makinede host firewall'ı bridge→host bağlantılarını, NFS de bind-mount'ları
# kırdığı için HER ŞEY compose ağında konteyner olarak koşar ve script'ler
# imaja KOPYALANIR (Dockerfile.sidecar):
#   1. Backend imajını derler → ondan `loadtest-sidecar` imajını kurar
#   2. `loadtest-sidecar` konteyneri: derlenmiş backend + in-process
#      event-loop-lag ölçümü (lag-sidecar.cjs)
#   3. Gerekiyorsa LOADTEST-* cihazlarını sağlar (provision → .devices.json)
#   4. k6'yı (grafana/k6) compose ağında → http://loadtest-sidecar:5000
#   5. Sidecar loglarından lag örneklerini toplar
#   6. Birleşik AC hükmü: HTTP P95 < 200ms VE event loop p99 lag < 50ms
#
# Kullanım (repo kökünden, docker yığını ayakta):
#   scripts/load-test/run.sh                                                  # smoke (3 seed cihaz, ~12 rps)
#   TARGET_RPS=1000 DEVICE_COUNT=300 DURATION=120s VUS=200 scripts/load-test/run.sh   # tam AC
#   SKIP_BUILD=1 scripts/load-test/run.sh                                     # imaj derlemeyi atla
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
LT="scripts/load-test"
mkdir -p "$LT/results"

: "${TARGET_RPS:=12}"
: "${DURATION:=60s}"
: "${VUS:=100}"
: "${P95_MS:=200}"
: "${SKIP_BUILD:=0}"
SIDECAR=loadtest-sidecar
SIDECAR_IMG=loadtest-sidecar:latest

[ -f .env ] || { echo "HATA: repo kökünde .env yok."; exit 1; }
NET="$(docker network ls --format '{{.Name}}' | grep -E 'yakit.*network' | head -1)"
[ -n "$NET" ] || { echo "HATA: compose ağı bulunamadı (docker compose up -d?)."; exit 1; }
BACKEND_IMG="$(docker compose config --images 2>/dev/null | grep -m1 backend || echo yakittakipsistemi-backend:latest)"

cleanup() { docker rm -f "$SIDECAR" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# --- 1. İmajlar -------------------------------------------------------------
if [ "$SKIP_BUILD" != "1" ]; then
  echo "▶ Backend imajı derleniyor (SKIP_BUILD=1 ile atlayın)..."
  docker compose build backend >/dev/null
fi
echo "▶ loadtest-sidecar imajı kuruluyor (temel: $BACKEND_IMG)..."
docker build --quiet --build-arg BASE="$BACKEND_IMG" \
  -f "$LT/Dockerfile.sidecar" -t "$SIDECAR_IMG" "$LT" >/dev/null

# --- 2. Sidecar (backend + lag monitor) ------------------------------------
echo "▶ loadtest-sidecar başlatılıyor (compose ağı: $NET)..."
docker run -d --name "$SIDECAR" --network "$NET" \
  --env-file "$ROOT/.env" \
  -e POSTGRES_HOST=postgres -e POSTGRES_PORT=5432 -e REDIS_HOST=redis -e REDIS_PORT=6379 \
  -e MQTT_URL=__CI_SKIP__ -e LOG_LEVEL="${LOADTEST_LOG_LEVEL:-warn}" -e NODE_ENV=production -e PORT=5000 \
  "$SIDECAR_IMG" node /lag-sidecar.cjs >/dev/null

echo -n "  sidecar sağlık bekleniyor "
HEALTHY=0
for i in $(seq 1 60); do
  if docker run --rm --network "$NET" curlimages/curl:latest -sf --max-time 3 \
      "http://$SIDECAR:5000/api/v1/health" >/dev/null 2>&1; then HEALTHY=1; echo " OK"; break; fi
  echo -n "."; sleep 1
done
[ "$HEALTHY" = 1 ] || { echo " ZAMAN AŞIMI"; docker logs --tail 40 "$SIDECAR"; exit 1; }

# --- 3. Cihaz havuzu -------------------------------------------------------
if [ -n "${DEVICE_COUNT:-}" ] && [ ! -f "$LT/.devices.json" ]; then
  echo "▶ $DEVICE_COUNT cihaz sağlanıyor (provision, ana backend'e karşı)..."
  docker run --rm --network "$NET" \
    -e BASE_URL="http://backend:5000/api/v1" -e DEVICE_COUNT="$DEVICE_COUNT" \
    "$SIDECAR_IMG" node /provision-devices.mjs > "$LT/.devices.json"
fi

if [ -f "$LT/.devices.json" ] && [ -s "$LT/.devices.json" ]; then
  DEVICES_JSON="$(cat "$LT/.devices.json")"
else
  set -a; . ./.env; set +a
  DEVICES_JSON="$(node -e 'const d=[["ESP32-PUMP-01","HW_SECRET_ESP32_PUMP_01"],["ESP32-TANK-01","HW_SECRET_ESP32_TANK_01"],["ESP32-FLOW-ISR","HW_SECRET_ESP32_FLOW_ISR"]].map(([id,k])=>({id,secret:process.env[k]})).filter(x=>x.secret);process.stdout.write(JSON.stringify(d))')"
fi
DEV_N="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).length))' "$DEVICES_JSON")"
echo "▶ Cihaz havuzu: $DEV_N cihaz | hedef: $TARGET_RPS istek/sn | süre: $DURATION | VU: $VUS"

NEED=$(( (TARGET_RPS + 3) / 4 ))
if [ "$DEV_N" -lt "$NEED" ]; then
  echo "HATA: $TARGET_RPS rps için en az $NEED cihaz gerek (cihaz başına <5 rps rate limiti)."
  echo "      DEVICE_COUNT=$NEED ... ile yeniden çalıştırın."
  exit 1
fi

# --- 4. k6 ---------------------------------------------------------------------
echo "▶ k6 çalıştırılıyor (grafana/k6, compose ağı → http://$SIDECAR:5000)..."
K6_SUMMARY="$LT/results/k6-summary.json"
K6_START_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
set +e
docker run --rm --network "$NET" -i \
  -e BASE_URL="http://$SIDECAR:5000/api/v1" \
  -e DEVICES="$DEVICES_JSON" \
  -e TARGET_RPS="$TARGET_RPS" -e DURATION="$DURATION" -e VUS="$VUS" -e P95_MS="$P95_MS" \
  grafana/k6 run --quiet - < "$LT/telemetry-k6.js" \
  >"$LT/results/k6.stdout.log" 2>"$LT/results/k6.log"
K6_EXIT=$?
set -e
K6_END_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
grep -oE '\{"__k6_summary__".*\}' "$LT/results/k6.stdout.log" | tail -1 > "$K6_SUMMARY" || echo '{}' > "$K6_SUMMARY"
grep -E "level=(error|warning)" "$LT/results/k6.log" | tail -6 || true
[ "$K6_EXIT" -ne 0 ] && echo "  (k6 exit=$K6_EXIT — eşik aşıldı ya da hata; ayrıntı: $LT/results/k6.log)"

# --- 5. Lag örneklerini sidecar loglarından topla ------------------------
docker logs "$SIDECAR" 2>&1 | grep -oE '\{"t":.*\}' > "$LT/results/eventloop-lag.jsonl" || true

# --- 6. Hüküm ----------------------------------------------------------------
cleanup; trap - EXIT
echo ""
echo "════════════════════════════════════════════════════════"
echo "  TEST-1002 SONUÇ  (rps=$TARGET_RPS, süre=$DURATION, cihaz=$DEV_N)"
echo "════════════════════════════════════════════════════════"
node "$LT/verdict.mjs" "$K6_SUMMARY" "$LT/results/eventloop-lag.jsonl" "$K6_START_MS" "$K6_END_MS"
