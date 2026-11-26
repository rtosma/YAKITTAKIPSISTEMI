/*
 * FUEL-401 (cihaz tarafı) + FW-1303 yazılım kilidi — ikmal oturumu durum makinesi.
 *
 * Sözleşme: docs/HARDWARE_INTEGRATION_GUIDE.md §9. Sunucu durumları:
 *   AUTHORIZED → PUMPING → FINALIZING → COMPLETED  (+ ABORTED / TIMED_OUT)
 * Cihaz bunlara iki yerel durum ekler: IDLE (kart bekleniyor) ve REQUESTING
 * (request-auth yanıtı bekleniyor).
 *
 * TEK GÜVENLİK KAPISI: rölenin (solenoid/pompa) açık olabileceği tek koşul
 * yt_session_relay_allowed()'dır. Röle sürücüsü başka hiçbir yoldan açılmaz
 * (FW-1303 AC: "Yetkisiz hiçbir kod yolundan röle açılamamalıdır").
 *
 * Saf mantıktır: ağ/zaman/donanım olayları çağıran tarafından olay olarak
 * verilir; bilgisayarda birim testle doğrulanır.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define YT_SESSION_ID_MAX 64
#define YT_CARD_ID_MAX 40
#define YT_IDEMPOTENCY_MAX 128
#define YT_REASON_MAX 40

#define YT_HEARTBEAT_INTERVAL_MS 5000   /* rehber §9.2: ~5 sn */
#define YT_NO_FLOW_FINISH_MS 20000      /* akış bu kadar süre durursa ikmal biter (kısa ara verilebilsin) */
#define YT_AUTH_START_TIMEOUT_MS 60000  /* yetki alındı ama akış hiç başlamadı */

typedef enum {
    YT_S_IDLE = 0,
    YT_S_REQUESTING,
    YT_S_AUTHORIZED,
    YT_S_PUMPING,
    YT_S_FINALIZING,
    YT_S_COMPLETED,
    YT_S_ABORTED,
} yt_session_state_t;

/** Röle neden kapandı / ikmal neden bitiyor (ekran mesajı ve log için). */
typedef enum {
    YT_END_NONE = 0,
    YT_END_FLOW_STOPPED,       /* tabanca kapandı, akış durdu */
    YT_END_LIMIT_REACHED,      /* maxAllowedLiters'a yerelde ulaşıldı */
    YT_END_FORCE_CUTOFF,       /* sunucu FORCE_CUTOFF (HTTP yanıtı veya MQTT) */
    YT_END_EMERGENCY_STOP,     /* acil durdurma girişi */
    YT_END_NO_FLOW_STARTED,    /* yetki alındı, akış hiç başlamadı */
    YT_END_ABNORMAL_RESTART,   /* ikmal sürerken cihaz yeniden başladı (FW-1303) */
} yt_end_reason_t;

typedef struct {
    yt_session_state_t state;
    char card_id[YT_CARD_ID_MAX];
    char session_id[YT_SESSION_ID_MAX];
    char idempotency_key[YT_IDEMPOTENCY_MAX];
    char denial[YT_REASON_MAX];       /* son request-auth reddi (details.error) */
    double max_allowed_liters;
    double start_totalizer;           /* oturum başındaki kümülatif litre */
    yt_end_reason_t end_reason;
    bool cutoff_latched;              /* bir kez kesildi mi — tekrar açılamaz */
    int64_t state_since_ms;
    int64_t last_heartbeat_ms;
    int64_t last_flow_ms;
    int finalize_attempts;
} yt_session_t;

void yt_session_init(yt_session_t *s);

/** Röle şu an açık OLABİLİR mi? (TEK kapı) */
bool yt_session_relay_allowed(const yt_session_t *s);

/* --- Olaylar (dönüş: olay bu durumda geçerli miydi) --- */
bool yt_session_on_card(yt_session_t *s, const char *card_id, int64_t now_ms);
bool yt_session_on_auth_granted(yt_session_t *s, const char *session_id, double max_allowed_liters,
                                double totalizer_now, const char *device_id, int64_t now_ms);
bool yt_session_on_auth_denied(yt_session_t *s, const char *error_code, int64_t now_ms);
/** Heartbeat yanıtı. force_cutoff: yanıt "FORCE_CUTOFF" komutu taşıyorsa. */
bool yt_session_on_heartbeat_ack(yt_session_t *s, bool force_cutoff, int64_t now_ms);
/** MQTT command/v1/{deviceId} FORCE_CUTOFF. session_id NULL/boşsa aktif oturuma uygulanır. */
bool yt_session_on_force_cutoff(yt_session_t *s, const char *session_id, int64_t now_ms);
bool yt_session_on_emergency_stop(yt_session_t *s, int64_t now_ms);
bool yt_session_on_finalize_ok(yt_session_t *s, int64_t now_ms);
/** Geçici hata (ağ): FINALIZING'de kalınır, AYNI idempotency anahtarıyla yeniden denenir. */
bool yt_session_on_finalize_failed(yt_session_t *s, int64_t now_ms);
/** Sunucu oturumu geçersiz saydı (ör. INVALID_STATE_TRANSITION) — kayıt atılır, ABORTED. */
bool yt_session_on_finalize_rejected(yt_session_t *s, int64_t now_ms);
/** COMPLETED/ABORTED → IDLE (ekran mesajı gösterildikten sonra). */
bool yt_session_reset(yt_session_t *s, int64_t now_ms);

/**
 * Periyodik değerlendirme (ana döngü, ~100 ms): akış/limit/zaman kurallarını uygular.
 * session_liters: bu ikmalde akan litre; flowing: son okumada pals var mı.
 */
void yt_session_tick(yt_session_t *s, double session_liters, bool flowing, int64_t now_ms);

/** Heartbeat gönderme zamanı geldi mi (AUTHORIZED/PUMPING'de her 5 sn). */
bool yt_session_heartbeat_due(const yt_session_t *s, int64_t now_ms);
void yt_session_mark_heartbeat_sent(yt_session_t *s, int64_t now_ms);

/** Finalize gönderilmeli mi (FINALIZING'de). */
bool yt_session_finalize_pending(const yt_session_t *s);

/**
 * Açılışta: NVS'te yarım kalmış bir oturum bulunduysa (röle açıkken reset/brown-out)
 * oturumu FINALIZING'e alıp "anormal sonlanma" olarak raporlanmasını sağlar (FW-1303 AC).
 */
void yt_session_restore_abnormal(yt_session_t *s, const char *session_id, const char *idempotency_key,
                                 double start_totalizer, int64_t now_ms);

/** Oturum, ikmal sürerken yeniden başlatmadan kurtarıldı mı (finalize'da recoveredAfterRestart). */
bool yt_session_recovered_after_restart(const yt_session_t *s);

const char *yt_session_state_name(yt_session_state_t st);
const char *yt_end_reason_name(yt_end_reason_t r);

#ifdef __cplusplus
}
#endif
