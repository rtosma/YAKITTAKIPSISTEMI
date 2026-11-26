#include "app_console.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/uart.h"
#include "driver/uart_vfs.h"
#include "esp_log.h"
#include "freertos/task.h"
#include "sdkconfig.h"
#include "yt_session.h"

static const char *TAG = "konsol";

static QueueHandle_t s_card_q;
static volatile double s_sim_liters_left;   /* akacak litre */
static volatile double s_sim_lpm;           /* debi */
static volatile bool s_status;
static double s_pulse_frac;

static void console_task(void *arg)
{
    char line[96];
    for (;;) {
        if (!fgets(line, sizeof line, stdin)) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        line[strcspn(line, "\r\n")] = '\0';
        char cmd[16] = "", a1[YT_CARD_ID_MAX] = "", a2[16] = "";
        if (sscanf(line, "%15s %39s %15s", cmd, a1, a2) < 1) continue;

        if (strcmp(cmd, "kart") == 0 && a1[0]) {
            ESP_LOGI(TAG, "kart okutuldu: %s", a1);
            xQueueSend(s_card_q, a1, 0);
        } else if (strcmp(cmd, "akis") == 0 && a1[0] && a2[0]) {
            s_sim_lpm = atof(a2);
            s_sim_liters_left = atof(a1);
            ESP_LOGI(TAG, "akış: %.2f L, %.1f L/dk", s_sim_liters_left, s_sim_lpm);
        } else if (strcmp(cmd, "durum") == 0) {
            s_status = true;
        } else {
            ESP_LOGW(TAG, "bilinmeyen komut: %s", line);
        }
    }
}

void app_console_start(QueueHandle_t card_q)
{
    s_card_q = card_q;
    /* stdin'i kesme tabanlı UART sürücüsüne bağla: fgets satır gelene kadar bekler. */
    uart_driver_install(CONFIG_ESP_CONSOLE_UART_NUM, 256, 0, 0, NULL, 0);
    uart_vfs_dev_use_driver(CONFIG_ESP_CONSOLE_UART_NUM);
    setvbuf(stdin, NULL, _IONBF, 0);
    xTaskCreate(console_task, "yt_console", 4096, NULL, tskIDLE_PRIORITY + 1, NULL);
    ESP_LOGW(TAG, "GELİŞTİRME KONSOLU AÇIK — üretimde kapatın (CONFIG_YT_DEV_CONSOLE)");
}

uint32_t app_console_sim_pulses(double k_factor, bool relay_on)
{
    /* Solenoid kapanınca tabancada kalan "istek" de biter (sonraki ikmale taşınmaz). */
    static bool was_on;
    if (was_on && !relay_on) s_sim_liters_left = 0;
    was_on = relay_on;
    if (!relay_on || s_sim_liters_left <= 0 || s_sim_lpm <= 0) return 0;
    double liters = s_sim_lpm / 600.0; /* 100 ms'de */
    if (liters > s_sim_liters_left) liters = s_sim_liters_left;
    s_sim_liters_left -= liters;
    double pulses = liters * k_factor + s_pulse_frac;
    uint32_t whole = (uint32_t)pulses;
    s_pulse_frac = pulses - whole;
    return whole;
}

bool app_console_status_requested(void)
{
    bool r = s_status;
    s_status = false;
    return r;
}
