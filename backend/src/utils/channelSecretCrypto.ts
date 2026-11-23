import crypto from 'crypto';
import { config } from '../config/env';

/**
 * NOTIF-1604 — Telegram bot token'ı ve webhook HMAC sırrının veritabanında
 * düz metin saklanmaması için AES-256-GCM. hardwareSecretCrypto.ts ile
 * BİREBİR AYNI mekanik (ayrı bir pepper, ARCH-108/AUTH-202.3 ile AYNI
 * gerekçe: biri sızarsa diğer alanları tehlikeye atmasın) — geri
 * döndürülebilir olmalı, çünkü gönderim anında token'ın kendisi gerekir
 * (tek yönlü Argon2id hash KULLANILAMAZ).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

function getEncryptionKey(): Buffer {
  return Buffer.from(config.NOTIFICATION_CHANNEL_ENCRYPTION_KEY, 'hex');
}

export function encryptChannelSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptChannelSecret(encrypted: string): string {
  const key = getEncryptionKey();
  const raw = Buffer.from(encrypted, 'base64');
  const iv = raw.subarray(0, IV_LENGTH_BYTES);
  const authTag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const ciphertext = raw.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
