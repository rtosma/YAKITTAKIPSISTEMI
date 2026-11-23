#!/usr/bin/env node
// ==============================================================================
// DOC-1206 (#188) — saha kurulum prosedürü + imzalanabilir devreye alma formu: SÖZLEŞME/DRIFT testleri (sıfır npm bağımlılığı).
// Belge kodla çelişemez: atıf yapılan API uçları gerçekten kayıtlı mı, sayısal eşikler (±30 sn, %20, 10 sn TTL, 300/dk, 15 dk claim)
// kodun sabitleriyle aynı mı, her adımda fotoğraf yeri var mı, form ↔ belge kriterleri (KRT-01…10) birebir mi.
// ==============================================================================
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0; let total = 0;
const check = (name, ok, detail = '') => { total++; if (ok) passed++; console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`); };

const files = ['docs/SAHA_KURULUM.md', 'docs/saha-kurulum/DEVREYE_ALMA_FORMU.html', 'docs/saha-kurulum/foto/README.md', 'docs/saha-kurulum/img/01-sistem-mimarisi.svg', 'docs/saha-kurulum/img/02-topraklama-ekran.svg'];
check('Dosyalar: prosedür, imzalanabilir form, fotoğraf çekim listesi ve iki şematik çizim mevcut', files.every((f) => existsSync(path.join(ROOT, f))), files.filter((f) => !existsSync(path.join(ROOT, f))).join(','));
const doc = read('docs/SAHA_KURULUM.md');
const form = read('docs/saha-kurulum/DEVREYE_ALMA_FORMU.html');
const photos = read('docs/saha-kurulum/foto/README.md');

// ── Kapsam bölümleri ────────────────────────────────────────────────────────
const need = ['Kurulum öncesi hazırlık', 'Donanım listesi', 'Ağ gereksinimleri', 'Elektrik ve montaj koşulları', 'Adım adım devreye alma', 'Konfigürasyon portalı ve claim', 'Sensör kalibrasyonu', 'Referans kap ile test alımı', 'Offline senaryosu', '24 saat izleme', 'Kalibrasyon prosedürü', 'Sık karşılaşılan saha sorunları', 'Kabul ve imza', 'Pilot geri beslemesi', 'Topraklama ve ekran'];
const miss = need.filter((t) => !doc.includes(t));
check('Kapsam (ticket): hazırlık (donanım/ağ/elektrik-montaj), adım adım devreye alma, kalibrasyon prosedürü + kabul kriterleri, checklist, sık sorunlar (topraklama/gürültü dahil) ve pilot geri beslemesi', miss.length === 0, `eksik=[${miss}]`);

// ── Fotoğraf yerleri ─────────────────────────────────────────────────────────
const docFotos = [...new Set([...doc.matchAll(/\[FOTO-(\d\d)\]/g)].map((m) => m[1]))].sort();
const listFotos = [...new Set([...photos.matchAll(/\| FOTO-(\d\d) \|/g)].map((m) => m[1]))].sort();
const sections = [...doc.matchAll(/### (4\.\d) [^\n]*\n([\s\S]*?)(?=\n### |\n## )/g)];
const noPhoto = sections.filter((s) => !/\[FOTO-\d\d\]/.test(s[2])).map((s) => s[1]);
check('Fotoğraf (AC — adım adım ve fotoğraflı): belgedeki her [FOTO-nn] çekim listesinde tarifle tanımlı ve tersi (14 kayıt); montaj/devreye alma adımlarının (4.1–4.9) her birinde fotoğraf yeri var; fotoğrafların pilotta ekleneceği DÜRÜSTÇE belirtilir',
  docFotos.join() === listFotos.join() && docFotos.length === 14 && sections.length >= 9 && noPhoto.length === 0 && /henüz eklenmedi/.test(doc) && /pilot/.test(photos), `belge=${docFotos.length}, liste=${listFotos.length}, fotoğrafsız adım=[${noPhoto}]`);
const svgs = ['docs/saha-kurulum/img/01-sistem-mimarisi.svg', 'docs/saha-kurulum/img/02-topraklama-ekran.svg'].map(read);
check('Şematik çizimler: geçerli SVG (title + kapanış), belgeye gömülü; topraklama şeması "ekran yalnızca kabin ucunda" kuralını gösterir',
  svgs.every((s) => s.startsWith('<svg') && s.includes('<title>') && s.trim().endsWith('</svg>')) && doc.includes('img/01-sistem-mimarisi.svg') && doc.includes('img/02-topraklama-ekran.svg') && /BAĞLANMAZ/.test(svgs[1]) && /kabin ucundan/.test(svgs[1]), '');

// ── Sayısal kabul kriterleri: belge ↔ form ─────────────────────────────────────
const codes = Array.from({ length: 10 }, (_, i) => `KRT-${String(i + 1).padStart(2, '0')}`);
const inDoc = codes.filter((c) => new RegExp(`\\*\\*${c}\\*\\*`).test(doc));
const inForm = codes.filter((c) => new RegExp(`data-krt="${c}"`).test(form));
check('Kabul kriterleri (AC — sayısal): KRT-01…KRT-10 belgede (§3 tablo) ve formda birebir aynı numarayla; her form satırında EVET/HAYIR + ölçülen değer alanı', inDoc.length === 10 && inForm.length === 10 && (form.match(/EVET/g) ?? []).length >= 10 && (form.match(/HAYIR/g) ?? []).length >= 10, `belge=${inDoc.length}, form=${inForm.length}`);
const thresholds = [['%0,5', 'test alımı sapması'], ['±30', 'saat sapması'], ['10 dk', 'offline/gürültü süresi'], ['86400', '24 saat'], ['3/3', 'offline kabul'], ['0 pals', 'gürültü']];
check('Eşikler belge ve formda AYNI: test alımı ≤ %0,5 · saat ±30 sn · WAN ≥ 10 dk · ≥ 3 ikmal 3/3 ACCEPTED · online-sla offlineSeconds 0 / totalSeconds ≥ 86400 · röle açık 10 dk → 0 pals',
  thresholds.every(([t]) => doc.includes(t) && (t === '3/3' || t === '%0,5' || t === '±30' || t === '10 dk' || t === '86400' || t === '0 pals' ? form.includes(t.replace('%0,5', '0,5')) : true)) && /offlineSeconds = <strong>0<\/strong>/.test(form) && /≥ 3 ikmal/.test(form), '');

// ── Kod ile tutarlılık (drift) ────────────────────────────────────────────────
const routes = read('backend/src/routes/routes.ts');
const registered = new Set([...routes.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2].replace(/:[A-Za-z]+/g, ':p')}`));
const cited = [...new Set([...doc.matchAll(/`?\b(GET|POST|PATCH|PUT|DELETE) (\/[A-Za-z0-9\-_/{}:]+)/g)].map((m) => `${m[1]} ${m[2].replace(/\{[A-Za-z]+\}/g, ':p')}`))];
const unknownRoutes = cited.filter((c) => !registered.has(c));
check(`Uç drift'i: belgede atıf yapılan ${cited.length} API ucunun HEPSİ routes.ts'te kayıtlı (yanlış/eski yol yok)`, cited.length >= 20 && unknownRoutes.length === 0, `kayıtsız=[${unknownRoutes}]`);
const auth = read('backend/src/middleware/hardwareAuthMiddleware.ts');
const rl = read('backend/src/middleware/rateLimitMiddleware.ts');
const redis = read('backend/src/db/redisPool.ts');
const tdb = read('backend/src/db/tenantDb.ts');
const hg = read('docs/HARDWARE_INTEGRATION_GUIDE.md');
const claimDefault = /CLAIM_CODE_TTL_MINUTES_DEFAULT = 15;/.exec(tdb);
check('Sabit drift\'i: belgedeki eşikler kodla aynı — HMAC zaman penceresi ±30 sn (MAX_ALLOWED_TIME_WINDOW_MS), ikinci onay %20 (CALIBRATION_SECOND_APPROVAL_THRESHOLD_RATIO), presence TTL 10 sn, cihaz limiti 300/dk, claim kodu varsayılan 15 dk (HARDWARE_INTEGRATION_GUIDE ile tutarlı)',
  /MAX_ALLOWED_TIME_WINDOW_MS = 30_000/.test(auth) && doc.includes('±30 sn') && !/±(?!30\b)\d+\s*sn/.test(doc) && !/±(?!30\b)\d+\s*sn/.test(form) && /CALIBRATION_SECOND_APPROVAL_THRESHOLD_RATIO = 0\.20/.test(tdb) && doc.includes('%20') && /DEVICE_PRESENCE_TTL_SECONDS = 10/.test(redis) && doc.includes('10 sn TTL') &&
    /limit: 300/.test(rl.slice(rl.indexOf('hardwareRateLimiter'))) && doc.includes('300 sınırı') && doc.includes('**15 dk**') && hg.includes('varsayılan 15 dk') && !!claimDefault, `claim varsayılanı bulundu=${!!claimDefault}`);
check('Kalibrasyon kuralları kodla uyumlu: başlangıç K yoksa test alımı 409 NO_BASELINE_K_FACTOR; doğrulama alımı yalnızca ONAYLANDI komut için; test alımı transactions\'a yazmaz ama tanktan düşer; K yalnızca ACK ile güncellenir',
  /NO_BASELINE_K_FACTOR/.test(tdb) && doc.includes('NO_BASELINE_K_FACTOR') && /CALIBRATION_NOT_YET_ACKED/.test(tdb) && doc.includes('ONAYLANDI') && /BİLEREK transactions'a INSERT YOK/.test(tdb) && doc.includes('tanktan düşer') && /yalnızca ACK ile/.test(doc), '');

// ── Bağlantılar ──────────────────────────────────────────────────────────────
const links = [...doc.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
const broken = links.filter((l) => !existsSync(path.join(ROOT, 'docs', l)));
check(`Bağlantılar: belgedeki ${links.length} göreli bağlantı/görsel mevcut dosyaya işaret eder`, links.length >= 8 && broken.length === 0, `kırık=[${broken}]`);

// ── Form kullanılabilirliği ──────────────────────────────────────────────────
const inputs = [...form.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
const unlabeled = inputs.filter((i) => !/aria-label=/.test(i) && !/type="checkbox"/.test(i));
check('Form (AC — kullanılabilir): tek dosya HTML, dış kaynak/betik yok, yazdırma stili + Yazdır düğmesi, üç imza bloğu (teknisyen/şantiye şefi/müşteri), KABUL/RED kararı, "imzasız canlıya alınmaz" uyarısı, tüm giriş alanları erişilebilir etiketli, formda kişisel veri/secret yazılmaz uyarısı',
  form.includes('<!DOCTYPE html>') && !/(src|href)="https?:/.test(form) && !/<script/.test(form) && form.includes('@media print') && form.includes('window.print()') && (form.match(/class="line"/g) ?? []).length === 3 &&
    ['Devreye alma teknisyeni', 'Şantiye şefi', 'Müşteri / yönetici yetkilisi'].every((t) => form.includes(t)) && form.includes('KABUL') && form.includes('RED') && /İmzalı form olmadan şantiye canlıya alınmaz/.test(form) && unlabeled.length === 0 && /TCKN, kart numarası, secret, claim kodu/.test(form),
  `etiketsiz giriş=${unlabeled.length}/${inputs.length}`);
const hgLink = read('docs/HARDWARE_INTEGRATION_GUIDE.md');
check('Entegrasyon: firmware/donanım rehberi ve alarm runbook\'u bu prosedüre bağlanır; CI\'da bu test çalışır',
  /SAHA_KURULUM\.md/.test(hgLink) && /SAHA_KURULUM\.md/.test(read('docs/runbooks/field.md')) && /node scripts\/test-doc1206\.mjs/.test(read('.github/workflows/ci-cd.yml')), '');

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
