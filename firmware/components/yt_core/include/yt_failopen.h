/*
 * FW-1310 — Sunucuya erişilemezken (fail-open) ikmal kararı (saf mantık).
 *
 * Sözleşme: docs/HARDWARE_INTEGRATION_GUIDE.md §8 (sunucu: FUEL-410).
 * Politika GET /telemetry/fail-open-policy ile periyodik çekilip NVS'te saklanır:
 *   offlineDispenseAllowed, failClose, maxLitersPerVehicle,
 *   maxDailyDispensesPerVehicle, whitelistFreshnessHours
 *
 * Kurallar:
 *  - Politika hiç alınmadıysa → ikmal YOK (güvenli varsayılan).
 *  - failClose = true → offlineDispenseAllowed'ı EZER, ikmal yok.
 *  - Kart yerel whitelist'te olmalı ve whitelist whitelistFreshnessHours'tan taze olmalı.
 *  - Araç başına günlük alım sayısı ve tek seferde litre sınırı uygulanır.
 *  - Cihaz saati şüpheliyse (RTC senkronsuz) tazelik doğrulanamaz → ikmal yok.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool received;                     /* sunucudan en az bir kez alındı mı */
    bool offline_dispense_allowed;
    bool fail_close;
    double max_liters_per_vehicle;
    int max_daily_dispenses_per_vehicle;
    int whitelist_freshness_hours;
} yt_failopen_policy_t;

typedef enum {
    YT_FO_ALLOW = 0,
    YT_FO_DENY_NO_POLICY,
    YT_FO_DENY_FAIL_CLOSE,
    YT_FO_DENY_OFFLINE_DISABLED,
    YT_FO_DENY_CLOCK_UNTRUSTED,
    YT_FO_DENY_NOT_WHITELISTED,
    YT_FO_DENY_WHITELIST_STALE,
    YT_FO_DENY_DAILY_LIMIT,
} yt_failopen_verdict_t;

typedef struct {
    yt_failopen_verdict_t verdict;
    double max_liters;                 /* ALLOW'da bu ikmale verilen üst sınır */
} yt_failopen_decision_t;

/**
 * @param card_whitelisted       kart yerel whitelist'te mi
 * @param whitelist_synced_at_s  whitelist'in son başarılı senkron zamanı (epoch sn, 0 = hiç)
 * @param now_s                  cihazın güvenilir epoch saniyesi
 * @param clock_trusted          RTC/NTP ile senkron mu (FW-1312)
 * @param dispenses_today        bu aracın bugünkü (İstanbul günü) çevrimdışı alım sayısı
 */
yt_failopen_decision_t yt_failopen_decide(const yt_failopen_policy_t *p, bool card_whitelisted,
                                          int64_t whitelist_synced_at_s, int64_t now_s,
                                          bool clock_trusted, int dispenses_today);

const char *yt_failopen_verdict_name(yt_failopen_verdict_t v);

#ifdef __cplusplus
}
#endif
