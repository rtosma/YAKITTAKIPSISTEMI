#!/usr/bin/env node
// ==============================================================================
// DOC-1205 (#42) — docs/SOZLUK.md SÖZLEŞME/DRIVER testleri (sıfır npm bağımlılığı).
// AC: (1) ≥ 30 terim; (2) her terim için projede kullanıldığı yer — dosya/dizin yolları GERÇEKTEN var; (3) Türkçe–İngilizce karşılıklar.
// Ek: ticket'ın sayıladığı terimlerin hepsi var; sayısal iddialar (TTL, pencere, limit) kodla aynı; rehberde terimler İLK geçtikleri yerde sözlüğe bağlı.
// ==============================================================================
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GLOSSARY_LINKS, isLinkedAtFirstOccurrence } from './lib/glossaryLinks.mjs';
import { parseSchema } from './generate-project-guide.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0; let total = 0;
const check = (name, ok, detail = '') => { total++; if (ok) passed++; console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`); };

const md = read('docs/SOZLUK.md');
const sections = {};
for (const m of md.matchAll(/^## (.+)\n([\s\S]*?)(?=\n## |\n---\n\n\*Bu belge)/gm)) sections[m[1]] = m[2];
const terms = [];
for (const [sec, body] of Object.entries(sections)) {
  if (sec === 'Kısaltmalar') continue;
  for (const line of body.split('\n')) {
    const m = /^\| <a id="([a-z0-9-]+)"><\/a>\*\*(.+?)\*\* \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line);
    if (m) terms.push({ sec, id: m[1], tr: m[2], en: m[3], def: m[4], usage: m[5] });
  }
}
const abbr = (sections['Kısaltmalar'] ?? '').split('\n').filter((l) => /^\| \*\*/.test(l)).length;

check(`AC 1: en az 30 terim (ticket) — tanımlı ${terms.length} terim, ${abbr} kısaltma; üç ticket kategorisi (teknik, iş, donanım) + güvenlik/işletme`, terms.length >= 30 && ['Teknik terimler', 'İş terimleri', 'Donanım terimleri'].every((s) => terms.filter((t) => t.sec === s).length >= 8) && abbr >= 8, Object.keys(sections).map((s) => `${s}=${terms.filter((t) => t.sec === s).length}`).join(' '));
const ids = terms.map((t) => t.id);
check('Çapalar benzersiz; her terimin satırı biçimli (Türkçe · English · tanım · projede nerede)', new Set(ids).size === ids.length && terms.every((t) => t.tr && t.en && t.def && t.usage), `yinelenen=[${ids.filter((x, i) => ids.indexOf(x) !== i)}]`);
const all = terms.map((t) => `${t.tr} ${t.en} ${t.id}`.toLowerCase()).join(' | ');
const required = ['k-factor', 'totaliz', 'strapping', 'hypertable', 'rls', 'tenant', 'lwt', 'ota', 'hmac', 'idempotency', 'çapraz alım', 'kota', 'fire', 'mutabakat', 'ikmal', 'e-irsaliye', 'ubl-tr', 'mükellef', 'debimetre', 'ultrasonik seviye sensörü', 'röle', 'rfid etiketi', 'uid', 'lorawan', 'brown-out'];
const missing = required.filter((t) => !all.includes(t));
check('Ticket kapsamı: sayılan TÜM terimler tanımlı — K-factor, totalizatör, strapping table, hypertable, RLS, tenant, LWT, OTA, HMAC, idempotency · çapraz alım, kota, fire, mutabakat, ikmal, e-İrsaliye, UBL-TR, mükellef · debimetre, ultrasonik seviye sensörü, röle, RFID tag/UID, LoRaWAN, brown-out', missing.length === 0, `eksik=[${missing}]`);

const trEnBad = terms.filter((t) => t.en.length < 3 || !/[A-Za-z]{3}/.test(t.en)).map((t) => t.id);
// Türkçede de aynen kullanılan yabancı terimler (karşılığı yok): aynı yazılması meşru.
const LOANWORDS = new Set(['hypertable', 'async-local-storage', 'nonce', 'argon2id', 'lorawan', 'websocket']);
const sameLang = terms.filter((t) => t.tr.toLowerCase() === t.en.toLowerCase() && !LOANWORDS.has(t.id)).map((t) => t.id);
const trChars = terms.filter((t) => /[ğüşıöçĞÜŞİÖÇ]/.test(t.en)).map((t) => t.id);
check('AC 3 (Türkçe–İngilizce karşılıklar): her terimde İngilizce karşılık var; İngilizce sütunu Türkçe karakter içermez (dil karışmaz); Türkçe ve İngilizce adlar aynı kelimenin tekrarı değildir (kısaltmalar hariç)', trEnBad.length === 0 && trChars.length === 0 && sameLang.length === 0, `kısa/boş=[${trEnBad}] TR-karakterli EN=[${trChars}] aynı=[${sameLang}]`);
const shortDef = terms.filter((t) => t.def.length < 40 || !/[.)]$|\.$/.test(t.def.trim().slice(-2)) && !/[.!)]/.test(t.def)).map((t) => t.id);
check('Her terimin tanımı kısa ama anlamlı (≥ 40 karakter, tam cümle)', shortDef.length === 0, `kısa=[${shortDef}]`);

// ── AC 2: projede nerede — yollar gerçek ─────────────────────────────────────
const isPath = (s) => !s.startsWith('/') && !/\s/.test(s) && (s.includes('/') || /\.(ts|tsx|mjs|md|sql|sh|yml|json|svg|html|cpp)$/.test(s));
const noPath = []; const brokenPaths = [];
const schema = parseSchema(read('backend/src/db/schema.sql'));
const badTables = [];
for (const t of terms) {
  const toks = [...t.usage.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const paths = toks.filter(isPath);
  if (paths.length === 0) noPath.push(t.id);
  for (const p of paths) { const clean = p.replace(/\/$/, ''); if (!existsSync(path.join(ROOT, clean))) brokenPaths.push(`${t.id}:${p}`); }
  for (const m of t.usage.matchAll(/schema\.sql` \(([^)]*)\)/g)) for (const n of [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]).filter((x) => /^[a-z_]+(\.[a-z_]+)?$/.test(x)).map((x) => x.split('.')[0])) if (!schema.tables.has(n)) badTables.push(`${t.id}:${n}`);
}
check(`AC 2 (projede nerede): ${terms.length} terimin HEPSİNDE en az bir gerçek dosya/dizin yolu var ve anılan ${terms.reduce((n, t) => n + [...t.usage.matchAll(/`([^`]+)`/g)].filter((m) => isPath(m[1])).length, 0)} yolun HEPSİ depoda mevcut; \`schema.sql (…)\` ile anılan tablolar/sütunlar gerçek`, noPath.length === 0 && brokenPaths.length === 0 && badTables.length === 0, `yolsuz=[${noPath}] kırık=[${brokenPaths}] olmayan tablo=[${badTables}]`);

// ── Sayısal iddialar kodla aynı ────────────────────────────────────────────────
const tdb = read('backend/src/db/tenantDb.ts');
const auth = read('backend/src/middleware/hardwareAuthMiddleware.ts');
const sess = read('backend/src/services/dispenseSessionService.ts');
const claims = [
  ['presence TTL 10 sn', /10 sn TTL/.test(md) && /DEVICE_PRESENCE_TTL_SECONDS = 10/.test(read('backend/src/db/redisPool.ts'))],
  ['nonce 120 sn', /120 sn içinde/.test(md) && /NONCE_TTL_MS = 120_000/.test(auth)],
  ['zaman penceresi ±30 sn', /±30 sn/.test(md) && /MAX_ALLOWED_TIME_WINDOW_MS = 30_000/.test(auth)],
  ['heartbeat 15 sn', /15 sn gelmezse/.test(md) && /HEARTBEAT_TIMEOUT_MS = 15_000/.test(sess)],
  ['oturum 30 dk TTL', /30 dk TTL/.test(md) && /SESSION_TTL_SECONDS = 30 \* 60/.test(sess)],
  ['sync-batch ≤ 5000', /≤ 5000 kayıt/.test(md) && /max\(5000/.test(read('backend/src/schemas/transactionSchema.ts'))],
  ['ikinci onay %20', /%20/.test(md) && /CALIBRATION_SECOND_APPROVAL_THRESHOLD_RATIO = 0\.20/.test(tdb)],
  ['sapma > %1', /%1 ise/.test(md) && /DISCREPANCY_THRESHOLD_RATIO = 0\.01/.test(tdb)],
  ['RPO ≤ 15 dk / RTO ≤ 4 sa', /≤ 15 dk/.test(md) && /≤ 4 sa/.test(md) && /\*\*15 dakika\*\*/.test(read('docs/BACKUP_RESTORE.md')) && /\*\*4 saat\*\*/.test(read('docs/BACKUP_RESTORE.md'))],
  ['access 15 dk', /15 dk/.test(md) && /15 ?dk|15m|'15m'/.test(read('backend/src/services/tokenService.ts') + read('backend/src/config/env.ts'))]
];
check('Sayısal iddialar kodla aynı (sözlük yalan söyleyemez): presence 10 sn, nonce 120 sn, zaman ±30 sn, heartbeat 15 sn, oturum 30 dk, sync-batch ≤ 5000, K-faktör %20, sapma %1, RPO/RTO, access belirteci 15 dk', claims.every(([, ok]) => ok), `tutmayan=[${claims.filter(([, ok]) => !ok).map(([n]) => n)}]`);

// ── Rehberden bağlantı ve ilk geçişte link ─────────────────────────────────────
const guide = read('docs/PROJE-REHBERI.md');
const results = GLOSSARY_LINKS.map(([re, anchor]) => [anchor, isLinkedAtFirstOccurrence(guide, re, anchor)]);
const present = results.filter(([, r]) => r !== null);
const unlinked = present.filter(([, r]) => r === false).map(([a]) => a);
const unknownAnchors = GLOSSARY_LINKS.map(([, a]) => a).filter((a) => !ids.includes(a));
check(`Rehber bağlantısı (ticket): PROJE-REHBERI.md sözlüğe bağlı; rehberde geçen ${present.length} terimin HEPSİ ilk geçtiği yerde sözlük çapasına bağlıdır (kod bloğu, başlık, üretilen bölüm hariç)`, /\[SOZLUK\.md\]\(SOZLUK\.md\)/.test(guide) && present.length >= 30 && unlinked.length === 0 && unknownAnchors.length === 0, `bağlanmamış=[${unlinked}] sözlükte olmayan çapa=[${unknownAnchors}]`);
const refs = []; for (const f of readdirSync(path.join(ROOT, 'docs')).filter((x) => x.endsWith('.md'))) for (const m of read(`docs/${f}`).matchAll(/SOZLUK\.md#([a-z0-9-]+)/g)) refs.push(`${f}:${m[1]}`);
const deadRefs = refs.filter((r) => !ids.includes(r.split(':')[1]));
check(`Sözlüğe verilen ${refs.length} çapalı bağlantının hepsi gerçek bir terime çıkar (ölü çapa yok)`, refs.length >= 30 && deadRefs.length === 0, `ölü=[${deadRefs}]`);
const ci = read('.github/workflows/ci-cd.yml');
check('CI: bu test pipeline\'da; README belge tablosu sözlüğü de listeler', /node scripts\/test-doc1205\.mjs/.test(ci) && /docs\/SOZLUK\.md/.test(read('README.md')), '');

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
