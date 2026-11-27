#include "yt_reader.h"

#include <string.h>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "yt_pn532.h"

static const char *TAG = "yt_reader";

#define PN532_I2C_ADDR 0x24
#define I2C_TIMEOUT_MS 50
#define READY_TIMEOUT_MS 120
#define POLL_MS 100
#define CONFIRM_POLL_MS 20       /* aday kart varken onay okuması hemen */
#define MAX_ERRORS 10            /* art arda bu kadar hata → okuyucu yeniden başlatılır */

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_dev;
static yt_reader_cb s_cb;
static volatile bool s_ok;

bool yt_reader_ok(void)
{
    return s_ok;
}

/* I2C modunda her okuma bir durum baytıyla başlar: bit0 = 1 → yanıt hazır. */
static bool wait_ready(int timeout_ms)
{
    uint8_t st = 0;
    for (int waited = 0; waited <= timeout_ms; waited += 5) {
        if (i2c_master_receive(s_dev, &st, 1, I2C_TIMEOUT_MS) == ESP_OK && (st & 0x01)) return true;
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    return false;
}

static esp_err_t pn532_cmd(uint8_t cmd, const uint8_t *params, size_t plen, uint8_t *resp, size_t cap, size_t *rlen)
{
    uint8_t frame[YT_PN532_FRAME_MAX];
    size_t n = yt_pn532_build(frame, sizeof frame, cmd, params, plen);
    if (!n) return ESP_ERR_INVALID_SIZE;
    esp_err_t err = i2c_master_transmit(s_dev, frame, n, I2C_TIMEOUT_MS);
    if (err != ESP_OK) return err;

    uint8_t ack[7];
    if (!wait_ready(READY_TIMEOUT_MS)) return ESP_ERR_TIMEOUT;
    err = i2c_master_receive(s_dev, ack, sizeof ack, I2C_TIMEOUT_MS);
    if (err != ESP_OK) return err;
    if (!yt_pn532_is_ack(ack, sizeof ack)) return ESP_ERR_INVALID_RESPONSE;

    uint8_t buf[YT_PN532_FRAME_MAX];
    if (!wait_ready(READY_TIMEOUT_MS)) return ESP_ERR_TIMEOUT;
    err = i2c_master_receive(s_dev, buf, sizeof buf, I2C_TIMEOUT_MS);
    if (err != ESP_OK) return err;
    yt_pn532_err_t pe = yt_pn532_parse(buf + 1, sizeof buf - 1, resp, cap, rlen);
    if (pe != YT_PN532_OK) return ESP_ERR_INVALID_CRC;
    if (*rlen < 1 || resp[0] != (uint8_t)(cmd + 1)) return ESP_ERR_INVALID_RESPONSE;
    return ESP_OK;
}

static esp_err_t pn532_init(void)
{
    uint8_t r[YT_PN532_FRAME_MAX];
    size_t rl = 0;
    esp_err_t err = pn532_cmd(YT_PN532_CMD_GET_FIRMWARE_VERSION, NULL, 0, r, sizeof r, &rl);
    if (err != ESP_OK) return err;
    uint8_t ic, ver, rev;
    if (!yt_pn532_parse_firmware(r, rl, &ic, &ver, &rev) || ic != 0x32) return ESP_ERR_NOT_SUPPORTED;
    ESP_LOGI(TAG, "PN532 bulundu (firmware %u.%u)", ver, rev);

    /* Normal mod, IRQ kullanılmıyor (durum baytı yoklanır). */
    static const uint8_t sam[] = { 0x01, 0x14, 0x01 };
    err = pn532_cmd(YT_PN532_CMD_SAM_CONFIGURATION, sam, sizeof sam, r, sizeof r, &rl);
    if (err != ESP_OK) return err;

    /* MaxRetries: pasif etkinleştirmede 1 deneme — kart yoksa InListPassiveTarget hemen
     * döner (varsayılan 0xFF = kart gelene kadar bekler, görevi kilitler). */
    static const uint8_t retries[] = { 0x05, 0xFF, 0x01, 0x01 };
    return pn532_cmd(YT_PN532_CMD_RF_CONFIGURATION, retries, sizeof retries, r, sizeof r, &rl);
}

/* 1: geçerli kart (uid_hex dolu), 0: kart yok / kullanılamaz kart, < 0: okuma hatası. */
static int poll_once(char *uid_hex, size_t cap)
{
    static const uint8_t inlist[] = { 0x01, 0x00 }; /* en fazla 1 hedef, 106 kbps tip A */
    uint8_t r[YT_PN532_FRAME_MAX];
    size_t rl = 0;
    if (pn532_cmd(YT_PN532_CMD_IN_LIST_PASSIVE_TARGET, inlist, sizeof inlist, r, sizeof r, &rl) != ESP_OK) return -1;
    yt_card_t card;
    int found = yt_pn532_parse_inlist(r, rl, &card);
    if (found <= 0) return found;

    yt_uid_check_t chk = yt_uid_check(card.uid, card.uid_len);
    if (chk != YT_UID_OK) {
        static int64_t last_warn;
        int64_t now = (int64_t)xTaskGetTickCount() * portTICK_PERIOD_MS;
        if (now - last_warn > 5000) {
            ESP_LOGW(TAG, "kullanılamaz kart (%s) — yok sayıldı", yt_uid_check_name(chk));
            last_warn = now;
        }
        return 0;
    }
    return yt_uid_hex(card.uid, card.uid_len, uid_hex, cap) ? 1 : -1;
}

static void reader_task(void *arg)
{
    yt_rfid_tracker_t tracker;
    yt_rfid_tracker_init(&tracker);
    int backoff_ms = 1000;
    int errors = 0;

    for (;;) {
        if (!s_ok) {
            if (pn532_init() == ESP_OK) {
                s_ok = true;
                errors = 0;
                backoff_ms = 1000;
                yt_rfid_tracker_init(&tracker);
            } else {
                ESP_LOGW(TAG, "PN532 yanıt vermiyor — %d sn sonra yeniden denenecek", backoff_ms / 1000);
                vTaskDelay(pdMS_TO_TICKS(backoff_ms));
                backoff_ms = backoff_ms * 2 > 30000 ? 30000 : backoff_ms * 2;
                continue;
            }
        }

        char uid[YT_RFID_UID_HEX_MAX] = "";
        int res = poll_once(uid, sizeof uid);
        if (res < 0) {
            /* Hata tarafsız: kartı ne onaylar ne çekildi sayar. */
            if (++errors >= MAX_ERRORS) {
                ESP_LOGW(TAG, "okuyucu art arda %d kez okunamadı — yeniden başlatılıyor", errors);
                s_ok = false;
            }
            vTaskDelay(pdMS_TO_TICKS(POLL_MS));
            continue;
        }
        errors = 0;

        char ev_uid[YT_RFID_UID_HEX_MAX];
        yt_rfid_event_t ev = yt_rfid_tracker_feed(&tracker, res == 1 ? uid : NULL, ev_uid, sizeof ev_uid);
        if (ev != YT_RFID_NONE && s_cb) s_cb(ev, ev_uid);

        vTaskDelay(pdMS_TO_TICKS(tracker.candidate_hits > 0 ? CONFIRM_POLL_MS : POLL_MS));
    }
}

esp_err_t yt_reader_start(int sda_gpio, int scl_gpio, yt_reader_cb cb)
{
    s_cb = cb;
    i2c_master_bus_config_t bc = {
        .i2c_port = -1, /* boş port seç */
        .sda_io_num = sda_gpio,
        .scl_io_num = scl_gpio,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bc, &s_bus);
    if (err != ESP_OK) return err;
    i2c_device_config_t dc = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = PN532_I2C_ADDR,
        .scl_speed_hz = 100000,
    };
    err = i2c_master_bus_add_device(s_bus, &dc, &s_dev);
    if (err != ESP_OK) return err;
    xTaskCreate(reader_task, "yt_reader", 4096, NULL, tskIDLE_PRIORITY + 2, NULL);
    ESP_LOGI(TAG, "RFID okuyucu (PN532, I2C SDA %d / SCL %d) başlatıldı", sda_gpio, scl_gpio);
    return ESP_OK;
}
