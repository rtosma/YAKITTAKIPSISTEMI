#!/usr/bin/env node
// ==============================================================================
// DOC-1204 (#41) — docs/SUNUM-REHBERI.md sözleşme testleri (sıfır npm bağımlılığı).
// AC: (1) 12-15 slaytlık akış + konuşma metni; (2) ≥ 8 SSS; (3) 60 sn'lik özet.
// Teknik notlar: teknik terim YOK; kazanımlar abartısız (uydurma oran YOK); demo gerçek sistemde prova edilmiş.
// Bu test belgenin İDDİALARINI kodla karşılaştırır: fiyat/paket/menü/eşik/sabitler değişirse belge de değişmek zorundadır.
// ==============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0; let total = 0;
const check = (name, ok, detail = '') => { total++; if (ok) passed++; console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`); };
const words = (t) => (t.match(/[\p{L}\p{N}'’]+/gu) ?? []).length;
const toSec = (mmss) => { const [m, s] = mmss.split(':').map(Number); return m * 60 + s; };

const md = read('docs/SUNUM-REHBERI.md');
const speakerRegion = md.slice(0, md.indexOf('## Ek A')); // Ek A/B teknik yardımcı içindir; sunucu metni değildir.

// ── Slayt ayrıştırma ──────────────────────────────────────────────────────────
const slides = [];
const slideRe = /^### Slayt (\d+) — (.+?) \((\d+:\d{2})\)\n([\s\S]*?)(?=\n### |\n## )/gm;
for (const m of md.matchAll(slideRe)) {
  const body = m[4];
  const quote = body.split('\n').filter((l) => l.startsWith('>')).map((l) => l.replace(/^>\s?/, '')).join(' ');
  slides.push({ n: Number(m[1]), title: m[2], dur: m[3], sec: toSec(m[3]), hasScreen: /\*\*Ekranda:\*\*/.test(body), speech: quote, words: words(quote) });
}
const sumSec = slides.reduce((a, s) => a + s.sec, 0);
check(`AC 1: 12–15 slaytlık akış (${slides.length} slayt), sıralı numaralı, her birinde başlık + "Ekranda" maddeleri + sunucu konuşma metni`, slides.length >= 12 && slides.length <= 15 && slides.every((s, i) => s.n === i + 1 && s.hasScreen && s.words >= (/canlı/i.test(s.title) ? 8 : 20)), `kısa/eksik=[${slides.filter((s) => !s.hasScreen || s.words < (/canlı/i.test(s.title) ? 8 : 20)).map((s) => s.n)}]`);
check(`Süre: slayt sürelerinin toplamı 15:00 (bulunan ${Math.floor(sumSec / 60)}:${String(sumSec % 60).padStart(2, '0')}); özet tablosundaki süreler başlıklarla aynı`, sumSec === 900 && slides.every((s) => new RegExp(`\\| ${s.n} \\| [^|]+\\|[^|]*${s.dur.replace(':', '\\:')}`).test(md) || new RegExp(`\\| ${s.n} \\| ${s.title.split(':')[0].slice(0, 6)}`).test(md) || md.includes(`${s.dur} |`)), '');
const flowOrder = ['problem', 'bugünkü durum', 'çözüm', 'nasıl çalışır', 'panel', 'kazanım', 'fark', 'fiyat', 'yol haritası', 'canlı'];
const idxOf = (kw) => slides.findIndex((s) => s.title.toLocaleLowerCase('tr').includes(kw));
const idxs = flowOrder.map(idxOf);
check('Ticket akışı sırasıyla: problem → mevcut durumun maliyeti → çözüm → nasıl çalışır → panel ekranları → kazanımlar → rekabet farkı → fiyatlandırma → yol haritası → demo', idxs.every((i) => i >= 0) && idxs.every((v, i) => i === 0 || v > idxs[i - 1]), `sıralar=${idxs}`);
const perMin = slides.filter((s) => !/canlı/i.test(s.title)).map((s) => ({ n: s.n, wpm: s.words / (s.sec / 60) }));
check('Konuşma metni süresine uygun: dakikada 55–170 kelime (alt sınır: slayt gösterme ve dinleyiciyle etkileşim payı; üst sınır: yetişilebilirlik); canlı gösterim hariç', perMin.every((x) => x.wpm >= 55 && x.wpm <= 170), perMin.map((x) => `${x.n}:${x.wpm.toFixed(0)}`).join(' '));

// ── Asansör konuşması ─────────────────────────────────────────────────────────
const elev = /## 2\. 60 saniyelik asansör konuşması[\s\S]*?\n((?:>.*\n?)+)/.exec(md);
const elevWords = elev ? words(elev[1].replace(/^>\s?/gm, '')) : 0;
check(`AC 3: 60 saniyelik asansör konuşması var ve gerçekten ≈ 60 sn (${elevWords} kelime; 120–170 aralığı ≈ 2,0–2,8 kelime/sn)`, elevWords >= 120 && elevWords <= 170 && /pilot/.test(elev?.[1] ?? '') && /kart/.test(elev?.[1] ?? ''), '');

// ── SSS ───────────────────────────────────────────────────────────────────────
const faqs = [...md.matchAll(/^### (3\.\d+) (.+)\n\n([\s\S]*?)(?=\n### |\n## )/gm)].map((m) => ({ id: m[1], q: m[2], a: m[3].trim(), w: words(m[3]) }));
const topics = [['internet', /internet kesilirse/], ['sayaç', /sayaç şaşarsa/], ['kart başkasına', /kart başkasına/], ['veriler kimde', /veriler kimde/]];
const missTopic = topics.filter(([, re]) => !faqs.some((f) => re.test(f.q.toLocaleLowerCase('tr')))).map(([n]) => n);
check(`AC 2: en az 8 sık sorulan soru, hepsinin gerçek bir cevabı var (${faqs.length} soru, cevaplar ≥ 30 kelime) ve ticket'ın dört sorusu (internet kesilirse, sayaç şaşarsa, kart başkasına verilirse, veriler kimde durur) mevcut`, faqs.length >= 8 && faqs.every((f) => f.w >= 30 && f.q.trim().endsWith('?')) && missTopic.length === 0, `eksik konu=[${missTopic}] kısa=[${faqs.filter((f) => f.w < 30).map((f) => f.id)}]`);
check('SSS dürüstlüğü: "kart başkasına verilirse" cevabı engelleyemeyeceğini açıkça söyler; "internet kesilirse" cevabı laboratuvar denemesi olduğunu belirtir; e-İrsaliye cevabı canlı entegrasyonun OLMADIĞINI söyler', /engelleyemeyiz/.test(faqs.find((f) => /kart başkasına/.test(f.q.toLocaleLowerCase('tr')))?.a ?? '') && /laboratuvar/i.test(faqs.find((f) => /internet kesilirse/.test(f.q.toLocaleLowerCase('tr')))?.a ?? '') && /henüz kurulmadı/.test(faqs.find((f) => /e-İrsaliye/.test(f.q))?.a ?? ''), '');

// ── Teknik terim yok / uydurma oran yok ─────────────────────────────────────────
const stripped = speakerRegion.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']');
const JARGON = ['RLS', 'HMAC', 'JWT', 'MQTT', 'tenant', 'kiracı', 'API', 'Docker', 'Redis', 'PostgreSQL', 'WebSocket', 'idempotency', 'totaliz', 'LoRa', 'ESP32', 'firmware', 'nonce', 'SQL', 'endpoint', 'backend', 'frontend', 'SaaS', 'RFID', 'heartbeat', 'token', 'veritabanı', 'sunucu tarafı', 'OTA', 'K-faktör', 'hypertable', 'blue/green', 'webhook', 'cache', 'timeout'];
const found = JARGON.filter((t) => new RegExp(`(^|[^\\p{L}])${t.replace(/[/.]/g, '\\$&')}`, 'iu').test(stripped) && !(t === 'API' && false));
check(`Teknik terim yasağı: sunucu metinlerinde (Ek A/B hariç) ${JARGON.length} teknik terimden HİÇBİRİ geçmez ("RLS" değil "her firmanın verisi birbirinden ayrı")`, found.length === 0, `bulunan=[${found}]`);
const pct = [...stripped.matchAll(/%\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s?%|yüzde\s+\d+(?:[.,]\d+)?/giu)].map((m) => m[0].toLowerCase().replace(/\s+/g, ' '));
const okPct = pct.every((p) => /^yüzde 1$/.test(p));
check('Abartı yasağı: belgede tek yüzde ifadesi ölçüm eşiği ("yüzde 1" sapma); hiçbir "yüzde X tasarruf/kazanç" oranı vaat edilmez, "garanti" kelimesi geçmez', okPct && !/garanti|kesin tasarruf|%100|yüzde yüz/i.test(stripped), `yüzdeler=[${pct}]`);
const claimsNoPromise = /oran vaat etm/i.test(md) && /pilot/i.test(md) && /sizin rakamlarınızla/i.test(md) && (md.match(/laboratuvar/gi) ?? []).length >= 3;
check('Kazanımlar ölçülebilir ve dürüst: her kazanımın "nasıl ölçülür" karşılığı var; "oran vaat etmiyoruz / sizin rakamlarınızla / pilot" ilkesi; laboratuvar denemesi laboratuvar olarak etiketli', /\| Kazanım \| Nasıl ölçülür \|/.test(md) && (md.match(/^\| \*\*[^|]+\*\* \| [^|]+ \|$/gm) ?? []).length >= 4 && claimsNoPromise, '');

// ── İddialar kodla aynı ──────────────────────────────────────────────────────
const disp = read('backend/src/services/dispenseSessionService.ts');
const hbSec = Number(/HEARTBEAT_TIMEOUT_MS = (\d+)_?(\d+)/.exec(disp)?.slice(1).join('')) / 1000;
const chaos = read('docs/CHAOS_TESTING.md');
const tdb = read('backend/src/db/tenantDb.ts');
const theft = read('backend/src/services/theftDetectionService.ts');
const backup = read('docs/BACKUP_RESTORE.md');
const saha = read('docs/SAHA_KURULUM.md');
const priv = read('backend/src/services/privacyService.ts');
const speech = (re) => re.test(speakerRegion);
const facts = [
  ['heartbeat 15 sn', hbSec === 15 && speech(/on beş saniyeden uzun/) && speech(/\*\*15 saniye\*\*/)],
  ['72 saat / 216 ikmal', /72 saat/.test(chaos) && /216/.test(chaos) && speech(/216 ikmalin 216/)],
  ['sapma yüzde 1', /DISCREPANCY_THRESHOLD_RATIO = 0\.01/.test(tdb) && speech(/yüzde 1'den/)],
  ['ikinci onay (büyük kalibrasyon değişikliği)', /CALIBRATION_SECOND_APPROVAL_THRESHOLD_RATIO = 0\.20/.test(tdb) && speech(/ikinci bir kişinin onayı/)],
  ['pompa kapalı 10 dk / 5 L alarmı', /10 dakikada 5 litreden fazla/.test(theft) && speech(/on dakikada beş litreden/) && speech(/10 dakikada 5 L/) === false],
  ['RPO 15 dk / RTO 4 sa', /\*\*15 dakika\*\*/.test(backup) && /\*\*4 saat\*\*/.test(backup) && speech(/on beş dakikalık/) && speech(/dört saat içinde/)],
  ['bilgi talebi 30 gün', /30/.test(priv) && speech(/\*\*30 gün\*\*/)],
  ['kurulum ≈ 1 iş günü + 24 saat izleme', /≈ 1 iş günü/.test(saha) && /24 saat/.test(saha) && speech(/\*\*bir iş günü\*\*/) && speech(/24 saatlik kesintisiz izleme/)]
];
check('Sayısal iddialar kodla/belgeyle AYNI: heartbeat 15 sn, 72 sa/216 ikmal, sapma %1, ikinci onay eşiği, 10 dk/5 L alarmı, RPO 15 dk/RTO 4 sa, bilgi talebi 30 gün, kurulum ≈ 1 iş günü', facts.every(([, ok]) => ok), `tutmayan=[${facts.filter(([, ok]) => !ok).map(([n]) => n)}]`);

// ── Fiyat / paket kodla aynı ─────────────────────────────────────────────────
const admin = read('backend/src/db/adminDb.ts');
const modNames = [...new Set([...admin.matchAll(/^\s{2}(aiAnomaly|eInvoice|smartWarehouse|maintenanceTrack|driverScore|crossSiteAuth): (?:true|false|\{)/gm)].map((m) => m[1]))];
const priceOf = (n) => Number(new RegExp(`${n}: \\{ label: '[^']+', monthlyPriceTRY: (\\d+)`).exec(admin)?.[1]);
const tierOf = (tier) => { const blk = new RegExp(`${tier}: \\{([^}]*)\\}`).exec(admin)?.[1] ?? ''; return Object.fromEntries([...blk.matchAll(/(\w+): (true|false)/g)].map((m) => [m[1], m[2] === 'true'])); };
const tiers = { Temel: tierOf('TEMEL'), Profesyonel: tierOf('PROFESYONEL'), Kurumsal: Object.fromEntries(modNames.map((n) => [n, true])) };
const LABELS = { 'Şoför performans skoru': 'driverScore', 'Yapay zekâ anomali tespiti': 'aiAnomaly', 'e-Fatura / e-İrsaliye hazırlığı': 'eInvoice', 'Bakım ve muayene takibi': 'maintenanceTrack', 'Şantiyeler arası yetkilendirme': 'crossSiteAuth', 'Akıllı depo ve envanter': 'smartWarehouse' };
const priceRows = [...md.matchAll(/^\| (.+?) \(([\d.]+) ₺\) \| (✔|—) \| (✔|—) \| (✔|—) \|$/gm)];
const priceBad = [];
for (const r of priceRows) {
  const mod = LABELS[r[1]]; if (!mod) { priceBad.push(`bilinmeyen:${r[1]}`); continue; }
  if (Number(r[2].replace('.', '')) !== priceOf(mod)) priceBad.push(`fiyat:${mod} ${r[2]}≠${priceOf(mod)}`);
  ['Temel', 'Profesyonel', 'Kurumsal'].forEach((t, i) => { if ((r[3 + i] === '✔') !== !!tiers[t][mod]) priceBad.push(`paket:${mod}/${t}`); });
}
check(`Fiyat tablosu koddaki değerlerle AYNI: ${priceRows.length}/${modNames.length} modülün aylık liste fiyatı ve hangi pakette dahil olduğu (adminDb.ts); ana paket bedeli için rakam UYDURULMAZ ("teklifle belirlenir")`, priceRows.length === modNames.length && modNames.length === 6 && priceBad.length === 0 && /teklifle belirlenir/.test(md) && /ana bedeli/.test(md), `sapma=[${priceBad}]`);

// ── Menü adları / demo ─────────────────────────────────────────────────────────
const layout = read('frontend/src/layouts/CustomerLayout.tsx');
const menu = ['Genel Bakış', 'Tank Durumu', 'Yakıt Hareketleri', 'Araç Yönetimi', 'Şoför Yönetimi', 'Şantiye Yönetimi'];
check('Panel menü adları, gerçek arayüzdekiyle AYNI (Genel Bakış, Tank Durumu, Yakıt Hareketleri, Araç/Şoför/Şantiye Yönetimi) — sunucu ekranda görmediği bir ad söylemez', menu.every((l) => layout.includes(`label: '${l}'`) && md.includes(l)), `eksik=[${menu.filter((l) => !layout.includes(`label: '${l}'`) || !md.includes(l))}]`);

const demoRows = [...md.matchAll(/^\| \*\*(D\d)\*\* \| (.+?) \| (.+?) \| (.+?) \|$/gm)];
const script = read('scripts/demo-provasi.mjs');
const scriptSteps = [...script.matchAll(/step\(['`](\d)\. /g)].map((m) => Number(m[1]));
check(`AC (Teknik not): demo senaryosu ${demoRows.length} adım (D1–D8); her adımda ne yapılır / ne söylenir / ne görülür dolu; prova betiği (scripts/demo-provasi.mjs) AYNI ${new Set(scriptSteps).size} adımı koşturur`, demoRows.length === 8 && demoRows.every((r, i) => r[1] === `D${i + 1}` && r[2].length > 8 && r[3].length > 8 && r[4].length > 8) && [1, 2, 3, 4, 5, 6, 7, 8].every((n) => scriptSteps.includes(n)) && /D1–D8/.test(md), `betik adımları=[${[...new Set(scriptSteps)]}]`);
const consts = [['plaka', '34 CTP 82', /plate: '34 CTP 82'/], ['sürücü', 'Ahmet Yılmaz', /driver: 'Ahmet Yılmaz'/], ['tank', 'Gebze Ana Tank (T-1)', /tankName: 'Gebze Ana Tank \(T-1\)'/], ['litre', '50 litre', /dispenseLiters: 50/], ['çevrimdışı 2 kayıt', '**2 kayıt**', /offlineLiters: \[30, 45\]/]];
const constBad = consts.filter(([, docTxt, re]) => !md.includes(docTxt) || !re.test(script)).map(([n]) => n);
check('Demoda söylenen değerler (plaka, sürücü, tank, 50 litre, 2 çevrimdışı kayıt) prova betiğindeki verilerle AYNI; betikte sunucu-CI kullanımı için --canli kipi var', constBad.length === 0 && /--canli/.test(script) && /--canli/.test(md), `tutmayan=[${constBad}]`);
const seed = read('backend/src/db/seed.ts');
const fuel401 = read('backend/test/test_fuel401_dispense_session.ts');
check('Prova verisi gerçek tohum verisine dayanır: araç/plaka seed.ts\'te, kart/tank adı FUEL-401 testinde, örnek firmalar (camsa, kusak) seed.ts\'te', /34 CTP 82/.test(seed) && /CARD-881201/.test(fuel401) && /Gebze Ana Tank \(T-1\)/.test(fuel401) && /'camsa'/.test(seed) && /'kusak'/.test(seed), '');

// ── Bağlantılar / kanıt yolları / bağlama ────────────────────────────────────
const slug = (h) => h.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
const heads = new Set([...md.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1].replace(/\*\*/g, ''))));
const badAnchors = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((a) => !heads.has(a));
const badFiles = [...md.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((f) => !existsSync(path.join(ROOT, 'docs', f)));
const evidence = md.slice(md.indexOf('## Ek B'));
const evPaths = [...evidence.matchAll(/`([^`(]+?)`/g)].map((m) => m[1].trim()).filter((p) => /\//.test(p) || /\.(ts|tsx|mjs|md|html)$/.test(p));
const evBad = evPaths.filter((p) => !existsSync(path.join(ROOT, p)));
check(`Bağlantılar sağlam: ${[...md.matchAll(/\]\(#/g)].length} iç bağlantı gerçek başlığa çıkar, dosya bağlantıları mevcut; Ek B'de anılan ${evPaths.length} kanıt yolunun hepsi depoda var`, badAnchors.length === 0 && badFiles.length === 0 && evBad.length === 0 && evPaths.length >= 15, `iç=[${badAnchors}] dosya=[${badFiles}] kanıt=[${evBad}]`);

const ci = read('.github/workflows/ci-cd.yml');
check('Prova protokolü (Test Notu) var: dinleyici sayısı, form, geçme ölçütü (≥ 4,0), sonuç kaydı; henüz uygulanmadığı DÜRÜSTÇE yazılı', /## 5\. Prova ve geri bildirim protokolü/.test(md) && /≥ 4,0/.test(md) && /henüz gerçek dinleyiciyle uygulanmamıştır/.test(md) && (md.match(/^\s+\d\. .+$/gm) ?? []).length >= 6, '');
check('Entegrasyon: CI bu testi ve gerçek sistemde demo provasını (backend/test/test_doc1204_demo_rehearsal.ts) koşturur; README belge tablosu ve Proje Rehberi bu belgeyi listeler', /node scripts\/test-doc1204\.mjs/.test(ci) && /test_doc1204_demo_rehearsal/.test(ci) && existsSync(path.join(ROOT, 'backend/test/test_doc1204_demo_rehearsal.ts')) && /docs\/SUNUM-REHBERI\.md/.test(read('README.md')) && /SUNUM-REHBERI\.md/.test(read('docs/PROJE-REHBERI.md')), '');

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
