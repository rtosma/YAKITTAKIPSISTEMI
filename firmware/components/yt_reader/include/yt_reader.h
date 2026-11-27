/*
 * FW-1302 — PN532 RFID okuyucu sürücüsü (I2C, adres 0x24).
 *
 * Kendi görevinde ~100 ms'de bir InListPassiveTarget (ISO 14443A, 106 kbps) ile alanı
 * tarar; okumaları yt_core/yt_rfid izleyicisinden geçirir (gürültü onayı, sıçrama, çekilme)
 * ve yalnızca olayları geri çağrıya verir. Yeni kart, ikinci (onay) okuması hemen ardından
 * yapıldığı için ~100-200 ms'de bildirilir (FW-1302 AC: 200 ms).
 *
 * Okuyucu yoksa / yanıt vermiyorsa artan aralıklarla (1 sn → 30 sn) yeniden başlatılır;
 * bu durum pompayı kilitlemez — yalnızca kart okunamaz.
 *
 * Donanım notları (sahada doğrulanacak — TEST-1005):
 *  - PN532 modülü I2C moduna alınmalı (çoğu modülde DIP anahtar / jumper: SEL0=1, SEL1=0).
 *  - Hatlarda 4,7 kΩ harici pull-up önerilir; dahili pull-up uzun kabloda yetmez.
 *  - Pompa motoru gürültüsüne karşı kısa, blendajlı kablo; okuyucu metal yüzeyden uzak.
 */
#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "yt_rfid.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Okuyucu görevinden çağrılır — kısa tutulmalı (kuyruğa koy). */
typedef void (*yt_reader_cb)(yt_rfid_event_t ev, const char *uid_hex);

esp_err_t yt_reader_start(int sda_gpio, int scl_gpio, yt_reader_cb cb);

/** Okuyucu şu an yanıt veriyor mu. */
bool yt_reader_ok(void);

#ifdef __cplusplus
}
#endif
