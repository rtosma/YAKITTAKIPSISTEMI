#include "yt_mqtt.h"

#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "mqtt_client.h"
#include "sdkconfig.h"
#include "yt_cmd.h"

static const char *TAG = "yt_mqtt";

#define PRESENCE_PERIOD_US (8 * 1000 * 1000)

static yt_mqtt_config_t s_cfg;
static yt_mqtt_command_cb s_cb;
static esp_mqtt_client_handle_t s_client;
static esp_timer_handle_t s_presence;
static volatile bool s_connected;
static char s_cmd_topic[YT_TOPIC_MAX];
static char s_ack_topic[YT_TOPIC_MAX];
static char s_status_topic[YT_TOPIC_MAX];

bool yt_mqtt_connected(void)
{
    return s_connected;
}

static void publish_online(void *arg)
{
    if (s_connected) esp_mqtt_client_publish(s_client, s_status_topic, "ONLINE", 6, 1, 0);
}

bool yt_mqtt_publish_ack(const char *command_id, bool ack)
{
    char body[128];
    size_t n = yt_cmd_ack_body(body, sizeof body, command_id, ack);
    if (!n || !s_client) return false;
    /* Bağlı değilse esp-mqtt QoS 1 mesajı kuyrukta tutar, bağlanınca gönderir. */
    return esp_mqtt_client_enqueue(s_client, s_ack_topic, body, (int)n, 1, 0, true) >= 0;
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    esp_mqtt_event_handle_t e = data;
    switch ((esp_mqtt_event_id_t)id) {
    case MQTT_EVENT_CONNECTED:
        s_connected = true;
        ESP_LOGI(TAG, "MQTT bağlandı, komut kanalı: %s", s_cmd_topic);
        esp_mqtt_client_subscribe(s_client, s_cmd_topic, 1);
        publish_online(NULL);
        break;
    case MQTT_EVENT_DISCONNECTED:
        if (s_connected) ESP_LOGW(TAG, "MQTT koptu — yeniden bağlanılacak");
        s_connected = false;
        break;
    case MQTT_EVENT_DATA:
        /* Komutlar küçüktür; parçalı (tampondan büyük) yük güvenle birleştirilemez → yok say. */
        if (e->current_data_offset != 0 || e->data_len != e->total_data_len) {
            ESP_LOGW(TAG, "parçalı MQTT yükü yok sayıldı (%d bayt)", e->total_data_len);
            break;
        }
        if (e->topic_len == (int)strlen(s_cmd_topic) && memcmp(e->topic, s_cmd_topic, e->topic_len) == 0 && s_cb) {
            s_cb(e->data, (size_t)e->data_len);
        }
        break;
    case MQTT_EVENT_ERROR:
        ESP_LOGW(TAG, "MQTT hatası (tip %d)", e->error_handle ? (int)e->error_handle->error_type : -1);
        break;
    default:
        break;
    }
}

static bool url_allowed(const char *url)
{
    if (strncmp(url, "mqtts://", 8) == 0) return true;
#if CONFIG_YT_DEV_ALLOW_PLAINTEXT
    return strncmp(url, "mqtt://", 7) == 0;
#else
    return false;
#endif
}

esp_err_t yt_mqtt_start(const yt_mqtt_config_t *cfg, yt_mqtt_command_cb cb)
{
    s_cfg = *cfg;
    s_cb = cb;
    if (!url_allowed(s_cfg.url)) {
        ESP_LOGE(TAG, "şifresiz MQTT adresi reddedildi — mqtts:// gerekli");
        return ESP_ERR_INVALID_ARG;
    }
    if (!yt_topic_command(s_cmd_topic, sizeof s_cmd_topic, s_cfg.device_id) ||
        !yt_topic_command_ack(s_ack_topic, sizeof s_ack_topic, s_cfg.device_id) ||
        !yt_topic_status(s_status_topic, sizeof s_status_topic, s_cfg.tenant_id, s_cfg.site_id, CONFIG_YT_DEVICE_TYPE,
                         s_cfg.device_id)) {
        ESP_LOGE(TAG, "MQTT topic'i kurulamadı (tenant_id/site_id/cihaz kimliği eksik veya geçersiz)");
        return ESP_ERR_INVALID_ARG;
    }

    esp_mqtt_client_config_t mc = {
        .broker.address.uri = s_cfg.url,
        .broker.verification.crt_bundle_attach = strncmp(s_cfg.url, "mqtts://", 8) == 0 ? esp_crt_bundle_attach : NULL,
        .credentials.username = s_cfg.user[0] ? s_cfg.user : NULL,
        .credentials.authentication.password = s_cfg.pass[0] ? s_cfg.pass : NULL,
        .credentials.client_id = s_cfg.device_id, /* kalıcı oturum için sabit */
        .session.disable_clean_session = true,
        .session.keepalive = 30,
        .session.last_will = { .topic = s_status_topic, .msg = "OFFLINE", .msg_len = 7, .qos = 1, .retain = 0 },
        .network.reconnect_timeout_ms = 5000,
    };
    s_client = esp_mqtt_client_init(&mc);
    if (!s_client) return ESP_FAIL;
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, on_event, NULL);

    const esp_timer_create_args_t t = { .callback = publish_online, .name = "mqtt_presence" };
    ESP_ERROR_CHECK(esp_timer_create(&t, &s_presence));
    ESP_ERROR_CHECK(esp_timer_start_periodic(s_presence, PRESENCE_PERIOD_US));

    ESP_LOGI(TAG, "MQTT %s (istemci %s)", s_cfg.url, s_cfg.device_id);
    return esp_mqtt_client_start(s_client);
}
