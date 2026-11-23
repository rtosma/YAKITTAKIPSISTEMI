#!/usr/bin/env node
// OPS-1106 — yedek/geri yükleme betiklerinin küçük JSON/SQL yardımcıları (bash'te JSON ayrıştırmamak için).
//   backupTools.mjs stats-json            stdin: "tbl|n|hash" satırları → stdout: {"tbl":{"n":..,"h":..}}
//   backupTools.mjs compare <manifest.json> <restored.json> exact|atleast   → uyuşmazlıkları yazar, exit 0/1
//   backupTools.mjs index-field <index.json> <alan>
//   backupTools.mjs pick-base <baseDir> latest|<TS> [<hedefZaman ISO>]   → seçilen yedek klasörü adı
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const [cmd, ...a] = process.argv.slice(2);

if (cmd === 'stats-json') {
  const out = {};
  for (const line of readFileSync(0, 'utf8').split('\n')) {
    if (!line.trim() || !line.includes('|')) continue;
    const [tbl, n, h] = line.split('|');
    out[tbl] = { n: Number(n), h: h || null };
  }
  process.stdout.write(JSON.stringify(out));
} else if (cmd === 'compare') {
  const expected = JSON.parse(readFileSync(a[0], 'utf8'));
  const actual = JSON.parse(readFileSync(a[1], 'utf8'));
  const mode = a[2] || 'exact';
  const problems = [];
  for (const [t, e] of Object.entries(expected)) {
    const r = actual[t];
    if (!r) { problems.push(`${t}: geri yüklenen veritabanında YOK`); continue; }
    if (mode === 'exact') {
      if (r.n !== e.n) problems.push(`${t}: satır sayısı ${r.n} ≠ beklenen ${e.n}`);
      else if (e.h && r.h !== e.h) problems.push(`${t}: içerik özeti (id md5) uyuşmuyor`);
    } else if (r.n < e.n) {
      // Yedekten SONRA yazılan kayıtlar (WAL ile) sayıyı artırabilir; azalmış olması veri kaybıdır.
      problems.push(`${t}: satır sayısı ${r.n} < yedek anındaki ${e.n} (veri kaybı)`);
    }
  }
  for (const t of Object.keys(actual)) if (!expected[t] && mode === 'exact') problems.push(`${t}: yedekte olmayan fazladan tablo`);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`${Object.keys(expected).length} tablo doğrulandı (${mode}).`);
} else if (cmd === 'index-field') {
  const idx = JSON.parse(readFileSync(a[0], 'utf8'));
  process.stdout.write(String(idx[a[1]] ?? ''));
} else if (cmd === 'pick-base') {
  const [dir, want, target] = a;
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => /^\d{8}T\d{6}Z$/.test(n) && existsSync(path.join(dir, n, 'index.json'))).sort() : [];
  if (names.length === 0) { console.error('Tamamlanmış yedek bulunamadı.'); process.exit(1); }
  let pick;
  if (want !== 'latest') pick = names.includes(want) ? want : null;
  else if (target) {
    // Hedef zamandan ÖNCE tamamlanmış en yeni taban yedek (PITR yalnızca hedefin ÖNCESİNDEKİ tabandan başlayabilir).
    const t = Date.parse(target);
    const ok = names.filter((n) => Date.parse(JSON.parse(readFileSync(path.join(dir, n, 'index.json'), 'utf8')).finishedAt) <= t);
    pick = ok.length ? ok[ok.length - 1] : null;
    if (!pick) { console.error(`Hedef zamandan (${target}) önce tamamlanmış taban yedek yok — PITR mümkün değil.`); process.exit(1); }
  } else pick = names[names.length - 1];
  if (!pick) { console.error(`Yedek bulunamadı: ${want}`); process.exit(1); }
  process.stdout.write(pick);
} else {
  console.error('Bilinmeyen komut');
  process.exit(2);
}
