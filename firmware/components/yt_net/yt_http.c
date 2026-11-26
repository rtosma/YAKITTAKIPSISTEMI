#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_random.h"
#include "sdkconfig.h"
#include "yt_api.h"
#include "yt_net_priv.h"

static const char *TAG = "yt_http";

#define HTTP_TIMEOUT_MS 8000

typedef struct {
    yt_http_resp_t *resp;
    size_t len;
    char date[40];
} ctx_t;

static esp_err_t on_event(esp_http_client_event_t *e)
{
    ctx_t *c = e->user_data;
    if (e->event_id == HTTP_EVENT_ON_HEADER && strcasecmp(e->header_key, "Date") == 0) {
        strlcpy(c->date, e->header_value, sizeof c->date);
    } else if (e->event_id == HTTP_EVENT_ON_DATA && c->resp) {
        size_t room = sizeof c->resp->body - 1 - c->len;
        size_t n = (size_t)e->data_len < room ? (size_t)e->data_len : room;
        memcpy(c->resp->body + c->len, e->data, n);
        c->len += n;
        c->resp->body[c->len] = '\0';
    }
    return ESP_OK;
}

static bool is_https(const char *url)
{
    return strncmp(url, "https://", 8) == 0;
}

static bool url_allowed(const char *url)
{
    if (is_https(url)) return true;
#if CONFIG_YT_DEV_ALLOW_PLAINTEXT_HTTP
    return strncmp(url, "http://", 7) == 0;
#else
    return false;
#endif
}

/* Date başlığına yalnızca kimliği doğrulanmış (TLS) bir sunucudan güvenilir; düz HTTP
 * yalnızca geliştirme yapılandırmasında zaten açık. */
static void adopt_date(const ctx_t *c)
{
    if (!c->date[0]) return;
    int64_t ms = yt_api_parse_http_date(c->date);
    if (ms > 0) yt_time_observe_server(ms + 500); /* 1 sn çözünürlük: ortası */
}

static int perform(const char *url, const char *body, const yt_api_auth_t *auth, ctx_t *ctx)
{
    const yt_net_config_t *cfg = yt_net_cfg();
    esp_http_client_config_t hc = {
        .url = url,
        .method = body ? HTTP_METHOD_POST : HTTP_METHOD_GET,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .event_handler = on_event,
        .user_data = ctx,
        .crt_bundle_attach = is_https(url) ? esp_crt_bundle_attach : NULL,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t h = esp_http_client_init(&hc);
    if (!h) return -1;
    if (auth) {
        esp_http_client_set_header(h, "X-Device-ID", cfg->device_id);
        esp_http_client_set_header(h, "X-Timestamp", auth->timestamp);
        esp_http_client_set_header(h, "X-Nonce", auth->nonce);
        esp_http_client_set_header(h, "X-Hardware-Signature", auth->signature);
    }
    if (body) {
        esp_http_client_set_header(h, "Content-Type", "application/json");
        esp_http_client_set_post_field(h, body, (int)strlen(body));
    }
    esp_err_t err = esp_http_client_perform(h);
    int status = err == ESP_OK ? esp_http_client_get_status_code(h) : -1;
    if (err != ESP_OK) ESP_LOGW(TAG, "%s: %s", url, esp_err_to_name(err));
    esp_http_client_cleanup(h);
    return status;
}

/* İmza için saat şart: güvenilir değilse imzasız GET /health yanıtının Date başlığından al. */
static bool ensure_time(void)
{
    if (yt_time_trusted()) return true;
    char url[YT_NET_URL_MAX + 16];
    snprintf(url, sizeof url, "%s/health", yt_net_cfg()->base_url);
    ctx_t ctx = { 0 };
    perform(url, NULL, NULL, &ctx);
    adopt_date(&ctx);
    return yt_time_trusted();
}

void yt_http_signed(const char *path, const char *body, yt_http_resp_t *resp)
{
    resp->status = -1;
    resp->body[0] = '\0';
    const yt_net_config_t *cfg = yt_net_cfg();

    char url[YT_NET_URL_MAX + 64];
    snprintf(url, sizeof url, "%s%s", cfg->base_url, path);
    if (!url_allowed(url)) {
        ESP_LOGE(TAG, "şifresiz adres reddedildi (%s) — https:// gerekli", cfg->base_url);
        resp->status = -2;
        return;
    }
    if (!yt_net_is_up()) return;
    if (!ensure_time()) {
        ESP_LOGW(TAG, "saat eşitlenemedi — imzalı istek gönderilmedi");
        return;
    }

    yt_api_auth_t auth;
    if (yt_api_sign(cfg->secret, yt_time_now_ms(), esp_fill_random, body, body ? strlen(body) : 0, &auth) != 0) {
        ESP_LOGE(TAG, "imza üretilemedi (secret yok?)");
        return;
    }
    ctx_t ctx = { .resp = resp };
    resp->status = perform(url, body, &auth, &ctx);
    adopt_date(&ctx);
}
