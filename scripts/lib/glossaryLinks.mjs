// DOC-1205 — rehberde sözlüğe bağlanacak terimler (regex → sözlük çapası). Hem bağlayıcı hem test bunu kullanır.
export const GLOSSARY_LINKS = [
  [/\bRLS\b/, 'rls'], [/\bmulti-tenant\b|\btenant\b/, 'tenant'], [/\bHMAC\b/, 'hmac'], [/\bnonce\b/i, 'nonce'], [/\breplay\b/i, 'replay'], [/\bJWT\b/, 'jwt'], [/\bArgon2id\b/, 'argon2id'],
  [/\bK-faktör\b/, 'k-factor'], [/\btotalizatör\b/i, 'totalizator'], [/\bstrapping\b/i, 'strapping-table'], [/\bhypertable\b/i, 'hypertable'], [/\bidempotency\b/i, 'idempotency'],
  [/\bfail-open\b/i, 'fail-open'], [/\bLWT\b/, 'lwt'], [/\bpresence\b/i, 'presence'], [/\bMQTT\b/, 'mqtt'], [/\bQoS\b/, 'qos'], [/\bOTA\b/, 'ota'], [/\bSocket\.io\b|\bWebSocket\b/, 'websocket'],
  [/\bAsyncLocalStorage\b/, 'async-local-storage'], [/\bdevre kesici\b/i, 'circuit-breaker'], [/\bexpand-only\b/i, 'expand-only'], [/\bblue\/green\b/i, 'blue-green'], [/\bdrain\b/i, 'graceful-shutdown'],
  [/\breadiness\b/i, 'readiness'], [/\bRPO\b/, 'rpo-rto'], [/\bPITR\b/, 'pitr'], [/\btraceId\b/, 'trace-id'], [/\bKVKK\b/, 'pii'], [/\banonimleştirme\b/i, 'anonymization'],
  [/\bçapraz şantiye\b|\bçapraz alım\b/i, 'cross-site'], [/\bkota\b/i, 'kota'], [/\bfire\b/i, 'fire'], [/\bmutabakat\b/i, 'mutabakat'], [/\be-İrsaliye\b/, 'e-irsaliye'], [/\bUBL-TR\b/, 'ubl-tr'],
  [/\bmükellef\b/i, 'mukellef'], [/\bETTN\b/, 'ettn'], [/\bzimmet\b/i, 'zimmet'], [/\bRFID\b/, 'rfid'], [/\bLoRaWAN\b/, 'lorawan'], [/\bsync-batch\b/, 'sync-batch'], [/\bclaim\b/i, 'claim'],
  [/\bdebimetre\b|\bakışmetre\b/i, 'debimetre'], [/\brölesi?\b|\brole\b/i, 'role']
];

const FENCE = /^```/;
/** Markdown gövdesinde (kod bloğu, üretilen bölüm, başlık, satır-içi kod ve mevcut bağlantı HARİÇ) ilk eşleşmeyi bulur. Dönüş: {line, index, text} | null */
export function firstEligibleMatch(md, re) {
  const lines = md.split('\n');
  let inFence = false; let inGen = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (FENCE.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (l.includes('ÜRETİLEN:') && l.includes('BAŞLA')) { inGen = true; continue; }
    if (l.includes('ÜRETİLEN:') && l.includes('BİTİŞ')) { inGen = false; continue; }
    if (inGen || /^#{1,6} /.test(l) || /^<!--/.test(l)) continue;
    // maskele: satır-içi kod ve mevcut bağlantı metinleri/hedefleri
    const masked = l.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length)).replace(/\]\([^)]*\)/g, (m) => ' '.repeat(m.length));
    const m = re.exec(masked);
    if (m) return { line: i, index: m.index, length: m[0].length, text: l.slice(m.index, m.index + m[0].length), masked: l };
  }
  return null;
}

/** İlk eşleşmenin `[metin](SOZLUK.md#çapa)` içinde olup olmadığı. */
export function isLinkedAtFirstOccurrence(md, re, anchor) {
  const hit = firstEligibleMatch(md, re);
  if (!hit) return null; // terim rehberde hiç geçmiyor
  const line = md.split('\n')[hit.line];
  const linkRe = /\[([^\]]*)\]\(SOZLUK\.md#([a-z0-9\-]+)\)/g;
  let m;
  while ((m = linkRe.exec(line)) !== null) {
    const textStart = m.index + 1; const textEnd = textStart + m[1].length;
    if (m[2] === anchor && hit.index >= textStart && hit.index < textEnd) return true;
  }
  return false;
}
