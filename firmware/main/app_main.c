/*
 * Yakıt Takip — ESP32 pompa kontrol ünitesi (FW-1300).
 *
 * Açılış sırası güvenlik önceliklidir: röle KAPALI → sürüm → HMAC öz-testi → NVS
 * (totalizatör, K-faktörü, yarım oturum) → girişler ve akışmetre → ağ → denetim döngüsü.
 *
 * Denetim döngüsü 100 ms'de bir (acil durdurma / güç kesintisi kenarında hemen) döner ve
 * oturumun TEK sahibidir:
 *   pals → yt_flow → kart → sunucu yanıtları → oturum kuralları → röle (TEK kapı)
 *   → sunucuya sıradaki istek → NVS commit → oturum kaydı → watchdog.
 * Ağ istekleri ayrı görevde (app_link) yürür; döngü onları beklemez.
 */
#include <inttypes.h>
#include <string.h>

#include "app_console.h"
#include "app_link.h"
#include "driver/gpio.h"
#include "esp_app_desc.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "yt_api.h"
#include "yt_cmd.h"
#include "yt_flow.h"
#include "yt_hmac.h"
#include "yt_mqtt.h"
#include "yt_net.h"
#include "yt_pcnt.h"
#include "yt_persist.h"
#include "yt_relay.h"
#include "yt_session.h"
#include "yt_store.h"

static const char *TAG = "yakittakip";

#define LOOP_PERIOD_MS 100
#define AUTH_MAX_ATTEMPTS 3
#define FINALIZE_SETTLE_MS 1000   /* röle kesildikten sonra damlayan yakıt da sayılsın */
#define FINALIZE_BACKOFF_MAX_MS 60000
#define RESULT_SHOW_MS 3000       /* sonuç ekranda kalsın, sonra yeni karta hazır */

static yt_flow_t s_flow;
static yt_session_t s_session;
static yt_commit_policy_t s_commit;
static bool s_store_ok;   /* NVS açık ve totalizatör biliniyor */
static bool s_meter_ok;   /* akışmetre (PCNT) çalışıyor */
static bool s_link_ok;    /* sunucu yapılandırması tam, ağ başlatıldı */

static yt_net_config_t s_net;
static char s_tank[64];

/* NVS'teki oturum kaydının bilinen hali (gereksiz yazmayı önler). */
static yt_marker_phase_t s_marker_phase = YT_MARKER_NONE;
static char s_marker_session[YT_SESSION_ID_MAX];

/* Sunucu istek zamanlaması (oturum durumu değişince sıfırlanır). */
static int s_attempts;
static int64_t s_next_try_ms;

static TaskHandle_t s_main_task;
static QueueHandle_t s_card_q;

/* MQTT'den gelen ham komutlar (MQTT görevi → denetim döngüsü). */
#define CMD_PAYLOAD_MAX 384
typedef struct {
    uint16_t len;
    char data[CMD_PAYLOAD_MAX];
} cmd_msg_t;
static QueueHandle_t s_cmd_q;

/* FUEL-404.1 kalibrasyon yanıtı: HTTP ile gönderilene (veya pencere kapanana) kadar bekler. */
static struct {
    bool pending;
    char command_id[YT_CMD_ID_MAX];
    bool ack;                 /* ACK: K uygulandı; NACK: reddedildi */
    double applied_k;
    double previous_k;        /* sunucu kabul etmezse geri dönülecek değer */
    char reason[40];
    int64_t received_ms;
    int attempts;
    int64_t next_try_ms;
    bool maybe_delivered;     /* önceki bir deneme sunucuya ulaşmış ama yanıtı kaybolmuş olabilir */
} s_cal;

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

    /* Kenarlar yalnızca denetim döngüsünü hemen uyandırır; kararlar döngüde, seviye okunarak. */
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

/* ---------- sunucu (FUEL-401) ---------- */

/* ---------- sunucu komutları (MQTT, FW-1307) ---------- */

static void on_mqtt_command(const char *payload, size_t len)
{
    cmd_msg_t m;
    if (len >= sizeof m.data) {
        ESP_LOGW(TAG, "komut çok uzun (%u bayt) — yok sayıldı", (unsigned)len);
        return;
    }
    memcpy(m.data, payload, len);
    m.data[len] = '\0';
    m.len = (uint16_t)len;
    if (xQueueSend(s_cmd_q, &m, 0) != pdTRUE) {
        ESP_LOGW(TAG, "komut kuyruğu dolu — komut yok sayıldı");
        return;
    }
    if (s_main_task) xTaskNotifyGive(s_main_task); /* FORCE_CUTOFF beklemesin */
}

static void mqtt_init(void)
{
    yt_mqtt_config_t mc = { 0 };
    yt_store_get_config("mqtt_url", mc.url, sizeof mc.url);
    yt_store_get_config("mqtt_user", mc.user, sizeof mc.user);
    yt_store_get_secret("mqtt_pass", mc.pass, sizeof mc.pass);
    yt_store_get_config("tenant_id", mc.tenant_id, sizeof mc.tenant_id);
    yt_store_get_config("site_id", mc.site_id, sizeof mc.site_id);
    strlcpy(mc.device_id, s_net.device_id, sizeof mc.device_id);
    if (!mc.url[0]) {
        ESP_LOGW(TAG, "MQTT yapılandırılmamış — sunucu komutları yalnızca heartbeat yanıtıyla gelir");
        return;
    }
    s_cmd_q = xQueueCreate(4, sizeof(cmd_msg_t));
    if (yt_mqtt_start(&mc, on_mqtt_command) != ESP_OK) ESP_LOGE(TAG, "MQTT başlatılamadı");
}

static bool session_busy(void)
{
    return s_session.state != YT_S_IDLE && s_session.state != YT_S_COMPLETED && s_session.state != YT_S_ABORTED;
}

static void calibration_reply(const char *command_id, bool ack, double applied_k, double previous_k,
                              const char *reason, int64_t t)
{
    s_cal.pending = true;
    strlcpy(s_cal.command_id, command_id, sizeof s_cal.command_id);
    s_cal.ack = ack;
    s_cal.applied_k = applied_k;
    s_cal.previous_k = previous_k;
    strlcpy(s_cal.reason, reason ? reason : "", sizeof s_cal.reason);
    s_cal.received_ms = t;
    s_cal.attempts = 0;
    s_cal.next_try_ms = 0;
    s_cal.maybe_delivered = false;
}

/* K-faktörü değiştirip kalıcı yazar. Oturum sürüyorsa yt_flow değişikliği erteler; o zaman
 * NVS'e oturum bitince on_state_change yazar. */
static bool set_k_factor(double k)
{
    yt_flow_k_result_t r = yt_flow_set_k_factor(&s_flow, k);
    if (r == YT_FLOW_K_INVALID) return false;
    if (r == YT_FLOW_K_APPLIED && s_store_ok && yt_store_save_k_factor(s_flow.k_factor) != ESP_OK) return false;
    return true;
}

/* FUEL-404.1: ikmal sürerken K değişmez (o ikmalin litresi tutarsız olur) → NACK; operatör
 * tekrar gönderir. Böylece sunucudaki k_factor her zaman cihazın ölçtüğüyle aynı kalır. */
static void on_set_k_factor(const yt_cmd_t *c, int64_t t)
{
    if (s_cal.pending) {
        ESP_LOGW(TAG, "önceki kalibrasyon yanıtı bekleniyor — %s yok sayıldı (sunucuda zaman aşımına düşer)",
                 c->command_id);
        return;
    }
    const char *nack = NULL;
    if (session_busy()) nack = "DISPENSE_IN_PROGRESS";
    else if (!(c->k_factor >= YT_FLOW_K_MIN && c->k_factor <= YT_FLOW_K_MAX)) nack = "INVALID_K_FACTOR";
    else if (!s_store_ok) nack = "STORAGE_UNAVAILABLE";
    if (nack) {
        ESP_LOGW(TAG, "kalibrasyon reddedildi (%s): K=%.4f", nack, c->k_factor);
        calibration_reply(c->command_id, false, 0, 0, nack, t);
        return;
    }
    double previous = s_flow.k_factor;
    if (!set_k_factor(c->k_factor)) {
        set_k_factor(previous);
        ESP_LOGE(TAG, "kalibrasyon kalıcı yazılamadı — reddedildi");
        calibration_reply(c->command_id, false, 0, 0, "STORAGE_WRITE_FAILED", t);
        return;
    }
    ESP_LOGI(TAG, "kalibrasyon uygulandı: K=%.4f (önceki %.4f), sunucuya bildiriliyor", s_flow.k_factor, previous);
    calibration_reply(c->command_id, true, s_flow.k_factor, previous, NULL, t);
}

static void calibration_revert(const char *why)
{
    if (s_cal.ack) {
        set_k_factor(s_cal.previous_k);
        ESP_LOGW(TAG, "kalibrasyon sunucuda kayda geçmedi (%s) — K %.4f'e geri alındı", why, s_cal.previous_k);
    } else {
        ESP_LOGW(TAG, "kalibrasyon reddi sunucuya iletilemedi (%s)", why);
    }
    s_cal.pending = false;
}

static void on_calibration_ack(const yt_http_resp_t *r, int64_t t)
{
    switch (yt_cmd_parse_calibration_ack(r->status, r->body)) {
    case YT_CAL_ACK_DONE:
        if (s_cal.ack) ESP_LOGI(TAG, "kalibrasyon sunucuda onaylandı: K=%.4f", s_cal.applied_k);
        else ESP_LOGI(TAG, "kalibrasyon reddi sunucuya iletildi (%s)", s_cal.reason);
        s_cal.pending = false;
        break;
    case YT_CAL_ACK_EXPIRED:
        /* Rehber §3.6: 404 ya komut zaman aşımına uğradı (sunucuda k_factor DEĞİŞMEDİ) ya da AYNI
         * yanıt daha önce işlendi demek. Önceki bir deneme sunucuya ulaşıp yanıtı kaybolduysa
         * ikincisi: yeni K kalır. Hiç ulaşmadıysa birincisi: eski K'ye dönülür. */
        if (s_cal.maybe_delivered) {
            ESP_LOGI(TAG, "kalibrasyon yanıtı muhtemelen zaten işlenmişti (404 tekrar) — K=%.4f korunuyor",
                     s_cal.applied_k);
            s_cal.pending = false;
        } else {
            calibration_revert("komut sunucuda yok/zaman aşımı");
        }
        break;
    case YT_CAL_ACK_REJECTED:
        calibration_revert("sunucu reddetti");
        break;
    default:
        if (r->status == YT_HTTP_NO_RESPONSE || r->status >= 500) s_cal.maybe_delivered = true;
        if (!s_cal.maybe_delivered && t - s_cal.received_ms >= YT_CALIBRATION_WINDOW_MS) {
            calibration_revert("5 dk içinde ulaşılamadı");
        } else {
            int64_t wait = 2000LL << (s_cal.attempts < 4 ? s_cal.attempts : 4);
            s_cal.attempts++;
            s_cal.next_try_ms = t + wait;
        }
        break;
    }
}

static void handle_commands(int64_t t)
{
    cmd_msg_t m;
    while (s_cmd_q && xQueueReceive(s_cmd_q, &m, 0) == pdTRUE) {
        yt_cmd_t c;
        switch (yt_cmd_parse(m.data, m.len, &c)) {
        case YT_CMD_FORCE_CUTOFF:
            /* Etkisiz-yinelemeli: zaten kapalı bir solenoidi kapatmak zararsız (§3.6). */
            ESP_LOGW(TAG, "MQTT kesme emri: FORCE_CUTOFF (%s)", c.reason[0] ? c.reason : "-");
            yt_session_on_force_cutoff(&s_session, c.session_id, t);
            yt_relay_apply(&s_session, true); /* döngünün sonunu beklemeden */
            if (c.command_id[0]) yt_mqtt_publish_ack(c.command_id, true);
            break;
        case YT_CMD_TIME_SYNC:
            ESP_LOGI(TAG, "MQTT saat eşitleme");
            yt_time_observe_server(c.server_time_ms);
            if (c.command_id[0]) yt_mqtt_publish_ack(c.command_id, true);
            break;
        case YT_CMD_SET_K_FACTOR:
            on_set_k_factor(&c, t);
            break;
        case YT_CMD_UNKNOWN:
            ESP_LOGW(TAG, "bilinmeyen komut: %s", c.name);
            if (c.command_id[0]) yt_mqtt_publish_ack(c.command_id, false);
            break;
        default:
            ESP_LOGW(TAG, "geçersiz komut yükü yok sayıldı");
            break;
        }
    }
}

static void link_init(void)
{
    if (!s_store_ok) return;
    esp_err_t creds = yt_store_load_credentials(s_net.device_id, sizeof s_net.device_id, s_net.secret,
                                                sizeof s_net.secret);
    yt_store_get_config("srv_url", s_net.base_url, sizeof s_net.base_url);
    yt_store_get_config("tank_name", s_tank, sizeof s_tank);
    yt_store_get_config("wifi_ssid", s_net.wifi_ssid, sizeof s_net.wifi_ssid);
    yt_store_get_config("wifi_pass", s_net.wifi_pass, sizeof s_net.wifi_pass);

    if (creds != ESP_OK || !s_net.base_url[0] || !s_tank[0]) {
        ESP_LOGE(TAG, "Yapılandırma eksik (%s%s%s) — sunucuya bağlanılmayacak, ikmal kapalı",
                 creds != ESP_OK ? "cihaz kimliği/secret " : "", s_net.base_url[0] ? "" : "srv_url ",
                 s_tank[0] ? "" : "tank_name");
        return;
    }
    ESP_LOGI(TAG, "Cihaz %s, tank \"%s\", sunucu %s", s_net.device_id, s_tank, s_net.base_url);
    if (yt_net_start(&s_net) != ESP_OK) {
        ESP_LOGE(TAG, "Ağ başlatılamadı — ikmal kapalı");
        return;
    }
    app_link_start();
    s_link_ok = true;
    mqtt_init();
}

static void on_auth(const yt_http_resp_t *r, int64_t t)
{
    yt_api_auth_result_t a;
    switch (yt_api_parse_request_auth(r->status, r->body, &a)) {
    case YT_API_OK:
        yt_flow_session_begin(&s_flow);
        if (yt_session_on_auth_granted(&s_session, a.session_id, a.max_allowed_liters,
                                       yt_flow_totalizer_liters(&s_flow), s_net.device_id, t)) {
            ESP_LOGI(TAG, "yetki verildi: oturum %s, %s / %s, en fazla %.0f L", a.session_id, a.vehicle_plate,
                     a.driver_name, a.max_allowed_liters);
        } else {
            yt_flow_session_end(&s_flow);
        }
        break;
    case YT_API_DENIED:
        ESP_LOGW(TAG, "yetki reddedildi: %s", a.code);
        yt_session_on_auth_denied(&s_session, a.code, t);
        break;
    default:
        if (++s_attempts >= AUTH_MAX_ATTEMPTS) {
            ESP_LOGW(TAG, "sunucuya ulaşılamadı (%s) — kart reddedildi", a.code);
            yt_session_on_auth_denied(&s_session, "SERVER_UNREACHABLE", t);
        } else {
            s_next_try_ms = t + 1000;
        }
        break;
    }
}

static void on_heartbeat(const yt_http_resp_t *r, int64_t t)
{
    yt_api_heartbeat_result_t h;
    switch (yt_api_parse_heartbeat(r->status, r->body, &h)) {
    case YT_API_OK:
        if (h.server_time_ms) yt_time_observe_server(h.server_time_ms);
        if (h.force_cutoff) ESP_LOGW(TAG, "sunucu kesme emri: FORCE_CUTOFF (%s)", h.code);
        yt_session_on_heartbeat_ack(&s_session, h.force_cutoff, t);
        break;
    case YT_API_REJECTED:
        /* Oturum sunucuda yok/geçersiz: yakıt akmaya devam etmemeli. */
        ESP_LOGW(TAG, "heartbeat reddedildi (%s) — röle kesiliyor", h.code);
        yt_session_on_force_cutoff(&s_session, NULL, t);
        break;
    default:
        /* Geçici: sıradaki heartbeat 5 sn sonra; 15 sn yanıtsızlıkta oturum kendisi keser. */
        break;
    }
}

static void on_finalize(const yt_http_resp_t *r, int64_t t)
{
    yt_api_finalize_result_t f;
    switch (yt_api_parse_finalize(r->status, r->body, &f)) {
    case YT_API_OK:
        ESP_LOGI(TAG, "ikmal kaydedildi: oturum %s, %.2f L, %s", s_session.session_id, f.amount_liters,
                 f.verification[0] ? f.verification : "?");
        yt_session_on_finalize_ok(&s_session, t);
        break;
    case YT_API_REJECTED:
        ESP_LOGE(TAG, "finalize reddedildi (%s) — oturum %s kayda geçemedi, operatör mutabakatı gerekli",
                 f.code, s_session.session_id);
        yt_session_on_finalize_rejected(&s_session, t);
        break;
    default: {
        yt_session_on_finalize_failed(&s_session, t);
        int64_t wait = 2000LL << (s_session.finalize_attempts < 5 ? s_session.finalize_attempts : 5);
        if (wait > FINALIZE_BACKOFF_MAX_MS) wait = FINALIZE_BACKOFF_MAX_MS;
        s_next_try_ms = t + wait;
        ESP_LOGW(TAG, "finalize gönderilemedi (%s), %lld sn sonra yeniden", f.code, (long long)(wait / 1000));
        break;
    }
    }
}

/* Oturumun durumuna göre sunucuya sıradaki istek (yetki / heartbeat / finalize). */
static void submit_session_request(int64_t t)
{
    char body[YT_API_BODY_MAX];
    switch (s_session.state) {
    case YT_S_REQUESTING:
        if (yt_api_body_request_auth(body, sizeof body, s_session.card_id, s_tank)) {
            app_link_submit(LINK_AUTH, "/dispense/request-auth", body);
        }
        break;
    case YT_S_AUTHORIZED:
    case YT_S_PUMPING:
        if (yt_session_heartbeat_due(&s_session, t) &&
            yt_api_body_heartbeat(body, sizeof body, s_session.session_id, yt_flow_totalizer_liters(&s_flow),
                                  yt_flow_rate_lpm(&s_flow, t))) {
            yt_session_mark_heartbeat_sent(&s_session, t);
            app_link_submit(LINK_HEARTBEAT, "/dispense/heartbeat", body);
        }
        break;
    case YT_S_FINALIZING:
        if (t - s_session.state_since_ms >= FINALIZE_SETTLE_MS &&
            yt_api_body_finalize(body, sizeof body, &s_session, yt_flow_totalizer_liters(&s_flow))) {
            app_link_submit(LINK_FINALIZE, "/dispense/finalize", body);
        }
        break;
    default:
        break;
    }
}

static void drive_link(int64_t t)
{
    if (!s_link_ok) return;

    link_kind_t done;
    const yt_http_resp_t *resp;
    if (app_link_poll(&done, &resp)) {
        if (done == LINK_AUTH && s_session.state == YT_S_REQUESTING) on_auth(resp, t);
        else if (done == LINK_HEARTBEAT) on_heartbeat(resp, t);
        else if (done == LINK_FINALIZE && s_session.state == YT_S_FINALIZING) on_finalize(resp, t);
        else if (done == LINK_CALIBRATION && s_cal.pending) on_calibration_ack(resp, t);
        app_link_release();
    }
    if (app_link_busy()) return;

    /* Kalibrasyon yanıtı 5 dk'da hiç ulaştırılamadıysa sunucu komutu zaman aşımına düşürdü. */
    if (s_cal.pending && !s_cal.maybe_delivered && t - s_cal.received_ms >= YT_CALIBRATION_WINDOW_MS) {
        calibration_revert("5 dk içinde ulaştırılamadı");
    }

    if (!yt_net_is_up()) {
        /* Çevrimdışı beklenen bir durum: istek denenmez (deneme hakkı ve geri çekilme harcanmaz).
         * Bekleyen finalize ağ gelince gider; heartbeat'siz 15 sn'de oturum kendisi keser.
         * Yeni kart şimdilik reddedilir — sınırlı çevrimdışı ikmal FW-1310 ile gelecek. */
        if (s_session.state == YT_S_REQUESTING) {
            ESP_LOGW(TAG, "çevrimdışı — kart reddedildi");
            yt_session_on_auth_denied(&s_session, "OFFLINE", t);
        }
        return;
    }

    if (t >= s_next_try_ms) submit_session_request(t);

    /* Oturum isteği yoksa sırada kalibrasyon yanıtı. */
    char body[YT_API_BODY_MAX];
    if (!app_link_busy() && s_cal.pending && t >= s_cal.next_try_ms &&
        yt_cmd_calibration_ack_body(body, sizeof body, s_cal.command_id, s_cal.ack, s_cal.applied_k, s_cal.reason)) {
        app_link_submit(LINK_CALIBRATION, "/telemetry/calibration-ack", body);
    }
}

/* Oturum durum geçişlerinde bir kez yapılacaklar. */
static void on_state_change(yt_session_state_t from, int64_t t)
{
    s_attempts = 0;
    s_next_try_ms = 0;
    switch (s_session.state) {
    case YT_S_FINALIZING:
        if (from == YT_S_AUTHORIZED || from == YT_S_PUMPING) {
            double k_before = s_flow.k_factor;
            double liters = yt_flow_session_end(&s_flow);
            ESP_LOGI(TAG, "ikmal bitti (%s), %.3f L — sunucuya bildiriliyor", yt_end_reason_name(s_session.end_reason),
                     liters);
            if (s_flow.k_factor != k_before && s_store_ok) yt_store_save_k_factor(s_flow.k_factor);
        }
        break;
    case YT_S_ABORTED:
        if (from == YT_S_REQUESTING) break; /* sebep zaten loglandı */
        ESP_LOGW(TAG, "oturum iptal: %s", s_session.session_id);
        break;
    case YT_S_IDLE:
        ESP_LOGI(TAG, "yeni karta hazır");
        break;
    default:
        break;
    }
}

static bool can_accept_card(bool estop, bool pf)
{
    return s_store_ok && s_meter_ok && s_link_ok && !estop && !pf;
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

    /* 5) Girişler, akışmetre, kart kaynağı. */
    s_main_task = xTaskGetCurrentTaskHandle();
    inputs_init();
    s_meter_ok = yt_pcnt_init(CONFIG_YT_PIN_FLOW, CONFIG_YT_FLOW_GLITCH_NS) == ESP_OK;
    if (!s_meter_ok) ESP_LOGE(TAG, "Akışmetre başlatılamadı — ikmal KAPALI (ölçemeyen cihaz ikmal yapmaz)");
    s_card_q = xQueueCreate(2, YT_CARD_ID_MAX);
#if CONFIG_YT_DEV_CONSOLE
    app_console_start(s_card_q);
#endif

    /* 6) Sunucu bağlantısı (arka planda kurulur; yarım oturum varsa ağ gelince gönderilir). */
    link_init();

    /* 7) Denetim döngüsü watchdog'a bağlı (FW-1313): takılırsa panik → reset → röle donanımsal
     *    olarak kapanır, açılışta yarım oturum kurtarılır. */
    ESP_ERROR_CHECK(esp_task_wdt_add(NULL));

    bool was_estop = false, was_pf = false;
    yt_session_state_t prev_state = s_session.state;
    for (;;) {
        int64_t t = now_ms();

        uint32_t pulses = yt_pcnt_take();
#if CONFIG_YT_DEV_CONSOLE
        pulses += app_console_sim_pulses(s_flow.k_factor, yt_relay_is_on());
#endif
        if (pulses) yt_flow_add_pulses(&s_flow, pulses, t);

        bool estop = estop_active();
        if (estop && !was_estop) {
            ESP_LOGW(TAG, "ACİL DURDURMA");
            yt_session_on_emergency_stop(&s_session, t);
        }
        was_estop = estop;
        bool pf = power_failing();

        char card[YT_CARD_ID_MAX];
        if (xQueueReceive(s_card_q, card, 0) == pdTRUE) {
            if (!can_accept_card(estop, pf)) {
                ESP_LOGW(TAG, "kart yok sayıldı: cihaz ikmale hazır değil");
            } else if (yt_session_on_card(&s_session, card, t)) {
                ESP_LOGI(TAG, "kart okundu: %s — yetki isteniyor", card);
            } else {
                ESP_LOGW(TAG, "kart yok sayıldı: önceki işlem sürüyor (%s)", yt_session_state_name(s_session.state));
            }
        }

        handle_commands(t);
        drive_link(t);
        yt_session_tick(&s_session, yt_flow_session_liters(&s_flow), pulses > 0, t);
        if ((s_session.state == YT_S_COMPLETED || s_session.state == YT_S_ABORTED) &&
            t - s_session.state_since_ms >= RESULT_SHOW_MS) {
            yt_session_reset(&s_session, t);
        }
        if (s_session.state != prev_state) {
            on_state_change(prev_state, t);
            prev_state = s_session.state;
        }

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

#if CONFIG_YT_DEV_CONSOLE
        if (app_console_status_requested()) {
            ESP_LOGI(TAG, "durum: %s, totalizatör %.3f L, ikmal %.3f L, debi %.1f L/dk, röle %s, ağ %s, saat %s",
                     yt_session_state_name(s_session.state), yt_flow_totalizer_liters(&s_flow),
                     yt_flow_session_liters(&s_flow), yt_flow_rate_lpm(&s_flow, t), yt_relay_is_on() ? "AÇIK" : "KAPALI",
                     yt_net_is_up() ? "var" : "yok", yt_time_trusted() ? "eşit" : "eşit değil");
        }
#endif

        esp_task_wdt_reset();
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(LOOP_PERIOD_MS));
    }
}
