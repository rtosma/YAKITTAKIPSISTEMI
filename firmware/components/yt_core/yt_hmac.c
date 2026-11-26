#include "yt_hmac.h"

#include <string.h>

#include "mbedtls/md.h"

void yt_to_hex(const uint8_t *in, size_t len, char *out)
{
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[2 * i] = digits[in[i] >> 4];
        out[2 * i + 1] = digits[in[i] & 0x0f];
    }
    out[2 * len] = '\0';
}

void yt_nonce_hex(yt_rng_fn rng, char *out)
{
    uint8_t raw[YT_NONCE_BYTES];
    rng(raw, sizeof raw);
    yt_to_hex(raw, sizeof raw, out);
    memset(raw, 0, sizeof raw);
}

int yt_hmac_sign(const char *secret, const char *timestamp, const char *nonce_hex,
                 const char *body, size_t body_len, char *out_hex)
{
    if (!secret || !timestamp || !nonce_hex || !out_hex || secret[0] == '\0') {
        return -1;
    }
    /* Gövdesiz istek: sunucu "{}" imzalar (rehber §2.1). */
    if (!body || body_len == 0) {
        body = "{}";
        body_len = 2;
    }

    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (!info) {
        return -2;
    }

    /* İmzalanan dizeyi bellekte birleştirmek yerine akış halinde besle:
     * büyük gövdeler (sync-batch) için ek tampon gerekmez. */
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    int rc = mbedtls_md_setup(&ctx, info, 1 /* HMAC */);
    if (rc == 0) rc = mbedtls_md_hmac_starts(&ctx, (const unsigned char *)secret, strlen(secret));
    if (rc == 0) rc = mbedtls_md_hmac_update(&ctx, (const unsigned char *)timestamp, strlen(timestamp));
    if (rc == 0) rc = mbedtls_md_hmac_update(&ctx, (const unsigned char *)".", 1);
    if (rc == 0) rc = mbedtls_md_hmac_update(&ctx, (const unsigned char *)nonce_hex, strlen(nonce_hex));
    if (rc == 0) rc = mbedtls_md_hmac_update(&ctx, (const unsigned char *)".", 1);
    if (rc == 0) rc = mbedtls_md_hmac_update(&ctx, (const unsigned char *)body, body_len);

    uint8_t mac[32];
    if (rc == 0) rc = mbedtls_md_hmac_finish(&ctx, mac);
    mbedtls_md_free(&ctx);
    if (rc != 0) {
        return -3;
    }
    yt_to_hex(mac, sizeof mac, out_hex);
    memset(mac, 0, sizeof mac);
    return 0;
}
