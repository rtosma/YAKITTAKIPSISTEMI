/**
 * Turkish License Plate Validation Regex & Helper
 * Formats: 34 CTP 82, 34 CTP 820, 06 A 1234, 41 KCL 05, etc.
 */
export const TURKISH_PLATE_REGEX = /^(0[1-9]|[1-7][0-9]|8[0-1])\s?[A-Z]{1,3}\s?[0-9]{2,4}$/i;

// FLEET-1401: plakası OLMAYAN iş makineleri (jeneratör, greyder...) için
// backend'in (vehicleSchema.ts) kabul ettiği AYNI ikinci format — örn.
// "EKS-04". Backend zaten bunu kabul ediyor olsa da bu regex burada da
// EŞLEŞMEZSE form hiç GÖNDERİLMEDEN reddedilirdi (canlı doğrulandı).
export const EQUIPMENT_CODE_REGEX = /^[A-ZÇĞİÖŞÜ]{2,6}-[0-9]{1,4}$/i;

export function isValidPlate(plate: string): boolean {
  if (!plate) return false;
  const trimmed = plate.trim();
  return TURKISH_PLATE_REGEX.test(trimmed) || EQUIPMENT_CODE_REGEX.test(trimmed);
}
