#include <stdint.h>
#include "yt_hmac.h"
#include "yt_test.h"

/* docs/HARDWARE_INTEGRATION_GUIDE.md §2.5 — sunucunun GERÇEK doğrulama koduyla üretilmiş vektörler. */
static const char *SECRET = "ornek_test_gizli_anahtar_12345";
static const char *TS = "1788700000000";
static const char *NONCE = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

static void counter_rng(void *buf, size_t len)
{
    static uint8_t n = 0;
    uint8_t *b = buf;
    for (size_t i = 0; i < len; i++) b[i] = n++;
}

void test_hmac(void)
{
    char sig[YT_HMAC_HEX_LEN + 1];

    /* Vektör 1 — gövdesiz istek: "{}" imzalanır. NULL ve boş gövde aynı sonucu vermeli. */
    CHECK(yt_hmac_sign(SECRET, TS, NONCE, NULL, 0, sig) == 0);
    CHECK_STR(sig, "991aa39d17cc4e261a57861ef19a2fb1738b8e7a729d6b94f21749cf1e51dd86");
    CHECK(yt_hmac_sign(SECRET, TS, NONCE, "", 0, sig) == 0);
    CHECK_STR(sig, "991aa39d17cc4e261a57861ef19a2fb1738b8e7a729d6b94f21749cf1e51dd86");
    CHECK(yt_hmac_sign(SECRET, TS, NONCE, "{}", 2, sig) == 0);
    CHECK_STR(sig, "991aa39d17cc4e261a57861ef19a2fb1738b8e7a729d6b94f21749cf1e51dd86");

    /* Vektör 2 — gövdeli istek (POST /dispense/request-auth). */
    const char *body = "{\"rfidCardId\":\"CARD-881201\",\"tankName\":\"Gebze Ana Tank (T-1)\"}";
    CHECK(yt_hmac_sign(SECRET, TS, NONCE, body, strlen(body), sig) == 0);
    CHECK_STR(sig, "d621eddad2c20ba99ead9816370c8eeea773d2a90a4d120701f9222622c4911d");

    /* Gövdedeki tek bir boşluk farkı imzayı değiştirir (bayt bayt aynı gönderilmeli). */
    const char *spaced = "{\"rfidCardId\": \"CARD-881201\",\"tankName\":\"Gebze Ana Tank (T-1)\"}";
    CHECK(yt_hmac_sign(SECRET, TS, NONCE, spaced, strlen(spaced), sig) == 0);
    CHECK(strcmp(sig, "d621eddad2c20ba99ead9816370c8eeea773d2a90a4d120701f9222622c4911d") != 0);

    /* Geçersiz girdi: secret yoksa imza üretilmez. */
    CHECK(yt_hmac_sign("", TS, NONCE, NULL, 0, sig) < 0);
    CHECK(yt_hmac_sign(NULL, TS, NONCE, NULL, 0, sig) < 0);

    /* Nonce: 32 küçük harf hex, art arda farklı. */
    char n1[YT_NONCE_HEX_LEN + 1], n2[YT_NONCE_HEX_LEN + 1];
    yt_nonce_hex(counter_rng, n1);
    yt_nonce_hex(counter_rng, n2);
    CHECK(strlen(n1) == 32);
    CHECK(strspn(n1, "0123456789abcdef") == 32);
    CHECK(strcmp(n1, n2) != 0);
    CHECK_STR(n1, "000102030405060708090a0b0c0d0e0f");
}
