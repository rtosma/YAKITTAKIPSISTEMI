#include "yt_pn532.h"
#include "yt_rfid.h"
#include "yt_test.h"

#define LEN(a) (sizeof(a) / sizeof((a)[0]))

void test_rfid(void)
{
    uint8_t f[YT_PN532_FRAME_MAX];
    uint8_t p[YT_PN532_FRAME_MAX];
    size_t pl = 0;

    /* --- komut çerçeveleri: PN532 kullanım kılavuzundaki (UM0701) örneklerle bayt bayt --- */
    static const uint8_t fw_cmd[] = { 0x00, 0x00, 0xFF, 0x02, 0xFE, 0xD4, 0x02, 0x2A, 0x00 };
    CHECK(yt_pn532_build(f, sizeof f, YT_PN532_CMD_GET_FIRMWARE_VERSION, NULL, 0) == LEN(fw_cmd));
    CHECK(memcmp(f, fw_cmd, LEN(fw_cmd)) == 0);
    static const uint8_t sam_cmd[] = { 0x00, 0x00, 0xFF, 0x05, 0xFB, 0xD4, 0x14, 0x01, 0x14, 0x01, 0x02, 0x00 };
    static const uint8_t sam_params[] = { 0x01, 0x14, 0x01 };
    CHECK(yt_pn532_build(f, sizeof f, YT_PN532_CMD_SAM_CONFIGURATION, sam_params, 3) == LEN(sam_cmd));
    CHECK(memcmp(f, sam_cmd, LEN(sam_cmd)) == 0);
    static const uint8_t inl_cmd[] = { 0x00, 0x00, 0xFF, 0x04, 0xFC, 0xD4, 0x4A, 0x01, 0x00, 0xE1, 0x00 };
    static const uint8_t inl_params[] = { 0x01, 0x00 };
    CHECK(yt_pn532_build(f, sizeof f, YT_PN532_CMD_IN_LIST_PASSIVE_TARGET, inl_params, 2) == LEN(inl_cmd));
    CHECK(memcmp(f, inl_cmd, LEN(inl_cmd)) == 0);
    CHECK(yt_pn532_build(f, 8, YT_PN532_CMD_GET_FIRMWARE_VERSION, NULL, 0) == 0);   /* sığmadı */

    /* --- ACK --- */
    static const uint8_t ack_i2c[] = { 0x01, 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00 };   /* I2C durum baytıyla */
    CHECK(yt_pn532_is_ack(ack_i2c, LEN(ack_i2c)));
    CHECK(!yt_pn532_is_ack(fw_cmd, LEN(fw_cmd)));

    /* --- yanıtlar --- */
    static const uint8_t fw_resp[] = { 0x01, 0x00, 0x00, 0xFF, 0x06, 0xFA, 0xD5, 0x03, 0x32, 0x01, 0x06, 0x07, 0xE8, 0x00 };
    CHECK(yt_pn532_parse(fw_resp, LEN(fw_resp), p, sizeof p, &pl) == YT_PN532_OK);
    uint8_t ic, ver, rev;
    CHECK(yt_pn532_parse_firmware(p, pl, &ic, &ver, &rev));
    CHECK(ic == 0x32 && ver == 1 && rev == 6);

    static const uint8_t uid4[] = { 0x00, 0x00, 0xFF, 0x0C, 0xF4, 0xD5, 0x4B, 0x01, 0x01, 0x00, 0x04, 0x08, 0x04,
                                    0x92, 0x2E, 0x58, 0x32, 0x84, 0x00 };
    yt_card_t card;
    CHECK(yt_pn532_parse(uid4, LEN(uid4), p, sizeof p, &pl) == YT_PN532_OK);
    CHECK(yt_pn532_parse_inlist(p, pl, &card) == 1);
    CHECK(card.uid_len == 4 && card.atqa == 0x0004 && card.sak == 0x08);   /* MIFARE Classic 1K */
    char hex[YT_RFID_UID_HEX_MAX];
    CHECK(yt_uid_hex(card.uid, card.uid_len, hex, sizeof hex) == 8);
    CHECK_STR(hex, "922E5832");
    CHECK(yt_uid_check(card.uid, card.uid_len) == YT_UID_OK);

    static const uint8_t uid7[] = { 0x00, 0x00, 0xFF, 0x0F, 0xF1, 0xD5, 0x4B, 0x01, 0x01, 0x00, 0x44, 0x00, 0x07, 0x04,
                                    0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6, 0xCA, 0x00 };
    CHECK(yt_pn532_parse(uid7, LEN(uid7), p, sizeof p, &pl) == YT_PN532_OK);
    CHECK(yt_pn532_parse_inlist(p, pl, &card) == 1);
    yt_uid_hex(card.uid, card.uid_len, hex, sizeof hex);
    CHECK_STR(hex, "04A1B2C3D4E5F6");                                        /* NTAG / Ultralight */

    static const uint8_t none[] = { 0x00, 0x00, 0xFF, 0x03, 0xFD, 0xD5, 0x4B, 0x00, 0xE0, 0x00 };
    CHECK(yt_pn532_parse(none, LEN(none), p, sizeof p, &pl) == YT_PN532_OK);
    CHECK(yt_pn532_parse_inlist(p, pl, &card) == 0);

    /* Gürültü: tek bit bozulursa çerçeve REDDEDİLİR (hatalı UID üretilmez). */
    uint8_t noisy[LEN(uid4)];
    memcpy(noisy, uid4, sizeof noisy);
    noisy[14] ^= 0x10;
    CHECK(yt_pn532_parse(noisy, sizeof noisy, p, sizeof p, &pl) == YT_PN532_E_DCS);
    memcpy(noisy, uid4, sizeof noisy);
    noisy[4] ^= 0x01;
    CHECK(yt_pn532_parse(noisy, sizeof noisy, p, sizeof p, &pl) == YT_PN532_E_LCS);
    CHECK(yt_pn532_parse(uid4, 10, p, sizeof p, &pl) == YT_PN532_E_SHORT);
    static const uint8_t err[] = { 0x00, 0x00, 0xFF, 0x01, 0xFF, 0x7F, 0x81, 0x00 };
    CHECK(yt_pn532_parse(err, LEN(err), p, sizeof p, &pl) == YT_PN532_E_ERROR_FRAME);
    CHECK(yt_pn532_parse(fw_cmd, LEN(fw_cmd), p, sizeof p, &pl) == YT_PN532_E_TFI);  /* kendi komutumuz yankılandı */
    /* Kısa/bozuk InList yükü */
    static const uint8_t bad_inl[] = { 0x4B, 0x01, 0x01, 0x00, 0x04, 0x08, 0x07, 0x04, 0xA1 };   /* 7 bayt diyor, 2 var */
    CHECK(yt_pn532_parse_inlist(bad_inl, LEN(bad_inl), &card) < 0);

    /* --- UID doğrulama --- */
    static const uint8_t z4[] = { 0, 0, 0, 0 }, f4[] = { 0xFF, 0xFF, 0xFF, 0xFF };
    static const uint8_t rnd[] = { 0x08, 0x12, 0x34, 0x56 }, casc[] = { 0x88, 0x04, 0xA1, 0xB2 };
    CHECK(yt_uid_check(z4, 4) == YT_UID_NOISE);
    CHECK(yt_uid_check(f4, 4) == YT_UID_NOISE);
    CHECK(yt_uid_check(rnd, 4) == YT_UID_RANDOM);       /* telefon / banka kartı: her okumada değişir */
    CHECK(yt_uid_check(casc, 4) == YT_UID_CASCADE);
    CHECK(yt_uid_check(rnd, 3) == YT_UID_BAD_LENGTH);
    CHECK_STR(yt_uid_check_name(YT_UID_RANDOM), "RANDOM_UID");
    CHECK(yt_uid_hex(card.uid, 7, hex, 10) == 0);       /* sığmadı */

    /* --- izleyici: onay, sıçrama, çekilme --- */
    yt_rfid_tracker_t t;
    char ev[YT_RFID_UID_HEX_MAX];
    yt_rfid_tracker_init(&t);
    CHECK(yt_rfid_tracker_feed(&t, "922E5832", ev, sizeof ev) == YT_RFID_NONE);      /* 1. okuma: onay bekler */
    CHECK(yt_rfid_tracker_feed(&t, "922E5832", ev, sizeof ev) == YT_RFID_PRESENTED);
    CHECK_STR(ev, "922E5832");
    for (int i = 0; i < 20; i++) CHECK(yt_rfid_tracker_feed(&t, "922E5832", ev, sizeof ev) == YT_RFID_NONE);  /* duruyor */
    CHECK(yt_rfid_tracker_feed(&t, NULL, ev, sizeof ev) == YT_RFID_NONE);
    CHECK(yt_rfid_tracker_feed(&t, "922E5832", ev, sizeof ev) == YT_RFID_NONE);      /* kısa kesinti: çekilmedi */
    for (int i = 0; i < YT_RFID_REMOVE_MISSES - 1; i++) CHECK(yt_rfid_tracker_feed(&t, "", ev, sizeof ev) == YT_RFID_NONE);
    CHECK(yt_rfid_tracker_feed(&t, "", ev, sizeof ev) == YT_RFID_REMOVED);
    CHECK_STR(ev, "922E5832");
    CHECK(yt_rfid_tracker_feed(&t, "", ev, sizeof ev) == YT_RFID_NONE);              /* bir kez */

    /* Tek seferlik bozuk okuma kart üretmez: farklı UID'ler arka arkaya → hiçbiri onaylanmaz. */
    yt_rfid_tracker_init(&t);
    CHECK(yt_rfid_tracker_feed(&t, "922E5832", ev, sizeof ev) == YT_RFID_NONE);
    CHECK(yt_rfid_tracker_feed(&t, "922E5833", ev, sizeof ev) == YT_RFID_NONE);
    CHECK(yt_rfid_tracker_feed(&t, NULL, ev, sizeof ev) == YT_RFID_NONE);
    CHECK(yt_rfid_tracker_feed(&t, "922E5832", ev, sizeof ev) == YT_RFID_NONE);      /* boşlukla onay sıfırlandı */
    CHECK(yt_rfid_tracker_feed(&t, "922E5832", ev, sizeof ev) == YT_RFID_PRESENTED);
    /* Çekilmeden başka kart: yenisi onaylanınca olay üretir. */
    CHECK(yt_rfid_tracker_feed(&t, "04A1B2C3D4E5F6", ev, sizeof ev) == YT_RFID_NONE);
    CHECK(yt_rfid_tracker_feed(&t, "04A1B2C3D4E5F6", ev, sizeof ev) == YT_RFID_PRESENTED);
    CHECK_STR(ev, "04A1B2C3D4E5F6");
}
