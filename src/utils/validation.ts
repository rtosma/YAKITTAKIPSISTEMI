/**
 * Turkish License Plate Validation Regex & Helper
 * Formats: 34 CTP 82, 34 CTP 820, 06 A 1234, 41 KCL 05, etc.
 */
export const TURKISH_PLATE_REGEX = /^(0[1-9]|[1-7][0-9]|8[0-1])\s?[A-Z]{1,3}\s?[0-9]{2,4}$/i;

export function isValidPlate(plate: string): boolean {
  if (!plate) return false;
  return TURKISH_PLATE_REGEX.test(plate.trim());
}
