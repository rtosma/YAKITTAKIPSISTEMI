import type { UserRole } from '../services/tokenService';

/**
 * COMP-606 (#132) — kişisel veri erişim/maskeleme kuralları (rol bazlı) — TEK geçiş noktası.
 *
 * KAPSAM UYARLAMASI: ticket "NestJS interceptor (maskeleme)" öneriyor; bu kod tabanı Express (bkz. REP-720 piiMask.ts ile
 * aynı gerekçe). Bunun yerine bu modül, yanıtı üreten route'ların çağırdığı saf fonksiyonlar sunar; maskeleme kuralı
 * tek yerde durur ve birim testlenir.
 *
 * POLİTİKA: TC Kimlik No ve telefonu TAM görebilen roller, kaydı OLUŞTURAN/DÜZENLEYEN roller ile sınırlıdır
 * (POST/PUT /drivers ve HR_MANAGER_ROLES ile aynı küme). Diğer TÜM roller (PUMP_OPERATOR, DRIVER ve ileride eklenecek
 * herhangi bir rol — fail-closed: liste dışı = maskeli) maskelenmiş görür.
 */
export const FULL_PII_ROLES: readonly UserRole[] = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER'];

export function canViewFullPii(role: UserRole | string | undefined): boolean {
  return !!role && (FULL_PII_ROLES as readonly string[]).includes(role);
}

/** 12345678901 → 123******01 (FLEET-1403'ten beri değişmeyen biçim). */
export function maskTcNo(tcNo: string | null | undefined): string | null | undefined {
  if (!tcNo || tcNo.length !== 11) return tcNo;
  return `${tcNo.slice(0, 3)}******${tcNo.slice(9)}`;
}

/** Son 2 hane hariç hepsi maskelenir: "0532 111 22 33" → "**********33" (rakam/işaret ayırt etmeksizin, uzunluk korunur). */
export function maskPhone(phone: string | null | undefined): string | null | undefined {
  if (!phone) return phone;
  const chars = Array.from(phone);
  if (chars.length <= 2) return '*'.repeat(chars.length);
  return '*'.repeat(chars.length - 2) + chars.slice(-2).join('');
}

/** ahmet@firma.com → a***@firma.com */
export function maskEmail(email: string | null | undefined): string | null | undefined {
  if (!email) return email;
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** Şoför kaydının yanıt kopyasını rolüne göre maskeler (girdiyi değiştirmez). */
export function maskDriverForRole<T extends { tc_no?: string | null; phone?: string | null }>(driver: T, role: UserRole | string | undefined): T {
  if (canViewFullPii(role)) return driver;
  return { ...driver, tc_no: maskTcNo(driver.tc_no) as any, phone: maskPhone(driver.phone) as any };
}

export function maskPersonnelForRole<T extends { tcNo?: string | null }>(person: T, role: UserRole | string | undefined): T {
  if (canViewFullPii(role)) return person;
  return { ...person, tcNo: maskTcNo(person.tcNo) as any };
}
