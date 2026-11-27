/*
 * FW-1302 — NXP PN532 çerçeve protokolü (saf mantık; I2C taşıması components/yt_rfid'de).
 *
 * Kaynak: PN532 User Manual (UM0701-02) §6.2 "Host controller communication protocol".
 *   Bilgi çerçevesi:  00 00 FF LEN LCS TFI PD0..PDn DCS 00
 *     LEN = TFI + PD bayt sayısı, LCS = -LEN, TFI = D4 (ana bilgisayar → PN532) / D5 (geri),
 *     DCS = -(TFI + ΣPD)
 *   ACK:  00 00 FF 00 FF 00      Hata çerçevesi: 00 00 FF 01 FF 7F 81 00
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define YT_PN532_CMD_GET_FIRMWARE_VERSION 0x02
#define YT_PN532_CMD_SAM_CONFIGURATION 0x14
#define YT_PN532_CMD_RF_CONFIGURATION 0x32
#define YT_PN532_CMD_IN_LIST_PASSIVE_TARGET 0x4A

#define YT_PN532_FRAME_MAX 64
#define YT_UID_MAX 10

typedef enum {
    YT_PN532_OK = 0,
    YT_PN532_E_SHORT = -1,     /* çerçeve yok / eksik */
    YT_PN532_E_LCS = -2,       /* uzunluk sağlaması tutmadı */
    YT_PN532_E_DCS = -3,       /* veri sağlaması tutmadı (gürültü) */
    YT_PN532_E_TFI = -4,       /* yön baytı D5 değil */
    YT_PN532_E_ERROR_FRAME = -5,
    YT_PN532_E_SPACE = -6,
} yt_pn532_err_t;

/** cmd + params → tam çerçeve. Dönüş: uzunluk, 0 = sığmadı. */
size_t yt_pn532_build(uint8_t *out, size_t cap, uint8_t cmd, const uint8_t *params, size_t params_len);

bool yt_pn532_is_ack(const uint8_t *buf, size_t len);

/**
 * Yanıt çerçevesini doğrular; payload = yanıt kodu (cmd+1) + veri (TFI hariç).
 * Baştaki dolgu baytları (I2C durum baytı vb.) atlanır.
 */
yt_pn532_err_t yt_pn532_parse(const uint8_t *buf, size_t len, uint8_t *payload, size_t cap, size_t *payload_len);

typedef struct {
    uint8_t uid[YT_UID_MAX];
    uint8_t uid_len;
    uint16_t atqa;   /* SENS_RES */
    uint8_t sak;     /* SEL_RES */
} yt_card_t;

/**
 * InListPassiveTarget (106 kbps tip A) yanıtı: 4B NbTg Tg SENS_RES(2) SEL_RES NFCIDLen NFCID…
 * Dönüş: 1 kart var, 0 kart yok, < 0 bozuk yanıt.
 */
int yt_pn532_parse_inlist(const uint8_t *payload, size_t len, yt_card_t *card);

/** GetFirmwareVersion yanıtı: 03 IC Ver Rev Support. PN532 ise IC = 0x32. */
bool yt_pn532_parse_firmware(const uint8_t *payload, size_t len, uint8_t *ic, uint8_t *ver, uint8_t *rev);

#ifdef __cplusplus
}
#endif
