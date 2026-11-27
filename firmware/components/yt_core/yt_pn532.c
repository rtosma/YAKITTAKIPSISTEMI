#include "yt_pn532.h"

#include <string.h>

#define TFI_HOST 0xD4
#define TFI_PN532 0xD5

size_t yt_pn532_build(uint8_t *out, size_t cap, uint8_t cmd, const uint8_t *params, size_t params_len)
{
    size_t len = 2 + params_len; /* TFI + cmd + params */
    size_t total = 3 + 2 + len + 2;
    if (!out || len > 254 || total > cap || (params_len && !params)) return 0;
    size_t p = 0;
    out[p++] = 0x00;
    out[p++] = 0x00;
    out[p++] = 0xFF;
    out[p++] = (uint8_t)len;
    out[p++] = (uint8_t)(0x100 - len);
    uint8_t sum = TFI_HOST + cmd;
    out[p++] = TFI_HOST;
    out[p++] = cmd;
    for (size_t i = 0; i < params_len; i++) {
        out[p++] = params[i];
        sum += params[i];
    }
    out[p++] = (uint8_t)(0x100 - sum);
    out[p++] = 0x00;
    return p;
}

bool yt_pn532_is_ack(const uint8_t *buf, size_t len)
{
    static const uint8_t ack[] = { 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00 };
    if (!buf) return false;
    for (size_t i = 0; i + sizeof ack <= len; i++) {
        if (memcmp(buf + i, ack, sizeof ack) == 0) return true;
    }
    return false;
}

yt_pn532_err_t yt_pn532_parse(const uint8_t *buf, size_t len, uint8_t *payload, size_t cap, size_t *payload_len)
{
    if (!buf) return YT_PN532_E_SHORT;
    size_t i = 0;
    /* Başlangıç kodu 00 FF; önündeki dolgu (I2C durum baytı, 00'lar) atlanır. */
    while (i + 1 < len && !(buf[i] == 0x00 && buf[i + 1] == 0xFF)) i++;
    if (i + 4 > len) return YT_PN532_E_SHORT;
    i += 2;
    uint8_t n = buf[i], lcs = buf[i + 1];
    if (n == 0x01 && lcs == 0xFF && i + 3 < len && buf[i + 2] == 0x7F) return YT_PN532_E_ERROR_FRAME;
    if ((uint8_t)(n + lcs) != 0) return YT_PN532_E_LCS;
    if (n < 1 || i + 2 + n + 1 > len) return YT_PN532_E_SHORT;
    const uint8_t *d = buf + i + 2;
    uint8_t sum = 0;
    for (size_t k = 0; k < n; k++) sum += d[k];
    if ((uint8_t)(sum + d[n]) != 0) return YT_PN532_E_DCS;
    if (d[0] != TFI_PN532) return YT_PN532_E_TFI;
    if (n - 1u > cap) return YT_PN532_E_SPACE;
    memcpy(payload, d + 1, n - 1u);
    *payload_len = n - 1u;
    return YT_PN532_OK;
}

int yt_pn532_parse_inlist(const uint8_t *payload, size_t len, yt_card_t *card)
{
    memset(card, 0, sizeof *card);
    if (!payload || len < 2 || payload[0] != YT_PN532_CMD_IN_LIST_PASSIVE_TARGET + 1) return -1;
    if (payload[1] == 0) return 0;
    /* NbTg ≥ 1: ilk hedef — Tg SENS_RES(2) SEL_RES NFCIDLength NFCID */
    if (len < 7) return -1;
    uint8_t uid_len = payload[6];
    if (uid_len == 0 || uid_len > YT_UID_MAX || len < 7u + uid_len) return -1;
    card->atqa = (uint16_t)(payload[3] << 8 | payload[4]);
    card->sak = payload[5];
    card->uid_len = uid_len;
    memcpy(card->uid, payload + 7, uid_len);
    return 1;
}

bool yt_pn532_parse_firmware(const uint8_t *payload, size_t len, uint8_t *ic, uint8_t *ver, uint8_t *rev)
{
    if (!payload || len < 5 || payload[0] != YT_PN532_CMD_GET_FIRMWARE_VERSION + 1) return false;
    *ic = payload[1];
    *ver = payload[2];
    *rev = payload[3];
    return true;
}
