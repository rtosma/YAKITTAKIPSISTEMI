#include "yt_failopen.h"
#include "yt_test.h"

void test_failopen(void)
{
    yt_failopen_policy_t p = { true, true, false, 400.0, 3, 24 };
    const int64_t now = 1788700000;
    const int64_t fresh = now - 3600;           /* 1 saat önce senkron */
    const int64_t stale = now - 25 * 3600;      /* 25 saat önce */

    yt_failopen_decision_t d = yt_failopen_decide(&p, true, fresh, now, true, 0);
    CHECK(d.verdict == YT_FO_ALLOW);
    CHECK_NEAR(d.max_liters, 400.0, 1e-12);

    /* Politika hiç alınmadıysa ikmal yok (güvenli varsayılan). */
    yt_failopen_policy_t none = { 0 };
    CHECK(yt_failopen_decide(&none, true, fresh, now, true, 0).verdict == YT_FO_DENY_NO_POLICY);
    CHECK(yt_failopen_decide(NULL, true, fresh, now, true, 0).verdict == YT_FO_DENY_NO_POLICY);

    /* failClose, offlineDispenseAllowed'ı EZER. */
    yt_failopen_policy_t fc = p; fc.fail_close = true;
    CHECK(yt_failopen_decide(&fc, true, fresh, now, true, 0).verdict == YT_FO_DENY_FAIL_CLOSE);
    yt_failopen_policy_t off = p; off.offline_dispense_allowed = false;
    CHECK(yt_failopen_decide(&off, true, fresh, now, true, 0).verdict == YT_FO_DENY_OFFLINE_DISABLED);

    CHECK(yt_failopen_decide(&p, true, fresh, now, false, 0).verdict == YT_FO_DENY_CLOCK_UNTRUSTED);
    CHECK(yt_failopen_decide(&p, false, fresh, now, true, 0).verdict == YT_FO_DENY_NOT_WHITELISTED);
    CHECK(yt_failopen_decide(&p, true, stale, now, true, 0).verdict == YT_FO_DENY_WHITELIST_STALE);
    CHECK(yt_failopen_decide(&p, true, 0, now, true, 0).verdict == YT_FO_DENY_WHITELIST_STALE);
    CHECK(yt_failopen_decide(&p, true, now + 600, now, true, 0).verdict == YT_FO_DENY_WHITELIST_STALE); /* saat geri gitti */
    /* Tam sınırda (24 saat) hâlâ taze. */
    CHECK(yt_failopen_decide(&p, true, now - 24 * 3600, now, true, 0).verdict == YT_FO_ALLOW);

    /* Günlük sınır 3: bugün 2 alım yapıldıysa 3. serbest, 3 yapıldıysa 4. reddedilir. */
    CHECK(yt_failopen_decide(&p, true, fresh, now, true, 2).verdict == YT_FO_ALLOW);
    CHECK(yt_failopen_decide(&p, true, fresh, now, true, 3).verdict == YT_FO_DENY_DAILY_LIMIT);

    CHECK_STR(yt_failopen_verdict_name(YT_FO_DENY_DAILY_LIMIT), "DAILY_LIMIT");
}
