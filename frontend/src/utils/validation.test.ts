import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TURKISH_PLATE_REGEX, isValidPlate } from './validation';
import { vehicleFactory } from '@test-support/factories';

/**
 * TEST_PLAN.md §3.2 — form doğrulamasının backend ile tutarlılığı.
 *
 * Frontend'deki tek paralel doğrulama plaka regex'i ve backend
 * `schemas/vehicleSchema.ts`'teki regex'in elle kopyası. Ayrışırlarsa ya
 * form backend'in kabul ettiği plakayı reddeder ya da kullanıcı formu geçip
 * 400 alır. Kopya birebir aynı kalmalı.
 */
const BACKEND_SCHEMA = resolve(__dirname, '../../../backend/src/schemas/vehicleSchema.ts');

describe('plaka doğrulaması ↔ backend vehicleSchema', () => {
  it('frontend TURKISH_PLATE_REGEX backend\'deki ile birebir aynı (kaynak + bayraklar)', () => {
    const match = /export const TURKISH_PLATE_REGEX = \/(.+)\/([a-z]*);/.exec(readFileSync(BACKEND_SCHEMA, 'utf8'));
    expect(match, 'backend vehicleSchema.ts içinde TURKISH_PLATE_REGEX bulunamadı').not.toBeNull();
    expect(TURKISH_PLATE_REGEX.source).toBe(match![1]);
    expect(TURKISH_PLATE_REGEX.flags).toBe(match![2]);
  });

  it.each(['34 CTP 82', '06 A 1234', '34ctp82', ' 41 KCL 05 '])('geçerli: %s', (plate) => {
    expect(isValidPlate(plate)).toBe(true);
  });

  it.each(['', '00 ABC 12', '82 AB 123', '34 ABCD 12', '34 E2E 1036', '34 CTP 1'])('geçersiz: "%s"', (plate) => {
    expect(isValidPlate(plate)).toBe(false);
  });
});

/** TEST-1006: ortak veri fabrikaları (backend birim testleriyle AYNI dosya) ön yüzde de kullanılır. */
describe('ortak test fabrikaları ↔ plaka doğrulaması', () => {
  it('vehicleFactory\'nin ürettiği tüm plakalar (50 adet) geçerli; ezilen geçersiz plaka reddedilir', () => {
    for (const v of vehicleFactory.buildMany(50)) expect(isValidPlate(v.plate)).toBe(true);
    expect(isValidPlate(vehicleFactory.build({ plate: '99 XX 1' }).plate)).toBe(false);
  });
});
