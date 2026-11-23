import { z } from 'zod';

/**
 * TEST_PLAN.md §2.2 — takvim olarak GEÇERLİ ISO tarih (YYYY-AA-GG) doğrulaması.
 *
 * NEDEN VAR (canlı testte bulunan gerçek hata):
 *   Şemalar tarih alanlarını yalnızca `/^\d{4}-\d{2}-\d{2}$/` regex'iyle
 *   doğruluyordu. Bu regex BİÇİMİ kontrol eder, TAKVİMİ değil — yani
 *   `2026-13-45`, `2026-02-30`, `9999-99-99` gibi değerler doğrulamayı
 *   GEÇİYOR, sonra Postgres'e gidip "date/time field value out of range"
 *   hatası veriyor ve istek 500 ile bitiyordu.
 *
 *   Bu bir bilgi sızıntısı değil (globalErrorHandler jenerik mesaj + traceId
 *   döndürüyor, RES-902), ama üç somut zararı var:
 *     1. İstemci hatasının (400) sunucu hatası (500) gibi görünmesi —
 *        izleme/alarm panolarında gerçek 500'lerin arasına gürültü katar.
 *     2. Kullanıcı neyi yanlış yazdığını öğrenemez.
 *     3. Her geçersiz istek stack trace'li bir error logu üretir; ucuz bir
 *        log/CPU tüketim yüzeyi.
 *
 * DOĞRULAMA YÖNTEMİ: `new Date(...)` tek başına yetmez (bazı geçersiz
 * tarihler sessizce bir sonraki aya taşar). Bu yüzden tarih parse edilip
 * GERİ biçimlendiriliyor ve girdiyle birebir eşleşmesi şart koşuluyor
 * (round-trip). Artık yıl davranışı da doğru: 2024-02-29 geçerli,
 * 2026-02-29 geçersiz.
 */
const ISO_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Round-trip: taşma olduysa (ör. 02-30 → 03-02) geri biçimlendirme
  // girdiden farklı çıkar ve değer reddedilir.
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * @param formatMessage Biçim hatalı olduğunda gösterilecek mesaj. Mevcut
 *        şemalardaki alan adlı mesajlar korunsun diye parametre —
 *        (ör. "startDate YYYY-AA-GG biçiminde olmalıdır.")
 */
export function isoDateString(formatMessage: string) {
  return z
    .string()
    .regex(ISO_DATE_FORMAT, formatMessage)
    .refine(isRealCalendarDate, {
      message: `${formatMessage.replace(/\.$/, '')} ve geçerli bir takvim tarihi olmalıdır (ör. 2026-02-30 geçersizdir).`
    });
}
