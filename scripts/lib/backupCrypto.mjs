#!/usr/bin/env node
// ==============================================================================
// OPS-1106 — Yedek dosyası şifreleme/doğrulama (AES-256-GCM, akışlı, sıfır bağımlılık).
//
// AC: "Günlük otomatik yedek alınmalı ve ŞİFRELİ saklanmalıdır" / Teknik Not: "Yedekler
// şifrelenmezse veri sızıntısı riski yedek deposuna kayar." Yedekler bu araçla, AYRI bir
// konuma yazılmadan ÖNCE şifrelenir; anahtar yedek deposunda BULUNMAZ (bkz. docs/BACKUP_RESTORE.md).
//
// NEDEN AES-256-GCM: doğrulanmış (authenticated) şifreleme — yalnızca gizlilik değil BÜTÜNLÜK de:
// depoda değiştirilmiş/bozulmuş bir yedek veya WAL segmenti sessizce geri yüklenmez, etiket (tag)
// doğrulaması başarısız olur. (openssl enc CBC modu bütünlük vermez.)
//
// Dosya biçimi:  "YKB1" | flags(1: bit0 = gzip) | iv(12) | şifreli veri | tag(16)
//   AAD = ilk 5 bayt (magic+flags) — biçim/gzip bayrağı da doğrulanır.
// Akışlıdır (büyük taban yedeğinde bellek şişmez). ÇÖZME yalnızca tag DOĞRULANDIKTAN sonra çıktı dosyasını
// yerine koyar (önce `.part`, başarıda rename; başarısızlıkta silinir) — doğrulanmamış veri asla kullanılmaz.
//
// Anahtar: BACKUP_ENCRYPTION_KEY (64 hex = 32 bayt) VEYA BACKUP_ENCRYPTION_KEY_FILE (içinde 64 hex).
//
// Kullanım:
//   node backupCrypto.mjs encrypt [--gzip] <in> <out>
//   node backupCrypto.mjs decrypt <in> <out>
//   node backupCrypto.mjs verify  <in>          # tag'i doğrular, çıktı yazmaz (exit 0/1)
//   node backupCrypto.mjs genkey                # yeni rastgele anahtar (hex) yazar
// ==============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, statSync, openSync, readSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAGIC = Buffer.from('YKB1');
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + IV_LEN;

export function loadKey(env = process.env) {
  let hex = env.BACKUP_ENCRYPTION_KEY;
  if (!hex && env.BACKUP_ENCRYPTION_KEY_FILE) hex = readFileSync(env.BACKUP_ENCRYPTION_KEY_FILE, 'utf8').trim();
  if (!hex) throw new Error('BACKUP_ENCRYPTION_KEY (veya BACKUP_ENCRYPTION_KEY_FILE) tanımlı değil.');
  if (!/^[0-9a-fA-F]{64}$/.test(hex.trim())) throw new Error('Yedek anahtarı tam olarak 64 hex karakter (32 bayt) olmalıdır (öneri: node backupCrypto.mjs genkey).');
  return Buffer.from(hex.trim(), 'hex');
}

export async function encryptFile(inPath, outPath, { gzip = false, key = loadKey() } = {}) {
  const iv = randomBytes(IV_LEN);
  const flags = Buffer.from([gzip ? 1 : 0]);
  const aad = Buffer.concat([MAGIC, flags]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const part = `${outPath}.part`;
  const out = createWriteStream(part, { mode: 0o600 });
  out.write(Buffer.concat([aad, iv]));
  try {
    const streams = [createReadStream(inPath)];
    if (gzip) streams.push(createGzip({ level: 6 }));
    streams.push(cipher);
    await pipeline(...streams, out, { end: false });
    await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
    renameSync(part, outPath);
  } catch (err) {
    try { unlinkSync(part); } catch { /* yok */ }
    throw err;
  }
}

function readHeaderAndTag(inPath) {
  const size = statSync(inPath).size;
  if (size < HEADER_LEN + TAG_LEN) throw new Error('Şifreli dosya çok kısa/bozuk.');
  const fd = openSync(inPath, 'r');
  try {
    const head = Buffer.alloc(HEADER_LEN);
    readSync(fd, head, 0, HEADER_LEN, 0);
    const tag = Buffer.alloc(TAG_LEN);
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Geçersiz dosya biçimi (magic uyuşmuyor) — şifreli yedek değil.');
    return { size, flags: head[MAGIC.length], aad: head.subarray(0, MAGIC.length + 1), iv: head.subarray(MAGIC.length + 1), tag };
  } finally {
    closeSync(fd);
  }
}

/** tag doğrulanmadan çıktı dosyasını YERİNE KOYMAZ. `outPath` null ise yalnızca doğrular. */
export async function decryptFile(inPath, outPath, { key = loadKey() } = {}) {
  const { size, flags, aad, iv, tag } = readHeaderAndTag(inPath);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const part = outPath ? `${outPath}.part` : null;
  const sink = part ? createWriteStream(part, { mode: 0o600 }) : new Transform({ transform(_c, _e, cb) { cb(); } });
  const streams = [createReadStream(inPath, { start: HEADER_LEN, end: size - TAG_LEN - 1 }), decipher];
  if (flags & 1) streams.push(createGunzip());
  streams.push(sink);
  try {
    // decipher.final() tag uyuşmazlığında hata fırlatır → pipeline reddedilir.
    await pipeline(...streams);
    if (part) renameSync(part, outPath);
  } catch (err) {
    if (part) { try { unlinkSync(part); } catch { /* yok */ } }
    throw new Error(`Şifre çözme/doğrulama BAŞARISIZ (yanlış anahtar veya bozulmuş/değiştirilmiş dosya): ${err.message}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'genkey') {
      process.stdout.write(randomBytes(32).toString('hex') + '\n');
    } else if (cmd === 'encrypt') {
      const gzip = rest[0] === '--gzip';
      const [i, o] = gzip ? rest.slice(1) : rest;
      await encryptFile(i, o, { gzip });
    } else if (cmd === 'decrypt') {
      await decryptFile(rest[0], rest[1]);
    } else if (cmd === 'verify') {
      await decryptFile(rest[0], null);
    } else {
      console.error('Kullanım: backupCrypto.mjs encrypt [--gzip] <in> <out> | decrypt <in> <out> | verify <in> | genkey');
      process.exit(2);
    }
  } catch (err) {
    console.error(`[backupCrypto] ${err.message}`);
    process.exit(1);
  }
}
