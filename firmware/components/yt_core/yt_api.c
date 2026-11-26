#include "yt_api.h"

#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"

/* ---------- HMAC başlıkları ---------- */

int yt_api_sign(const char *secret, int64_t epoch_ms, yt_rng_fn rng, const char *body, size_t body_len,
                yt_api_auth_t *out)
{
    if (!secret || !secret[0] || !rng || !out || epoch_ms <= 0) return -1;
    snprintf(out->timestamp, sizeof out->timestamp, "%" PRId64, epoch_ms);
    yt_nonce_hex(rng, out->nonce);
    return yt_hmac_sign(secret, out->timestamp, out->nonce, body, body_len, out->signature);
}

/* ---------- gövde yazımı ---------- */

typedef struct {
    char *buf;
    size_t cap;
    size_t len;
    bool ok;
} writer_t;

static void put_raw(writer_t *w, const char *s, size_t n)
{
    if (!w->ok) return;
    if (w->len + n >= w->cap) {
        w->ok = false;
        return;
    }
    memcpy(w->buf + w->len, s, n);
    w->len += n;
    w->buf[w->len] = '\0';
}

static void put(writer_t *w, const char *s)
{
    put_raw(w, s, strlen(s));
}

/* JSON dizesi: tırnak, ters bölü ve kontrol karakterleri kaçırılır; UTF-8 olduğu gibi. */
static void put_str(writer_t *w, const char *s)
{
    put(w, "\"");
    for (const unsigned char *p = (const unsigned char *)s; *p && w->ok; p++) {
        char esc[8];
        if (*p == '"' || *p == '\\') {
            esc[0] = '\\';
            esc[1] = (char)*p;
            put_raw(w, esc, 2);
        } else if (*p < 0x20) {
            snprintf(esc, sizeof esc, "\\u%04x", *p);
            put(w, esc);
        } else {
            put_raw(w, (const char *)p, 1);
        }
    }
    put(w, "\"");
}

static void put_num(writer_t *w, double v, int decimals)
{
    char tmp[40];
    if (!isfinite(v)) {
        w->ok = false;
        return;
    }
    snprintf(tmp, sizeof tmp, "%.*f", decimals, v);
    put(w, tmp);
}

static size_t finish(writer_t *w)
{
    return w->ok ? w->len : 0;
}

size_t yt_api_body_request_auth(char *buf, size_t cap, const char *card_id, const char *tank_name)
{
    if (!buf || !card_id || !card_id[0] || !tank_name || !tank_name[0]) return 0;
    writer_t w = { buf, cap, 0, cap > 0 };
    put(&w, "{\"rfidCardId\":");
    put_str(&w, card_id);
    put(&w, ",\"tankName\":");
    put_str(&w, tank_name);
    put(&w, "}");
    return finish(&w);
}

size_t yt_api_body_heartbeat(char *buf, size_t cap, const char *session_id, double totalizer_liters,
                             double flow_rate_lpm)
{
    if (!buf || !session_id || !session_id[0] || totalizer_liters < 0) return 0;
    writer_t w = { buf, cap, 0, cap > 0 };
    put(&w, "{\"sessionId\":");
    put_str(&w, session_id);
    put(&w, ",\"totalizerLiters\":");
    put_num(&w, totalizer_liters, 3);
    put(&w, ",\"flowRateLpm\":");
    put_num(&w, flow_rate_lpm > 0 ? flow_rate_lpm : 0.0, 1);
    put(&w, "}");
    return finish(&w);
}

size_t yt_api_body_finalize(char *buf, size_t cap, const yt_session_t *s, double end_totalizer_liters)
{
    if (!buf || !s || !s->session_id[0] || !s->idempotency_key[0] || end_totalizer_liters < 0) return 0;
    double reported = end_totalizer_liters - s->start_totalizer;
    if (reported < 0) reported = 0;
    writer_t w = { buf, cap, 0, cap > 0 };
    put(&w, "{\"sessionId\":");
    put_str(&w, s->session_id);
    put(&w, ",\"endTotalizerLiters\":");
    put_num(&w, end_totalizer_liters, 3);
    put(&w, ",\"reportedLiters\":");
    put_num(&w, reported, 3);
    put(&w, ",\"idempotencyKey\":");
    put_str(&w, s->idempotency_key);
    if (yt_session_recovered_after_restart(s)) put(&w, ",\"recoveredAfterRestart\":true");
    put(&w, "}");
    return finish(&w);
}

/* ---------- yanıt okuma ---------- */

static void copy_json_str(const cJSON *obj, const char *key, char *dst, size_t cap)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cap == 0) return;
    if (cJSON_IsString(v) && v->valuestring) {
        snprintf(dst, cap, "%s", v->valuestring);
    } else {
        dst[0] = '\0';
    }
}

/* Sayı veya sayısal dize ("30.00" — PostgreSQL NUMERIC JSON'da dize gelir). */
static bool json_number(const cJSON *obj, const char *key, double *out)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsNumber(v)) {
        *out = v->valuedouble;
        return isfinite(*out);
    }
    if (cJSON_IsString(v) && v->valuestring && v->valuestring[0]) {
        char *end = NULL;
        double d = strtod(v->valuestring, &end);
        if (end && *end == '\0' && isfinite(d)) {
            *out = d;
            return true;
        }
    }
    return false;
}

static void code_from(const cJSON *root, char *code, size_t cap)
{
    code[0] = '\0';
    if (!cJSON_IsObject(root)) return;
    const cJSON *details = cJSON_GetObjectItemCaseSensitive(root, "details");
    if (cJSON_IsObject(details)) copy_json_str(details, "error", code, cap);
    if (!code[0]) copy_json_str(root, "error", code, cap);
}

void yt_api_error_code(const char *json, char *code, size_t cap)
{
    if (!code || cap == 0) return;
    code[0] = '\0';
    if (!json) return;
    cJSON *root = cJSON_Parse(json);
    code_from(root, code, cap);
    cJSON_Delete(root);
}

static bool success_true(const cJSON *root)
{
    return cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(root, "success"));
}

bool yt_api_is_clock_rejection(int http_status, const char *json)
{
    if (http_status != 401) return false;
    char code[YT_API_CODE_MAX];
    yt_api_error_code(json, code, sizeof code);
    return strcmp(code, "REPLAY_ATTACK_DETECTED") == 0;
}

/* Tüm uçlarda ortak geçici durumlar: ağ, hız sınırı, sunucu hatası, saat, nonce çakışması. */
static bool is_transient(int http_status, const char *code)
{
    if (http_status <= 0 || http_status == 429 || http_status >= 500) return true;
    return http_status == 401 && (strcmp(code, "REPLAY_ATTACK_DETECTED") == 0 || strcmp(code, "NONCE_REUSED") == 0);
}

static void status_code(int http_status, char *code, size_t cap)
{
    if (code[0]) return;
    if (http_status <= 0) {
        snprintf(code, cap, "NETWORK");
    } else {
        snprintf(code, cap, "HTTP_%d", http_status);
    }
}

yt_api_outcome_t yt_api_parse_request_auth(int http_status, const char *json, yt_api_auth_result_t *r)
{
    memset(r, 0, sizeof *r);
    cJSON *root = json ? cJSON_Parse(json) : NULL;
    code_from(root, r->code, sizeof r->code);

    if (http_status == 200 && success_true(root)) {
        const cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
        double max = 0;
        copy_json_str(data, "sessionId", r->session_id, sizeof r->session_id);
        if (r->session_id[0] && json_number(data, "maxAllowedLiters", &max) && max > 0) {
            r->max_allowed_liters = max;
            copy_json_str(data, "vehiclePlate", r->vehicle_plate, sizeof r->vehicle_plate);
            copy_json_str(data, "driverName", r->driver_name, sizeof r->driver_name);
            r->outcome = YT_API_OK;
        } else {
            /* Yetki "verildi" ama oturum/limit yok: güvenli tarafta kal. */
            r->session_id[0] = '\0';
            snprintf(r->code, sizeof r->code, "INVALID_AUTH_RESPONSE");
            r->outcome = YT_API_DENIED;
        }
    } else if (is_transient(http_status, r->code)) {
        r->outcome = YT_API_RETRY;
    } else {
        r->outcome = YT_API_DENIED;
    }
    status_code(http_status, r->code, sizeof r->code);
    if (r->outcome == YT_API_OK) r->code[0] = '\0';
    cJSON_Delete(root);
    return r->outcome;
}

yt_api_outcome_t yt_api_parse_heartbeat(int http_status, const char *json, yt_api_heartbeat_result_t *r)
{
    memset(r, 0, sizeof *r);
    cJSON *root = json ? cJSON_Parse(json) : NULL;

    if (http_status == 200 && success_true(root)) {
        char command[24];
        copy_json_str(root, "command", command, sizeof command);
        char st[40];
        copy_json_str(root, "serverTime", st, sizeof st);
        int64_t t = st[0] ? yt_api_parse_iso8601(st) : -1;
        r->server_time_ms = t > 0 ? t : 0;
        if (strcmp(command, "FORCE_CUTOFF") == 0) {
            r->force_cutoff = true;
            copy_json_str(root, "reason", r->code, sizeof r->code);
            r->outcome = YT_API_OK;
        } else if (strcmp(command, "CONTINUE") == 0) {
            r->outcome = YT_API_OK;
        } else {
            /* Tanınmayan komut: akışı sürdürmek yerine kes. */
            r->force_cutoff = true;
            snprintf(r->code, sizeof r->code, "UNKNOWN_COMMAND");
            r->outcome = YT_API_OK;
        }
    } else {
        code_from(root, r->code, sizeof r->code);
        /* Oturum artık sunucuda yaşamıyor (TIMED_OUT, bilinmiyor) veya cihaz reddedildi:
         * pompalama sürmemeli. Yalnızca geçici durumlar yeniden denenir. */
        r->outcome = is_transient(http_status, r->code) ? YT_API_RETRY : YT_API_REJECTED;
        status_code(http_status, r->code, sizeof r->code);
    }
    cJSON_Delete(root);
    return r->outcome;
}

yt_api_outcome_t yt_api_parse_finalize(int http_status, const char *json, yt_api_finalize_result_t *r)
{
    memset(r, 0, sizeof *r);
    cJSON *root = json ? cJSON_Parse(json) : NULL;

    if (http_status == 200) {
        /* 200 = kayıt sunucuda oluştu. Gövde kesik/okunamaz olsa bile OK: aksi halde aynı
         * finalize sonsuza dek yeniden gönderilir (sunucu her seferinde idempotent 200 döner). */
        const cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
        copy_json_str(data, "verification_status", r->verification, sizeof r->verification);
        double amount = 0;
        if (json_number(data, "amount_liters", &amount)) r->amount_liters = amount;
        r->outcome = YT_API_OK;
    } else {
        code_from(root, r->code, sizeof r->code);
        if (http_status == 404 || http_status == 409 || http_status == 400) {
            /* Oturum yok / geçersiz geçiş / gövde reddedildi: yeniden denemek aynı sonucu verir. */
            r->outcome = YT_API_REJECTED;
        } else {
            /* Ağ, 5xx, 429, saat, nonce — ve 401/403 (secret rotasyonu, geçici bloke): kayıt
             * kaybolmasın diye saklanıp yeniden denenir. */
            r->outcome = YT_API_RETRY;
        }
        status_code(http_status, r->code, sizeof r->code);
    }
    cJSON_Delete(root);
    return r->outcome;
}

/* ---------- zaman ---------- */

/* Gregoryen tarih → 1970'ten bu yana gün (Howard Hinnant'ın days_from_civil'i). */
static int64_t days_from_civil(int64_t y, int m, int d)
{
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const int64_t yoe = y - era * 400;
    const int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

static int64_t to_epoch_ms(int y, int mon, int d, int h, int mi, int s, int ms)
{
    if (y < 2000 || y > 2200 || mon < 1 || mon > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59 ||
        s < 0 || s > 60 || ms < 0 || ms > 999) {
        return -1;
    }
    int64_t days = days_from_civil(y, mon, d);
    return ((days * 24 + h) * 60 + mi) * 60000LL + s * 1000LL + ms;
}

int64_t yt_api_parse_http_date(const char *s)
{
    static const char *months[] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
    char wd[4], mon[4], tz[4];
    int d, y, h, mi, sec;
    if (!s || sscanf(s, "%3[A-Za-z], %d %3s %d %d:%d:%d %3s", wd, &d, mon, &y, &h, &mi, &sec, tz) != 8) return -1;
    if (strcmp(tz, "GMT") != 0) return -1;
    for (int i = 0; i < 12; i++) {
        if (strcmp(mon, months[i]) == 0) return to_epoch_ms(y, i + 1, d, h, mi, sec, 0);
    }
    return -1;
}

int64_t yt_api_parse_iso8601(const char *s)
{
    int y, mon, d, h, mi, sec, n = 0;
    if (!s || sscanf(s, "%4d-%2d-%2dT%2d:%2d:%2d%n", &y, &mon, &d, &h, &mi, &sec, &n) != 6) return -1;
    const char *p = s + n;
    int ms = 0;
    if (*p == '.') {
        p++;
        int digits = 0;
        while (*p >= '0' && *p <= '9') {
            if (digits < 3) ms = ms * 10 + (*p - '0');
            digits++;
            p++;
        }
        if (digits == 0) return -1;
        for (int i = digits; i < 3; i++) ms *= 10;
    }
    if (strcmp(p, "Z") != 0) return -1; /* sunucu her zaman UTC "Z" döner */
    return to_epoch_ms(y, mon, d, h, mi, sec, ms);
}
