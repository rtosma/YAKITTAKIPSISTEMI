#!/usr/bin/env node
// ==============================================================================
// DOC-1207 (#189) — cihaz ekran mesajı kataloğundan (docs/operator/device-messages.json) el kitabı bölümünü ve özet kartı ÜRETİR.
//   node scripts/generate-operator-manual.mjs          dosyaları günceller
//   node scripts/generate-operator-manual.mjs --check  güncel değilse çıkış 1 (CI / test)
// Amaç (AC: "El kitabı cihaz ekran mesajlarıyla birebir uyumlu"): mesaj metni ELLE kopyalanmaz; kataloğu değiştirmeden el kitabı değişemez.
// ==============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'docs/operator/device-messages.json');
const MANUAL = path.join(ROOT, 'docs/OPERATOR_EL_KITABI.md');
const CARD = path.join(ROOT, 'docs/operator/OZET_KART.html');
const CHECK = process.argv.includes('--check');

export const MARK = { md: ['<!-- MESAJLAR:BAŞLA (scripts/generate-operator-manual.mjs üretir — ELLE DEĞİŞTİRMEYİN) -->', '<!-- MESAJLAR:BİTİŞ -->'], card: ['<!-- KART-MESAJLAR:BAŞLA -->', '<!-- KART-MESAJLAR:BİTİŞ -->'] };
export const CARD_IDS = ['CARD_UNKNOWN', 'RFID_CARD_BLOCKED', 'QUOTA_EXHAUSTED', 'VEHICLE_FUEL_LIMIT_EXCEEDED', 'FUEL_TYPE_MISMATCH', 'OFFLINE', 'FLOW_FAULT', 'SERVER_BUSY'];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const GROUP_TITLES = {
  BEKLEME: 'Bekleme', KART_OKUNDU: 'Kart okundu', YETKI_BEKLENIYOR: 'Yetki bekleniyor', YETKI_VERILDI: 'Yetki verildi', AKIS: 'İkmal sürüyor', TAMAMLANDI: 'İkmal bitti', HATA: 'Hata / ret', CEVRIMDISI: 'Çevrimdışı'
};

export function screenText(m) { return m.lines.join(' / '); }

export function renderManualSection(cat) {
  const out = [];
  const bz = cat.buzzer;
  out.push(`Ekran ${cat.display.cols} harf × ${cat.display.rows} satırdır. Aşağıda **ekranda gördüğünüz yazı** kalın yazılmıştır; satırlar \`/\` ile ayrılır. \`{plaka}\`, \`{litre}\`, \`{debi}\` yerine gerçek değer gelir.`);
  out.push('');
  out.push('**Ses (buzzer):** ' + Object.entries(bz).filter(([k]) => k !== 'YOK').map(([k, v]) => `**${k}** = ${v.desc}`).join(' · '));
  for (const screen of cat.screens) {
    const group = cat.messages.filter((m) => m.screen === screen);
    if (group.length === 0) continue;
    out.push('', `#### ${GROUP_TITLES[screen]}`, '');
    for (const m of group) {
      out.push(`- **${screenText(m)}** — ses: ${m.buzzer === 'YOK' ? 'yok' : `${m.buzzer} (${bz[m.buzzer].desc})`}`);
      out.push(`  - Anlamı: ${m.meaning}`);
      out.push(`  - **Ne yapmalı:** ${m.action}`);
      out.push(`  - <sub>Kod: ${(m.source.codes ?? [m.source.code]).map((c) => `\`${c}\``).join(', ')}</sub>`);
    }
  }
  return out.join('\n');
}

export function renderCardMessages(cat) {
  const rows = CARD_IDS.map((id) => {
    const m = cat.messages.find((x) => x.id === id);
    return `<tr><td class="scr">${m.lines.map(esc).join('<br>')}</td><td>${esc(m.action)}</td></tr>`;
  });
  return rows.join('\n');
}

function splice(text, [start, end], body) {
  const a = text.indexOf(start); const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a) throw new Error(`İşaretçi bulunamadı: ${start}`);
  return `${text.slice(0, a + start.length)}\n${body}\n${text.slice(b)}`;
}

export function build() {
  const cat = JSON.parse(readFileSync(CATALOG, 'utf8'));
  return {
    manual: splice(readFileSync(MANUAL, 'utf8'), MARK.md, renderManualSection(cat)),
    card: splice(readFileSync(CARD, 'utf8'), MARK.card, renderCardMessages(cat))
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { manual, card } = build();
  const stale = readFileSync(MANUAL, 'utf8') !== manual || readFileSync(CARD, 'utf8') !== card;
  if (CHECK) {
    if (stale) { console.error('[generate-operator-manual] HATA: el kitabı/özet kart mesaj kataloğuyla uyumsuz — `node scripts/generate-operator-manual.mjs` çalıştırın.'); process.exit(1); }
    console.log('[generate-operator-manual] OK — el kitabı ve özet kart mesaj kataloğuyla birebir uyumlu.');
  } else {
    writeFileSync(MANUAL, manual); writeFileSync(CARD, card);
    console.log(`[generate-operator-manual] ${stale ? 'güncellendi' : 'zaten güncel'}: docs/OPERATOR_EL_KITABI.md, docs/operator/OZET_KART.html`);
  }
}
