#!/usr/bin/env node
// ==============================================================================
// OPS-1104 — Sürüm etiketleme ve değişiklik günlüğü.
//
// Depo Conventional Commits kullanıyor (feat(REP-719): ..., fix(...): ...). Bu script
// iki sürüm arasındaki commit'lerden (a) bir sonraki semver'i ve (b) gruplanmış bir
// değişiklik günlüğü (markdown) üretir. Etiketi atmak İNSAN kararıdır (git tag vX.Y.Z →
// üretim dağıtımını tetikler); script yalnızca doğru sürümü ÖNERİR ve notu üretir.
//
// Semver kuralı (sürüm 0.x için de aynı): BREAKING (`type!:` veya "BREAKING CHANGE:" gövdesi) → major,
// en az bir feat → minor, aksi halde (fix/perf/refactor/...) → patch. Hiç önceki etiket yoksa
// taban v0.0.0 sayılır ve tüm geçmiş taranır.
//
// Kullanım:
//   node scripts/generate-changelog.mjs --next-version           # yalnızca önerilen sürümü yazar (örn. v1.4.0)
//   node scripts/generate-changelog.mjs [--from <ref>] [--to <ref>] [--version vX.Y.Z] [--out CHANGELOG.md] [--prepend]
//   --from varsayılan: en son v*.*.* etiketi; --to varsayılan: HEAD; --repo <dizin> (testler için)
// ==============================================================================

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : undefined; };
const flag = (n) => process.argv.includes(n);
const REPO = arg('--repo') || ROOT;

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const SECTIONS = [
  ['breaking', '⚠️ Geriye uyumsuz değişiklikler'],
  ['feat', 'Yeni özellikler'],
  ['fix', 'Düzeltmeler'],
  ['perf', 'Performans'],
  ['refactor', 'Yeniden düzenleme'],
  ['security', 'Güvenlik'],
  ['docs', 'Dokümantasyon'],
  ['test', 'Testler'],
  ['ci', 'CI/CD'],
  ['chore', 'Bakım'],
  ['other', 'Diğer']
];

export function parseCommit(subject, body) {
  const m = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
  const type = m ? m[1].toLowerCase() : 'other';
  const breaking = !!(m && m[3]) || /(^|\n)BREAKING[ -]CHANGE:/.test(body || '');
  return { type: SECTIONS.some(([k]) => k === type) ? type : 'other', scope: m?.[2] || '', breaking, text: m ? m[4] : subject };
}

export function bumpVersion(prev, commits) {
  const [maj, min, pat] = prev.replace(/^v/, '').split('.').map(Number);
  if (commits.some((c) => c.breaking)) return `v${maj + 1}.0.0`;
  if (commits.some((c) => c.type === 'feat')) return `v${maj}.${min + 1}.0`;
  return `v${maj}.${min}.${pat + 1}`;
}

function latestTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function readCommits(from, to) {
  const range = from ? `${from}..${to}` : to;
  const raw = execFileSync('git', ['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', range], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, subject, body] = r.split('\x1f');
    return { hash, short: hash.slice(0, 7), subject, ...parseCommit(subject, body) };
  });
}

export function renderChangelog(version, date, commits, fromLabel) {
  const lines = [`## ${version} — ${date}`, ''];
  if (fromLabel) lines.push(`_${fromLabel} sürümünden bu yana ${commits.length} değişiklik._`, '');
  for (const [key, title] of SECTIONS) {
    const items = key === 'breaking' ? commits.filter((c) => c.breaking) : commits.filter((c) => c.type === key && !c.breaking);
    if (items.length === 0) continue;
    lines.push(`### ${title}`, '');
    for (const c of items) lines.push(`- ${c.scope ? `**${c.scope}:** ` : ''}${c.text} (\`${c.short}\`)`);
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const from = arg('--from') ?? latestTag();
  const to = arg('--to') || 'HEAD';
  const commits = readCommits(from, to);
  const next = arg('--version') || bumpVersion(from || 'v0.0.0', commits);
  if (flag('--next-version')) {
    console.log(next);
    process.exit(0);
  }
  if (commits.length === 0) {
    console.error(`[changelog] ${from ?? 'başlangıç'}..${to} arasında commit yok — değişiklik günlüğü üretilmedi.`);
    process.exit(1);
  }
  const date = new Date().toISOString().slice(0, 10);
  const md = renderChangelog(next, date, commits, from);
  const out = arg('--out');
  if (!out) {
    process.stdout.write(md + '\n');
  } else if (flag('--prepend') && existsSync(out)) {
    const existing = readFileSync(out, 'utf8').replace(/^# Değişiklik Günlüğü\s*\n+/, '');
    writeFileSync(out, `# Değişiklik Günlüğü\n\n${md}\n${existing}`);
  } else {
    writeFileSync(out, `# Değişiklik Günlüğü\n\n${md}\n`);
  }
}
