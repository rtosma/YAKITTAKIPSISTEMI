/*
 * QEMU açılış testi yardımcısı: NVS'e konacak oturum kaydını (yt_persist biçimi) hex basar.
 *   mkmarker <sessionId> [active|finalizing] [corrupt]
 * Cihazdaki AYNI yt_core kaynağıyla derlenir; biçim değişirse test de değişir.
 */
#include <stdio.h>
#include <string.h>

#include "yt_persist.h"

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "kullanım: %s <sessionId> [active|finalizing] [corrupt]\n", argv[0]);
        return 2;
    }
    yt_session_t s;
    yt_session_init(&s);
    yt_session_on_card(&s, "CARD-881201", 0);
    yt_session_on_auth_granted(&s, argv[1], 320.0, 1200.5, "pump-7", 10);
    yt_session_on_heartbeat_ack(&s, false, 100);
    if (argc > 2 && strcmp(argv[2], "finalizing") == 0) {
        yt_session_tick(&s, 12.0, true, 1000);
        yt_session_on_heartbeat_ack(&s, false, 1000 + YT_NO_FLOW_FINISH_MS - 100);
        yt_session_tick(&s, 12.0, false, 1000 + YT_NO_FLOW_FINISH_MS);
    }
    yt_session_marker_t m;
    yt_marker_from_session(&s, &m);
    uint8_t buf[YT_MARKER_ENCODED_MAX];
    size_t n = yt_marker_encode(&m, buf, sizeof buf);
    if (n == 0) return 1;
    if (argc > 3 && strcmp(argv[3], "corrupt") == 0) buf[12] ^= 0x40; /* CRC artık tutmaz */
    for (size_t i = 0; i < n; i++) printf("%02x", buf[i]);
    printf("\n");
    return 0;
}
