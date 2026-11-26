#include "yt_flow.h"

#include <math.h>
#include <string.h>

#define SLOT_MS (YT_FLOW_RATE_WINDOW_MS / YT_FLOW_RATE_SLOTS)

static bool k_valid(double k)
{
    return isfinite(k) && k >= YT_FLOW_K_MIN && k <= YT_FLOW_K_MAX;
}

void yt_flow_init(yt_flow_t *f, double k_factor, double totalizer_liters)
{
    memset(f, 0, sizeof *f);
    f->k_factor = k_valid(k_factor) ? k_factor : 450.0; /* mevcut saha taslağındaki değer */
    f->liters_before_k = (isfinite(totalizer_liters) && totalizer_liters > 0) ? totalizer_liters : 0.0;
    for (int i = 0; i < YT_FLOW_RATE_SLOTS; i++) f->slot_start_ms[i] = INT64_MIN;
}

double yt_flow_totalizer_liters(const yt_flow_t *f)
{
    return f->liters_before_k + (double)f->pulses_since_k / f->k_factor;
}

void yt_flow_add_pulses(yt_flow_t *f, uint32_t pulses, int64_t now_ms)
{
    f->pulses_since_k += pulses;

    int64_t slot_start = now_ms - (now_ms % SLOT_MS);
    int idx = (int)((now_ms / SLOT_MS) % YT_FLOW_RATE_SLOTS);
    if (f->slot_start_ms[idx] != slot_start) {
        f->slot_start_ms[idx] = slot_start;
        f->slot_pulses[idx] = 0;
    }
    f->slot_pulses[idx] += pulses;
}

double yt_flow_rate_lpm(const yt_flow_t *f, int64_t now_ms)
{
    uint64_t sum = 0;
    for (int i = 0; i < YT_FLOW_RATE_SLOTS; i++) {
        int64_t age = now_ms - f->slot_start_ms[i];
        if (f->slot_start_ms[i] != INT64_MIN && age >= 0 && age < YT_FLOW_RATE_WINDOW_MS) {
            sum += f->slot_pulses[i];
        }
    }
    double liters = (double)sum / f->k_factor;
    return liters * (60000.0 / YT_FLOW_RATE_WINDOW_MS);
}

static void apply_k(yt_flow_t *f, double k)
{
    /* Mevcut K ile birikmiş litreyi sabitle, sayacı yeni K için sıfırla. */
    f->liters_before_k = yt_flow_totalizer_liters(f);
    f->pulses_since_k = 0;
    f->k_factor = k;
}

yt_flow_k_result_t yt_flow_set_k_factor(yt_flow_t *f, double k_factor)
{
    if (!k_valid(k_factor)) return YT_FLOW_K_INVALID;
    if (f->in_session) {
        f->pending_k_factor = k_factor;
        f->has_pending_k = true;
        return YT_FLOW_K_DEFERRED;
    }
    apply_k(f, k_factor);
    return YT_FLOW_K_APPLIED;
}

void yt_flow_session_begin(yt_flow_t *f)
{
    f->in_session = true;
    f->session_start_liters = yt_flow_totalizer_liters(f);
}

double yt_flow_session_liters(const yt_flow_t *f)
{
    if (!f->in_session) return 0.0;
    double d = yt_flow_totalizer_liters(f) - f->session_start_liters;
    return d > 0 ? d : 0.0;
}

double yt_flow_session_end(yt_flow_t *f)
{
    double liters = yt_flow_session_liters(f);
    f->in_session = false;
    if (f->has_pending_k) {
        apply_k(f, f->pending_k_factor);
        f->has_pending_k = false;
    }
    return liters;
}
