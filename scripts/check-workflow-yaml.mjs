#!/usr/bin/env node
// ==============================================================================
// TEST_PLAN.md §6 — GitHub Actions workflow dosyalarının GEÇERLİ YAML olduğunu
// doğrular.
//
// NEDEN bu kontrol var (gerçek bir olaydan doğdu):
//   `151881b` (2026-09-04, OPS-1105) commit'iyle ci-cd.yml'e şu satır girdi:
//       name: 🔑 OPS-1105: Gitleaks Secret Taraması
//   Tırnaksız bir YAML skalarında " OPS-1105: " içindeki iki nokta üst üste
//   bir mapping ayırıcısı olarak yorumlanır → dosyanın TAMAMI geçersiz YAML
//   olur → GitHub Actions "Invalid workflow file" der ve HİÇBİR job çalışmaz.
//   Sonuç: RLS kapsama kontrolü, 51 entegrasyon testi, gitleaks taraması,
//   Trivy imaj taraması — hepsi SESSİZCE devre dışı kalır. Hiçbir uyarı,
//   hiçbir kırmızı X görünmez; CI "yok" olur.
//
//   Bu, bir güvenlik kontrolünün başarısız olmasından DAHA TEHLİKELİDİR:
//   başarısız kontrol görünür, çalışmayan kontrol görünmez.
//
// TASARIM NOTU: Bu script'in CI İÇİNDE çalışması tek başına yeterli değildir
// (workflow bozuksa CI zaten çalışmaz — tavuk/yumurta). Asıl değeri
// commit ÖNCESİ yerel çalıştırmadadır; CI'da olması ise `pull_request`
// event'lerinde base branch'in workflow'u kullanıldığı durumları yakalar.
//
// BAĞIMLILIK: Kasıtlı olarak SIFIR npm bağımlılığı. Sistemde python3+PyYAML
// varsa TAM parse yapılır; yoksa bilinen hata sınıflarını yakalayan yapısal
// kontrollere düşülür (ikisi de aynı hatayı yakalar).
//
// Kullanım: node scripts/check-workflow-yaml.mjs
// ==============================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');

if (!existsSync(WORKFLOW_DIR)) {
  console.log('[check-workflow-yaml] .github/workflows yok — atlanıyor.');
  process.exit(0);
}

const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => path.join(WORKFLOW_DIR, f));

const violations = [];

/** python3 + PyYAML varsa tam bir YAML parse dener. Dönüş: 'ok' | 'fail' | 'unavailable' */
function tryPythonParse(file) {
  try {
    execFileSync(
      'python3',
      ['-c', 'import sys, yaml; yaml.safe_load(open(sys.argv[1], encoding="utf-8"))', file],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' }
    );
    return { status: 'ok' };
  } catch (err) {
    const stderr = (err.stderr || '').toString();
    // PyYAML kurulu değilse / python3 yoksa: bu bir workflow hatası DEĞİL.
    if (/ModuleNotFoundError|No module named|ENOENT|not found/i.test(stderr) || err.code === 'ENOENT') {
      return { status: 'unavailable' };
    }
    return { status: 'fail', detail: stderr.trim().split('\n').slice(-3).join(' ') };
  }
}

/**
 * Bağımlılıksız yapısal kontroller — python3/PyYAML olmadığında da çalışır.
 * Amaç tam bir YAML parser yazmak DEĞİL; gerçekte karşılaşılan, sessiz
 * başarısızlığa yol açan hata sınıflarını yakalamaktır.
 */
function structuralChecks(file, content) {
  const found = [];
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // 1) Tırnaksız bir değer içinde ": " — YAML bunu mapping ayırıcısı sayar.
    //    `key: değer: başka` biçimi geçersizdir (yukarıdaki OPS-1105 olayı).
    const kv = /^(\s*)(-\s+)?([A-Za-z_][\w-]*):\s+(.+)$/.exec(line);
    if (kv) {
      const value = kv[4].trim();
      const isQuoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      const isBlockScalar = value === '|' || value === '>' || /^[|>][-+]?\d*$/.test(value);
      const isComment = value.startsWith('#');
      if (!isQuoted && !isBlockScalar && !isComment && /:\s/.test(value)) {
        found.push({
          line: lineNo,
          rule: 'unquoted-colon-in-value',
          text: line.trim(),
          hint: `Değeri tırnak içine alın:  ${kv[3]}: "${value}"`
        });
      }
    }

    // 2) Girinti için sekme karakteri — YAML spec'inde kesinlikle yasak.
    if (/^\t| \t/.test(line)) {
      found.push({
        line: lineNo,
        rule: 'tab-indentation',
        text: line.replace(/\t/g, '\\t').trim(),
        hint: 'YAML girintilerinde sekme kullanılamaz; boşluk kullanın.'
      });
    }
  });

  // 3) Temel iskelet: bir workflow'da `on:` ve `jobs:` olmak zorunda.
  if (!/^on:/m.test(content) && !/^"on":/m.test(content)) {
    found.push({ line: 1, rule: 'missing-on', text: '(dosya geneli)', hint: "Workflow'da `on:` tetikleyicisi yok." });
  }
  if (!/^jobs:/m.test(content)) {
    found.push({ line: 1, rule: 'missing-jobs', text: '(dosya geneli)', hint: "Workflow'da `jobs:` bloğu yok." });
  }

  return found;
}

let pythonAvailable = false;

for (const file of workflowFiles) {
  const relative = path.relative(REPO_ROOT, file);
  const content = readFileSync(file, 'utf-8');

  const py = tryPythonParse(file);
  if (py.status === 'ok') {
    pythonAvailable = true;
  } else if (py.status === 'fail') {
    pythonAvailable = true;
    violations.push({ file: relative, line: '?', rule: 'yaml-parse-error', text: py.detail, hint: 'Dosya geçerli YAML değil — GitHub Actions bu workflow\'u ÇALIŞTIRMAZ.' });
  }

  for (const v of structuralChecks(file, content)) {
    violations.push({ file: relative, ...v });
  }
}

if (violations.length > 0) {
  console.error('[check-workflow-yaml] HATA: workflow dosyasında sorun bulundu:\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]`);
    console.error(`    ${v.text}`);
    console.error(`    → ${v.hint}\n`);
  }
  console.error(
    'UYARI: Geçersiz bir workflow dosyası "kırmızı CI" olarak DEĞİL, ' +
    'HİÇ ÇALIŞMAYAN CI olarak görünür — tüm test ve güvenlik kontrolleri ' +
    'sessizce devre dışı kalır.'
  );
  process.exit(1);
}

console.log(
  `[check-workflow-yaml] OK — ${workflowFiles.length} workflow dosyası geçerli ` +
  `(${pythonAvailable ? 'tam YAML parse + yapısal kontroller' : 'yapısal kontroller; python3/PyYAML bulunamadı'}).`
);
