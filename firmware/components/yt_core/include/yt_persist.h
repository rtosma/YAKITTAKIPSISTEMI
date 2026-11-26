/*
 * FW-1314 — Güç kesintisine dayanıklılık: totalizatörün NVS'e ne zaman yazılacağı ve
 * yarım kalan ikmal oturumunun kalıcı kaydı (saf mantık, bilgisayarda test edilir).
 *
 * Asıl NVS okuma/yazma components/yt_store'dadır; bu modül yalnızca KARARI ve kayıt
 * BİÇİMİNİ verir.
 *
 * 1) Totalizatör commit politikası
 *    Her palste yazmak flash'ı aylar içinde bitirir. Kural: akış varken son commit'ten
 *    bu yana 5 L birikince VEYA 10 sn geçince yaz; değişiklik yoksa hiç yazma (rölantide
 *    sıfır aşınma). Güç kesilirse kayıp = min(5 L, 10 sn'lik akış). Oturum geçişlerinde
 *    (başlangıç / bitiş) çağıran ayrıca zorla commit eder. Hesap: firmware/README.md.
 *
 * 2) Oturum işareti (marker)
 *    Yetki alındığı anda (AUTHORIZED) NVS'e yazılır, ikmal bitince (FINALIZING) güncellenir,
 *    sunucu kabul edince (COMPLETED / ABORTED) silinir. Açılışta varsa:
 *      - ACTIVE      → ikmal sürerken yeniden başlandı: oturum FINALIZING'e alınır,
 *                      sebep ABNORMAL_RESTART, finalize "recoveredAfterRestart": true
 *                      ile gider (sunucu kaydı operatör onayına düşürür).
 *      - FINALIZING  → ikmal normal bitmişti ama finalize sunucuya ulaşmamıştı: aynı
 *                      idempotency anahtarı ve asıl bitiş sebebiyle yeniden denenir.
 *    Röle açılışta her durumda KAPALI başlar ve bu oturumda bir daha açılmaz.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "yt_session.h"

#ifdef __cplusplus
extern "C" {
#endif

#define YT_COMMIT_STEP_ML 5000ULL          /* 5 L — FW-1314 AC: en fazla 5 L kayıp */
#define YT_COMMIT_MAX_INTERVAL_MS 10000    /* düşük debide 10 sn'de bir */

/* ---------- 1) Totalizatör commit politikası ---------- */

typedef struct {
    uint64_t committed_ml;     /* NVS'teki son değer */
    int64_t committed_at_ms;   /* son yazma zamanı (monoton ms) */
} yt_commit_policy_t;

/** committed_ml: açılışta NVS'ten okunan değer. */
void yt_commit_init(yt_commit_policy_t *c, uint64_t committed_ml, int64_t now_ms);

/** Şimdi yazılmalı mı? totalizer_ml: anlık kümülatif değer. */
bool yt_commit_due(const yt_commit_policy_t *c, uint64_t totalizer_ml, int64_t now_ms);

/** Yazma BAŞARILI olduktan sonra çağrılır (başarısızsa çağrılmaz → bir sonraki tick'te yeniden). */
void yt_commit_done(yt_commit_policy_t *c, uint64_t totalizer_ml, int64_t now_ms);

/**
 * Litre ↔ mililitre. NVS'te totalizatör tamsayı mL (u64) tutulur: double'ın bit kalıbını
 * saklamaktan daha okunur ve sürümler arası taşınabilir. Aşağı yuvarlanır (açılış başına
 * < 1 mL); negatif / NaN 0 olur.
 */
uint64_t yt_liters_to_ml(double liters);
double yt_ml_to_liters(uint64_t ml);

/* ---------- 2) Oturum işareti ---------- */

typedef enum {
    YT_MARKER_NONE = 0,        /* NVS'te kayıt olmamalı */
    YT_MARKER_ACTIVE = 1,      /* AUTHORIZED / PUMPING */
    YT_MARKER_FINALIZING = 2,  /* ikmal bitti, finalize bekliyor */
} yt_marker_phase_t;

typedef struct {
    yt_marker_phase_t phase;
    yt_end_reason_t end_reason;                 /* FINALIZING'de asıl bitiş sebebi */
    double start_totalizer;
    char session_id[YT_SESSION_ID_MAX];
    char idempotency_key[YT_IDEMPOTENCY_MAX];
} yt_session_marker_t;

/* sihirli sayı(4) + sürüm(1) + aşama(1) + sebep(1) + ayrılmış(1) + başlangıç(8)
 * + 1+63 oturum + 1+127 anahtar + crc32(4) */
#define YT_MARKER_ENCODED_MAX (4 + 4 + 8 + 1 + (YT_SESSION_ID_MAX - 1) + 1 + (YT_IDEMPOTENCY_MAX - 1) + 4)

/** Oturumun bu durumunda NVS'te hangi kayıt durmalı. */
yt_marker_phase_t yt_marker_phase_for(const yt_session_t *s);

/** Oturumdan kayıt üretir (phase = yt_marker_phase_for). */
void yt_marker_from_session(const yt_session_t *s, yt_session_marker_t *m);

/** Sabit, sürümlü, CRC'li ikili biçim. Dönüş: yazılan bayt (0 = hata). */
size_t yt_marker_encode(const yt_session_marker_t *m, uint8_t *buf, size_t cap);

/** Bozuk / farklı sürüm / kısaltılmış kayıtta false (kayıt yok sayılır ve loglanır). */
bool yt_marker_decode(const uint8_t *buf, size_t len, yt_session_marker_t *m);

/**
 * Açılışta bulunan kayıttan oturumu kurar (bkz. dosya başı). Kayıt ACTIVE/FINALIZING
 * değilse veya oturum kimliği boşsa false döner ve oturum IDLE kalır.
 */
bool yt_marker_restore(const yt_session_marker_t *m, yt_session_t *s, int64_t now_ms);

/** CRC-32 (IEEE 802.3, yansıtılmış 0xEDB88320) — kayıt bütünlüğü için. */
uint32_t yt_crc32(const uint8_t *data, size_t len);

#ifdef __cplusplus
}
#endif
