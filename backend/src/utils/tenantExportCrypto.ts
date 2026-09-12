import crypto from 'crypto';
import { config } from '../config/env';

/**
 * ARCH-108 — tenant veri dışa aktarım arşivini AES-256-GCM ile şifreler.
 * `utils/hardwareSecretCrypto.ts` ile AYNI desen (iv | authTag | ciphertext
 * tek bir buffer'da) ama KASITLI OLARAK AYRI bir anahtar
 * (TENANT_EXPORT_ENCRYPTION_KEY) — cihaz sırları ile bir müşterinin TÜM
 * verisi farklı tehdit modelleri, biri sızarsa diğerini tehlikeye atmamalı.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

function getExportEncryptionKey(): Buffer {
  return Buffer.from(config.TENANT_EXPORT_ENCRYPTION_KEY, 'hex');
}

export function encryptTenantExport(plaintextJson: string): Buffer {
  const key = getExportEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/** Sadece yönetici araçları/testler için — sunucu tarafında ASLA çağrılmaz. */
export function decryptTenantExport(encrypted: Buffer): string {
  const key = getExportEncryptionKey();
  const iv = encrypted.subarray(0, IV_LENGTH_BYTES);
  const authTag = encrypted.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const ciphertext = encrypted.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
