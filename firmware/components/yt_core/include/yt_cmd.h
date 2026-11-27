/*
 * FW-1307 / FUEL-401.3 / FUEL-404.1 / IOT-305 / IOT-307 — Sunucu → cihaz komutları
 * (saf mantık; MQTT taşıması components/yt_mqtt'te).
 *
 * Sözleşme: docs/HARDWARE_INTEGRATION_GUIDE.md §3 (topic'ler, presence), §3.6 (komutlar), §5.
 *   command/v1/{deviceId}         ← { "command": "<AD>", …, "issuedAt": "<ISO>" }
 *   command/v1/{deviceId}/ack     → { "commandId", "status": "ACK" | "NACK" }   (IOT-305, commandId varsa)
 *   POST /telemetry/calibration-ack  { commandId, status, appliedKFactor | reason }  (SET_K_FACTOR)
 *   telemetry/v1/{tenant}/{site}/{tip}/{deviceId}/status  → "ONLINE" / LWT "OFFLINE"
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define YT_CMD_ID_MAX 64
#define YT_CMD_TEXT_MAX 64
#define YT_TOPIC_MAX 192

/* Kalibrasyon komutu sunucuda 5 dk sonra ZAMAN_ASIMI olur; ondan sonra ACK kabul edilmez. */
#define YT_CALIBRATION_WINDOW_MS (5 * 60 * 1000)

typedef enum {
    YT_CMD_INVALID = 0,    /* JSON değil / "command" yok */
    YT_CMD_UNKNOWN,        /* tanınmayan komut — yok sayılır, NACK edilir */
    YT_CMD_FORCE_CUTOFF,
    YT_CMD_TIME_SYNC,
    YT_CMD_SET_K_FACTOR,
} yt_cmd_type_t;

typedef struct {
    yt_cmd_type_t type;
    char name[24];                       /* ham komut adı (log için) */
    char command_id[YT_CMD_ID_MAX];      /* IOT-305 / kalibrasyon kimliği; yoksa "" */
    char session_id[YT_CMD_TEXT_MAX];    /* FORCE_CUTOFF: bilgi amaçlı */
    char reason[YT_CMD_TEXT_MAX];        /* FORCE_CUTOFF: bilgi amaçlı */
    double k_factor;                     /* SET_K_FACTOR: newKFactor */
    int64_t server_time_ms;              /* TIME_SYNC: serverTime */
    int64_t issued_ms;                   /* issuedAt (yoksa 0) */
} yt_cmd_t;

yt_cmd_type_t yt_cmd_parse(const char *json, size_t len, yt_cmd_t *out);

/*
 * Bayat / başka oturuma ait komut filtresi. Kalıcı MQTT oturumunda broker, cihaz
 * çevrimdışıyken gelen QoS 1 komutları SAKLAR ve bağlanınca teslim eder — saatler önceki bir
 * komut o an süren alakasız bir ikmali kesmemeli, saati geri almamalı (QEMU uçtan uca testi
 * yakaladı).
 *  - FORCE_CUTOFF sessionId'li: yalnızca aktif oturum O ise uygulanır (eski oturuma ait emir).
 *    sessionId'siz (ör. yetkisiz akış alarmı): YT_CMD_CUTOFF_MAX_AGE_MS'den eskiyse yok sayılır.
 *  - TIME_SYNC: YT_CMD_TIME_SYNC_MAX_AGE_MS'den eskiyse ya da cihaz saati henüz güvenilir
 *    değilse yok sayılır (o durumda ilk HTTP yanıtının Date başlığı eşitler).
 *  - SET_K_FACTOR: sunucunun 5 dk'lık penceresi geçtiyse yok sayılır (zaten ZAMAN_ASIMI).
 * now_ms = 0 → saat güvenilir değil (yaş hesaplanamaz).
 */
#define YT_CMD_CUTOFF_MAX_AGE_MS (2 * 60 * 1000)
#define YT_CMD_TIME_SYNC_MAX_AGE_MS (60 * 1000)

typedef enum {
    YT_CMD_APPLY = 0,
    YT_CMD_IGNORE_OTHER_SESSION,
    YT_CMD_IGNORE_STALE,
    YT_CMD_IGNORE_CLOCK_UNTRUSTED,
} yt_cmd_verdict_t;

yt_cmd_verdict_t yt_cmd_freshness(const yt_cmd_t *c, const char *active_session_id, int64_t now_ms);
const char *yt_cmd_verdict_name(yt_cmd_verdict_t v);

/** command/v1/{deviceId}/ack gövdesi. Dönüş: uzunluk (0 = sığmadı). */
size_t yt_cmd_ack_body(char *buf, size_t cap, const char *command_id, bool ack);

/** POST /telemetry/calibration-ack gövdesi. ack ise applied_k zorunlu, değilse reason. */
size_t yt_cmd_calibration_ack_body(char *buf, size_t cap, const char *command_id, bool ack, double applied_k,
                                   const char *reason);

typedef enum {
    YT_CAL_ACK_DONE = 0,     /* sunucu kaydetti */
    YT_CAL_ACK_EXPIRED,      /* 404 CALIBRATION_COMMAND_NOT_FOUND: zaman aşımı / zaten işlendi */
    YT_CAL_ACK_REJECTED,     /* 400 vb.: gövde reddedildi — yeniden denemek aynı sonucu verir */
    YT_CAL_ACK_RETRY,        /* ağ / 5xx / 429 / saat */
} yt_cal_ack_outcome_t;

yt_cal_ack_outcome_t yt_cmd_parse_calibration_ack(int http_status, const char *json);

/* ---------- topic'ler ---------- */

size_t yt_topic_command(char *buf, size_t cap, const char *device_id);
size_t yt_topic_command_ack(char *buf, size_t cap, const char *device_id);
size_t yt_topic_status(char *buf, size_t cap, const char *tenant_id, const char *site_id, const char *device_type,
                       const char *device_id);

/** Topic'e konacak kimliklerde MQTT joker/ayraç karakteri olmamalı (+, #, /). */
bool yt_topic_segment_ok(const char *s);

#ifdef __cplusplus
}
#endif
