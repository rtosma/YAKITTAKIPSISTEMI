#include "yt_session.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static void copy_str(char *dst, size_t cap, const char *src)
{
    if (!src) src = "";
    snprintf(dst, cap, "%s", src);
}

static void enter(yt_session_t *s, yt_session_state_t st, int64_t now_ms)
{
    s->state = st;
    s->state_since_ms = now_ms;
}

/* Röle kesilir ve oturum kesinleştirmeye gider. Kesme mandallıdır: aynı oturumda
 * röle bir daha açılamaz (FORCE_CUTOFF'tan sonra "CONTINUE" gelse bile). */
static void cut_and_finalize(yt_session_t *s, yt_end_reason_t reason, int64_t now_ms)
{
    s->cutoff_latched = true;
    if (s->end_reason == YT_END_NONE) s->end_reason = reason;
    enter(s, YT_S_FINALIZING, now_ms);
}

void yt_session_init(yt_session_t *s)
{
    memset(s, 0, sizeof *s);
    s->state = YT_S_IDLE;
}

bool yt_session_relay_allowed(const yt_session_t *s)
{
    if (s->cutoff_latched) return false;
    if (s->session_id[0] == '\0') return false;          /* sunucu yetkisi yoksa asla */
    if (!(s->max_allowed_liters > 0) || !isfinite(s->max_allowed_liters)) return false;
    return s->state == YT_S_AUTHORIZED || s->state == YT_S_PUMPING;
}

bool yt_session_on_card(yt_session_t *s, const char *card_id, int64_t now_ms)
{
    if (s->state != YT_S_IDLE || !card_id || card_id[0] == '\0') return false;
    yt_session_init(s);
    copy_str(s->card_id, sizeof s->card_id, card_id);
    enter(s, YT_S_REQUESTING, now_ms);
    return true;
}

bool yt_session_on_auth_granted(yt_session_t *s, const char *session_id, double max_allowed_liters,
                                double totalizer_now, const char *device_id, int64_t now_ms)
{
    if (s->state != YT_S_REQUESTING) return false;
    if (!session_id || session_id[0] == '\0' || !(max_allowed_liters > 0) || !isfinite(max_allowed_liters)) {
        /* Geçersiz yanıt: güvenli tarafta kal, yetki yok say. */
        copy_str(s->denial, sizeof s->denial, "INVALID_AUTH_RESPONSE");
        enter(s, YT_S_ABORTED, now_ms);
        return false;
    }
    copy_str(s->session_id, sizeof s->session_id, session_id);
    /* Idempotency anahtarı oturum başına SABİT: ağ kesintisinden sonra aynı
     * değerle tekrar gönderilir, ikinci kayıt oluşmaz (rehber §9.3). */
    snprintf(s->idempotency_key, sizeof s->idempotency_key, "%s:%s", device_id ? device_id : "dev", session_id);
    s->max_allowed_liters = max_allowed_liters;
    s->start_totalizer = totalizer_now;
    s->last_heartbeat_ms = 0;
    s->last_flow_ms = now_ms;
    enter(s, YT_S_AUTHORIZED, now_ms);
    return true;
}

bool yt_session_on_auth_denied(yt_session_t *s, const char *error_code, int64_t now_ms)
{
    if (s->state != YT_S_REQUESTING) return false;
    copy_str(s->denial, sizeof s->denial, error_code ? error_code : "DENIED");
    enter(s, YT_S_ABORTED, now_ms);
    return true;
}

bool yt_session_on_heartbeat_ack(yt_session_t *s, bool force_cutoff, int64_t now_ms)
{
    if (s->state != YT_S_AUTHORIZED && s->state != YT_S_PUMPING) return false;
    if (force_cutoff) {
        cut_and_finalize(s, YT_END_FORCE_CUTOFF, now_ms);
        return true;
    }
    /* İlk heartbeat sunucuda AUTHORIZED → PUMPING geçişini yapar (§9.2). */
    if (s->state == YT_S_AUTHORIZED) enter(s, YT_S_PUMPING, now_ms);
    return true;
}

bool yt_session_on_force_cutoff(yt_session_t *s, const char *session_id, int64_t now_ms)
{
    if (s->state != YT_S_AUTHORIZED && s->state != YT_S_PUMPING) {
        /* Zaten kapalı bir solenoidi kapatmak zararsız: komut etkisiz-yinelemeli (§3.6). */
        return false;
    }
    /* Komuttaki sessionId aktif oturumla eşleşmese bile kesilir: sunucu BU cihaz için
     * kesme istiyor; yanlış pozitif yalnızca bir ikmali erken bitirir, yanlış negatif
     * ise yakıtın akmaya devam etmesi demektir. */
    (void)session_id;
    cut_and_finalize(s, YT_END_FORCE_CUTOFF, now_ms);
    return true;
}

bool yt_session_on_emergency_stop(yt_session_t *s, int64_t now_ms)
{
    if (s->state == YT_S_AUTHORIZED || s->state == YT_S_PUMPING) {
        /* Akan yakıt kayda geçsin diye ABORTED değil FINALIZING (litre raporlanır). */
        cut_and_finalize(s, YT_END_EMERGENCY_STOP, now_ms);
        return true;
    }
    if (s->state == YT_S_REQUESTING) {
        copy_str(s->denial, sizeof s->denial, "EMERGENCY_STOP");
        enter(s, YT_S_ABORTED, now_ms);
        return true;
    }
    return false;
}

bool yt_session_on_finalize_ok(yt_session_t *s, int64_t now_ms)
{
    if (s->state != YT_S_FINALIZING) return false;
    enter(s, YT_S_COMPLETED, now_ms);
    return true;
}

bool yt_session_on_finalize_failed(yt_session_t *s, int64_t now_ms)
{
    if (s->state != YT_S_FINALIZING) return false;
    s->finalize_attempts++;
    (void)now_ms;
    return true;
}

bool yt_session_on_finalize_rejected(yt_session_t *s, int64_t now_ms)
{
    if (s->state != YT_S_FINALIZING) return false;
    enter(s, YT_S_ABORTED, now_ms);
    return true;
}

bool yt_session_reset(yt_session_t *s, int64_t now_ms)
{
    if (s->state != YT_S_COMPLETED && s->state != YT_S_ABORTED) return false;
    yt_session_init(s);
    s->state_since_ms = now_ms;
    return true;
}

void yt_session_tick(yt_session_t *s, double session_liters, bool flowing, int64_t now_ms)
{
    if (s->state != YT_S_AUTHORIZED && s->state != YT_S_PUMPING) return;

    if (flowing) s->last_flow_ms = now_ms;

    /* Yerel limit: sunucunun FORCE_CUTOFF'unu beklemeden kes (ağ yavaş olabilir). */
    if (session_liters >= s->max_allowed_liters) {
        cut_and_finalize(s, YT_END_LIMIT_REACHED, now_ms);
        return;
    }
    if (s->state == YT_S_AUTHORIZED && session_liters <= 0.0 &&
        now_ms - s->state_since_ms >= YT_AUTH_START_TIMEOUT_MS) {
        cut_and_finalize(s, YT_END_NO_FLOW_STARTED, now_ms);
        return;
    }
    if (session_liters > 0.0 && now_ms - s->last_flow_ms >= YT_NO_FLOW_FINISH_MS) {
        cut_and_finalize(s, YT_END_FLOW_STOPPED, now_ms);
    }
}

bool yt_session_heartbeat_due(const yt_session_t *s, int64_t now_ms)
{
    if (s->state != YT_S_AUTHORIZED && s->state != YT_S_PUMPING) return false;
    return s->last_heartbeat_ms == 0 || now_ms - s->last_heartbeat_ms >= YT_HEARTBEAT_INTERVAL_MS;
}

void yt_session_mark_heartbeat_sent(yt_session_t *s, int64_t now_ms)
{
    s->last_heartbeat_ms = now_ms;
}

bool yt_session_finalize_pending(const yt_session_t *s)
{
    return s->state == YT_S_FINALIZING;
}

void yt_session_restore_abnormal(yt_session_t *s, const char *session_id, const char *idempotency_key,
                                 double start_totalizer, int64_t now_ms)
{
    yt_session_init(s);
    copy_str(s->session_id, sizeof s->session_id, session_id);
    copy_str(s->idempotency_key, sizeof s->idempotency_key, idempotency_key);
    s->start_totalizer = start_totalizer;
    s->cutoff_latched = true;            /* açılışta röle KAPALI başlar ve açılmaz */
    s->end_reason = YT_END_ABNORMAL_RESTART;
    enter(s, YT_S_FINALIZING, now_ms);
}

bool yt_session_recovered_after_restart(const yt_session_t *s)
{
    return s->end_reason == YT_END_ABNORMAL_RESTART;
}

const char *yt_session_state_name(yt_session_state_t st)
{
    switch (st) {
    case YT_S_IDLE: return "IDLE";
    case YT_S_REQUESTING: return "REQUESTING";
    case YT_S_AUTHORIZED: return "AUTHORIZED";
    case YT_S_PUMPING: return "PUMPING";
    case YT_S_FINALIZING: return "FINALIZING";
    case YT_S_COMPLETED: return "COMPLETED";
    case YT_S_ABORTED: return "ABORTED";
    }
    return "?";
}

const char *yt_end_reason_name(yt_end_reason_t r)
{
    switch (r) {
    case YT_END_NONE: return "NONE";
    case YT_END_FLOW_STOPPED: return "FLOW_STOPPED";
    case YT_END_LIMIT_REACHED: return "LIMIT_REACHED";
    case YT_END_FORCE_CUTOFF: return "FORCE_CUTOFF";
    case YT_END_EMERGENCY_STOP: return "EMERGENCY_STOP";
    case YT_END_NO_FLOW_STARTED: return "NO_FLOW_STARTED";
    case YT_END_ABNORMAL_RESTART: return "ABNORMAL_RESTART";
    }
    return "?";
}
