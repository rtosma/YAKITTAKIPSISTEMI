#include "yt_relay.h"

#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "yt_relay";

static int s_gpio = -1;
static bool s_active_high = true;
static bool s_on = false;

static void write_level(bool on)
{
    if (s_gpio < 0) return;
    int level = on ? (s_active_high ? 1 : 0) : (s_active_high ? 0 : 1);
    gpio_set_level((gpio_num_t)s_gpio, level);
    s_on = on;
}

esp_err_t yt_relay_init(int gpio, bool active_high)
{
    s_gpio = gpio;
    s_active_high = active_high;

    /* Önce KAPALI seviyeyi yaz, sonra çıkış yap: çıkış etkinleştiği an röle kapalıdır. */
    gpio_set_level((gpio_num_t)gpio, active_high ? 0 : 1);
    gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << gpio,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = active_high ? GPIO_PULLUP_DISABLE : GPIO_PULLUP_ENABLE,
        .pull_down_en = active_high ? GPIO_PULLDOWN_ENABLE : GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "GPIO%d yapılandırılamadı: %s", gpio, esp_err_to_name(err));
        return err;
    }
    write_level(false);
    ESP_LOGI(TAG, "Röle GPIO%d (%s) KAPALI başlatıldı", gpio, active_high ? "aktif-yüksek" : "aktif-düşük");
    return ESP_OK;
}

void yt_relay_apply(const yt_session_t *s, bool emergency_stop_active)
{
    bool want_on = !emergency_stop_active && s && yt_session_relay_allowed(s);
    if (want_on != s_on) {
        write_level(want_on);
        ESP_LOGI(TAG, "Röle %s (oturum=%s)", want_on ? "AÇIK" : "KAPALI", s ? yt_session_state_name(s->state) : "-");
    }
}

void yt_relay_force_off(void)
{
    write_level(false);
}

bool yt_relay_is_on(void)
{
    return s_on;
}
