#include "yt_cmd.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "yt_api.h"

/* Kimlikler (UUID, oturum id) gövdeye kaçışsız yazıldığı için yalnızca güvenli karakterler. */
static bool safe_id(const char *s)
{
    if (!s || !*s) return false;
    for (const char *p = s; *p; p++) {
        char c = *p;
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' ||
                  c == '_' || c == ':' || c == '.';
        if (!ok) return false;
    }
    return true;
}

static void copy_str(const cJSON *obj, const char *key, char *dst, size_t cap)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    dst[0] = '\0';
    if (cJSON_IsString(v) && v->valuestring) snprintf(dst, cap, "%s", v->valuestring);
}

yt_cmd_type_t yt_cmd_parse(const char *json, size_t len, yt_cmd_t *out)
{
    memset(out, 0, sizeof *out);
    out->type = YT_CMD_INVALID;
    if (!json || len == 0) return out->type;

    cJSON *root = cJSON_ParseWithLength(json, len);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return out->type;
    }
    copy_str(root, "command", out->name, sizeof out->name);
    if (!out->name[0]) {
        cJSON_Delete(root);
        return out->type;
    }
    copy_str(root, "commandId", out->command_id, sizeof out->command_id);
    if (!safe_id(out->command_id)) out->command_id[0] = '\0';
    copy_str(root, "sessionId", out->session_id, sizeof out->session_id);
    copy_str(root, "reason", out->reason, sizeof out->reason);

    if (strcmp(out->name, "FORCE_CUTOFF") == 0) {
        out->type = YT_CMD_FORCE_CUTOFF;
    } else if (strcmp(out->name, "TIME_SYNC") == 0) {
        char st[40];
        copy_str(root, "serverTime", st, sizeof st);
        int64_t t = st[0] ? yt_api_parse_iso8601(st) : -1;
        out->server_time_ms = t > 0 ? t : 0;
        out->type = out->server_time_ms ? YT_CMD_TIME_SYNC : YT_CMD_INVALID;
    } else if (strcmp(out->name, "SET_K_FACTOR") == 0) {
        /* Sunucu değeri PostgreSQL NUMERIC'ten aktarır: JSON'da DİZE gelir ("459.0000"). */
        const cJSON *k = cJSON_GetObjectItemCaseSensitive(root, "newKFactor");
        out->k_factor = NAN;
        if (cJSON_IsNumber(k)) {
            out->k_factor = k->valuedouble;
        } else if (cJSON_IsString(k) && k->valuestring && k->valuestring[0]) {
            char *end = NULL;
            double d = strtod(k->valuestring, &end);
            if (end && *end == '\0') out->k_factor = d;
        }
        /* Kimliksiz kalibrasyon yanıtlanamaz → geçersiz. Değer aralığını uygulayan karar verir (NACK). */
        out->type = out->command_id[0] ? YT_CMD_SET_K_FACTOR : YT_CMD_INVALID;
    } else {
        out->type = YT_CMD_UNKNOWN;
    }
    cJSON_Delete(root);
    return out->type;
}

static size_t done(int n, size_t cap)
{
    return (n > 0 && (size_t)n < cap) ? (size_t)n : 0;
}

size_t yt_cmd_ack_body(char *buf, size_t cap, const char *command_id, bool ack)
{
    if (!buf || !safe_id(command_id)) return 0;
    return done(snprintf(buf, cap, "{\"commandId\":\"%s\",\"status\":\"%s\"}", command_id, ack ? "ACK" : "NACK"), cap);
}

size_t yt_cmd_calibration_ack_body(char *buf, size_t cap, const char *command_id, bool ack, double applied_k,
                                   const char *reason)
{
    if (!buf || !safe_id(command_id)) return 0;
    if (ack) {
        if (!(applied_k > 0) || !isfinite(applied_k)) return 0;
        return done(snprintf(buf, cap, "{\"commandId\":\"%s\",\"status\":\"ACK\",\"appliedKFactor\":%.4f}",
                             command_id, applied_k), cap);
    }
    if (!safe_id(reason)) reason = "REJECTED";
    return done(snprintf(buf, cap, "{\"commandId\":\"%s\",\"status\":\"NACK\",\"reason\":\"%s\"}", command_id,
                         reason), cap);
}

yt_cal_ack_outcome_t yt_cmd_parse_calibration_ack(int http_status, const char *json)
{
    if (http_status == 200) return YT_CAL_ACK_DONE;
    if (http_status == 404) return YT_CAL_ACK_EXPIRED;
    if (http_status <= 0 || http_status == 429 || http_status >= 500) return YT_CAL_ACK_RETRY;
    if (http_status == 401) {
        char code[YT_API_CODE_MAX];
        yt_api_error_code(json, code, sizeof code);
        if (strcmp(code, "REPLAY_ATTACK_DETECTED") == 0 || strcmp(code, "NONCE_REUSED") == 0) return YT_CAL_ACK_RETRY;
    }
    return YT_CAL_ACK_REJECTED;
}

bool yt_topic_segment_ok(const char *s)
{
    if (!s || !*s) return false;
    return strpbrk(s, "+#/") == NULL;
}

size_t yt_topic_command(char *buf, size_t cap, const char *device_id)
{
    if (!buf || !yt_topic_segment_ok(device_id)) return 0;
    return done(snprintf(buf, cap, "command/v1/%s", device_id), cap);
}

size_t yt_topic_command_ack(char *buf, size_t cap, const char *device_id)
{
    if (!buf || !yt_topic_segment_ok(device_id)) return 0;
    return done(snprintf(buf, cap, "command/v1/%s/ack", device_id), cap);
}

size_t yt_topic_status(char *buf, size_t cap, const char *tenant_id, const char *site_id, const char *device_type,
                       const char *device_id)
{
    if (!buf || !yt_topic_segment_ok(tenant_id) || !yt_topic_segment_ok(site_id) ||
        !yt_topic_segment_ok(device_type) || !yt_topic_segment_ok(device_id)) {
        return 0;
    }
    return done(snprintf(buf, cap, "telemetry/v1/%s/%s/%s/%s/status", tenant_id, site_id, device_type, device_id),
                cap);
}
