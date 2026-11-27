#include "yt_rfid.h"

#include <stdio.h>
#include <string.h>

yt_uid_check_t yt_uid_check(const uint8_t *uid, size_t len)
{
    if (!uid || (len != 4 && len != 7 && len != 10)) return YT_UID_BAD_LENGTH;
    bool all00 = true, allff = true;
    for (size_t i = 0; i < len; i++) {
        if (uid[i] != 0x00) all00 = false;
        if (uid[i] != 0xFF) allff = false;
    }
    if (all00 || allff) return YT_UID_NOISE;
    if (uid[0] == 0x88) return YT_UID_CASCADE;
    if (len == 4 && uid[0] == 0x08) return YT_UID_RANDOM;
    return YT_UID_OK;
}

const char *yt_uid_check_name(yt_uid_check_t c)
{
    switch (c) {
    case YT_UID_OK: return "OK";
    case YT_UID_BAD_LENGTH: return "BAD_LENGTH";
    case YT_UID_NOISE: return "NOISE";
    case YT_UID_CASCADE: return "CASCADE";
    case YT_UID_RANDOM: return "RANDOM_UID";
    }
    return "?";
}

size_t yt_uid_hex(const uint8_t *uid, size_t len, char *out, size_t cap)
{
    static const char hex[] = "0123456789ABCDEF";
    if (!uid || !out || len == 0 || 2 * len + 1 > cap) return 0;
    for (size_t i = 0; i < len; i++) {
        out[2 * i] = hex[uid[i] >> 4];
        out[2 * i + 1] = hex[uid[i] & 0x0F];
    }
    out[2 * len] = '\0';
    return 2 * len;
}

void yt_rfid_tracker_init(yt_rfid_tracker_t *t)
{
    memset(t, 0, sizeof *t);
}

static void emit(char *dst, size_t cap, const char *uid)
{
    if (dst && cap) snprintf(dst, cap, "%s", uid);
}

yt_rfid_event_t yt_rfid_tracker_feed(yt_rfid_tracker_t *t, const char *uid_hex, char *event_uid, size_t cap)
{
    if (event_uid && cap) event_uid[0] = '\0';

    if (!uid_hex || !uid_hex[0]) {
        t->candidate[0] = '\0';
        t->candidate_hits = 0;
        if (t->present[0] && ++t->misses >= YT_RFID_REMOVE_MISSES) {
            emit(event_uid, cap, t->present);
            t->present[0] = '\0';
            t->misses = 0;
            return YT_RFID_REMOVED;
        }
        return YT_RFID_NONE;
    }

    t->misses = 0;
    if (strcmp(uid_hex, t->present) == 0) {
        t->candidate[0] = '\0';
        t->candidate_hits = 0;
        return YT_RFID_NONE; /* okuyucuda duruyor */
    }
    if (strcmp(uid_hex, t->candidate) == 0) {
        t->candidate_hits++;
    } else {
        snprintf(t->candidate, sizeof t->candidate, "%s", uid_hex);
        t->candidate_hits = 1;
    }
    if (t->candidate_hits < YT_RFID_CONFIRM_READS) return YT_RFID_NONE;

    /* Onaylandı. Önceki kart çekilmeden yenisi geldiyse eskisi sessizce düşer. */
    snprintf(t->present, sizeof t->present, "%s", uid_hex);
    t->candidate[0] = '\0';
    t->candidate_hits = 0;
    emit(event_uid, cap, uid_hex);
    return YT_RFID_PRESENTED;
}
