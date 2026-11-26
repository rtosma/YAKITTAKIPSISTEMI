/*
 * GELİŞTİRME konsolu (CONFIG_YT_DEV_CONSOLE): donanımsız uçtan uca test için seri porttan
 *   kart <uid>              — RFID okutma (FW-1302 sürücüsü gelene kadar tek kart kaynağı)
 *   akis <litre> <L/dk>     — akışmetre palsi üret (yalnızca röle AÇIKKEN akar, gerçek
 *                             solenoid gibi)
 *   durum                   — oturum ve sayaç durumu
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

/** Kart olayları card_q'ya (YT_CARD_ID_MAX baytlık öğeler) yazılır. */
void app_console_start(QueueHandle_t card_q);

/** Bu 100 ms'lik turda simüle akıştan gelen pals. */
uint32_t app_console_sim_pulses(double k_factor, bool relay_on);

/** "durum" komutu istendi mi (bir kez true döner). */
bool app_console_status_requested(void);
