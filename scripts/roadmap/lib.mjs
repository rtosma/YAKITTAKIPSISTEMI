// Ortak tanımlar: label seti, milestone (faz) seti ve issue gövdesi şablonu.
// Bu dosya scripts/roadmap/sync.mjs tarafından kullanılır.

export const REPO = process.env.REPO || 'rtosma/YAKITTAKIPSISTEMI';

export const PRIORITY_LABEL = {
  P0: 'P0-blocker',
  P1: 'P1-high',
  P2: 'P2-medium',
  P3: 'P3-low',
};

export const PRIORITY_TEXT = {
  P0: 'P0-Blocker',
  P1: 'P1-High',
  P2: 'P2-Medium',
  P3: 'P3-Low',
};

export const PHASES = {
  1: { title: 'FAZ 1 — Çekirdek Altyapı & Güvenlik (Hafta 1-3)', text: 'FAZ 1' },
  2: { title: 'FAZ 2 — IoT Haberleşme & Akaryakıt Otomasyonu (Hafta 4-6)', text: 'FAZ 2' },
  3: { title: 'FAZ 3 — Anomali, Mevzuat & Raporlama (Hafta 7-9)', text: 'FAZ 3' },
  4: { title: 'FAZ 4 — Test, Stres Testi & Canlıya Çıkış (Hafta 10-12)', text: 'FAZ 4' },
  5: { title: 'FAZ 5 — Kapsam Genişletme (Backlog)', text: 'FAZ 5' },
};

export const PHASE_DESC = {
  1: 'Multi-tenancy, kimlik doğrulama, güvenlik ve CI/CD temelinin kurulduğu faz.',
  2: 'MQTT/LoRaWAN haberleşmesi, ESP32 firmware ve ikmal otomasyonunun devreye alındığı faz.',
  3: 'Anomali tespiti, GİB e-İrsaliye, raporlama ve bildirim katmanının tamamlandığı faz.',
  4: 'Test otomasyonu, yük testi, izleme ve canlıya çıkış hazırlıkları.',
  5: 'Çekirdek ürün canlıya çıktıktan sonra ele alınacak kapsam genişletme kalemleri.',
};

export const LABELS = [
  // Modül etiketleri
  { name: 'mod:arch',         color: '1D3557', description: 'Mimari ve çoklu kiracılık (multi-tenancy)' },
  { name: 'mod:auth',         color: '7B2CBF', description: 'Kimlik doğrulama, yetkilendirme ve güvenlik' },
  { name: 'mod:iot',          color: '0077B6', description: 'Donanım haberleşmesi, MQTT ve telemetri' },
  { name: 'mod:firmware',     color: '023047', description: 'ESP32 gömülü yazılım (ESP-IDF)' },
  { name: 'mod:fuel',         color: 'E76F51', description: 'Akaryakıt otomasyonu, RFID ve ikmal protokolü' },
  { name: 'mod:ai',           color: '9D4EDD', description: 'Anomali tespiti ve yapay zeka servisleri' },
  { name: 'mod:compliance',   color: '52796F', description: 'GİB e-İrsaliye, UBL-TR ve mevzuat' },
  { name: 'mod:reporting',    color: '2A9D8F', description: 'Raporlama, export ve arşivleme' },
  { name: 'mod:frontend',     color: 'F4A261', description: 'React arayüzü ve 3 panel' },
  { name: 'mod:resilience',   color: 'BC4749', description: 'Hata yönetimi, doğrulama ve dayanıklılık' },
  { name: 'mod:test',         color: '606C38', description: 'Test otomasyonu ve kalite güvence' },
  { name: 'mod:devops',       color: '283618', description: 'DevOps, container, CI/CD ve izleme' },
  { name: 'mod:docs',         color: '8D99AE', description: 'Dokümantasyon' },
  { name: 'mod:fleet',        color: 'FFB703', description: 'Filo, araç ve sürücü yönetimi' },
  { name: 'mod:inventory',    color: 'FB8500', description: 'Stok, tedarik ve maliyet' },
  { name: 'mod:notification', color: 'EF476F', description: 'Bildirim ve alarm kanalları' },
  { name: 'mod:billing',      color: '3A86FF', description: 'SaaS abonelik ve lisans' },
  { name: 'mod:hr',           color: 'A2D2FF', description: 'İnsan kaynakları modülleri' },
  // Katman
  { name: 'layer:firmware',   color: '011627', description: 'Gömülü yazılım katmanı' },
  { name: 'layer:backend',    color: '0B525B', description: 'Node.js/NestJS backend katmanı' },
  { name: 'layer:frontend',   color: 'C77DFF', description: 'React frontend katmanı' },
  { name: 'layer:database',   color: '4A4E69', description: 'PostgreSQL / TimescaleDB katmanı' },
  { name: 'layer:infra',      color: '6C757D', description: 'Altyapı, container ve CI/CD katmanı' },
  // Öncelik
  { name: 'P0-blocker',       color: 'B60205', description: 'Sistem çalışması için zorunlu; güvenlik/veri kaybı riski' },
  { name: 'P1-high',          color: 'D93F0B', description: 'Temel iş süreçlerini doğrudan etkiler' },
  { name: 'P2-medium',        color: 'FBCA04', description: 'Deneyim, analitik ve optimizasyon' },
  { name: 'P3-low',           color: '0E8A16', description: 'İkincil ve opsiyonel geliştirmeler' },
  // Efor
  { name: 'size:XS',          color: 'C2E0C6', description: '1-2 gün' },
  { name: 'size:S',           color: 'BFD4F2', description: '3-5 gün' },
  { name: 'size:M',           color: 'D4C5F9', description: '1-2 hafta' },
  { name: 'size:L',           color: 'F9D0C4', description: '2-3 hafta' },
  { name: 'size:XL',          color: 'E99695', description: '1 ay ve üzeri' },
  // Tip
  { name: 'type:feature',     color: '1D76DB', description: 'Yeni işlevsellik' },
  { name: 'type:bug',         color: 'EE0701', description: 'Hata düzeltmesi' },
  { name: 'type:chore',       color: 'CFD3D7', description: 'Bakım, altyapı ve teknik borç' },
  { name: 'type:spike',       color: 'FEF2C0', description: 'Araştırma / teknik ön çalışma' },
  { name: 'type:design',      color: 'F9C0EE', description: 'Tasarım ve UX çalışması' },
  { name: 'type:security',    color: '5319E7', description: 'Güvenlik odaklı iş' },
  // Ek
  { name: 'epic',             color: '000000', description: 'Alt issue’ları toplayan takip (tracking) issue’su' },
  { name: 'blocked',          color: 'D876E3', description: 'Başka bir iş tamamlanmadan başlanamaz' },
];

const bullet = (items) => (items && items.length ? items.map((i) => `- [ ] ${i}`).join('\n') : '- [ ] _(tanımlanacak)_');

/**
 * Issue gövdesini md şablonuna göre üretir.
 * refs: { KEY: '#123' } eşlemesi — bağımlılıklar bu eşlemeyle numaraya çevrilir.
 */
export function renderBody(issue, refs = {}) {
  const ref = (key) => refs[key] || `\`${key}\``;
  const phase = PHASES[issue.phase].text;
  const lines = [];

  lines.push(
    `> **Modül Kodu:** \`${issue.key}\` | **Faz:** ${phase} | **Öncelik:** ${PRIORITY_TEXT[issue.priority]} | **Efor:** ${issue.size}`
  );
  if (issue.epic) lines.push(`>`, `> ⬆️ Bu iş **${ref(issue.epic)}** epic'inin bir parçasıdır.`);
  lines.push('');
  lines.push('## Amaç', issue.amac.trim(), '');
  lines.push('## Kapsam', bullet(issue.kapsam), '');

  if (issue.epicOf && issue.epicOf.length) {
    lines.push('## Alt İşler', issue.epicOf.map((k) => `- [ ] ${ref(k)}`).join('\n'), '');
  }

  lines.push('## Teknik Yığın', issue.stack.trim(), '');
  lines.push('## Teknik Notlar & Uç Durumlar', issue.notlar.trim(), '');
  lines.push('## Kabul Kriterleri (AC)', bullet(issue.ac), '');

  const bl = (issue.blockedBy || []).map(ref);
  const bs = (issue.blocks || []).map(ref);
  lines.push('## Bağımlılıklar');
  lines.push(`- **Bloklayan:** ${bl.length ? bl.join(', ') : '_yok_'}`);
  lines.push(`- **Blokladığı:** ${bs.length ? bs.join(', ') : '_yok_'}`);
  lines.push('');
  lines.push('## Test Notu', issue.test.trim(), '');
  lines.push('---');
  lines.push(`_Kaynak: \`docs/ISSUES_ROADMAP.md\` — Node.js Enterprise Roadmap v2.2_`);

  return lines.join('\n');
}

export function issueTitle(issue) {
  return `[${issue.key}] ${issue.title}`;
}

export function issueLabels(issue) {
  const labels = [
    `mod:${issue.module}`,
    `layer:${issue.layer}`,
    PRIORITY_LABEL[issue.priority],
    `size:${issue.size}`,
    `type:${issue.type}`,
  ];
  if (issue.epicOf && issue.epicOf.length) labels.push('epic');
  return labels;
}
