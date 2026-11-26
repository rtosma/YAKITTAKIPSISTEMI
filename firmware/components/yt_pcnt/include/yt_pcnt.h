/*
 * FW-1304 — Akışmetre pals sayımı, ESP32 donanım PCNT birimiyle.
 *
 * Yazılım kesmesi (GPIO ISR) yüksek debide pals kaçırır; PCNT palsleri CPU'dan
 * bağımsız sayar. Ana döngü ~100 ms'de bir yt_pcnt_take() ile artışı alır ve
 * yt_flow_add_pulses()'a verir. Litre/K-faktörü hesabı yt_core/yt_flow'dadır.
 *
 * Donanım notları (sahada doğrulanacak — TEST-1005):
 *  - Giriş yükselen kenarda sayar. Sürücü dahili pull-up açar; açık-kollektörlü
 *    Hall sensörlerinde yine de harici 4,7 kΩ pull-up (3,3 V'a) önerilir.
 *  - 5/12/24 V çıkışlı sayaçlar optokuplör veya seviye dönüştürücüyle bağlanmalı;
 *    ESP32 girişleri 3,3 V'tur.
 *  - Glitch filtresi en fazla ~12,7 µs'lik gürültüyü eler. Reed kontaklı (mekanik)
 *    sayaçların ms düzeyindeki sıçramasını ELEYEMEZ: onlarda RC filtre + Schmitt
 *    tetikleyici şarttır.
 */
#pragma once

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Donanım sayacının sardığı değer (16-bit sayaç, pozitif sınır). */
#define YT_PCNT_HIGH_LIMIT 32767

/**
 * @param gpio       akışmetre pals girişi
 * @param glitch_ns  bu süreden kısa darbeler gürültü sayılır (0 = filtre kapalı, en fazla ~12700)
 */
esp_err_t yt_pcnt_init(int gpio, uint32_t glitch_ns);

/** Son çağrıdan bu yana sayılan pals. 100 ms'de bir çağrılırsa 327 kHz'e kadar doğru. */
uint32_t yt_pcnt_take(void);

#ifdef __cplusplus
}
#endif
