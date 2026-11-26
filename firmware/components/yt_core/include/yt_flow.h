/*
 * FW-1304 — Akışmetre pals → litre hesabı, totalizatör ve anlık debi (saf mantık).
 *
 * Pals sayımının kendisi donanımda (PCNT çevre birimi) yapılır; bu modül yalnızca
 * okunan pals artışlarını işler. IDF'ye bağımlı değildir, bilgisayarda test edilir.
 *
 * Kurallar (FW-1304 + rehber §9.2):
 *  - Totalizatör ömür boyu, SIFIRLANMAYAN, 64-bit (32-bit taşma yok).
 *  - Heartbeat'te KÜMÜLATİF totalizatör litresi gönderilir; ikmal litresi
 *    "son − başlangıç" farkıdır (sunucunun asıl doğruluk kaynağı).
 *  - K-faktörü (pals/litre) ikmal SIRASINDA değişemez: değişiklik bekletilir ve
 *    ikmal bitince uygulanır; aksi halde o ikmalin litresi tutarsız olur.
 *  - K değişince geçmiş litre korunur (eski K ile birikmiş litre sabitlenir).
 *  - Anlık debi (L/dk) son 1 saniyelik pencereden hesaplanır.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define YT_FLOW_K_MIN 1.0        /* pals/L — makul alt sınır (ör. büyük çaplı sayaç) */
#define YT_FLOW_K_MAX 100000.0   /* pals/L — makul üst sınır */
#define YT_FLOW_RATE_WINDOW_MS 1000
#define YT_FLOW_RATE_SLOTS 10    /* 100 ms'lik dilimler */

typedef struct {
    double k_factor;               /* pals/litre (uygulanan) */
    double pending_k_factor;       /* ikmal sırasında gelen değişiklik */
    bool has_pending_k;

    uint64_t pulses_since_k;       /* mevcut K ile sayılan pals */
    double liters_before_k;        /* önceki K'lerle birikmiş litre (sabit) */

    bool in_session;
    double session_start_liters;   /* ikmal başındaki totalizatör */

    /* anlık debi: 100 ms'lik dilimlerde pals */
    uint32_t slot_pulses[YT_FLOW_RATE_SLOTS];
    int64_t slot_start_ms[YT_FLOW_RATE_SLOTS];
} yt_flow_t;

typedef enum {
    YT_FLOW_K_APPLIED = 0,   /* hemen uygulandı */
    YT_FLOW_K_DEFERRED = 1,  /* ikmal sürüyor — bitince uygulanacak */
    YT_FLOW_K_INVALID = -1   /* aralık dışı / sayı değil — reddedildi */
} yt_flow_k_result_t;

/** totalizer_liters: NVS'ten geri yüklenen kümülatif değer (ilk kurulumda 0). */
void yt_flow_init(yt_flow_t *f, double k_factor, double totalizer_liters);

/** PCNT'den okunan pals artışını işle. now_ms: monoton milisaniye. */
void yt_flow_add_pulses(yt_flow_t *f, uint32_t pulses, int64_t now_ms);

/** Ömür boyu kümülatif litre (heartbeat'teki totalizerLiters). */
double yt_flow_totalizer_liters(const yt_flow_t *f);

/** Son 1 sn'deki anlık debi, L/dk. */
double yt_flow_rate_lpm(const yt_flow_t *f, int64_t now_ms);

/** Yeni K-faktörü talebi (uzaktan kalibrasyon). */
yt_flow_k_result_t yt_flow_set_k_factor(yt_flow_t *f, double k_factor);

void yt_flow_session_begin(yt_flow_t *f);
/** Bu ikmalde akan litre (totalizatör farkı). */
double yt_flow_session_liters(const yt_flow_t *f);
/** İkmali bitirir; bekleyen K değişikliğini uygular. Dönen değer: ikmal litresi. */
double yt_flow_session_end(yt_flow_t *f);

#ifdef __cplusplus
}
#endif
