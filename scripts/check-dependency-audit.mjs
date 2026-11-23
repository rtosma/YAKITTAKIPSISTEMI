#!/usr/bin/env node
// ==============================================================================
// TEST_PLAN.md §2.2 / §5 (OWASP A06 — Vulnerable and Outdated Components).
//
// NEDEN bu script, düz `npm audit` yerine:
//   - `npm audit --audit-level=high` ya HER ŞEYİ kırar (bugün düzeltmesi
//     OLMAYAN, fiilen istismar edilemez bulgular yüzünden CI sürekli kırmızı
//     kalır ve insanlar uyarıyı görmezden gelmeye alışır) ya da eşiği
//     gevşetince GERÇEK yeni bir HIGH bulguyu da sessizce yutar.
//   - Bu script bunun yerine GHSA (advisory) ID bazında çalışır: bilinen ve
//     GEREKÇELENDİRİLMİŞ bulgular allowlist'tedir; allowlist'te OLMAYAN her
//     yeni bulgu — severity'si ne olursa olsun — CI'ı kırar.
//   - Ayrıca allowlist'te olup ARTIK MEVCUT OLMAYAN girdileri de raporlar
//     (stale kayıt temizliği) — böylece allowlist zamanla şişip körleşmez.
//
// CI'daki docker-security-scan (Trivy) YALNIZCA imaj/OS paketlerini tarar,
// node_modules içindeki JS bağımlılıklarını DEĞİL — bu script o boşluğu kapatır.
//
// Kullanım: node scripts/check-dependency-audit.mjs
// ==============================================================================

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const WORKSPACES = ['backend', 'frontend'];

/**
 * Kabul edilmiş (bilinen, gerekçelendirilmiş) advisory'ler.
 *
 * KURAL: Buraya bir girdi eklemek "bu zafiyet önemsiz" demek DEĞİLDİR —
 * "bu zafiyetin bu kod tabanında tetiklenme yolunun KAPALI olduğu
 * gösterilmiştir VE bu kapalılık mekanik olarak korunmaktadır" demektir.
 * Her girdi `why` (neden istismar edilemez) ve `guard` (bunu ne koruyor)
 * alanlarını doldurmak ZORUNDADIR.
 */
const ACCEPTED = {
  'GHSA-4r6h-8v6p-xvw6': {
    package: 'xlsx',
    severity: 'high',
    why:
      'Prototype pollution YALNIZCA XLSX.read/readFile (parse) yolunda ' +
      'tetiklenir. Frontend xlsx\'i sadece YAZMA için kullanıyor ' +
      '(json_to_sheet/book_new/writeFile) ve uygulamada hiç dosya yükleme ' +
      'ucu (input[type=file] / FileReader) yok — yani saldırganın kontrol ' +
      'ettiği bir workbook hiçbir zaman parse edilmiyor.',
    guard: 'scripts/check-frontend-security.mjs → no-xlsx-parse kuralı',
    note:
      'SheetJS npm dağıtımı terk edilmiş durumda (upstream kendi CDN\'ine ' +
      'taşındı), bu yüzden "fixAvailable: false". Excel OKUMA ihtiyacı ' +
      'doğarsa bu kabul GEÇERSİZDİR — bağımlılık kararı yeniden verilmelidir.'
  },
  'GHSA-5pgg-2g8v-p4x9': {
    package: 'xlsx',
    severity: 'high',
    why: 'ReDoS — GHSA-4r6h-8v6p-xvw6 ile AYNI parse yolu; okuma yapılmıyor.',
    guard: 'scripts/check-frontend-security.mjs → no-xlsx-parse kuralı',
    note: 'Bkz. GHSA-4r6h-8v6p-xvw6 notu.'
  },
  'GHSA-w5hq-g745-h8pq': {
    package: 'uuid',
    severity: 'moderate',
    why:
      'Eksik buffer sınır kontrolü YALNIZCA v3/v5/v6 çağrılarına `buf` ' +
      'parametresi verildiğinde tetiklenir. uuid buraya exceljs üzerinden ' +
      'transitive geliyor; uygulama kodu uuid\'i doğrudan hiç çağırmıyor, ' +
      'ExcelJS de `buf` parametresiyle kullanmıyor.',
    guard:
      'Uygulama kodunda doğrudan uuid kullanımı yok (transitive-only); ' +
      'ExcelJS yalnızca sunucu tarafı .xlsx YAZMA için kullanılıyor ' +
      '(transactionExportService.ts).',
    note: 'exceljs yeni bir uuid sürümüne geçerse bu girdi stale olarak raporlanır.'
  },
  'GHSA-3g3m-2fjr-6pw4': {
    package: 'glob',
    severity: 'moderate',
    why:
      'AbortSignal ile iptal edilen bir glob taramasının zaman aşımından ' +
      'sonra dosya sistemini gezmeye devam etmesi. glob yalnızca transitive: ' +
      'swagger-jsdoc (index.ts\'teki SABİT route desenleri, AbortSignal yok), ' +
      'archiver-utils (kod archive.glob/archive.directory kullanmıyor, ' +
      'dosyalar tek tek eklenir) ve cacache (yalnızca node-gyp derleme anı). ' +
      'Uygulama kodu glob\'a ne desen ne de signal geçiriyor.',
    guard: 'Bu betikteki backendGlobUsage(): backend/src\'de glob/minimatch import\'u veya archive.glob/directory çağrısı bulunursa bu kabul düşer.',
    note: 'Düzeltme swagger-jsdoc/archiver/libxmljs2\'nin yeni glob\'a geçmesine bağlı (npm\'in önerdiği "fix" sürüm GERİ gidişi).'
  },
  'GHSA-g3hv-75wg-m249': {
    package: 'minimatch',
    severity: 'moderate',
    why:
      'Saldırganın kontrol ettiği bir glob DESENİYLE CPU tüketimi (DoS). ' +
      'minimatch yalnızca glob üzerinden transitive; desenler kodda sabit, ' +
      'istekten gelen hiçbir değer desene dönüşmüyor (bkz. GHSA-3g3m-2fjr-6pw4).',
    guard: 'Bu betikteki backendGlobUsage() — GHSA-3g3m-2fjr-6pw4 ile aynı koşul.',
    note: 'Bkz. GHSA-3g3m-2fjr-6pw4 notu.'
  }
};

// GHSA-3g3m-2fjr-6pw4 / GHSA-g3hv-75wg-m249 kabulünün mekanik koşulu:
// backend kaynağı glob/minimatch'i ya da archiver'ın glob tabanlı
// archive.glob()/archive.directory()'sini doğrudan çağırmamalı. Çağırırsa
// desen/sinyal artık kod tabanının kontrolünde olmayabilir → kabul geçersiz.
function backendGlobUsage() {
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) {
        const src = readFileSync(f, 'utf-8');
        if (/from ['"](glob|minimatch)['"]|require\(['"](glob|minimatch)['"]\)|\barchive\.(glob|directory)\(/.test(src)) hits.push(path.relative(REPO_ROOT, f));
      }
    }
  };
  walk(path.join(REPO_ROOT, 'backend', 'src'));
  return hits;
}
const globHits = backendGlobUsage();
if (globHits.length > 0) {
  console.error(`[check-dependency-audit] glob/minimatch kabulü GEÇERSİZ — doğrudan kullanım bulundu: ${globHits.join(', ')}`);
  delete ACCEPTED['GHSA-3g3m-2fjr-6pw4'];
  delete ACCEPTED['GHSA-g3hv-75wg-m249'];
}

function runAudit(workspace) {
  const cwd = path.join(REPO_ROOT, workspace);
  let stdout;
  try {
    stdout = execFileSync('npm', ['audit', '--json'], {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024
    });
  } catch (err) {
    // `npm audit` zafiyet bulduğunda sıfırdan farklı exit kodu döner —
    // bu bizim için HATA DEĞİL, beklenen durum: çıktıyı yine de parse ederiz.
    stdout = err.stdout;
    if (!stdout) {
      console.error(`[check-dependency-audit] '${workspace}' için npm audit çalıştırılamadı:`, err.message);
      process.exit(1);
    }
  }
  return JSON.parse(stdout);
}

/** npm audit çıktısındaki iç içe `via` yapısından benzersiz advisory'leri çıkarır. */
function collectAdvisories(auditJson, workspace) {
  const found = new Map();
  for (const vuln of Object.values(auditJson.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      if (typeof via === 'string') continue; // dolaylı zincir adı, advisory değil
      const ghsa = (via.url || '').split('/').pop();
      if (!ghsa) continue;
      if (!found.has(ghsa)) {
        found.set(ghsa, {
          ghsa,
          workspace,
          package: via.name || vuln.name,
          severity: via.severity,
          title: via.title,
          url: via.url
        });
      }
    }
  }
  return found;
}

const allFound = new Map();
for (const ws of WORKSPACES) {
  const audit = runAudit(ws);
  for (const [ghsa, info] of collectAdvisories(audit, ws)) {
    if (!allFound.has(ghsa)) allFound.set(ghsa, info);
  }
}

const unexpected = [...allFound.values()].filter((a) => !ACCEPTED[a.ghsa]);
const stale = Object.keys(ACCEPTED).filter((ghsa) => !allFound.has(ghsa));

if (unexpected.length > 0) {
  console.error('[check-dependency-audit] HATA: allowlist\'te OLMAYAN yeni bağımlılık zafiyeti bulundu:\n');
  for (const a of unexpected) {
    console.error(`  [${a.severity.toUpperCase()}] ${a.package} (${a.workspace})`);
    console.error(`    ${a.title}`);
    console.error(`    ${a.url}\n`);
  }
  console.error(
    'Yapılacaklar:\n' +
    '  1) Mümkünse paketi güncelleyin (npm audit fix / sürüm yükseltmesi).\n' +
    '  2) Düzeltme yoksa: zafiyetin tetiklenme yolunun bu kod tabanında KAPALI\n' +
    '     olduğunu GÖSTERİN, bunu koruyan mekanik bir kontrol ekleyin\n' +
    '     (bkz. scripts/check-frontend-security.mjs) ve ancak ondan sonra\n' +
    '     scripts/check-dependency-audit.mjs içindeki ACCEPTED listesine\n' +
    '     why + guard alanlarını doldurarak ekleyin.'
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.log('[check-dependency-audit] Bilgi: artık mevcut olmayan allowlist girdileri (temizlenebilir):');
  for (const ghsa of stale) {
    console.log(`  - ${ghsa} (${ACCEPTED[ghsa].package})`);
  }
}

console.log(
  `[check-dependency-audit] OK — ${allFound.size} bilinen advisory'nin hepsi ` +
  `gerekçelendirilmiş allowlist'te (${WORKSPACES.join(', ')}).`
);
