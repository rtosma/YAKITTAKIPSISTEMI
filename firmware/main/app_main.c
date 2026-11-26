/*
 * Yakıt Takip — ESP32 pompa kontrol ünitesi (FW-1300).
 *
 * Açılış sırası güvenlik önceliklidir: röle KAPALI → sürüm → HMAC öz-testi → NVS
 * (totalizatör, K-faktörü, yarım oturum) → akışmetre → ana döngü.
 *
 * Ana döngü 100 ms'de bir (güç kesintisi sinyalinde hemen) döner:
 *   PCNT artışı → yt_flow → oturum kuralları → röle (TEK kapı) → NVS commit politikası
 *   → oturum kaydını durumla eşitle → watchdog besle.
 * Kart (FW-1302) ve ağ (FW-1306/1307) olayları sonraki adımlarda bu döngüye bağlanır;
 * o zamana kadar yeni oturum açılmaz, röle kapalı kalır.
 */
#include <inttypes.h>
#include <string.h>

#include "driver/gpio.h"
#include "esp_app_desc.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "yt_flow.h"
#include "yt_hmac.h"
#include "yt_pcnt.h"
#include "yt_persist.h"
#include "yt_relay.h"
#include "yt_session.h"
#include "yt_store.h"

static const char *TAG = "yakittakip";

#define LOOP_PERIOD_MS 100

static yt_flow_t s_flow;
static yt_session_t s_session;
static yt_commit_policy_t s_commit;
static bool s_store_ok;   /* NVS açık ve totalizatör biliniyor */
static bool s_meter_ok;   /* akışmetre (PCNT) çalışıyor */

/* NVS'teki oturum kaydının bilinen hali (gereksiz yazmayı önler). */
static yt_marker_phase_t s_marker_phase = YT_MARKER_NONE;
static char s_marker_session[YT_SESSION_ID_MAX];

static TaskHandle_t s_main_task;

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

/* ---------- girişler ---------- */

static void IRAM_ATTR wake_main_isr(void *arg)
{
    BaseType_t woken = pdFALSE;
    if (s_main_task) vTaskNotifyGiveFromISR(s_main_task, &woken);
    portYIELD_FROM_ISR(woken);
}

static void inputs_init(void)
{
    /* Acil durdurma: NC kontak GPIO–GND, dahili pull-up. Normal LOW; basılı/kopuk HIGH. */
    gpio_config_t estop = {
        .pin_bit_mask = 1ULL << CONFIG_YT_PIN_ESTOP,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .intr_type = GPIO_INTR_POSEDGE,
    };
    ESP_ERROR_CHECK(gpio_config(&estop));

    /* Kenarlar yalnızca ana döngüyü hemen uyandırır; kararlar döngüde, seviye okunarak verilir. */
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add(CONFIG_YT_PIN_ESTOP, wake_main_isr, NULL));

#if CONFIG_YT_PIN_POWER_FAIL >= 0
    gpio_config_t pfc = {
        .pin_bit_mask = 1ULL << CONFIG_YT_PIN_POWER_FAIL,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .intr_type = GPIO_INTR_NEGEDGE,
    };
    ESP_ERROR_CHECK(gpio_config(&pfc));
    ESP_ERROR_CHECK(gpio_isr_handler_add(CONFIG_YT_PIN_POWER_FAIL, wake_main_isr, NULL));
#endif
}

static bool estop_active(void)
{
    return gpio_get_level(CONFIG_YT_PIN_ESTOP) != 0;
}

static bool power_failing(void)
{
#if CONFIG_YT_PIN_POWER_FAIL >= 0
    return gpio_get_level(CONFIG_YT_PIN_POWER_FAIL) == 0;
#else
    return false;
#endif
}

/* ---------- kalıcılık (FW-1314) ---------- */

static void store_restore(int64_t t)
{
    s_store_ok = yt_store_init() == ESP_OK;

    double k = (double)CONFIG_YT_DEFAULT_K_FACTOR;
    uint64_t tot_ml = 0;
    if (s_store_ok) {
        esp_err_t err = yt_store_load_k_factor(&k);
        if (err == ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGW(TAG, "K-faktörü kayıtlı değil — varsayılan %.1f (uzaktan kalibrasyon bekleniyor)", k);
        } else if (err != ESP_OK) {
            k = (double)CONFIG_YT_DEFAULT_K_FACTOR;
            ESP_LOGE(TAG, "Kayıtlı K-faktörü okunamadı (%s) — varsayılan %.1f", esp_err_to_name(err), k);
        }

        err = yt_store_load_totalizer_ml(&tot_ml);
        if (err == ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGW(TAG, "Totalizatör kaydı yok — ilk kurulum, 0 L'den başlıyor");
            tot_ml = 0;
        } else if (err != ESP_OK) {
            /* Sayaç bilinmiyorsa ikmal faturalanamaz: ikmal kapalı. */
            ESP_LOGE(TAG, "Totalizatör okunamadı (%s) — ikmal KAPALI", esp_err_to_name(err));
            s_store_ok = false;
        }
    }

    yt_flow_init(&s_flow, k, yt_ml_to_liters(tot_ml));
    yt_commit_init(&s_commit, tot_ml, t);
    yt_session_init(&s_session);
    ESP_LOGI(TAG, "K-faktörü %.3f pals/L, totalizatör %.3f L", s_flow.k_factor, yt_flow_totalizer_liters(&s_flow));

    if (!s_store_ok) return;

    yt_session_marker_t m;
    esp_err_t err = yt_store_load_marker(&m);
    if (err == ESP_OK && yt_marker_restore(&m, &s_session, t)) {
        s_marker_phase = m.phase;
        strlcpy(s_marker_session, m.session_id, sizeof s_marker_session);
        if (yt_session_recovered_after_restart(&s_session)) {
            ESP_LOGW(TAG, "İkmal sürerken yeniden başlandı: oturum %s kurtarıldı, "
                          "sunucuya 'recoveredAfterRestart' ile bildirilecek (operatör onayı)", m.session_id);
        } else {
            ESP_LOGW(TAG, "Bitmiş ama sunucuya ulaşmamış ikmal %s (%s) yeniden gönderilecek",
                     m.session_id, yt_end_reason_name(s_session.end_reason));
        }
    } else if (err == ESP_ERR_INVALID_CRC) {
        ESP_LOGE(TAG, "Oturum kaydı bozuk/uyumsuz — yok sayılıp siliniyor");
        yt_store_clear_marker();
    } else if (err != ESP_ERR_NVS_NOT_FOUND && err != ESP_OK) {
        ESP_LOGE(TAG, "Oturum kaydı okunamadı: %s", esp_err_to_name(err));
    }
}

static void commit_totalizer(int64_t t, bool force)
{
    if (!s_store_ok) return;
    uint64_t ml = yt_liters_to_ml(yt_flow_totalizer_liters(&s_flow));
    if (force ? ml <= s_commit.committed_ml : !yt_commit_due(&s_commit, ml, t)) return;
    esp_err_t err = yt_store_save_totalizer_ml(ml);
    if (err == ESP_OK) {
        yt_commit_done(&s_commit, ml, t);
    } else {
        ESP_LOGE(TAG, "Totalizatör yazılamadı: %s (bir sonraki turda yeniden)", esp_err_to_name(err));
    }
}

/* NVS'teki oturum kaydını oturumun durumuyla eşitler. Kayıt yazılmadan önce sayaç da
 * commit edilir: kurtarılan başlangıç/bitiş değerleri NVS'teki sayaçla tutarlı olsun. */
static void sync_marker(int64_t t)
{
    if (!s_store_ok) return;
    yt_marker_phase_t want = yt_marker_phase_for(&s_session);
    if (want == s_marker_phase && strcmp(s_session.session_id, s_marker_session) == 0) return;
    if (want == YT_MARKER_NONE && s_marker_phase == YT_MARKER_NONE) return;

    esp_err_t err;
    if (want == YT_MARKER_NONE) {
        err = yt_store_clear_marker();
    } else {
        commit_totalizer(t, true);
        yt_session_marker_t m;
        yt_marker_from_session(&s_session, &m);
        err = yt_store_save_marker(&m);
    }
    if (err == ESP_OK) {
        s_marker_phase = want;
        strlcpy(s_marker_session, want == YT_MARKER_NONE ? "" : s_session.session_id, sizeof s_marker_session);
    } else {
        ESP_LOGE(TAG, "Oturum kaydı yazılamadı: %s (bir sonraki turda yeniden)", esp_err_to_name(err));
    }
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

    /* 4) Kalıcı durum: K-faktörü, totalizatör, yarım kalmış oturum. */
    store_restore(now_ms());

    /* 5) Girişler ve akışmetre. */
    s_main_task = xTaskGetCurrentTaskHandle();
    inputs_init();
    s_meter_ok = yt_pcnt_init(CONFIG_YT_PIN_FLOW, CONFIG_YT_FLOW_GLITCH_NS) == ESP_OK;
    if (!s_meter_ok) ESP_LOGE(TAG, "Akışmetre başlatılamadı — ikmal KAPALI (ölçemeyen cihaz ikmal yapmaz)");

    /* 6) Ana döngü watchdog'a bağlı (FW-1313): takılırsa panik → reset → röle donanımsal
     *    olarak kapanır, açılışta yarım oturum kurtarılır. */
    ESP_ERROR_CHECK(esp_task_wdt_add(NULL));

    bool was_estop = false, was_pf = false;
    for (;;) {
        int64_t t = now_ms();

        uint32_t pulses = yt_pcnt_take();
        if (pulses) yt_flow_add_pulses(&s_flow, pulses, t);

        bool estop = estop_active();
        if (estop && !was_estop) {
            ESP_LOGW(TAG, "ACİL DURDURMA");
            yt_session_on_emergency_stop(&s_session, t);
        }
        was_estop = estop;

        bool pf = power_failing();
        yt_session_tick(&s_session, yt_flow_session_liters(&s_flow), pulses > 0, t);

        /* TEK kapı: oturum izni + acil durdurma + güç kesintisi + ölçüm/kalıcılık sağlıklı. */
        yt_relay_apply(&s_session, estop || pf || !s_store_ok || !s_meter_ok);

        if (pf && !was_pf) {
            commit_totalizer(t, true);
            ESP_LOGW(TAG, "Güç kesintisi: röle kapatıldı, totalizatör %.3f L yazıldı",
                     yt_ml_to_liters(s_commit.committed_ml));
        }
        was_pf = pf;

        commit_totalizer(t, false);
        sync_marker(t);

        esp_task_wdt_reset();
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(LOOP_PERIOD_MS));
    }
}
