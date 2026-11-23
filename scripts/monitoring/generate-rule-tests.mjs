#!/usr/bin/env node
// ==============================================================================
// OPS-1108 — promtool unit test dosyasını ÜRETİR: deploy/monitoring/tests/alerts.test.yml
// Kaynaklar: deploy/monitoring/rules/*.yml (kurallar + açıklama şablonları) + alert-scenarios.mjs (senaryolar).
// promtool `exp_annotations`'ı KATI karşılaştırır → açıklama şablonları (`{{ $value | printf "%.2f" }}`, `{{ $labels.x }}`) burada
// beklenen değerle doldurulur; böylece test yalnızca "ateşledi mi" değil "doğru şiddet/etiket/açıklamayla ateşledi mi"yi de doğrular.
// Kullanım: node scripts/monitoring/generate-rule-tests.mjs [--check]   (--check: commit'li dosya üretimden farklıysa exit 1)
// ==============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SCENARIOS } from './alert-scenarios.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RULES_DIR = path.join(ROOT, 'deploy/monitoring/rules');
const OUT = path.join(ROOT, 'deploy/monitoring/tests/alerts.test.yml');

export function loadRules() {
  const rules = [];
  for (const f of readdirSync(RULES_DIR).filter((n) => n.endsWith('.yml')).sort()) {
    const doc = JSON.parse(execFileSync('python3', ['-c', 'import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path.join(RULES_DIR, f)], { encoding: 'utf8' }));
    for (const g of doc.groups) for (const r of g.rules) rules.push({ ...r, file: f, group: g.name });
  }
  return rules;
}

const fmt = (spec, v) => {
  const m = /^%\.(\d+)f$/.exec(spec);
  if (!m) throw new Error(`desteklenmeyen printf biçimi: ${spec}`);
  return Number(v).toFixed(Number(m[1]));
};
export function renderTemplate(tpl, value, labels) {
  return tpl
    .replace(/\{\{\s*\$value\s*\|\s*printf\s+"(%[^"]+)"\s*\}\}/g, (_m, spec) => fmt(spec, value))
    .replace(/\{\{\s*\$labels\.(\w+)\s*\}\}/g, (_m, k) => labels[k] ?? '');
}

// Minimal YAML üreticisi (nesne/dizi/skaler; skalerler JSON biçimli → geçerli YAML).
function toYaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x !== null ? `${pad}-${toYaml(x, indent + 2).replace(/^\s+/, ' ')}` : `${pad}- ${JSON.stringify(x)}`)).join('\n') + '\n';
  if (typeof v === 'object' && v !== null) {
    return Object.entries(v).map(([k, x]) => (typeof x === 'object' && x !== null && (Array.isArray(x) ? x.length : Object.keys(x).length)
      ? `${pad}${k}:\n${toYaml(x, indent + 2).replace(/\n$/, '')}` : `${pad}${k}: ${typeof x === 'object' ? (Array.isArray(x) ? '[]' : '{}') : JSON.stringify(x)}`)).join('\n') + '\n';
  }
  return `${pad}${JSON.stringify(v)}\n`;
}

const forMinutes = (r) => (r.for ? Number(/^(\d+)m$/.exec(r.for)?.[1] ?? 0) : 0);

export function buildTests() {
  const rules = loadRules();
  const byName = new Map();
  for (const r of rules) byName.set(r.alert, [...(byName.get(r.alert) || []), r]);
  const tests = [];
  for (const sc of SCENARIOS) {
    const rs = byName.get(sc.alert);
    if (!rs) throw new Error(`senaryo var ama kural yok: ${sc.alert}`);
    for (const cs of sc.cases) {
      const build = (evalMinutes, expect) => ({
        interval: '1m',
        input_series: cs.series.map(([series, values]) => ({ series, values })),
        alert_rule_test: [{
          eval_time: `${evalMinutes}m`, alertname: sc.alert,
          exp_alerts: expect.map((e) => {
            const rule = rs.find((r) => r.labels.severity === e.severity);
            if (!rule) throw new Error(`${sc.alert}: severity=${e.severity} kuralı yok`);
            const labels = { severity: e.severity, domain: rule.labels.domain, ...(e.labels || {}) };
            const ann = {};
            for (const [k, t] of Object.entries(rule.annotations)) ann[k] = renderTemplate(t, e.value, labels);
            return { exp_labels: labels, exp_annotations: ann };
          })
        }]
      });
      tests.push({ _name: `${sc.alert}: ${cs.name}`, ...build(cs.evalMinutes, cs.expect) });
      // Anlık (gauge) kurallarda ifade t=0'dan doğru → `for` dolmadan (for-1 dk) ATEŞLEMEMELİ (pending ≠ firing).
      if (cs.gauge && cs.expect.length) tests.push({ _name: `${sc.alert}: ${cs.name} — for dolmadan (${cs.gauge - 1} dk) ateşlemez`, ...build(cs.gauge - 1, []) });
    }
  }
  return tests;
}

export function render() {
  const tests = buildTests().map(({ _name, ...t }) => ({ ...t, name: _name }));
  const doc = { rule_files: ['../rules/api.yml', '../rules/infra.yml', '../rules/field.yml', '../rules/meta.yml'], evaluation_interval: '1m', tests };
  return `# OPS-1108 — ÜRETİLDİ (scripts/monitoring/generate-rule-tests.mjs; kaynak: rules/*.yml + alert-scenarios.mjs). ELLE DÜZENLEMEYİN.\n# Çalıştırma: promtool test rules deploy/monitoring/tests/alerts.test.yml\n${toYaml(doc)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const text = render();
  if (process.argv.includes('--check')) {
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== text) { console.error('[rule-tests] commit\'li alerts.test.yml üretimden FARKLI — node scripts/monitoring/generate-rule-tests.mjs çalıştırıp commit\'leyin.'); process.exit(1); }
    process.exit(0);
  }
  writeFileSync(OUT, text);
  console.log(`[rule-tests] ${OUT} yazıldı (${buildTests().length} test).`);
}
