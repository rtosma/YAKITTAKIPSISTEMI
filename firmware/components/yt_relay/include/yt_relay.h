/*
 * FW-1303 — Röle (pompa/solenoid) sürücüsü ve yazılım kilidi.
 *
 * Güvenlik kuralları:
 *  1. Açılışta röle ÖNCE kapalı seviyeye çekilir, SONRA çıkış yapılır (aradaki
 *     belirsiz durumda bile açılmasın). Donanımda röle sürücü girişinde fiziksel
 *     PULL-DOWN direnci ZORUNLUDUR: MCU reset/brown-out/kilitlenmede GPIO yüksek
 *     empedansa düşer ve röle kendiliğinden kapanır (README "Röle güvenliği").
 *  2. Röle yalnızca yt_relay_apply() ile, yt_session_relay_allowed() izin verdiğinde
 *     ve acil durdurma aktif DEĞİLKEN açılır. Doğrudan "aç" fonksiyonu YOKTUR.
 */
#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "yt_session.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Röleyi kapalı başlatır. active_high: röle modülü HIGH ile mi çekiyor. */
esp_err_t yt_relay_init(int gpio, bool active_high);

/** Tek yol: oturum izin veriyor VE acil durdurma yoksa açık, aksi halde kapalı. */
void yt_relay_apply(const yt_session_t *s, bool emergency_stop_active);

/** Koşulsuz kapat (FORCE_CUTOFF, panik öncesi, hata yolları). Her zaman güvenli. */
void yt_relay_force_off(void);

bool yt_relay_is_on(void);

#ifdef __cplusplus
}
#endif
