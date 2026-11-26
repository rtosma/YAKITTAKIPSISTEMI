#include "yt_persist.h"

#include <math.h>
#include <string.h>

#define MARKER_MAGIC 0x4D535459u /* "YTSM" (little-endian) */
#define MARKER_VERSION 1u

/* ---------- totalizatör commit politikası ---------- */

void yt_commit_init(yt_commit_policy_t *c, uint64_t committed_ml, int64_t now_ms)
{
    c->committed_ml = committed_ml;
    c->committed_at_ms = now_ms;
}

bool yt_commit_due(const yt_commit_policy_t *c, uint64_t totalizer_ml, int64_t now_ms)
{
    /* Değişiklik yoksa (rölanti) yazma; totalizatör geri gitmez, gerisini de yazma. */
    if (totalizer_ml <= c->committed_ml) return false;
    if (totalizer_ml - c->committed_ml >= YT_COMMIT_STEP_ML) return true;
    return now_ms - c->committed_at_ms >= YT_COMMIT_MAX_INTERVAL_MS;
}

void yt_commit_done(yt_commit_policy_t *c, uint64_t totalizer_ml, int64_t now_ms)
{
    if (totalizer_ml > c->committed_ml) c->committed_ml = totalizer_ml;
    c->committed_at_ms = now_ms;
}

uint64_t yt_liters_to_ml(double liters)
{
    if (!(liters > 0) || !isfinite(liters)) return 0;
    double ml = floor(liters * 1000.0 + 1e-6); /* 0.3 L * 1000 = 299.999… → 300 */
    if (ml >= 18446744073709549568.0) return UINT64_MAX;
    return (uint64_t)ml;
}

double yt_ml_to_liters(uint64_t ml)
{
    return (double)ml / 1000.0;
}

/* ---------- oturum işareti ---------- */

uint32_t yt_crc32(const uint8_t *data, size_t len)
{
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int b = 0; b < 8; b++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}

yt_marker_phase_t yt_marker_phase_for(const yt_session_t *s)
{
    switch (s->state) {
    case YT_S_AUTHORIZED:
    case YT_S_PUMPING: return YT_MARKER_ACTIVE;
    case YT_S_FINALIZING: return YT_MARKER_FINALIZING;
    default: return YT_MARKER_NONE;
    }
}

void yt_marker_from_session(const yt_session_t *s, yt_session_marker_t *m)
{
    memset(m, 0, sizeof *m);
    m->phase = yt_marker_phase_for(s);
    m->end_reason = s->end_reason;
    m->start_totalizer = s->start_totalizer;
    memcpy(m->session_id, s->session_id, sizeof m->session_id);
    m->session_id[sizeof m->session_id - 1] = '\0';
    memcpy(m->idempotency_key, s->idempotency_key, sizeof m->idempotency_key);
    m->idempotency_key[sizeof m->idempotency_key - 1] = '\0';
}

static void put_u32(uint8_t *p, uint32_t v)
{
    for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i));
}

static uint32_t get_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static size_t bounded_len(const char *s, size_t max)
{
    size_t n = 0;
    while (n < max && s[n] != '\0') n++;
    return n;
}

size_t yt_marker_encode(const yt_session_marker_t *m, uint8_t *buf, size_t cap)
{
    size_t sid_len = bounded_len(m->session_id, YT_SESSION_ID_MAX - 1);
    size_t key_len = bounded_len(m->idempotency_key, YT_IDEMPOTENCY_MAX - 1);
    size_t need = 4 + 4 + 8 + 1 + sid_len + 1 + key_len + 4;
    if (!buf || cap < need) return 0;

    size_t p = 0;
    put_u32(buf + p, MARKER_MAGIC); p += 4;
    buf[p++] = MARKER_VERSION;
    buf[p++] = (uint8_t)m->phase;
    buf[p++] = (uint8_t)m->end_reason;
    buf[p++] = 0;
    uint64_t bits;
    memcpy(&bits, &m->start_totalizer, sizeof bits);
    put_u32(buf + p, (uint32_t)bits); p += 4;
    put_u32(buf + p, (uint32_t)(bits >> 32)); p += 4;
    buf[p++] = (uint8_t)sid_len;
    memcpy(buf + p, m->session_id, sid_len); p += sid_len;
    buf[p++] = (uint8_t)key_len;
    memcpy(buf + p, m->idempotency_key, key_len); p += key_len;
    put_u32(buf + p, yt_crc32(buf, p)); p += 4;
    return p;
}

bool yt_marker_decode(const uint8_t *buf, size_t len, yt_session_marker_t *m)
{
    memset(m, 0, sizeof *m);
    if (!buf || len < 4 + 4 + 8 + 1 + 1 + 4 || len > YT_MARKER_ENCODED_MAX) return false;
    if (get_u32(buf) != MARKER_MAGIC || buf[4] != MARKER_VERSION) return false;
    if (yt_crc32(buf, len - 4) != get_u32(buf + len - 4)) return false;

    size_t body_end = len - 4;
    size_t p = 5;
    uint8_t phase = buf[p++];
    uint8_t reason = buf[p++];
    p++; /* ayrılmış */
    uint64_t bits = (uint64_t)get_u32(buf + p) | (uint64_t)get_u32(buf + p + 4) << 32;
    p += 8;
    double start;
    memcpy(&start, &bits, sizeof start);

    size_t sid_len = buf[p++];
    if (sid_len == 0 || sid_len > YT_SESSION_ID_MAX - 1 || p + sid_len + 1 > body_end) return false;
    memcpy(m->session_id, buf + p, sid_len);
    p += sid_len;
    size_t key_len = buf[p++];
    if (key_len == 0 || key_len > YT_IDEMPOTENCY_MAX - 1 || p + key_len != body_end) return false;
    memcpy(m->idempotency_key, buf + p, key_len);

    if (phase != YT_MARKER_ACTIVE && phase != YT_MARKER_FINALIZING) return false;
    if (reason >= YT_END__COUNT) return false;
    if (!isfinite(start) || start < 0) return false;
    if (memchr(m->session_id, '\0', sid_len) || memchr(m->idempotency_key, '\0', key_len)) return false;

    m->phase = (yt_marker_phase_t)phase;
    m->end_reason = (yt_end_reason_t)reason;
    m->start_totalizer = start;
    return true;
}

bool yt_marker_restore(const yt_session_marker_t *m, yt_session_t *s, int64_t now_ms)
{
    if (!m || m->session_id[0] == '\0' || m->idempotency_key[0] == '\0' ||
        (m->phase != YT_MARKER_ACTIVE && m->phase != YT_MARKER_FINALIZING)) {
        yt_session_init(s);
        return false;
    }
    yt_session_restore_abnormal(s, m->session_id, m->idempotency_key, m->start_totalizer, now_ms);
    /* İkmal normal bitmiş ve sayaç o anda commit edilmişti: veri kaybı yok, asıl sebep
     * korunur. ACTIVE'de veya iki kez yeniden başlanmışsa ABNORMAL_RESTART kalır. */
    if (m->phase == YT_MARKER_FINALIZING && m->end_reason != YT_END_NONE) {
        s->end_reason = m->end_reason;
    }
    return true;
}
