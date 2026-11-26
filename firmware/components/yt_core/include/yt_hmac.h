/*
 * FW-1308 — Cihaz HTTP isteklerinin HMAC-SHA256 imzası.
 *
 * Sözleşme: docs/HARDWARE_INTEGRATION_GUIDE.md §2 (sunucu: hardwareAuthMiddleware.ts)
 *
 *   signString = <X-Timestamp> + "." + <X-Nonce> + "." + <rawBody>
 *   X-Hardware-Signature = küçük harf hex(HMAC_SHA256(signString, deviceSecret))
 *
 * - rawBody, gövdenin GÖNDERİLEN baytlarının birebir aynısıdır; gövdesiz istekte "{}".
 * - Nonce: istek başına 16 bayt rastgele (donanım RNG'si, esp_random) → 32 hex.
 *
 * Bu modül IDF'ye bağımlı değildir (yalnızca mbedTLS); bilgisayarda birim testle
 * şartnamedeki resmi test vektörlerine karşı doğrulanır (firmware/test/host).
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define YT_HMAC_HEX_LEN 64   /* 32 bayt → 64 hex karakter (+1 '\0') */
#define YT_NONCE_BYTES 16
#define YT_NONCE_HEX_LEN 32  /* +1 '\0' */

/** Rastgele bayt kaynağı. Cihazda esp_fill_random; testte deterministik. */
typedef void (*yt_rng_fn)(void *buf, size_t len);

/**
 * İmzayı hesaplar. body NULL ya da boşsa "{}" imzalanır (gövdesiz istek kuralı).
 * out_hex en az YT_HMAC_HEX_LEN + 1 bayt olmalı. Başarıda 0, hatada < 0 döner.
 */
int yt_hmac_sign(const char *secret, const char *timestamp, const char *nonce_hex,
                 const char *body, size_t body_len, char *out_hex);

/** 16 rastgele bayttan 32 karakterlik küçük harf hex nonce üretir (out en az 33 bayt). */
void yt_nonce_hex(yt_rng_fn rng, char *out);

/** Baytları küçük harf hex'e çevirir (out en az 2*len + 1 bayt). */
void yt_to_hex(const uint8_t *in, size_t len, char *out);

#ifdef __cplusplus
}
#endif
