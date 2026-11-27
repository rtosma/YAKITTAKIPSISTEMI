/*
 * Sunucu bağlantı görevi. HTTP istekleri (TLS el sıkışması saniyeler sürebilir) röleyi
 * süren 100 ms'lik denetim döngüsünü ASLA bekletmez: döngü isteği bırakır, bu görev
 * gönderir, sonuç bir sonraki turda okunur. Aynı anda tek istek (TLS belleği, FW-1307).
 */
#pragma once

#include <stdbool.h>

#include "yt_net.h"

typedef enum {
    LINK_NONE = 0,
    LINK_AUTH,
    LINK_HEARTBEAT,
    LINK_FINALIZE,
    LINK_CALIBRATION,   /* POST /telemetry/calibration-ack (FUEL-404.1) */
} link_kind_t;

void app_link_start(void);

/** İstek bırak (meşgulken false). path ve body kopyalanır. */
bool app_link_submit(link_kind_t kind, const char *path, const char *body);

/** Biten istek var mı. Varsa sonuç app_link_release()'e kadar geçerli. */
bool app_link_poll(link_kind_t *kind, const yt_http_resp_t **resp);

void app_link_release(void);

bool app_link_busy(void);
