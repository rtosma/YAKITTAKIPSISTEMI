/*
 * FW-1302 — Kart kimliği (UID) doğrulama/biçimleme ve okuma izleyicisi (saf mantık).
 *
 * Sunucuya giden rfidCardId = UID'nin BÜYÜK HARF onaltılık, ayraçsız yazımı
 * (4 bayt "A1B2C3D4", 7 bayt "04A1B2C3D4E5F6"). Sunucu bilinmeyen kartı panelde
 * "Tanımsız RFID Kartı" olarak gösterir; yönetici onu sürücüye atayınca kayıt tamamlanır
 * (rehber §9.1). Aynı kart her okuyucuda aynı dizeyi üretmeli — biçim bu yüzden sabit.
 *
 * İzleyici kuralları (FW-1302 AC):
 *  - Gürültü: bir UID ancak art arda YT_RFID_CONFIRM_READS kez aynı okunursa kabul edilir;
 *    çerçeve sağlaması (DCS) tutmayan okuma hiç sayılmaz.
 *  - Sıçrama: okuyucuda duran kart tekrar tekrar olay üretmez.
 *  - Kart çekilince (art arda YT_RFID_REMOVE_MISSES boş okuma) REMOVED olayı.
 *  - Okuma HATASI (I2C, bozuk çerçeve) tarafsızdır: ne kartı onaylar ne çekildi sayar.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define YT_RFID_UID_HEX_MAX 21          /* 10 bayt → 20 karakter + NUL */
#define YT_RFID_CONFIRM_READS 2
#define YT_RFID_REMOVE_MISSES 3

typedef enum {
    YT_UID_OK = 0,
    YT_UID_BAD_LENGTH,   /* ISO 14443-3: 4, 7 veya 10 bayt */
    YT_UID_NOISE,        /* tümü 00 / FF — okuma hatası */
    YT_UID_CASCADE,      /* ilk bayt 0x88 (cascade tag) — eksik UID */
    YT_UID_RANDOM,       /* 4 bayt ve ilk bayt 0x08: her okumada değişen rastgele kimlik
                            (telefon, banka kartı) — kişiyi tanımlamaz */
} yt_uid_check_t;

yt_uid_check_t yt_uid_check(const uint8_t *uid, size_t len);
const char *yt_uid_check_name(yt_uid_check_t c);

/** Büyük harf onaltılık. Dönüş: uzunluk, 0 = sığmadı / geçersiz. */
size_t yt_uid_hex(const uint8_t *uid, size_t len, char *out, size_t cap);

typedef enum {
    YT_RFID_NONE = 0,
    YT_RFID_PRESENTED,
    YT_RFID_REMOVED,
} yt_rfid_event_t;

typedef struct {
    char present[YT_RFID_UID_HEX_MAX];    /* şu an okuyucuda kabul edilmiş kart ("" yok) */
    char candidate[YT_RFID_UID_HEX_MAX];  /* onay bekleyen */
    int candidate_hits;
    int misses;
} yt_rfid_tracker_t;

void yt_rfid_tracker_init(yt_rfid_tracker_t *t);

/** Başarılı bir okuma: uid_hex NULL/"" = alanda kart yok. Olay varsa ilgili UID event_uid'e. */
yt_rfid_event_t yt_rfid_tracker_feed(yt_rfid_tracker_t *t, const char *uid_hex, char *event_uid, size_t cap);

#ifdef __cplusplus
}
#endif
