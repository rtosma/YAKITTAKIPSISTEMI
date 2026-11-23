#!/usr/bin/env node
// ==============================================================================
// DOC-1203 (#40) — docs/PROJE-REHBERI.md'nin KODDAN ÜRETİLEN bölümleri (eskiyen rehber, rehber olmamasından kötüdür):
//   VERITABANI  : schema.sql → tablo/sütun/RLS/saklama sınıfı
//   ROLLER      : routes.ts → rol × kaynak yetki matrisi (authorizeRoles + sabit rol listeleri)
//   ENDPOINT    : routes.ts → kaynak grubu başına uç sayısı ve kimlik doğrulama türü
//   RAPORLAR    : reports/definitions/* → rapor kataloğu (id, başlık, roller, filtre/sütun sayısı)
//   node scripts/generate-project-guide.mjs          günceller
//   node scripts/generate-project-guide.mjs --check  güncel değilse çıkış 1 (CI)
// ==============================================================================
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = path.join(ROOT, 'docs/PROJE-REHBERI.md');
const CHECK = process.argv.includes('--check');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
export const ROLES = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR', 'DRIVER'];
const marker = (k) => [`<!-- ÜRETİLEN:${k}:BAŞLA (scripts/generate-project-guide.mjs — ELLE DEĞİŞTİRMEYİN) -->`, `<!-- ÜRETİLEN:${k}:BİTİŞ -->`];

// ── Veritabanı ───────────────────────────────────────────────────────────────
export function parseSchema(sql) {
  const tables = new Map();
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const cols = [];
    for (const line of m[2].split('\n')) {
      const c = /^\s{4}(\w+)\s+([A-Za-z]+(?:\s*\([^)]*\))?(?:\[\])?)/.exec(line);
      if (c && !/^(PRIMARY|UNIQUE|CONSTRAINT|CHECK|FOREIGN)$/i.test(c[1])) cols.push([c[1], c[2].replace(/\s+/g, '')]);
    }
    tables.set(m[1], cols);
  }
  for (const m of sql.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)\s+([A-Za-z]+(?:\s*\([^)]*\))?(?:\[\])?)/g)) {
    const t = tables.get(m[1]); if (t && !t.some(([n]) => n === m[2])) t.push([m[2], m[3].replace(/\s+/g, '')]);
  }
  const rls = new Set([...sql.matchAll(/ALTER TABLE\s+(\w+)\s+FORCE ROW LEVEL SECURITY/gi)].map((m) => m[1]));
  return { tables, rls };
}

function retentionClasses() {
  const cat = read('backend/src/retention/retentionCatalog.ts');
  const cls = new Map();
  for (const m of cat.matchAll(/table: '(\w+)', timestampColumn/g)) cls.set(m[1], 'silinebilir');
  const prot = cat.slice(cat.indexOf('PROTECTED_TABLES'), cat.indexOf('MANAGED_TABLES'));
  for (const m of prot.matchAll(/^  (\w+): \{ minYears/gm)) cls.set(m[1], 'KORUMALI (mali)');
  for (const m of cat.slice(cat.indexOf('MANAGED_TABLES'), cat.indexOf('EXTERNAL_CLASSES')).matchAll(/^  (\w+): '/gm)) cls.set(m[1], 'yönetilen');
  const master = cat.slice(cat.indexOf('MASTER_TABLES: readonly string[]'));
  for (const m of master.slice(0, master.indexOf('];')).matchAll(/'(\w+)'/g)) cls.set(m[1], 'ana veri');
  for (const m of cat.matchAll(/dataClass: '(?:DRIVER_PII|PERSONNEL_PII)', kind: 'ANONYMIZE'[^}]*?table: '(\w+)'/g)) if (!cls.has(m[1])) cls.set(m[1], 'ana veri');
  return cls;
}

export function renderDb() {
  const { tables, rls } = parseSchema(read('backend/src/db/schema.sql'));
  const cls = retentionClasses();
  const rows = [...tables.entries()].map(([t, cols]) => `| \`${t}\` | ${cols.map(([n, ty]) => `${n}:${ty.toLowerCase()}`).join(', ')} | ${rls.has(t) ? 'RLS' : '—'} | ${cls.get(t) ?? '—'} |`);
  return [`**${tables.size} tablo**, ${[...tables.keys()].filter((t) => rls.has(t)).length} tanesinde satır düzeyi güvenlik (RLS, tenant izolasyonu). "Saklama sınıfı" [DATA_RETENTION.md](DATA_RETENTION.md)'deki katalogdandır.`, '', '| Tablo | Sütunlar (ad:tip) | Tenant RLS | Saklama sınıfı |', '|---|---|---|---|', ...rows].join('\n');
}

// ── Rotalar: roller + uç sayıları ─────────────────────────────────────────────
export function parseRoutes(src) {
  const consts = {};
  for (const m of src.matchAll(/^const (\w+)(?:: [^=]+)? = \[([^\]]*)\](?: as const)?;/gm)) consts[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  const calls = [...src.matchAll(/^router\.(get|post|put|patch|delete)\(\s*(?:\n\s*)?'([^']+)'/gm)];
  const out = [];
  calls.forEach((m, i) => {
    const seg = src.slice(m.index, i + 1 < calls.length ? calls[i + 1].index : m.index + 4000);
    const head = seg.slice(0, seg.search(/async \(|\(req[:,)]|\(_req/) > 0 ? seg.search(/async \(|\(req[:,)]|\(_req/) : 1500);
    const ar = /authorizeRoles\(([^)]*)\)/.exec(head);
    let roles = null;
    if (ar) { roles = []; for (const a of ar[1].split(',').map((s) => s.trim()).filter(Boolean)) { if (a.startsWith('...')) roles.push(...(consts[a.slice(3)] ?? [`?${a}`])); else { const l = /'(\w+)'/.exec(a); if (l) roles.push(l[1]); } } }
    const jwt = /authenticateJWT/.test(head);
    const hw = /hardwareAuthMiddleware|lorawanWebhookAuth/.test(head);
    out.push({ method: m[1].toUpperCase(), path: m[2], auth: hw ? 'device' : jwt ? (roles ? 'roles' : 'any') : 'public', roles });
  });
  return out;
}

const GROUP_LABEL = {
  auth: 'Kimlik doğrulama / oturum', health: 'Sağlık kontrolü', companies: 'Firma (tenant) yönetimi', admin: 'Platform yönetimi (SUPER_ADMIN)', sites: 'Şantiyeler', tanks: 'Tanklar ve stok', vehicles: 'Araçlar', drivers: 'Sürücüler',
  transactions: 'İkmal hareketleri', dispense: 'İkmal oturumu (cihaz)', telemetry: 'Telemetri / çevrimdışı senkron (cihaz)', devices: 'Cihaz claim ve kalibrasyon', 'hardware-devices': 'Donanım cihazları ve sağlık', policies: 'Fail-open politikası',
  reports: 'Raporlar', archives: 'Şifreli arşivler', alarms: 'Alarmlar', notifications: 'Bildirimler', personnel: 'Personel ve izin', 'rfid-cards': 'RFID kart yönetimi', inventory: 'Envanter / depo', 'fuel-intakes': 'Yakıt alım (dolum)',
  'anomaly-flags': 'Mesai dışı / anomali işaretleri', 'audit-logs': 'Denetim günlüğü', 'cross-site-permissions': 'Çapraz şantiye alım izinleri', 'despatch-advice-documents': 'e-İrsaliye belgeleri', 'despatch-advice-transmissions': 'e-İrsaliye iletimi', 'fire-records': 'Fire kayıtları', 'firmware-artifacts': 'Firmware imajları', 'firmware-rollouts': 'Firmware dağıtımı (OTA)', fleet: 'Filo tüketim ve uyum', 'fuel-budgets': 'Yakıt bütçeleri', 'fuel-stock-summary': 'Yakıt stok özeti', 'inventory-items': 'Envanter kalemleri', 'lab-samples': 'Laboratuvar numuneleri', 'leave-calendar': 'İzin takvimi', 'leave-requests': 'İzin talepleri', lorawan: 'LoRaWAN uplink (webhook)', 'maintenance-records': 'Bakım kayıtları', 'manual-dispense-requests': 'Manuel ikmal talepleri (çift onay)', 'meter-readings': 'Km / motor saati okumaları', quotas: 'Yakıt kotaları', recipients: 'e-İrsaliye alıcı mükellefleri', 'report-deliveries': 'Zamanlanmış rapor teslimleri', 'report-schedules': 'Zamanlanmış raporlar', 'stock-reconciliations': 'Stok mutabakatı', taxpayers: 'Mükellef sorgusu (VKN)', 'tenant-info': 'Tenant bağlamı (tanı)', tires: 'Lastik takibi', 'usage-metering': 'Kullanım ölçümü (faturalama)', 'vehicle-documents': 'Araç belgeleri', privacy: 'KVKK veri sahibi başvuruları', retention: 'Veri saklama politikası', monitoring: 'İzleme (Sentry tüneli)', ai: 'Yapay zeka analizleri', users: 'Kullanıcılar', dashboard: 'Dashboard', lab: 'Laboratuvar / kalite', despatch: 'e-İrsaliye', anomalies: 'Anomali tespiti'
};
const segOf = (p) => p.split('/').filter(Boolean)[0] ?? '';

export function renderRoles() {
  const routes = parseRoutes(read('backend/src/routes/routes.ts'));
  const groups = new Map();
  for (const r of routes) {
    const g = segOf(r.path); if (!groups.has(g)) groups.set(g, { read: new Set(), write: new Set(), n: 0, device: 0, pub: 0 });
    const e = groups.get(g); e.n++;
    if (r.auth === 'device') { e.device++; continue; }
    if (r.auth === 'public') { e.pub++; continue; }
    const allowed = r.auth === 'any' ? ROLES : r.roles;
    for (const role of allowed) (r.method === 'GET' ? e.read : e.write).add(role);
  }
  const cell = (e, role) => (e.write.has(role) ? (e.read.has(role) ? 'O/Y' : 'Y') : e.read.has(role) ? 'O' : '—');
  const rows = [...groups.entries()].filter(([, e]) => e.n > e.device + e.pub).sort((a, b) => (GROUP_LABEL[a[0]] ?? a[0]).localeCompare(GROUP_LABEL[b[0]] ?? b[0], 'tr'))
    .map(([g, e]) => `| ${GROUP_LABEL[g] ?? g} (\`/${g}\`) | ${ROLES.map((r) => cell(e, r)).join(' | ')} |`);
  return ['**O** = okuma (GET) yapabilir · **Y** = yazma/işlem (POST/PUT/PATCH/DELETE) yapabilir · **—** = erişemez. Kaynak: `routes.ts` (`authorizeRoles` ve rol sabitleri); kimlik doğrulaması olan ama rol kısıtı olmayan uçlar **tüm rollere** açıktır (site kapsamı ve PII maskesi ayrıca uygulanır — bkz. [KVKK_ENVANTER.md](KVKK_ENVANTER.md)). Ek kural: `SITE_MANAGER` yalnızca kendi şantiyesinin verisini görür (`siteScopeFor`).', '', `| Kaynak grubu | ${ROLES.map((r) => `\`${r}\``).join(' | ')} |`, `|---|${ROLES.map(() => ':-:').join('|')}|`, ...rows].join('\n');
}

export function renderEndpoints() {
  const routes = parseRoutes(read('backend/src/routes/routes.ts'));
  const c = { public: 0, any: 0, roles: 0, device: 0 };
  for (const r of routes) c[r.auth]++;
  const groups = new Map();
  for (const r of routes) groups.set(segOf(r.path), (groups.get(segOf(r.path)) ?? 0) + 1);
  const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `\`/${g}\` ${n}`).join(' · ');
  return [`Toplam **${routes.length} REST ucu** (\`/api/v1\` altında). Kimlik doğrulama türüne göre: **cihaz HMAC** ${c.device} · **JWT + rol kısıtı** ${c.roles} · **JWT (tüm roller)** ${c.any} · **kimliksiz** ${c.public} (giriş, sağlık, parola sıfırlama, indirme bağlantıları, Sentry tüneli).`, '', `Kaynak gruplarına göre: ${top}.`].join('\n');
}

// ── Rapor kataloğu ───────────────────────────────────────────────────────────
export function renderReports() {
  const dir = 'backend/src/reports/definitions';
  const rows = [];
  for (const f of readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.ts')).sort()) {
    const src = read(`${dir}/${f}`);
    const consts = {};
    for (const m of src.matchAll(/^const (\w+)(?:: [^=]+)? = \[([^\]]*)\];/gm)) consts[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
    const parts = src.split(/(?:export )?const \w+: ReportDefinition = \{/).slice(1);
    for (const p of parts) {
      const id = /^\s*id: '([^']+)'/m.exec(p)?.[1]; const title = /^\s*title: '([^']+)'/m.exec(p)?.[1];
      const ar = /allowedRoles: (\[[^\]]*\]|\w+)/.exec(p)?.[1];
      const roles = ar?.startsWith('[') ? [...ar.matchAll(/'(\w+)'/g)].map((x) => x[1]) : consts[ar] ?? [];
      const colBlock = /columns: \[([\s\S]*?)\n  \],/.exec(p)?.[1] ?? '';
      const nCols = (colBlock.match(/^\s{4}\{ key: '/gm) ?? []).length;
      if (id && title) rows.push({ id, title, roles, nCols });
    }
  }
  const short = (r) => r.map((x) => ({ SUPER_ADMIN: 'SA', COMPANY_OWNER: 'CO', SITE_MANAGER: 'SM', PUMP_OPERATOR: 'PO', DRIVER: 'DR' }[x] ?? x)).join(' ');
  return [`**${rows.length} rapor tanımı** (REP-711…723; ana rapor + alt görünümler). Yeni rapor = \`reports/definitions/\` altına tanım + \`reports/index.ts\`'e bir satır. Roller: SA=SUPER_ADMIN, CO=COMPANY_OWNER, SM=SITE_MANAGER, PO=PUMP_OPERATOR, DR=DRIVER. Çıktılar: JSON, CSV, PDF (rol bazlı PII maskesi — REP-720).`, '', '| Rapor kodu | Başlık | Roller | Sütun |', '|---|---|---|:-:|', ...rows.map((r) => `| \`${r.id}\` | ${r.title} | ${short(r.roles)} | ${r.nCols || '—'} |`)].join('\n');
}

export const SECTIONS = { VERITABANI: renderDb, ROLLER: renderRoles, ENDPOINT: renderEndpoints, RAPORLAR: renderReports };

export function build() {
  let text = readFileSync(GUIDE, 'utf8');
  for (const [k, fn] of Object.entries(SECTIONS)) {
    const [s, e] = marker(k); const a = text.indexOf(s); const b = text.indexOf(e);
    if (a === -1 || b === -1 || b < a) throw new Error(`İşaretçi yok: ${k}`);
    text = `${text.slice(0, a + s.length)}\n${fn()}\n${text.slice(b)}`;
  }
  return text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = build(); const cur = readFileSync(GUIDE, 'utf8');
  if (CHECK) {
    if (next !== cur) { console.error('[generate-project-guide] HATA: docs/PROJE-REHBERI.md üretilen bölümleri koddan eskimiş — `node scripts/generate-project-guide.mjs` çalıştırın.'); process.exit(1); }
    console.log('[generate-project-guide] OK — rehberin üretilen bölümleri (veritabanı, roller, uçlar, raporlar) koda uygun.');
  } else { writeFileSync(GUIDE, next); console.log(`[generate-project-guide] ${next === cur ? 'zaten güncel' : 'güncellendi'}: docs/PROJE-REHBERI.md`); }
}
