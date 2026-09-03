#!/bin/sh
# ==============================================================================
# EMQX entrypoint wrapper — generates the built_in_database authentication
# bootstrap file from MQTT_USERNAME/MQTT_PASSWORD env vars before starting
# EMQX, so no plaintext credentials need to be committed to the repo.
#
# Why this exists: the stock EMQX image has no way to seed a user account
# purely from docker-compose environment variables — the built_in_database
# authenticator needs a bootstrap CSV file on disk. This script writes that
# file into the emqxdata volume (owned by the `emqx` user) on every container
# start, from whatever MQTT_USERNAME/MQTT_PASSWORD are set in .env.
# ==============================================================================
set -e

if [ -z "$MQTT_USERNAME" ] || [ -z "$MQTT_PASSWORD" ]; then
  echo "FATAL: MQTT_USERNAME ve MQTT_PASSWORD ortam değişkenleri zorunludur (anonim MQTT erişimi kapatıldı)." >&2
  echo "Kök .env dosyanıza güçlü bir MQTT_USERNAME / MQTT_PASSWORD ekleyin." >&2
  exit 1
fi

mkdir -p /opt/emqx/data
# bootstrap_type=plain expects a HEADER row plus user_id,password,is_superuser
# columns — a headerless 2-column file is silently ignored (no error, no user).
printf 'user_id,password,is_superuser\n%s,%s,false\n' "$MQTT_USERNAME" "$MQTT_PASSWORD" > /opt/emqx/data/authn_bootstrap.csv

exec /usr/bin/docker-entrypoint.sh "$@"
