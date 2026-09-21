#!/usr/bin/env node
// ==============================================================================
// DOC-1207 (#189) — PDF çıktısı (ticket: "Markdown + PDF çıktı"): özet kart (tek sayfa, A4) ve el kitabı.
//   node scripts/build-operator-pdf.mjs        → docs/operator/pdf/OZET_KART.pdf, OPERATOR_EL_KITABI.pdf
// Ön koşul: ekran mesajlarının güncel olması (generate-operator-manual.mjs) ve Chrome/Chromium (CHROME_BIN veya PATH'te google-chrome/chromium).
// Markdown → HTML küçük yerleşik dönüştürücüyle (bu belgede kullanılan alt küme: başlık, liste, kalın/italik/kod, tablo, alıntı, bağlantı).
// ==============================================================================
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/operator/pdf');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/&lt;sub&gt;(.*?)&lt;\/sub&gt;/g, '<sub>$1</sub>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="lnk">$1</span>');
  return t;
}

export function mdToHtml(md) {
  const lines = md.replace(/<!--[\s\S]*?-->/g, (m) => (m.includes('\n') ? '' : '')).split('\n');
  const out = [];
  const stack = []; // açık liste girintileri
  const closeLists = (to = 0) => { while (stack.length > to) out.push(stack.pop() === 'ol' ? '</li></ol>' : '</li></ul>'); };
  let table = null;
  const flushTable = () => { if (table) { out.push(`<table>${table.join('')}</table>`); table = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\|.*\|$/.test(line)) {
      closeLists();
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      const cells = line.slice(1, -1).split('|').map((c) => c.trim());
      if (!table) { table = [`<tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`]; } else table.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      continue;
    }
    flushTable();
    let m;
    if ((m = /^(#{1,6}) (.*)$/.exec(line))) { closeLists(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^---+$/.test(line)) { closeLists(); out.push('<hr>'); continue; }
    if ((m = /^(\s*)([-*]|\d+\.) (.*)$/.exec(line))) {
      const depth = Math.floor(m[1].length / 2) + 1; const kind = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (stack.length < depth) { out.push(`<${kind}><li>`); stack.push(kind); }
      else { closeLists(depth); out.push('</li><li>'); }
      out.push(inline(m[3])); continue;
    }
    if (line.startsWith('> ')) { closeLists(); out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`); continue; }
    if (line === '') { closeLists(); continue; }
    closeLists(); out.push(`<p>${inline(line)}</p>`);
  }
  closeLists(); flushTable();
  return out.join('\n');
}

const CSS = `body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.35;color:#111;margin:0}
h1{font-size:20pt;border-bottom:3px solid #000;padding-bottom:3px}h2{font-size:15pt;background:#000;color:#fff;padding:3px 6px;margin-top:18px}h3{font-size:13pt;margin-top:14px}h4{font-size:12pt;margin:12px 0 4px;border-bottom:1px solid #999}
ul,ol{margin:4px 0 4px 0;padding-left:20px}li{margin:2px 0}blockquote{border-left:4px solid #555;margin:8px 0;padding:2px 10px;background:#f2f2f2}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #555;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eee}
code{font-family:"Courier New",monospace;background:#eee;padding:0 2px}hr{border:0;border-top:1px solid #aaa;margin:14px 0}.lnk{text-decoration:underline}sub{color:#555}
@page{size:A4;margin:14mm}h2,h3,h4{break-after:avoid}li{break-inside:avoid}`;

function findChrome() {
  for (const c of [process.env.CHROME_BIN, 'google-chrome', 'chromium', 'chromium-browser'].filter(Boolean)) if (spawnSync(c, ['--version']).status === 0) return c;
  throw new Error('Chrome/Chromium bulunamadı (CHROME_BIN ayarlayın).');
}

function printPdf(chrome, htmlFile, pdfFile) {
  const r = spawnSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdfFile}`, `file://${htmlFile}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`PDF üretilemedi (${htmlFile}): ${r.stderr}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chrome = findChrome();
  const tmp = mkdtempSync(path.join(tmpdir(), 'opdf-'));
  mkdirSync(OUT, { recursive: true });
  const card = path.join(ROOT, 'docs/operator/OZET_KART.html');
  printPdf(chrome, card, path.join(OUT, 'OZET_KART.pdf'));
  const manualHtml = path.join(tmp, 'manual.html');
  writeFileSync(manualHtml, `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>Operatör El Kitabı</title><style>${CSS}</style></head><body>${mdToHtml(readFileSync(path.join(ROOT, 'docs/OPERATOR_EL_KITABI.md'), 'utf8'))}</body></html>`);
  printPdf(chrome, manualHtml, path.join(OUT, 'OPERATOR_EL_KITABI.pdf'));
  rmSync(tmp, { recursive: true, force: true });
  console.log('[build-operator-pdf] docs/operator/pdf/OZET_KART.pdf + OPERATOR_EL_KITABI.pdf üretildi.');
}
