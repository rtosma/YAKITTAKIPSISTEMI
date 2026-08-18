#!/usr/bin/env node
/**
 * docs/ISSUES_ROADMAP.md dosyasını katalogdan ve oluşturulan issue
 * numaralarından (created.json) üretir. Elle düzenlenmemelidir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASES, PRIORITY_TEXT } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'created.json'), 'utf8'));
const REPO_URL = 'https://github.com/rtosma/YAKITTAKIPSISTEMI';

const MODULE_TITLES = {
  arch: '🏗️ ARCH — Mimari & Çoklu Kiracılık (Multi-Tenancy)',
  auth: '🔐 AUTH — Kimlik Doğrulama, Yetkilendirme & Güvenlik',
  iot: '📡 IOT — Donanım Haberleşmesi, Telemetri & MQTT',
  firmware: '🔧 FW — ESP32 Firmware (ESP-IDF)',
  fuel: '⛽ FUEL — Akaryakıt Otomasyonu, RFID & İkmal Protokolü',
  fleet: '🚚 FLEET — Filo, Araç & Sürücü Yönetimi',
  inventory: '📦 INV — Stok, Tedarik & Maliyet',
  ai: '🧠 AI — Yapay Zeka & Anomali Tespiti',
  compliance: '📄 COMP — GİB e-İrsaliye, UBL-TR & Mevzuat',
  reporting: '📊 REP — Raporlama, Export & Arşivleme',
  frontend: '💻 FE — Frontend & Üç Panel',
  notification: '🔔 NOTIF — Bildirim & Alarm',
  resilience: '⚠️ RES — Hata Yönetimi & Dayanıklılık',
  test: '🧪 TEST — Test Otomasyonu',
  devops: '🚀 OPS — DevOps, Container, CI/CD & İzleme',
  docs: '📚 DOC — Dokümantasyon',
  billing: '💳 BILL — SaaS Abonelik & Lisans',
  hr: '👥 HR — İnsan Kaynakları',
};
const MODULE_ORDER = Object.keys(MODULE_TITLES);

const CRITICAL_PATH = [
  'ARCH-100', 'ARCH-109', 'ARCH-101.1', 'ARCH-101.2', 'ARCH-101.3',
  'AUTH-201.1', 'AUTH-201.2', 'AUTH-201.4', 'AUTH-202.1', 'AUTH-202.2', 'AUTH-202.3',
  'IOT-304', 'IOT-301.1', 'IOT-301.2', 'IOT-305',
  'FW-1301', 'FW-1304', 'FW-1307', 'FW-1308', 'FW-1309', 'FW-1310',
  'FUEL-401.1', 'FUEL-401.2', 'FUEL-401.3', 'FUEL-401.4', 'FUEL-410',
  'IOT-303.1', 'IOT-303.2', 'ARCH-103.2', 'AI-501.1',
  'COMP-601.1', 'COMP-602.1', 'REP-703', 'REP-711',
  'TEST-1001', 'TEST-1003', 'OPS-1104', 'OPS-1106',
];

async function loadCatalog() {
  const dir = path.join(__dirname, 'catalog');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const all = [];
  for (const f of files) all.push(...(await import(path.join(dir, f))).default);
  return all;
}

const link = (key) => (state[key] ? `[#${state[key]}](${REPO_URL}/issues/${state[key]})` : '_(açılmadı)_');

const catalog = await loadCatalog();
const byKey = Object.fromEntries(catalog.map((i) => [i.key, i]));
const L = [];

L.push('# 📋 PROJE MASTER İŞ VE GÖREV DÖKÜMÜ');
L.push('**Proje Adı:** Endüstriyel IoT Destekli Çok Kiracılı (Multi-Tenant) Akaryakıt, Şantiye ve Telemetri Yönetim Platformu  ');
L.push('**Backend:** Node.js (TypeScript) + NestJS + Drizzle ORM + PostgreSQL 16/TimescaleDB + Redis/BullMQ + EMQX (MQTT v5)  ');
L.push('**Firmware:** ESP32 + **ESP-IDF v5.x** (FreeRTOS, güvenli OTA, NVS şifreleme)  ');
L.push('**Frontend:** React 18 + TypeScript + Vite + TanStack Query v5 + Zustand  ');
L.push('**Hedef:** Sıfır hata toleransı, uçtan uca bütünsel mimari, donanım-bulut entegrasyonu ve kurumsal SaaS olgunluğu  ');
L.push('**Sürüm:** Node.js Enterprise Roadmap **v2.2** (v2.1 genişletildi — 6 yeni modül grubu, firmware ve rapor kataloğu eklendi)  ');
L.push(`**Toplam iş paketi:** ${catalog.length} (${catalog.filter((i) => i.epicOf).length} epic + ${catalog.filter((i) => !i.epicOf).length} alt/bağımsız issue)  `);
L.push('');
L.push('> ⚙️ Bu dosya `scripts/roadmap/` altındaki katalogdan otomatik üretilir (`node scripts/roadmap/generate-roadmap-doc.mjs`). Elle düzenlemeyin; kaynağı `scripts/roadmap/catalog/*.mjs` dosyalarıdır.');
L.push('');
L.push('---');
L.push('');
L.push('## 🧭 Önceliklendirme ve Efor Skalası');
L.push('* **Öncelik:** `[P0 - Blocker]` sistem çalışması için zorunlu / güvenlik / veri kaybı riski · `[P1 - High]` temel iş süreçleri · `[P2 - Medium]` deneyim, analitik, optimizasyon · `[P3 - Low]` ikincil ve opsiyonel');
L.push('* **Efor:** `[XS]` 1-2 gün · `[S]` 3-5 gün · `[M]` 1-2 hafta · `[L]` 2-3 hafta · `[XL]` 1+ ay');
L.push('* **Not:** `[L]` ve `[XL]` iş paketleri **epic** olarak tutulur ve her biri `XS`/`S` boyutunda alt issue’lara bölünmüştür.');
L.push('');
L.push('## 🎯 Alınan Temel Kararlar');
L.push('| Konu | Karar | Gerekçe |');
L.push('|---|---|---|');
L.push('| Firmware framework | **ESP-IDF v5.x** | Gerçek task watchdog, güvenli OTA + rollback, NVS şifreleme, brown-out detector — röle süren bir cihazda zorunlu |');
L.push('| Sunucuya ulaşılamadığında | **Hibrit sınırlı fail-open** | Şantiye durmaz; yerel whitelist + araç başına 200 L + günde 1 alım + 24 saat liste tazeliği ile kaçak riski sınırlanır (`FUEL-410`, `FW-1310`) |');
L.push('| Ölçek profili | **Orta** (5-20 firma, 20-80 şantiye, 100-300 cihaz) | Günde 2.000-10.000 ikmal; read replica, Redis cluster ve EMQX çok düğüm FAZ 2’den itibaren planlanır |');
L.push('| Tenant izolasyonu | **PostgreSQL RLS + AsyncLocalStorage** | Uygulama katmanında unutulan filtre veri sızıntısına dönüşmemeli |');
L.push('| Kota kontrolü kesintide | **Fail-close** | Cihaz yetkilendirmesinden farklı: kota aşımı riski, kesinti riskinden ağırdır (`RES-905`) |');
L.push('');
L.push('---');
L.push('');

// Faz özeti
L.push('## 📅 Faz Planı ve Milestone’lar');
L.push('');
L.push('| Faz | Milestone | Issue | Kapsam |');
L.push('|---|---|---|---|');
const phaseScope = {
  1: 'Multi-tenancy, kimlik, güvenlik, CI/CD temeli',
  2: 'MQTT/LoRaWAN, ESP32 firmware, ikmal otomasyonu, filo/tank tanımları',
  3: 'Anomali tespiti, e-İrsaliye, 13 rapor, bildirim kanalları',
  4: 'Test otomasyonu, yük testi, izleme, yedekleme, canlıya çıkış',
  5: 'Lisans, İK, bakım-lastik, envanter, laboratuvar (canlı sonrası)',
};
for (const p of [1, 2, 3, 4, 5]) {
  const n = catalog.filter((i) => i.phase === p).length;
  L.push(`| FAZ ${p} | ${PHASES[p].title} | ${n} | ${phaseScope[p]} |`);
}
L.push('');

// Modül × faz matrisi
L.push('## 📊 Modül × Faz Dağılımı');
L.push('');
L.push('| Modül | FAZ 1 | FAZ 2 | FAZ 3 | FAZ 4 | FAZ 5 | Toplam |');
L.push('|---|---:|---:|---:|---:|---:|---:|');
for (const m of MODULE_ORDER) {
  const items = catalog.filter((i) => i.module === m);
  const c = (p) => items.filter((i) => i.phase === p).length || '–';
  L.push(`| ${MODULE_TITLES[m].replace(/^[^ ]+ /, '')} | ${c(1)} | ${c(2)} | ${c(3)} | ${c(4)} | ${c(5)} | **${items.length}** |`);
}
const t = (p) => catalog.filter((i) => i.phase === p).length;
L.push(`| **TOPLAM** | **${t(1)}** | **${t(2)}** | **${t(3)}** | **${t(4)}** | **${t(5)}** | **${catalog.length}** |`);
L.push('');
L.push('---');
L.push('');

// Modül bölümleri
for (const m of MODULE_ORDER) {
  const items = catalog.filter((i) => i.module === m);
  if (!items.length) continue;
  L.push(`# ${MODULE_TITLES[m]}`);
  L.push('');
  L.push('| Kod | Issue | Başlık | Faz | Öncelik | Efor | Bağımlı olduğu |');
  L.push('|---|---|---|---|---|---|---|');
  const epics = items.filter((i) => i.epicOf);
  const rest = items.filter((i) => !i.epicOf);
  const ordered = [];
  for (const e of epics) {
    ordered.push(e);
    for (const k of e.epicOf) if (byKey[k] && byKey[k].module === m) ordered.push(byKey[k]);
  }
  for (const r of rest) if (!ordered.includes(r)) ordered.push(r);

  for (const i of ordered) {
    const indent = i.epic ? '&nbsp;&nbsp;↳ ' : '';
    const epicMark = i.epicOf ? ' 🎯' : '';
    const deps = (i.blockedBy || []).map((k) => `\`${k}\``).join(', ') || '–';
    L.push(`| ${indent}\`${i.key}\`${epicMark} | ${link(i.key)} | ${i.title} | ${PHASES[i.phase].text} | ${PRIORITY_TEXT[i.priority]} | ${i.size} | ${deps} |`);
  }
  L.push('');
}

// Kritik yol
L.push('---');
L.push('');
L.push('## 🔗 Kritik Yol (Critical Path)');
L.push('');
L.push('Projenin toplam süresini belirleyen, birbirine bağımlı en uzun zincir:');
L.push('');
L.push('```');
L.push(CRITICAL_PATH.map((k, idx) => `${String(idx + 1).padStart(2, ' ')}. ${k.padEnd(14)} #${state[k] || '?'}  ${byKey[k] ? byKey[k].title : ''}`).join('\n'));
L.push('```');
L.push('');
L.push(`**Zincir uzunluğu:** ${CRITICAL_PATH.length} issue. Tek geliştiriciyle yaklaşık 14 hafta; backend / firmware / frontend olarak üç paralel şerit ile 12 haftaya sığar.`);
L.push('');
L.push('**Zincirdeki en riskli üç geçiş:**');
L.push(`1. \`AUTH-202.3\` → \`FW-1308\` (${link('FW-1308')}): sunucu ve firmware’in **kanonik serileştirmede birebir aynı** olması gerekir. \`DOC-1202\` test vektörleri olmadan bu geçiş sahada patlar.`);
L.push(`2. \`FUEL-401.4\` → \`IOT-303.1\` (${link('IOT-303.1')}): çevrimdışı senkronun mükerrer finansal kayıt üretmemesi, idempotency tasarımının doğruluğuna bağlıdır.`);
L.push(`3. \`FUEL-403\` → \`AI-501.1\` (${link('AI-501.1')}): hacim hesabı yanlışsa hırsızlık motoru sürekli yanlış alarm üretir ve güvenilirliğini kaybeder.`);
L.push('');
L.push('---');
L.push('');
L.push('## 🗂️ Eski Issue’ların Yeni Karşılıkları');
L.push('');
L.push('v2.1 öncesi açılan `Modül 1…11` issue’ları kapatıldı; kapsamları aşağıdaki iş paketlerine taşındı.');
L.push('');
L.push('| Eski | Yeni iş paketleri |');
L.push('|---|---|');
const legacy = {
  '#2 Modül 1: Çekirdek Kurulum ve Güvenlik': ['ARCH-100', 'ARCH-101', 'AUTH-201', 'AUTH-202', 'RES-901', 'RES-902', 'OPS-1101'],
  '#3 Modül 2: Context → Zustand': ['FE-800', 'FE-801', 'FE-802'],
  '#4 Modül 3: Mock → REST API': ['ARCH-100', 'ARCH-104', 'FE-800', 'FE-802', 'DOC-1201'],
  '#5 Modül 4: Gerçek Zamanlı Telemetri': ['IOT-301', 'IOT-302', 'ARCH-103', 'FE-801'],
  '#6 Modül 5: Test ve CI/CD': ['TEST-1006', 'TEST-1001', 'TEST-1004', 'OPS-1102', 'OPS-1103'],
  '#7 Modül 6: Personel İzin Takibi': ['HR-1801'],
  '#8 Modül 7: Muayene / Bakım / Lastik': ['FLEET-1408', 'FLEET-1407', 'FLEET-1409'],
  '#9 Modül 8: GİB e-İrsaliye': ['COMP-601', 'COMP-602', 'COMP-603', 'COMP-604', 'COMP-605'],
  '#10 Modül 9: Laboratuvar / Numune': ['INV-1507'],
  '#11 Modül 10: Envanter / Yedek Parça': ['INV-1506'],
  '#12 Modül 11: AI Aylık Rapor': ['REP-724', 'AI-502'],
};
for (const [old, keys] of Object.entries(legacy)) {
  L.push(`| ${old} | ${keys.map((k) => `${link(k)} \`${k}\``).join(', ')} |`);
}
L.push('');
L.push('---');
L.push('');
L.push('## 🏷️ Etiket Sistemi');
L.push('');
L.push('| Grup | Etiketler |');
L.push('|---|---|');
L.push('| Modül | `mod:arch` `mod:auth` `mod:iot` `mod:firmware` `mod:fuel` `mod:ai` `mod:compliance` `mod:reporting` `mod:frontend` `mod:resilience` `mod:test` `mod:devops` `mod:docs` `mod:fleet` `mod:inventory` `mod:notification` `mod:billing` `mod:hr` |');
L.push('| Katman | `layer:firmware` `layer:backend` `layer:frontend` `layer:database` `layer:infra` |');
L.push('| Öncelik | `P0-blocker` `P1-high` `P2-medium` `P3-low` |');
L.push('| Efor | `size:XS` `size:S` `size:M` `size:L` `size:XL` |');
L.push('| Tip | `type:feature` `type:bug` `type:chore` `type:spike` `type:design` `type:security` |');
L.push('| Ek | `epic` `blocked` |');
L.push('');
L.push('---');
L.push('');
L.push('## ❓ Açık Sorular');
L.push('');
L.push('Aşağıdaki başlıklar varsayımla ilerletildi; netleştiğinde ilgili issue’lar güncellenmelidir.');
L.push('');
L.push('| Konu | Varsayım | Etkilediği iş paketi |');
L.push('|---|---|---|');
L.push(`| Özel entegratör (Logo / Sovos / diğer) | Sağlayıcı adapter pattern ile soyutlandı; somut adaptör seçim sonrası yazılacak | \`COMP-602.1\` ${link('COMP-602.1')} |`);
L.push(`| Dağıtım hedefi (VPS / Cloud Run / K8s) | Docker Compose’lu tek VPS + ayrı staging | \`OPS-1104\` ${link('OPS-1104')} |`);
L.push(`| SMS sağlayıcısı | Adapter pattern; sağlayıcı sonradan bağlanacak | \`NOTIF-1603\` ${link('NOTIF-1603')} |`);
L.push(`| Gözlemlenebilirlik yığını | Prometheus + Grafana + Sentry | \`OPS-1107\` ${link('OPS-1107')} |`);
L.push(`| Geçici parolanın teslim kanalı | Panelde tek seferlik gösterim + ilk girişte zorunlu değişiklik | \`AUTH-204\` ${link('AUTH-204')} |`);
L.push(`| Offline kuyruk dolduğunda davranış | Yeni ikmal reddedilir (en eski kayıt silinmez) — mali kayıt kaybı kabul edilmez | \`FW-1309\` ${link('FW-1309')} |`);
L.push('');
L.push('---');
L.push('');
L.push(`_Son güncelleme: ${new Date().toISOString().slice(0, 10)} · Kaynak: \`scripts/roadmap/catalog/\` · Issue aralığı: #${Math.min(...Object.values(state))}–#${Math.max(...Object.values(state))}_`);

fs.writeFileSync(path.join(__dirname, '../../docs/ISSUES_ROADMAP.md'), L.join('\n') + '\n');
console.log(`✅ docs/ISSUES_ROADMAP.md üretildi (${L.length} satır, ${catalog.length} iş paketi).`);
