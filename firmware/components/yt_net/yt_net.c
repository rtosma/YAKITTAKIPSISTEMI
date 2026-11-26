#include "yt_net.h"

#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "sdkconfig.h"
#include "yt_net_priv.h"

#if CONFIG_YT_NET_OPENETH
#include "esp_eth.h"
#include "esp_eth_mac_openeth.h"
#else
#include "esp_wifi.h"
#endif

static const char *TAG = "yt_net";

#define BACKOFF_MIN_MS 1000
#define BACKOFF_MAX_MS 30000 /* FW-1306 AC: ağ geri gelince 30 sn içinde bağlan */

static yt_net_config_t s_cfg;
static volatile bool s_up;
static volatile bool s_time_trusted;

const yt_net_config_t *yt_net_cfg(void)
{
    return &s_cfg;
}

bool yt_net_is_up(void)
{
    return s_up;
}

/* ---------- saat ---------- */

static int64_t raw_now_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

bool yt_time_trusted(void)
{
    return s_time_trusted;
}

int64_t yt_time_now_ms(void)
{
    return s_time_trusted ? raw_now_ms() : 0;
}

void yt_time_observe_server(int64_t server_ms)
{
    if (server_ms <= 0) return;
    int64_t drift = raw_now_ms() - server_ms;
    if (s_time_trusted && llabs(drift) <= 2000) return;
    struct timeval tv = { .tv_sec = server_ms / 1000, .tv_usec = (server_ms % 1000) * 1000 };
    settimeofday(&tv, NULL);
    if (s_time_trusted) {
        ESP_LOGW(TAG, "saat sunucuya göre %lld ms kaymıştı, düzeltildi", (long long)drift);
    } else {
        ESP_LOGI(TAG, "saat sunucuyla eşitlendi");
    }
    s_time_trusted = true;
}

static void on_sntp(struct timeval *tv)
{
    if (!s_time_trusted) ESP_LOGI(TAG, "saat SNTP ile eşitlendi");
    s_time_trusted = true;
}

/* ---------- bağlantı ---------- */

static void on_ip(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (id == IP_EVENT_STA_GOT_IP || id == IP_EVENT_ETH_GOT_IP) {
        const ip_event_got_ip_t *e = data;
        ESP_LOGI(TAG, "ağ hazır, IP " IPSTR, IP2STR(&e->ip_info.ip));
        s_up = true;
    } else if (id == IP_EVENT_STA_LOST_IP) {
        ESP_LOGW(TAG, "IP kaybedildi — çevrimdışı");
        s_up = false;
    }
}

#if CONFIG_YT_NET_OPENETH

int yt_net_rssi(void)
{
    return 0;
}

static esp_err_t link_start(void)
{
    esp_netif_config_t ncfg = ESP_NETIF_DEFAULT_ETH();
    esp_netif_t *netif = esp_netif_new(&ncfg);
    eth_mac_config_t mac_config = ETH_MAC_DEFAULT_CONFIG();
    eth_phy_config_t phy_config = ETH_PHY_DEFAULT_CONFIG();
    phy_config.autonego_timeout_ms = 100;
    esp_eth_mac_t *mac = esp_eth_mac_new_openeth(&mac_config);
    esp_eth_phy_t *phy = esp_eth_phy_new_dp83848(&phy_config);
    esp_eth_config_t config = ETH_DEFAULT_CONFIG(mac, phy);
    esp_eth_handle_t eth = NULL;
    esp_err_t err = esp_eth_driver_install(&config, &eth);
    if (err != ESP_OK) return err;
    esp_netif_attach(netif, esp_eth_new_netif_glue(eth));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, on_ip, NULL));
    ESP_LOGI(TAG, "QEMU Ethernet (openeth) başlatılıyor");
    return esp_eth_start(eth);
}

#else

static int s_backoff_ms = BACKOFF_MIN_MS;
static esp_timer_handle_t s_reconnect;

int yt_net_rssi(void)
{
    wifi_ap_record_t ap;
    return (s_up && esp_wifi_sta_get_ap_info(&ap) == ESP_OK) ? ap.rssi : 0;
}

static void reconnect(void *arg)
{
    esp_wifi_connect();
}

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (id == WIFI_EVENT_STA_CONNECTED) {
        s_backoff_ms = BACKOFF_MIN_MS;
    } else if (id == WIFI_EVENT_STA_DISCONNECTED) {
        /* Bağlantı yokluğu beklenen durum: çevrimdışı moda geç, sessizce yeniden dene. */
        s_up = false;
        ESP_LOGW(TAG, "WiFi yok — %d sn sonra yeniden denenecek", s_backoff_ms / 1000);
        esp_timer_stop(s_reconnect);
        esp_timer_start_once(s_reconnect, (uint64_t)s_backoff_ms * 1000);
        s_backoff_ms = s_backoff_ms * 2 > BACKOFF_MAX_MS ? BACKOFF_MAX_MS : s_backoff_ms * 2;
    }
}

static esp_err_t link_start(void)
{
    if (!s_cfg.wifi_ssid[0]) {
        ESP_LOGE(TAG, "WiFi adı (wifi_ssid) yapılandırılmamış — ağ kapalı");
        return ESP_ERR_INVALID_STATE;
    }
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    const esp_timer_create_args_t t = { .callback = reconnect, .name = "wifi_retry" };
    ESP_ERROR_CHECK(esp_timer_create(&t, &s_reconnect));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_ip, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_LOST_IP, on_ip, NULL));

    wifi_config_t wc = { 0 };
    strlcpy((char *)wc.sta.ssid, s_cfg.wifi_ssid, sizeof wc.sta.ssid);
    strlcpy((char *)wc.sta.password, s_cfg.wifi_pass, sizeof wc.sta.password);
    wc.sta.threshold.authmode = s_cfg.wifi_pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_LOGI(TAG, "WiFi \"%s\" ağına bağlanılıyor", s_cfg.wifi_ssid);
    return esp_wifi_start();
}

#endif

esp_err_t yt_net_start(const yt_net_config_t *cfg)
{
    s_cfg = *cfg;
    ESP_ERROR_CHECK(esp_netif_init());
    esp_err_t err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;

    esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG(CONFIG_YT_NTP_SERVER);
    sntp.sync_cb = on_sntp;
    esp_netif_sntp_init(&sntp);

    return link_start();
}
