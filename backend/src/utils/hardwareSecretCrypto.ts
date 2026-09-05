import crypto from 'crypto';
import { config } from '../config/env';

/**
 * AUTH-202.3 — cihaz secret'larının veritabanında düz metin saklanmaması
 * için AES-256-GCM ile simetrik şifreleme. password_hash gibi Argon2id
 * (tek yönlü) KULLANILAMAZ: hardwareAuthMiddleware her istekte HMAC'ı
 * doğrulamak için secret'ın kendisini (düz metin) yeniden elde edebilmeli —
 * bu yüzden geri döndürülebilir bir şifreleme, HW_SECRET_ENCRYPTION_KEY
 * pepper'ıyla.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

function getEncryptionKey(): Buffer {
  return Buffer.from(config.HW_SECRET_ENCRYPTION_KEY, 'hex');
}

export function encryptDeviceSecret(plaintextSecret: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextSecret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv | authTag | ciphertext tek bir base64 blob'ta — ayrı kolonlara
  // bölmeye gerek yok, uzunlukları sabit (12/16 bayt) olduğundan decrypt
  // sırasında güvenle geri kesilebiliyor.
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptDeviceSecret(encrypted: string): string {
  const key = getEncryptionKey();
  const raw = Buffer.from(encrypted, 'base64');
  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const ciphertext = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** AC: "256-bit rastgele secret üretimi" — hex-encoded, HMAC anahtarı olarak kullanılır. */
export function generateDeviceSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
