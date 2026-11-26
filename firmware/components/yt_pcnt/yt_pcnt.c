#include "yt_pcnt.h"

#include <inttypes.h>

#include "driver/pulse_cnt.h"
#include "esp_check.h"
#include "esp_log.h"
#include "yt_flow.h"

static const char *TAG = "yt_pcnt";

static pcnt_unit_handle_t s_unit;
static int s_last_raw;

esp_err_t yt_pcnt_init(int gpio, uint32_t glitch_ns)
{
    /* accum_count bilerek KAPALI: ham sayaç 0..HIGH_LIMIT-1 arasında sarar, fark
     * yt_flow_counter_delta() ile modüler hesaplanır (gerekçe: yt_flow.h). */
    pcnt_unit_config_t unit_cfg = {
        .low_limit = -1, /* sayaç azalmaz; sürücü negatif bir alt sınır istiyor */
        .high_limit = YT_PCNT_HIGH_LIMIT,
    };
    ESP_RETURN_ON_ERROR(pcnt_new_unit(&unit_cfg, &s_unit), TAG, "PCNT birimi oluşturulamadı");

    if (glitch_ns > 0) {
        pcnt_glitch_filter_config_t filter = { .max_glitch_ns = glitch_ns };
        ESP_RETURN_ON_ERROR(pcnt_unit_set_glitch_filter(s_unit, &filter), TAG, "glitch filtresi (%" PRIu32 " ns)", glitch_ns);
    }

    pcnt_chan_config_t chan_cfg = { .edge_gpio_num = gpio, .level_gpio_num = -1 };
    pcnt_channel_handle_t chan;
    ESP_RETURN_ON_ERROR(pcnt_new_channel(s_unit, &chan_cfg, &chan), TAG, "PCNT kanalı (GPIO %d)", gpio);
    ESP_RETURN_ON_ERROR(pcnt_channel_set_edge_action(chan, PCNT_CHANNEL_EDGE_ACTION_INCREASE,
                                                     PCNT_CHANNEL_EDGE_ACTION_HOLD), TAG, "kenar ayarı");

    ESP_RETURN_ON_ERROR(pcnt_unit_enable(s_unit), TAG, "enable");
    ESP_RETURN_ON_ERROR(pcnt_unit_clear_count(s_unit), TAG, "clear");
    ESP_RETURN_ON_ERROR(pcnt_unit_start(s_unit), TAG, "start");
    s_last_raw = 0;
    ESP_LOGI(TAG, "akışmetre GPIO %d, glitch filtresi %" PRIu32 " ns", gpio, glitch_ns);
    return ESP_OK;
}

uint32_t yt_pcnt_take(void)
{
    int raw = 0;
    if (!s_unit || pcnt_unit_get_count(s_unit, &raw) != ESP_OK) return 0;
    uint32_t d = yt_flow_counter_delta(s_last_raw, raw, YT_PCNT_HIGH_LIMIT);
    s_last_raw = raw;
    return d;
}
