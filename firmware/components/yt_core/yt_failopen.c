#include "yt_failopen.h"

#include <math.h>

static yt_failopen_decision_t deny(yt_failopen_verdict_t v)
{
    yt_failopen_decision_t d = { v, 0.0 };
    return d;
}

yt_failopen_decision_t yt_failopen_decide(const yt_failopen_policy_t *p, bool card_whitelisted,
                                          int64_t whitelist_synced_at_s, int64_t now_s,
                                          bool clock_trusted, int dispenses_today)
{
    if (!p || !p->received) return deny(YT_FO_DENY_NO_POLICY);
    if (p->fail_close) return deny(YT_FO_DENY_FAIL_CLOSE);
    if (!p->offline_dispense_allowed) return deny(YT_FO_DENY_OFFLINE_DISABLED);
    if (!clock_trusted) return deny(YT_FO_DENY_CLOCK_UNTRUSTED);
    if (!card_whitelisted) return deny(YT_FO_DENY_NOT_WHITELISTED);

    int64_t max_age_s = (int64_t)p->whitelist_freshness_hours * 3600;
    int64_t age_s = now_s - whitelist_synced_at_s;
    /* Gelecekte görünen senkron zamanı da (saat geri gitti) bayat sayılır. */
    if (whitelist_synced_at_s <= 0 || max_age_s <= 0 || age_s < 0 || age_s > max_age_s) {
        return deny(YT_FO_DENY_WHITELIST_STALE);
    }
    if (dispenses_today >= p->max_daily_dispenses_per_vehicle) return deny(YT_FO_DENY_DAILY_LIMIT);
    if (!(p->max_liters_per_vehicle > 0) || !isfinite(p->max_liters_per_vehicle)) {
        return deny(YT_FO_DENY_OFFLINE_DISABLED);
    }

    yt_failopen_decision_t d = { YT_FO_ALLOW, p->max_liters_per_vehicle };
    return d;
}

const char *yt_failopen_verdict_name(yt_failopen_verdict_t v)
{
    switch (v) {
    case YT_FO_ALLOW: return "ALLOW";
    case YT_FO_DENY_NO_POLICY: return "NO_POLICY";
    case YT_FO_DENY_FAIL_CLOSE: return "FAIL_CLOSE";
    case YT_FO_DENY_OFFLINE_DISABLED: return "OFFLINE_DISABLED";
    case YT_FO_DENY_CLOCK_UNTRUSTED: return "CLOCK_UNTRUSTED";
    case YT_FO_DENY_NOT_WHITELISTED: return "NOT_WHITELISTED";
    case YT_FO_DENY_WHITELIST_STALE: return "WHITELIST_STALE";
    case YT_FO_DENY_DAILY_LIMIT: return "DAILY_LIMIT";
    }
    return "?";
}
