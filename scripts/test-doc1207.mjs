#!/usr/bin/env node
// ==============================================================================
// DOC-1207 (#189) — operatör el kitabı + özet kart + cihaz mesaj kataloğu: SÖZLEŞME/DRIFT testleri (sıfır npm bağımlılığı).
// AC'ler: (1) sunucunun cihaza döndürdüğü HER hata kodu kataloğda (ekran mesajı + ne yapmalı) ve el kitabında; (2) tek sayfalık özet kart
// (PDF gerçekten 1 sayfa); (3) el kitabı/kart cihaz mesajlarıyla BİREBİR (kataloğdan üretilir, elle kopya yok).
// ==============================================================================
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0; let total = 0;
const check = (name, ok, detail = '') => { total++; if (ok) passed++; console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`); };

const cat = JSON.parse(read('docs/operator/device-messages.json'));
const manual = read('docs/OPERATOR_EL_KITABI.md');
const card = read('docs/operator/OZET_KART.html');
const ph = cat.placeholders;
const expand = (s) => s.replace(/\{(\w+)\}/g, (_, k) => ph[k] ?? `{${k}}`);

// ── Katalog geçerliliği ─────────────────────────────────────────────────────
const ids = cat.messages.map((m) => m.id);
const badLines = cat.messages.flatMap((m) => m.lines.filter((l) => expand(l).length > cat.display.cols).map((l) => `${m.id}: "${l}"`));
const tooMany = cat.messages.filter((m) => m.lines.length > cat.display.rows).map((m) => m.id);
const ALLOWED = /^[A-Za-z0-9ğüşıöçĞÜŞİÖÇ .,:;!?()/{}'"+\-…%=]+$/;
const badChars = cat.messages.flatMap((m) => m.lines.filter((l) => !ALLOWED.test(l)).map((l) => `${m.id}: "${l}"`));
const incomplete = cat.messages.filter((m) => !m.meaning || !m.action || !m.screen || !m.buzzer || !m.source?.code).map((m) => m.id);
const badRefs = cat.messages.filter((m) => !cat.screens.includes(m.screen) || !(m.buzzer in cat.buzzer)).map((m) => m.id);
check(`Katalog geçerli (${cat.messages.length} mesaj): benzersiz id; ekran ${cat.display.cols}×${cat.display.rows} sınırında (yer tutucular en uzun değerle genişletilerek); yalnızca ekranın gösterebileceği karakterler (Türkçe dahil); her mesajın anlamı + "ne yapmalı" + buzzer + ekran tanımı var`,
  new Set(ids).size === ids.length && badLines.length === 0 && tooMany.length === 0 && badChars.length === 0 && incomplete.length === 0 && badRefs.length === 0, `uzun=[${badLines}] fazla satır=[${tooMany}] karakter=[${badChars}] eksik=[${incomplete}] hatalı ref=[${badRefs}]`);
const first = (id) => cat.messages.find((m) => m.id === id)?.lines[0];
const fw1316States = ['BEKLEME', 'KART_OKUNDU', 'YETKI_BEKLENIYOR', 'AKIS', 'TAMAMLANDI', 'HATA'];
check('FW-1316 kapsamı: ekran düzeni durumları (bekleme, kart okundu, yetki bekleniyor, akış litre+debi, tamamlandı, hata) + çevrimdışı/limit; ret mesajları SEBEBİ söyler ("Kota doldu", "Kart tanımsız", "Çevrimdışı limit"); yalnızca "Hata" yazan mesaj YOK; akış ekranı litre ve debi gösterir; buzzer kalıpları (kabul/ret/uyarı/hata)',
  fw1316States.every((s) => cat.messages.some((m) => m.screen === s)) && cat.messages.some((m) => m.screen === 'CEVRIMDISI') && first('QUOTA_EXHAUSTED') === 'Kota doldu' && first('CARD_UNKNOWN') === 'Kart tanımsız' && first('OFFLINE_LIMIT') === 'Çevrimdışı limit' &&
    !cat.messages.some((m) => /^hata!?$/i.test(m.lines[0].trim())) && cat.messages.find((m) => m.id === 'AKIS').lines.join('|').includes('{litre}') && cat.messages.find((m) => m.id === 'AKIS').lines.join('|').includes('{debi}') && ['KABUL', 'RET', 'UYARI', 'HATA'].every((b) => b in cat.buzzer), '');

// ── AC 1: her hata kodu ─────────────────────────────────────────────────────
const tdb = read('backend/src/db/tenantDb.ts');
const start = tdb.indexOf('export async function authorizeDispenseRequest');
const body = tdb.slice(start, tdb.indexOf('\nexport ', start + 40));
const authCodes = [...new Set([...body.matchAll(/error: '([A-Z_]{4,})'/g)].map((m) => m[1]))];
const sess = read('backend/src/services/dispenseSessionService.ts');
const sessCodes = [...new Set([...sess.matchAll(/error: '([A-Z_]{4,})'/g)].map((m) => m[1]))];
const hw = read('backend/src/middleware/hardwareAuthMiddleware.ts');
const hwCodes = [...new Set([...hw.matchAll(/'((?:UNAUTHORIZED_DEVICE|DEVICE_BLOCKED|CLOCK_DRIFT|MISSING_HARDWARE_HEADERS|INVALID_[A-Z_]+|NONCE_[A-Z_]+|REPLAY_ATTACK_DETECTED))'/g)].map((m) => m[1]))];
const reasons = [...new Set([...sess.matchAll(/reason: '([A-Z_]+_EXCEEDED)'/g)].map((m) => m[1]))];
const sysCodes = ['TOO_MANY_REQUESTS', 'DB_UNAVAILABLE', 'DB_BUSY', 'SERVICE_UNAVAILABLE'];
const covered = new Set(cat.messages.flatMap((m) => m.source.codes ?? [m.source.code]));
const required = [...new Set([...authCodes, ...sessCodes, ...hwCodes, ...reasons, ...sysCodes])];
const uncovered = required.filter((c) => !covered.has(c));
check(`AC1 (tüm hata mesajları ve karşılığı): cihazın alabileceği ${required.length} hata kodunun (ikmal yetkilendirme ${authCodes.length}, oturum ${sessCodes.length}, cihaz kimlik doğrulama ${hwCodes.length}, pompa kesme nedeni ${reasons.length}, sistem ${sysCodes.length}) HEPSİ katalogda ekran mesajı + "ne yapmalı" ile karşılanır`, authCodes.length >= 10 && uncovered.length === 0, `karşılanmayan=[${uncovered}]`);
const notInManual = cat.messages.filter((m) => !manual.includes(`**${m.lines.join(' / ')}**`) || !manual.includes(m.action) || !manual.includes(m.meaning)).map((m) => m.id);
check('AC1/AC3: kataloğdaki HER mesaj el kitabında ekran yazısıyla (satırlar " / " ile) + anlamı + "ne yapmalı" ile BİREBİR yer alır', notInManual.length === 0, `eksik=[${notInManual}]`);

// ── AC 3: kataloğdan üretilmiş, elle kopya yok ─────────────────────────────────
const gen = spawnSync('node', [path.join(ROOT, 'scripts/generate-operator-manual.mjs'), '--check'], { encoding: 'utf8' });
check('AC3 (birebir uyum): el kitabı mesaj bölümü ve özet kart tabloları katalogdan üretilmiştir — katalog değişip belge güncellenmediyse CI kırılır (generate-operator-manual.mjs --check)', gen.status === 0, (gen.stdout + gen.stderr).trim().slice(0, 200));
const CARD_IDS = ['CARD_UNKNOWN', 'RFID_CARD_BLOCKED', 'QUOTA_EXHAUSTED', 'VEHICLE_FUEL_LIMIT_EXCEEDED', 'FUEL_TYPE_MISMATCH', 'OFFLINE', 'FLOW_FAULT', 'SERVER_BUSY'];
const cardMissing = CARD_IDS.filter((id) => { const m = cat.messages.find((x) => x.id === id); return !m || !m.lines.every((l) => card.includes(l.replace(/&/g, '&amp;'))); });
check(`Özet kart mesajları: kartta gösterilen ${CARD_IDS.length} en sık ekran yazısı katalogdakiyle harfiyen aynı`, cardMissing.length === 0, `uyuşmayan=[${cardMissing}]`);

// ── AC 2: tek sayfalık özet kart ───────────────────────────────────────────────
const pdfPath = path.join(ROOT, 'docs/operator/pdf/OZET_KART.pdf');
const pdf = existsSync(pdfPath) ? readFileSync(pdfPath) : Buffer.alloc(0);
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
const manualPdf = existsSync(path.join(ROOT, 'docs/operator/pdf/OPERATOR_EL_KITABI.pdf'));
check('AC2 (tek sayfalık özet kart): PDF gerçekten TEK sayfa (A4); laminasyona uygun (büyük punto, yüksek kontrast, yazdırma stili); içinde 5 adım, sık ekran yazıları, acil durum kutusu ve doldurulacak telefon alanları var; el kitabının da PDF çıktısı üretilmiş',
  pdf.subarray(0, 5).toString() === '%PDF-' && pages === 1 && card.includes('@page') && card.includes('size: A4') && /İKMAL: 5 ADIM/.test(card) && (card.match(/<li>/g) ?? []).length >= 5 && /ACİL DURUM/.test(card) && /ACİL DURDURMA/.test(card) && /TELEFONLAR/.test(card) && !/(src|href)="https?:/.test(card) && manualPdf, `sayfa=${pages}`);

// ── El kitabı kapsamı ve sadelik ─────────────────────────────────────────────
const need = ['Günlük kullanım', 'Kartınızı okutun', 'Ekran mesajları ve ne yapmalı', 'Kart okunmuyor', 'Yetki reddedildi', 'İnternet yok / çevrimdışı mod', 'Akış kesildi / pompa durdu', 'Panel kullanımı', 'Yakıt Hareketleri', 'Km / motor saati girişi', 'Canlı ikmal ekranı', 'Acil durdurma', 'Hırsızlık / şüpheli ikmal alarmı', 'Cihaz arızası', 'Telefonlar', 'OZET_KART'];
const miss = need.filter((t) => !manual.includes(t));
check('Kapsam (ticket): günlük kullanım (kart okutma, ikmal, ekran mesajları), hata durumları (kart okunmuyor, yetki reddedildi, çevrimdışı, akış kesildi), panel (canlı ekran, km girişi, hareket sorgulama), acil durum (acil durdurma, hırsızlık alarmı, cihaz arızası), telefonlar, özet kart', miss.length === 0, `eksik=[${miss}]`);
const prose = manual.replace(/<!-- MESAJLAR:BAŞLA[\s\S]*?MESAJLAR:BİTİŞ -->/, '').replace(/[`*_#>|<>-]/g, ' ').split(/(?<=[.!?:])\s+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 3);
const words = prose.map((s) => s.split(/\s+/).length);
const avg = words.reduce((a, b) => a + b, 0) / words.length;
const long = prose.filter((s) => s.split(/\s+/).length > 40).length;
check('Sade dil (hedef okuyucu teknik değil, telefondan okur): ortalama cümle ≤ 14 kelime, 40 kelimeyi aşan cümle ≤ 3; teknik terim (HMAC, JWT, API, endpoint, RLS, MQTT) YOK', avg <= 14 && long <= 3 && !/\b(HMAC|JWT|API|endpoint|MQTT|RLS|nonce|payload)\b/i.test(manual), `ortalama=${avg.toFixed(1)}, uzun=${long}`);

// ── Panel: belgedeki arayüz adları gerçek ─────────────────────────────────────
const fe = (f) => read(f);
const site = fe('frontend/src/pages/santiye/SiteOperatorPanel.tsx');
const tx = fe('frontend/src/pages/customer/TransactionsPage.tsx');
const layout = fe('frontend/src/layouts/CustomerLayout.tsx');
const labels = [['Pompayı Başlat & İkmal Et', site], ['İkmal başlatma yetkiniz yok', site], ['Debi (L/dk)', site], ['Pompa Akışı Aktif', site], ['Excel Olarak İndir', tx], ['Filtreleri Temizle', tx], ['Yakıt Hareketleri', layout], ['Tank Durumu', layout], ['Bildirimler', layout]];
const missingLabels = labels.filter(([l, src]) => !src.includes(l) || !manual.includes(l)).map(([l]) => l);
check('Panel drift\'i: el kitabında anılan ekran/düğme adları arayüzde GERÇEKTEN var (ve belgede yazıldığı gibi)', missingLabels.length === 0, `uyuşmayan=[${missingLabels}]`);
const pagesDir = readdirSync(path.join(ROOT, 'frontend/src/pages/customer')).concat(readdirSync(path.join(ROOT, 'frontend/src/pages/santiye')));
const kmScreen = pagesDir.some((f) => /km|odometer|meter|sayac/i.test(f)) || /meter-readings/.test(site + tx);
const liveScreen = pagesDir.some((f) => /live|canli/i.test(f)); const alarmScreen = pagesDir.some((f) => /alarm/i.test(f));
check('"Henüz yok" iddiaları doğru: km girişi (FE-813), canlı ikmal ekranı (FE-811) ve alarm merkezi (FE-815) için arayüzde sayfa YOK — biri eklenirse bu test kırılır ve el kitabı §4.3 güncellenmek zorundadır',
  !kmScreen && !liveScreen && !alarmScreen && /FE-813/.test(manual) && /FE-811/.test(manual) && /FE-815/.test(manual), `km=${kmScreen} canlı=${liveScreen} alarm=${alarmScreen}`);

// ── Kullanılabilirlik testi + bağlantılar + CI ─────────────────────────────────
const ut = read('docs/operator/KULLANILABILIRLIK_TESTI.md');
check('Kullanılabilirlik testi (Test Notu): hiç görmemiş katılımcılarla görev/başarı ölçütü protokolü hazır (G3 yanlış yakıt = kritik), sonuç tablosu boş ve "HENÜZ YAPILMADI" dürüstçe belirtilmiş', /HENÜZ YAPILMADI/.test(ut) && ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'].every((g) => ut.includes(`| ${g} |`)) && /≤ 5 dk/.test(ut) && /pilotta doldurulacak/.test(ut), '');
const links = [...manual.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
const broken = links.filter((l) => !existsSync(path.join(ROOT, 'docs', l)));
const ci = read('.github/workflows/ci-cd.yml');
check('Bağlantılar ve entegrasyon: el kitabı bağlantıları geçerli; HARDWARE_INTEGRATION_GUIDE kataloğu firmware için tek kaynak olarak tanımlar; SAHA_KURULUM el kitabına bağlanır; CI\'da katalog↔belge uyumu ve bu test çalışır',
  broken.length === 0 && /device-messages\.json/.test(read('docs/HARDWARE_INTEGRATION_GUIDE.md')) && /OPERATOR_EL_KITABI\.md/.test(read('docs/SAHA_KURULUM.md')) && /generate-operator-manual\.mjs --check/.test(ci) && /node scripts\/test-doc1207\.mjs/.test(ci), `kırık=[${broken}]`);

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
