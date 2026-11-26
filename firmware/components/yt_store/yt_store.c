#include "yt_store.h"

#include <math.h>
#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "yt_flow.h"

static const char *TAG = "yt_store";

static nvs_handle_t s_main = 0;
static nvs_handle_t s_sec = 0;
static nvs_handle_t s_cfg = 0;
static bool s_ready = false;

esp_err_t yt_store_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS açılamadı: %s. Totalizatör/K-faktörü/secret bu bölümde; "
                      "otomatik SİLİNMEDİ — ikmal kapalı, servis gerekli.", esp_err_to_name(err));
        return err;
    }
    err = nvs_open("yt", NVS_READWRITE, &s_main);
    if (err == ESP_OK) err = nvs_open("yt_sec", NVS_READWRITE, &s_sec);
    if (err == ESP_OK) err = nvs_open("yt_cfg", NVS_READWRITE, &s_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS ad alanı açılamadı: %s", esp_err_to_name(err));
        return err;
    }
    s_ready = true;
    return ESP_OK;
}

bool yt_store_ready(void)
{
    return s_ready;
}

static esp_err_t commit(nvs_handle_t h, esp_err_t err)
{
    return err == ESP_OK ? nvs_commit(h) : err;
}

esp_err_t yt_store_load_totalizer_ml(uint64_t *ml)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    return nvs_get_u64(s_main, "tot_ml", ml);
}

esp_err_t yt_store_save_totalizer_ml(uint64_t ml)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    return commit(s_main, nvs_set_u64(s_main, "tot_ml", ml));
}

esp_err_t yt_store_load_k_factor(double *k)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    double v = 0;
    size_t len = sizeof v;
    esp_err_t err = nvs_get_blob(s_main, "k_factor", &v, &len);
    if (err != ESP_OK) return err;
    if (len != sizeof v || !isfinite(v) || v < YT_FLOW_K_MIN || v > YT_FLOW_K_MAX) return ESP_ERR_INVALID_STATE;
    *k = v;
    return ESP_OK;
}

esp_err_t yt_store_save_k_factor(double k)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    if (!isfinite(k) || k < YT_FLOW_K_MIN || k > YT_FLOW_K_MAX) return ESP_ERR_INVALID_ARG;
    return commit(s_main, nvs_set_blob(s_main, "k_factor", &k, sizeof k));
}

esp_err_t yt_store_load_marker(yt_session_marker_t *m)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    uint8_t buf[YT_MARKER_ENCODED_MAX];
    size_t len = sizeof buf;
    esp_err_t err = nvs_get_blob(s_main, "sess", buf, &len);
    if (err == ESP_ERR_NVS_INVALID_LENGTH) return ESP_ERR_INVALID_CRC; /* beklenenden büyük: başka sürüm */
    if (err != ESP_OK) return err;
    return yt_marker_decode(buf, len, m) ? ESP_OK : ESP_ERR_INVALID_CRC;
}

esp_err_t yt_store_save_marker(const yt_session_marker_t *m)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    uint8_t buf[YT_MARKER_ENCODED_MAX];
    size_t len = yt_marker_encode(m, buf, sizeof buf);
    if (len == 0) return ESP_ERR_INVALID_ARG;
    return commit(s_main, nvs_set_blob(s_main, "sess", buf, len));
}

esp_err_t yt_store_clear_marker(void)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    esp_err_t err = nvs_erase_key(s_main, "sess");
    if (err == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    return commit(s_main, err);
}

esp_err_t yt_store_get_config(const char *key, char *buf, size_t cap)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    size_t len = cap;
    esp_err_t err = nvs_get_str(s_cfg, key, buf, &len);
    if (err != ESP_OK && cap > 0) buf[0] = '\0';
    return err;
}

esp_err_t yt_store_load_credentials(char *device_id, size_t id_cap, char *secret, size_t secret_cap)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    size_t len = id_cap;
    esp_err_t err = nvs_get_str(s_sec, "dev_id", device_id, &len);
    if (err != ESP_OK) return err;
    len = secret_cap;
    return nvs_get_str(s_sec, "secret", secret, &len);
}

esp_err_t yt_store_save_credentials(const char *device_id, const char *secret)
{
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    if (!device_id || !secret || strlen(device_id) >= YT_DEVICE_ID_MAX || strlen(secret) >= YT_SECRET_MAX) {
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t err = nvs_set_str(s_sec, "dev_id", device_id);
    if (err == ESP_OK) err = nvs_set_str(s_sec, "secret", secret);
    return commit(s_sec, err);
}
