/*
 * FW-1306 / FW-1307 / FW-1312 — Ağ bağlantısı, saat ve imzalı HTTP istemcisi.
 *
 * Bağlantı: WiFi istasyon (kimlik NVS'te), koparsa üstel geri çekilmeyle yeniden bağlanır
 * (1 sn → 5 dk). Bağlantı yokluğu HATA DEĞİL beklenen durumdur. QEMU testinde
 * (CONFIG_YT_NET_OPENETH) emüle Ethernet kullanılır. GSM/PPPoS sonraki adım.
 *
 * Saat: SNTP + sunucu yanıtlarındaki HTTP `Date` başlığı (ve heartbeat'teki serverTime).
 * Cihazda henüz RTC yok (FW-1312 DS3231 sonraki adım); sunucu ±30 sn dışındaki imzayı
 * reddettiği için saat güvenilir olmadan imzalı istek gönderilmez — önce imzasız
 * GET /health ile Date alınır.
 *
 * HTTP: her istek HMAC başlıklarıyla (rehber §2). HTTPS sertifikası ESP-IDF'in gömülü CA
 * paketiyle DOĞRULANIR; doğrulama kapatılamaz. Düz http:// yalnızca
 * CONFIG_YT_DEV_ALLOW_PLAINTEXT_HTTP ile (QEMU/geliştirme) kabul edilir.
 * TLS belleği nedeniyle istekler sıralıdır (tek görev, tek bağlantı).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define YT_NET_URL_MAX 128
#define YT_HTTP_RESP_MAX 4096

typedef struct {
    char base_url[YT_NET_URL_MAX];     /* ör. https://yakit.example.com/api/v1 */
    char device_id[64];
    char secret[129];
    char wifi_ssid[33];
    char wifi_pass[65];
} yt_net_config_t;

/** Ağ arayüzünü ve SNTP'yi başlatır. Bağlantı arka planda kurulur. */
esp_err_t yt_net_start(const yt_net_config_t *cfg);

/** IP alındı mı. */
bool yt_net_is_up(void);

/** WiFi sinyal gücü (dBm). Bilinmiyorsa / Ethernet'te 0. */
int yt_net_rssi(void);

/* ---------- saat ---------- */

/** Saat SNTP veya güvenilir sunucu yanıtıyla eşitlendi mi. */
bool yt_time_trusted(void);

/** Epoch ms (saat güvenilir değilse 0). */
int64_t yt_time_now_ms(void);

/** Sunucunun bildirdiği zaman (heartbeat serverTime, ms). Fark > 2 sn ise saat düzeltilir. */
void yt_time_observe_server(int64_t server_ms);

/* ---------- HTTP ---------- */

typedef struct {
    int status;                        /* HTTP durum kodu; <= 0: yanıt yok (ağ/TLS/zaman aşımı) */
    char body[YT_HTTP_RESP_MAX];       /* NUL sonlu, gerekirse kesilir */
} yt_http_resp_t;

/**
 * İmzalı istek. path base_url'e eklenir ("/dispense/heartbeat"). body NULL → GET.
 * Saat güvenilir değilse önce eşitlemeyi dener; olmazsa status = -1.
 */
void yt_http_signed(const char *path, const char *body, yt_http_resp_t *resp);

#ifdef __cplusplus
}
#endif
