/*
 * Yakıt Takip — ESP32 pompa kontrol ünitesi (FW-1300).
 *
 * Bu iskelet (FW-1301) açılış güvenliğini ve çekirdek mantığın cihazda çalıştığını
 * kurar: röle her şeyden önce KAPALI, sürüm log'da, HMAC öz-testi şartname
 * vektörleriyle. Sürücüler (RFID FW-1302, PCNT FW-1304, ağ FW-1306/1307, NVS
 * FW-1314, kuyruk FW-1309) sonraki adımlarda bu döngüye bağlanır.
 */
#include <inttypes.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "yt_flow.h"
#include "yt_hmac.h"
#include "yt_relay.h"
#include "yt_session.h"

static const char *TAG = "yakittakip";

/* docs/HARDWARE_INTEGRATION_GUIDE.md §2.5 — sunucuyla birebir aynı imza üretilmeli. */
static bool hmac_self_test(void)
{
    static const char *secret = "ornek_test_gizli_anahtar_12345";
    static const char *ts = "1788700000000";
    static const char *nonce = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    static const char *body = "{\"rfidCardId\":\"CARD-881201\",\"tankName\":\"Gebze Ana Tank (T-1)\"}";
    char sig[YT_HMAC_HEX_LEN + 1];

    bool ok = yt_hmac_sign(secret, ts, nonce, NULL, 0, sig) == 0 &&
              strcmp(sig, "991aa39d17cc4e261a57861ef19a2fb1738b8e7a729d6b94f21749cf1e51dd86") == 0;
    ok = ok && yt_hmac_sign(secret, ts, nonce, body, strlen(body), sig) == 0 &&
         strcmp(sig, "d621eddad2c20ba99ead9816370c8eeea773d2a90a4d120701f9222622c4911d") == 0;
    return ok;
}

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

void app_main(void)
{
    /* 1) Her şeyden önce röle KAPALI (FW-1303). */
    yt_relay_init(CONFIG_YT_PIN_RELAY, CONFIG_YT_RELAY_ACTIVE_HIGH);

    /* 2) Sürüm (FW-1301 AC: açılışta log'a basılır). */
    const esp_app_desc_t *app = esp_app_get_description();
    ESP_LOGI(TAG, "Yakıt Takip pompa ünitesi %s (IDF %s, derleme %s %s)", app->version, app->idf_ver, app->date, app->time);

    /* 3) İmzalama öz-testi: tutmuyorsa sunucu hiçbir isteği kabul etmez — ikmale başlama. */
    if (!hmac_self_test()) {
        ESP_LOGE(TAG, "HMAC öz-testi BAŞARISIZ — ikmal devre dışı. (mbedTLS/derleme sorunu)");
        for (;;) {
            yt_relay_force_off();
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
    ESP_LOGI(TAG, "HMAC öz-testi geçti (şartname vektörleri)");

    yt_flow_t flow;
    yt_flow_init(&flow, (double)CONFIG_YT_DEFAULT_K_FACTOR, 0.0);
    yt_session_t session;
    yt_session_init(&session);
    ESP_LOGI(TAG, "K-faktörü %.1f pals/L, totalizatör %.3f L", flow.k_factor, yt_flow_totalizer_liters(&flow));

    /* 4) Ana döngü: oturum kurallarını uygula, röleyi TEK kapıdan sür. Sürücüler
     *    bağlanana kadar oturum IDLE'da kalır ve röle kapalıdır. */
    for (;;) {
        int64_t t = now_ms();
        yt_session_tick(&session, yt_flow_session_liters(&flow), false, t);
        yt_relay_apply(&session, false);
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
