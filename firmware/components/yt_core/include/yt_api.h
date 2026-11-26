/*
 * FW-1307 / FUEL-401 — Sunucu sözleşmesi: istek gövdeleri, HMAC başlıkları ve yanıtların
 * sınıflandırılması (saf mantık; HTTP taşıması components/yt_net'te).
 *
 * Sözleşme: docs/HARDWARE_INTEGRATION_GUIDE.md §2 (HMAC), §9 (ikmal oturumu), §12 (hata kodları).
 *
 * Yanıt sınıfları:
 *   OK       — istek kabul edildi
 *   DENIED   — sunucu bilerek reddetti (kart bilinmiyor, kota bitti…); tekrar denemenin anlamı yok
 *   REJECTED — oturum sunucuda artık geçerli değil (INVALID_STATE_TRANSITION, oturum yok)
 *   RETRY    — geçici: ağ, 5xx, 429, saat sapması (önce saat düzeltilir) — aynı istek yeniden
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "yt_hmac.h"
#include "yt_session.h"

#ifdef __cplusplus
extern "C" {
#endif

#define YT_API_BODY_MAX 512
#define YT_API_CODE_MAX 40
#define YT_API_PLATE_MAX 24
#define YT_API_NAME_MAX 64

typedef enum {
    YT_API_OK = 0,
    YT_API_DENIED,
    YT_API_REJECTED,
    YT_API_RETRY,
} yt_api_outcome_t;

/* ---------- HMAC başlıkları (§2) ---------- */

typedef struct {
    char timestamp[24];                     /* X-Timestamp: ms epoch */
    char nonce[YT_NONCE_HEX_LEN + 1];       /* X-Nonce */
    char signature[YT_HMAC_HEX_LEN + 1];    /* X-Hardware-Signature */
} yt_api_auth_t;

/** body NULL/boşsa "{}" imzalanır. Başarıda 0. */
int yt_api_sign(const char *secret, int64_t epoch_ms, yt_rng_fn rng, const char *body, size_t body_len,
                yt_api_auth_t *out);

/* ---------- istek gövdeleri (dönüş: yazılan uzunluk, 0 = sığmadı / geçersiz) ---------- */

size_t yt_api_body_request_auth(char *buf, size_t cap, const char *card_id, const char *tank_name);
size_t yt_api_body_heartbeat(char *buf, size_t cap, const char *session_id, double totalizer_liters,
                             double flow_rate_lpm);
/** reportedLiters = end − start; recoveredAfterRestart yalnızca true ise eklenir (FW-1314). */
size_t yt_api_body_finalize(char *buf, size_t cap, const yt_session_t *s, double end_totalizer_liters);

/* ---------- yanıtlar ---------- */

/** Yanıttaki makine-okunur kod: details.error, yoksa error. Bulunamazsa "". */
void yt_api_error_code(const char *json, char *code, size_t cap);

typedef struct {
    yt_api_outcome_t outcome;
    char session_id[YT_SESSION_ID_MAX];
    double max_allowed_liters;
    char vehicle_plate[YT_API_PLATE_MAX];
    char driver_name[YT_API_NAME_MAX];
    char code[YT_API_CODE_MAX];             /* DENIED/RETRY sebebi */
} yt_api_auth_result_t;

/** http_status <= 0: ağ hatası (yanıt yok). */
yt_api_outcome_t yt_api_parse_request_auth(int http_status, const char *json, yt_api_auth_result_t *r);

typedef struct {
    yt_api_outcome_t outcome;
    bool force_cutoff;
    char code[YT_API_CODE_MAX];             /* FORCE_CUTOFF sebebi veya hata kodu */
    int64_t server_time_ms;                 /* serverTime (IOT-307), yoksa 0 */
} yt_api_heartbeat_result_t;

yt_api_outcome_t yt_api_parse_heartbeat(int http_status, const char *json, yt_api_heartbeat_result_t *r);

typedef struct {
    yt_api_outcome_t outcome;
    char verification[32];                  /* "DOĞRULANDI" | "DOĞRULAMA_BEKLIYOR" */
    double amount_liters;
    char code[YT_API_CODE_MAX];
} yt_api_finalize_result_t;

yt_api_outcome_t yt_api_parse_finalize(int http_status, const char *json, yt_api_finalize_result_t *r);

/** Yanıt saat sapması yüzünden mi reddedildi (önce saati düzelt, sonra yeniden dene). */
bool yt_api_is_clock_rejection(int http_status, const char *json);

/* ---------- zaman ---------- */

/** RFC 7231 "Wed, 26 Nov 2026 13:10:36 GMT" → epoch ms. Geçersizse -1. */
int64_t yt_api_parse_http_date(const char *s);

/** ISO-8601 UTC "2026-11-26T13:10:36.123Z" → epoch ms. Geçersizse -1. */
int64_t yt_api_parse_iso8601(const char *s);

#ifdef __cplusplus
}
#endif
