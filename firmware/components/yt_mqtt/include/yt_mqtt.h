/*
 * FW-1307 — MQTT kanalı: sunucu komutları (command/v1/{deviceId}) ve presence.
 *
 * - Kalıcı oturum (clean session = false) + QoS 1 abonelik: cihaz kısa süre koparsa
 *   kaçırdığı komutlar (ör. FORCE_CUTOFF) yeniden bağlanınca teslim edilir.
 * - LWT: telemetry/v1/{tenant}/{site}/pump/{deviceId}/status = "OFFLINE" (rehber §3.4);
 *   bağlıyken 8 sn'de bir "ONLINE" (sunucu presence TTL'i 10 sn).
 * - mqtts:// sertifikası IDF CA paketiyle doğrulanır; mqtt:// yalnızca
 *   CONFIG_YT_DEV_ALLOW_PLAINTEXT ile (QEMU/geliştirme).
 * - Komutlar burada YORUMLANMAZ: ham yük çağıranın geri çağrısına verilir; oturumu
 *   tek sahibi olan denetim döngüsü uygular.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char url[128];        /* mqtts://broker:8883 */
    char user[64];
    char pass[96];
    char tenant_id[48];
    char site_id[48];
    char device_id[64];
} yt_mqtt_config_t;

/** Komut geldiğinde MQTT görevinden çağrılır — kısa tutulmalı (kuyruğa koy). */
typedef void (*yt_mqtt_command_cb)(const char *payload, size_t len);

esp_err_t yt_mqtt_start(const yt_mqtt_config_t *cfg, yt_mqtt_command_cb cb);

bool yt_mqtt_connected(void);

/** IOT-305: command/v1/{deviceId}/ack. */
bool yt_mqtt_publish_ack(const char *command_id, bool ack);

#ifdef __cplusplus
}
#endif
