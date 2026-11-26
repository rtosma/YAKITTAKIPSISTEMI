/*
 * FW-1314 / FW-1304 / FW-1308 — Kalıcı cihaz durumu (NVS).
 *
 * Ad alanı "yt":     tot_ml (u64, totalizatör mL), k_factor (double), sess (oturum kaydı)
 * Ad alanı "yt_sec": dev_id, secret (claim ile gelen HMAC secret'ı)
 *
 * NVS AÇILAMAZSA OTOMATİK SİLİNMEZ. ESP-IDF örneklerindeki "hata → nvs_flash_erase()"
 * kalıbı burada yanlış olur: totalizatör, K-faktörü ve secret sessizce sıfırlanır,
 * faturalama zinciri kopar. Bunun yerine yt_store_ready() false kalır, cihaz ikmal
 * kabul etmez ve servis gerekir.
 *
 * Üretimde secret şifreli saklanır: flash şifreleme + CONFIG_NVS_ENCRYPTION açılınca
 * nvs_flash_init() anahtarları "nvs_keys" bölümünden kendisi okur (kod değişmez).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "nvs.h" /* ESP_ERR_NVS_* dönüş kodları */
#include "yt_persist.h"

#ifdef __cplusplus
extern "C" {
#endif

#define YT_DEVICE_ID_MAX 64
#define YT_SECRET_MAX 129   /* 64 bayt hex + NUL */

esp_err_t yt_store_init(void);
bool yt_store_ready(void);

/** ESP_ERR_NVS_NOT_FOUND: ilk kurulum (0'dan başlanır). */
esp_err_t yt_store_load_totalizer_ml(uint64_t *ml);
esp_err_t yt_store_save_totalizer_ml(uint64_t ml);

/** ESP_ERR_NVS_NOT_FOUND: hiç kalibre edilmedi; ESP_ERR_INVALID_STATE: kayıtlı değer aralık dışı. */
esp_err_t yt_store_load_k_factor(double *k);
esp_err_t yt_store_save_k_factor(double k);

/** ESP_ERR_NVS_NOT_FOUND: yarım oturum yok; ESP_ERR_INVALID_CRC: kayıt bozuk/eski sürüm. */
esp_err_t yt_store_load_marker(yt_session_marker_t *m);
esp_err_t yt_store_save_marker(const yt_session_marker_t *m);
esp_err_t yt_store_clear_marker(void);

/** Claim (IOT-304) sonrası cihaz kimliği ve HMAC secret'ı. */
esp_err_t yt_store_load_credentials(char *device_id, size_t id_cap, char *secret, size_t secret_cap);
esp_err_t yt_store_save_credentials(const char *device_id, const char *secret);

#ifdef __cplusplus
}
#endif
