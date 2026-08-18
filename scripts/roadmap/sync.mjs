#!/usr/bin/env node
/**
 * Roadmap senkronizasyon motoru.
 *
 * Sırayla:
 *   1. Label'ları oluşturur/günceller
 *   2. Milestone'ları (fazları) oluşturur
 *   3. Katalogdaki issue'ları oluşturur (epic'ler önce, sonra alt işler)
 *   4. Numara eşlemesini scripts/roadmap/created.json dosyasına yazar
 *   5. Tahmin edilen numara ile gerçek numara uyuşmazsa etkilenen gövdeleri düzeltir
 *
 * Kullanım:
 *   node scripts/roadmap/sync.mjs --dry-run     # hiçbir şey yazmaz, doğrular
 *   node scripts/roadmap/sync.mjs --labels      # sadece label + milestone
 *   node scripts/roadmap/sync.mjs --issues      # sadece issue'lar
 *   node scripts/roadmap/sync.mjs --all
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS, PHASES, PHASE_DESC, REPO, renderBody, issueTitle, issueLabels } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'created.json');
const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const DO_LABELS = args.includes('--labels') || args.includes('--all');
const DO_ISSUES = args.includes('--issues') || args.includes('--all');
const THROTTLE_MS = Number(process.env.THROTTLE_MS || 900);

if (!TOKEN && !DRY) {
  console.error('GH_TOKEN / GITHUB_TOKEN yok.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Not: Node'un yerleşik fetch'i bu ortamdaki HTTPS proxy'yi kullanmadığı için
// (proxy kimlik bilgisi enjekte ediyor) istekler curl üzerinden yapılır.
async function gh(method, endpoint, body, { retries = 4 } = {}) {
  if (DRY) return { __dry: true };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const args = [
      '-sS', '-X', method,
      '-w', '\n%{http_code}',
      '-H', `Authorization: Bearer ${TOKEN}`,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28',
      '-H', 'Content-Type: application/json',
      '-H', 'User-Agent: yakit-roadmap-sync',
    ];
    let tmp;
    if (body) {
      tmp = path.join(os.tmpdir(), `gh-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      fs.writeFileSync(tmp, JSON.stringify(body));
      args.push('--data-binary', `@${tmp}`);
    }
    args.push(`${API}${endpoint}`);

    const out = await new Promise((resolve, reject) => {
      execFile('curl', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout) reject(new Error(`curl: ${stderr || err.message}`));
        else resolve(stdout);
      });
    });
    if (tmp) fs.unlinkSync(tmp);

    const idx = out.lastIndexOf('\n');
    const status = Number(out.slice(idx + 1).trim());
    const payload = out.slice(0, idx);

    if (status === 403 || status === 429) {
      console.warn('  ⏳ Rate limit; 60sn bekleniyor...');
      await sleep(60000);
      continue;
    }
    if (status < 200 || status >= 300) {
      if (attempt === retries) throw new Error(`${method} ${endpoint} → ${status}: ${payload.slice(0, 400)}`);
      const backoff = 2000 * 2 ** attempt;
      console.warn(`  ↻ ${status}, ${backoff / 1000}sn sonra tekrar (${attempt + 1}/${retries})`);
      await sleep(backoff);
      continue;
    }
    if (!payload.trim()) return {};
    try { return JSON.parse(payload); } catch { return {}; }
  }
}

async function loadCatalog() {
  const dir = path.join(__dirname, 'catalog');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const all = [];
  for (const f of files) {
    const mod = await import(path.join(dir, f));
    all.push(...mod.default);
  }
  return all;
}

function validate(catalog) {
  const seen = new Set();
  const keys = new Set(catalog.map((i) => i.key));
  const errors = [];
  for (const i of catalog) {
    if (seen.has(i.key)) errors.push(`Mükerrer kod: ${i.key}`);
    seen.add(i.key);
    for (const field of ['title', 'module', 'layer', 'priority', 'size', 'type', 'phase', 'amac', 'stack', 'notlar', 'test']) {
      if (!i[field]) errors.push(`${i.key}: '${field}' alanı eksik`);
    }
    if (!Array.isArray(i.kapsam) || i.kapsam.length < 2) errors.push(`${i.key}: kapsam en az 2 madde olmalı`);
    if (!Array.isArray(i.ac) || i.ac.length < 2) errors.push(`${i.key}: kabul kriteri en az 2 madde olmalı`);
    for (const dep of [...(i.blockedBy || []), ...(i.blocks || []), ...(i.epicOf || []), ...(i.epic ? [i.epic] : [])]) {
      if (!keys.has(dep)) errors.push(`${i.key}: bilinmeyen referans '${dep}'`);
    }
    if (!PHASES[i.phase]) errors.push(`${i.key}: geçersiz faz ${i.phase}`);
  }
  return errors;
}

async function syncLabels() {
  console.log(`\n🏷️  ${LABELS.length} label işleniyor...`);
  for (const label of LABELS) {
    try {
      await gh('POST', `/repos/${REPO}/labels`, label);
      console.log(`  + ${label.name}`);
    } catch (e) {
      if (String(e).includes('already_exists') || String(e).includes('→ 422')) {
        await gh('PATCH', `/repos/${REPO}/labels/${encodeURIComponent(label.name)}`, {
          new_name: label.name, color: label.color, description: label.description,
        });
        console.log(`  ~ ${label.name} (güncellendi)`);
      } else throw e;
    }
    await sleep(250);
  }
}

async function syncMilestones() {
  console.log(`\n🎯 Milestone'lar işleniyor...`);
  const existing = DRY ? [] : await gh('GET', `/repos/${REPO}/milestones?state=all&per_page=100`);
  const map = {};
  for (const [phase, { title }] of Object.entries(PHASES)) {
    const found = (existing || []).find((m) => m.title === title);
    if (found) {
      map[phase] = found.number;
      console.log(`  = ${title} (#${found.number})`);
    } else {
      const created = await gh('POST', `/repos/${REPO}/milestones`, { title, description: PHASE_DESC[phase] });
      map[phase] = created.number || Number(phase);
      console.log(`  + ${title} (#${map[phase]})`);
    }
    await sleep(250);
  }
  return map;
}

async function nextIssueNumber() {
  const res = await gh('GET', `/repos/${REPO}/issues?state=all&per_page=1&sort=created&direction=desc`);
  const issues = Array.isArray(res) ? res : [];
  const pulls = await gh('GET', `/repos/${REPO}/pulls?state=all&per_page=1&sort=created&direction=desc`);
  const maxIssue = issues[0]?.number || 0;
  const maxPull = (Array.isArray(pulls) ? pulls : [])[0]?.number || 0;
  return Math.max(maxIssue, maxPull) + 1;
}

async function syncIssues(catalog, milestones) {
  // Oluşturma sırası: faz → epic'ler önce → modül → kod
  const order = [...catalog].sort((a, b) => {
    if (a.phase !== b.phase) return a.phase - b.phase;
    const ae = a.epicOf ? 0 : 1, be = b.epicOf ? 0 : 1;
    if (ae !== be) return ae - be;
    if (a.module !== b.module) return a.module.localeCompare(b.module);
    return a.key.localeCompare(b.key, 'tr', { numeric: true });
  });

  const start = DRY ? 999 : await nextIssueNumber();
  console.log(`\n📌 İlk issue numarası tahmini: #${start}`);

  // Tahmini numaralar → referans eşlemesi
  const refs = {};
  order.forEach((issue, idx) => { refs[issue.key] = `#${start + idx}`; });

  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const mismatched = [];

  console.log(`\n📝 ${order.length} issue oluşturuluyor...`);
  for (let idx = 0; idx < order.length; idx++) {
    const issue = order[idx];
    if (state[issue.key]) { console.log(`  = ${issue.key} zaten #${state[issue.key]}`); continue; }

    const payload = {
      title: issueTitle(issue),
      body: renderBody(issue, refs),
      labels: issueLabels(issue),
      milestone: milestones[issue.phase],
    };
    const created = await gh('POST', `/repos/${REPO}/issues`, payload);
    const number = DRY ? start + idx : created.number;
    state[issue.key] = number;
    const predicted = start + idx;
    if (number !== predicted) {
      mismatched.push({ key: issue.key, predicted, actual: number });
      refs[issue.key] = `#${number}`;
    }
    console.log(`  [${idx + 1}/${order.length}] #${number} ${issue.key} — ${issue.title.slice(0, 60)}`);
    if (!DRY) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    await sleep(THROTTLE_MS);
  }

  // Tahmin sapması varsa etkilenen gövdeleri düzelt
  if (mismatched.length) {
    const badKeys = new Set(mismatched.map((m) => m.key));
    console.log(`\n🔧 ${mismatched.length} numara sapması; etkilenen gövdeler düzeltiliyor...`);
    for (const issue of order) {
      const touches = [...(issue.blockedBy || []), ...(issue.blocks || []), ...(issue.epicOf || []), ...(issue.epic ? [issue.epic] : [])];
      if (!touches.some((k) => badKeys.has(k))) continue;
      await gh('PATCH', `/repos/${REPO}/issues/${state[issue.key]}`, { body: renderBody(issue, refs) });
      console.log(`  ~ #${state[issue.key]} ${issue.key}`);
      await sleep(THROTTLE_MS);
    }
  }

  return state;
}

async function main() {
  const catalog = await loadCatalog();
  const errors = validate(catalog);
  if (errors.length) {
    console.error(`\n❌ Katalog doğrulama hatası (${errors.length}):`);
    errors.slice(0, 40).forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  console.log(`✅ Katalog doğrulandı: ${catalog.length} issue, ${catalog.filter((i) => i.epicOf).length} epic`);

  const byModule = {};
  const byPhase = {};
  for (const i of catalog) {
    byModule[i.module] = (byModule[i.module] || 0) + 1;
    byPhase[i.phase] = (byPhase[i.phase] || 0) + 1;
  }
  console.log('   Modül:', JSON.stringify(byModule));
  console.log('   Faz  :', JSON.stringify(byPhase));

  if (DRY && !DO_LABELS && !DO_ISSUES) return;
  if (DO_LABELS) { await syncLabels(); }
  const milestones = DO_LABELS || DO_ISSUES ? await syncMilestones() : {};
  if (DO_ISSUES) { await syncIssues(catalog, milestones); }
  console.log('\n🏁 Tamamlandı.');
}

main().catch((e) => { console.error(e); process.exit(1); });
