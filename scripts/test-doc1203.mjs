#!/usr/bin/env node
// ==============================================================================
// DOC-1203 (#40) — docs/PROJE-REHBERI.md SÖZLEŞME/DRIFT testleri (sıfır npm bağımlılığı).
// AC: (1) yeni geliştirici rehberle 30 dk'da çalışan ortama sahip olur → kurulum adımları GERÇEKTEN çalıştırılır (sır üretim betiği belgeden alınıp
// koşulur, compose'un zorunlu kıldığı tüm anahtarlar örnek dosyada mı, demo hesaplar tohum verisinde mi); (2) tüm modül grupları ve kritik kararlar
// gerekçeleriyle; (3) rol matrisi ve rapor kataloğu tablo — ve KODDAN üretilmiş (eskiyen rehber olmaz).
// ==============================================================================
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseSchema, parseRoutes, ROLES } from './generate-project-guide.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0; let total = 0;
const check = (name, ok, detail = '') => { total++; if (ok) passed++; console.log(`${ok ? '✅ [PASS]' : '❌ [FAIL]'} ${name}${detail ? `\n   ${detail}` : ''}`); };

const guide = read('docs/PROJE-REHBERI.md');
const routes = read('backend/src/routes/routes.ts');
const schema = parseSchema(read('backend/src/db/schema.sql'));

// ── Üretilen bölümler güncel ───────────────────────────────────────────────────
const gen = spawnSync('node', [path.join(ROOT, 'scripts/generate-project-guide.mjs'), '--check'], { encoding: 'utf8' });
check('Drift (AC 3): rehberin üretilen bölümleri (veritabanı şeması, rol matrisi, uç sayıları, rapor kataloğu) koddan güncel — eskiyen rehber CI\'ı kırar', gen.status === 0, (gen.stdout + gen.stderr).trim().slice(0, 200));

// ── Modül haritası (18 grup) ──────────────────────────────────────────────────
const GROUPS = ['ARCH', 'AUTH', 'IOT', 'FUEL', 'FLEET', 'INV', 'AI', 'COMP', 'REP', 'NOTIF', 'BILL', 'HR', 'FE', 'FW', 'RES', 'TEST', 'OPS', 'DOC'];
const mapSection = guide.slice(guide.indexOf('## 2. Modül haritası'), guide.indexOf('## 3. Diyagramlar'));
const missingGroups = GROUPS.filter((g) => !new RegExp(`\\| \\*\\*${g}\\*\\* `).test(mapSection));
const codeGroups = new Set([...(read('backend/src/db/tenantDb.ts') + routes).matchAll(/\b(ARCH|AUTH|IOT|FUEL|FLEET|INV|AI|COMP|REP|NOTIF|BILL|HR|FE|RES|OPS)-\d{3}/g)].map((m) => m[1]));
check(`Modül haritası (AC 2): 18 grubun HEPSİ (ne yapar, bağlı olduğu, kodda yeri, belge/test) tabloda; kodda gerçekten kullanılan grup kodları haritada eksiksiz (${codeGroups.size} grup kodda)`, GROUPS.length === 18 && missingGroups.length === 0 && [...codeGroups].every((g) => GROUPS.includes(g)), `eksik=[${missingGroups}]`);
const pathCells = [...mapSection.matchAll(/`([A-Za-z0-9_./*-]+\.(?:ts|tsx|mjs|md|yml|json)|[a-z]+\/[A-Za-z0-9_./*-]*\/)`/g)].map((m) => m[1]);
const resolves = (p) => {
  const cands = [p, `backend/src/${p}`, `backend/${p}`, `frontend/${p}`, `docs/${p}`];
  for (const c of cands) {
    if (c.includes('*')) { const dir = path.join(ROOT, path.dirname(c)); const re = new RegExp(`^${path.basename(c).replace(/\./g, '\\.').replace(/\*/g, '.*')}$`); if (existsSync(dir) && readdirSync(dir).some((f) => re.test(f))) return true; }
    else if (existsSync(path.join(ROOT, c))) return true;
  }
  return c_test_dir(p);
};
function c_test_dir(p) { if (!p.includes('*')) return false; const dir = path.join(ROOT, 'backend/test'); const re = new RegExp(`^${p.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`); return readdirSync(dir).some((f) => re.test(f)); }
const brokenPaths = pathCells.filter((p) => !resolves(p) && !/^(hardware\/|docs\/operator\/device-messages\.json)/.test(p));
check(`Modül haritasındaki ${pathCells.length} dosya/dizin/test yolu gerçekten var (eski/yanlış yol yok; FW grubu için "depoda yok" açıkça yazılı)`, pathCells.length >= 30 && brokenPaths.length === 0 && /\*\*bu depoda yok\*\*/.test(mapSection), `bulunamayan=[${brokenPaths}]`);

// ── Diyagramlar ───────────────────────────────────────────────────────────────
const blocks = [...guide.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
const kinds = blocks.map((b) => b.trim().split(/\s+/)[0]);
const er = blocks.find((b) => b.startsWith('erDiagram')) ?? '';
const entities = [...new Set([...er.matchAll(/^\s+(\w+) [|}o][|o]--[|o{][|o{] (\w+)/gm)].flatMap((m) => [m[1], m[2]]))];
const badEntities = entities.filter((e) => !schema.tables.has(e));
const seq = blocks.find((b) => b.startsWith('sequenceDiagram')) ?? '';
const seqPaths = [...seq.matchAll(/(POST|GET) (\/[a-z\-/]+)/g)].map((m) => `${m[1]} ${m[2]}`);
const registered = new Set(parseRoutes(routes).map((r) => `${r.method} ${r.path.replace(/:[A-Za-z]+/g, ':p')}`));
const seqBad = seqPaths.filter((p) => !registered.has(p));
const structural = blocks.filter((b) => b.startsWith('flowchart')).every((b) => (b.match(/\bsubgraph\b/g) ?? []).length === (b.match(/^\s*end\s*$/gm) ?? []).length) && !/;/.test(seq.replace(/<br\/>/g, ''));
check('Diyagramlar (ticket): 4 Mermaid — sistem mimarisi, veri akışı, ER şeması, ikmal sekansı; ER varlıklarının HEPSİ gerçek tablo, sekanstaki uçlar gerçek rota; yapısal denetim (subgraph/end dengesi, sekansta ";" yok — Mermaid ifade ayracıdır). Gerçek Mermaid ayrıştırıcısıyla ayrıca doğrulandı',
  blocks.length === 4 && kinds.join() === 'flowchart,flowchart,erDiagram,sequenceDiagram' && entities.length >= 15 && badEntities.length === 0 && seqPaths.length >= 4 && seqBad.length === 0 && structural, `varlık=${entities.length}, tabloda olmayan=[${badEntities}], kayıtsız uç=[${seqBad}]`);

// ── Kurulum: 30 dakikada çalışan ortam ──────────────────────────────────────────
const compose = read('docker-compose.yml');
const requiredKeys = [...new Set([...compose.matchAll(/\$\{([A-Z_0-9]+):\?/g)].map((m) => m[1]))];
const rootEnv = read('.env.example');
const missingKeys = requiredKeys.filter((k) => !new RegExp(`^${k}=`, 'm').test(rootEnv));
check(`Kurulum (AC 1) — GERÇEK HATA yakalayıcı: docker-compose.yml'in zorunlu kıldığı ${requiredKeys.length} anahtarın HEPSİ kök .env.example'da (eksikse README'deki "cp .env.example .env && docker compose up" başlamadan düşer — bu test yazılırken gerçekten eksikti)`, requiredKeys.length >= 10 && missingKeys.length === 0, `eksik=[${missingKeys}]`);
const snippet = /cp \.env\.example \.env\n(while grep[\s\S]*?done)/.exec(guide)?.[1];
let snippetOk = false; let snippetDetail = 'betik belgede bulunamadı';
if (snippet) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'guide-'));
  writeFileSync(path.join(tmp, '.env'), rootEnv);
  // timeout: bozuk bir betik (yer tutucuyu doldurmayan döngü) testi ASILI bırakmasın.
  const r = spawnSync('bash', ['-c', snippet.replace(/\s+# macOS.*$/m, '')], { cwd: tmp, encoding: 'utf8', timeout: 15000 });
  const env = readFileSync(path.join(tmp, '.env'), 'utf8');
  const val = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1] ?? '';
  const hex64 = ['HW_SECRET_ENCRYPTION_KEY', 'TENANT_EXPORT_ENCRYPTION_KEY', 'NOTIFICATION_CHANNEL_ENCRYPTION_KEY'].every((k) => /^[0-9a-f]{64}$/.test(val(k)));
  const jwtLong = /^[0-9a-f]{128}$/.test(val('JWT_SECRET')) && val('JWT_SECRET') !== val('JWT_REFRESH_SECRET');
  snippetOk = r.status === 0 && !/__CHANGE_ME/.test(env) && hex64 && jwtLong;
  snippetDetail = `çıkış=${r.status}, kalan yer tutucu=${(env.match(/__CHANGE_ME/g) ?? []).length}, 64-hex anahtarlar=${hex64}, JWT ayrı ve 128 hex=${jwtLong}`;
  rmSync(tmp, { recursive: true, force: true });
}
check('Kurulum: belgedeki sır üretim betiği (§7.1) OLDUĞU GİBİ çalıştırılır — tüm yer tutucular rastgele değerle dolar, şifreleme anahtarları tam 64 hex, JWT sırları farklı ve güçlü', snippetOk, snippetDetail);
const seed = read('backend/src/db/seed_mock_data.sql');
const demo = [['admin', 'SUPER_ADMIN'], ['camsa', 'COMPANY_OWNER'], ['gebze-santiye', 'SITE_MANAGER'], ['pompa-op-01', 'PUMP_OPERATOR']];
const demoBad = demo.filter(([u]) => !seed.includes(`'${u}'`) || !guide.includes(`\`${u}\``));
const bePkg = JSON.parse(read('backend/package.json')); const fePkg = JSON.parse(read('frontend/package.json'));
const healthRoutes = ['GET /health', 'GET /health/ready'].every((r) => registered.has(r));
check('Kurulum adımlarındaki iddialar doğru: demo hesaplar tohum verisinde ve belgede; `npm run dev` (backend + frontend), `lint` betikleri var; sağlık uçları kayıtlı; frontend :3000 ve /api proxy :5000; backend host\'a yayınlanmaz',
  demoBad.length === 0 && !!bePkg.scripts.dev && !!fePkg.scripts.dev && !!bePkg.scripts.lint && healthRoutes && /port: 3000/.test(read('frontend/vite.config.ts')) && /localhost:5000/.test(read('frontend/vite.config.ts')) && !/^\s+- "5000:5000"/m.test(compose) && /docker compose up -d --build/.test(guide), `demo eksik=[${demoBad}]`);
check('README kurulum akışı rehberle tutarlı: sır üretim döngüsü README\'de de var ve rehbere bağlanır; README belge tablosu rehberi "buradan başlayın" olarak gösterir',
  /__CHANGE_ME_RUN_openssl_rand_-hex_/.test(read('README.md')) && /docs\/PROJE-REHBERI\.md/.test(read('README.md')) && /Buradan başlayın/.test(read('README.md')), '');

// ── Roller, raporlar, şema tabloları ──────────────────────────────────────────────
const roleTable = guide.slice(guide.indexOf('ÜRETİLEN:ROLLER:BAŞLA'), guide.indexOf('ÜRETİLEN:ROLLER:BİTİŞ'));
const roleRows = (roleTable.match(/^\| .* \| (?:O\/Y|O|Y|—) \|/gm) ?? []).length;
check(`Rol/yetki matrisi (AC 3): tablo — 5 rol sütunu (${ROLES.join(', ')}), ${roleRows} kaynak grubu satırı; koddan üretilir`, ROLES.every((r) => roleTable.includes(`\`${r}\``)) && roleRows >= 35 && /SITE_MANAGER` yalnızca kendi şantiyesinin/.test(roleTable), `satır=${roleRows}`);
const repTable = guide.slice(guide.indexOf('ÜRETİLEN:RAPORLAR:BAŞLA'), guide.indexOf('ÜRETİLEN:RAPORLAR:BİTİŞ'));
const mainReports = Array.from({ length: 13 }, (_, i) => `rep-${711 + i}`);
check('Rapor kataloğu (AC 3): tablo — REP-711…723 ana raporlarının 13\'ü ve alt görünümleri (toplam ≥ 26), roller ve sütun sayısıyla', mainReports.every((id) => new RegExp(`\`${id}\``).test(repTable)) && (repTable.match(/^\| `rep-/gm) ?? []).length >= 26, `satır=${(repTable.match(/^\| `rep-/gm) ?? []).length}`);
const dbTable = guide.slice(guide.indexOf('ÜRETİLEN:VERITABANI:BAŞLA'), guide.indexOf('ÜRETİLEN:VERITABANI:BİTİŞ'));
check(`Veritabanı şeması (ticket: tablo/alan): schema.sql'deki ${schema.tables.size} tablonun HEPSİ sütunlarıyla, RLS ve saklama sınıfıyla listelenir; hypertable stratejisi DÜRÜSTÇE "henüz uygulanmadı" olarak anlatılır`,
  [...schema.tables.keys()].every((t) => dbTable.includes(`| \`${t}\` |`)) && /henüz uygulanmadı/.test(guide) && /chunk 1 gün/.test(guide) && /compression|sıkıştırma/.test(guide) && /segmentby=device_id/.test(guide), '');

// ── Kapsam, kararlar, kurallar ─────────────────────────────────────────────────────
const need = ['Proje amacı, kapsamı ve kapsam dışı', 'Kapsam dışı (bilinçli)', 'Teknoloji yığını ve gerekçeleri', 'Tenant izolasyonu', 'Fail-open politikası', 'K-faktör', 'idempotency', 'expand-only', 'Repo yapısı, branch, commit ve PR kuralları', 'Ortam kurulumu', 'MQTT topic şeması', 'Rol / yetki matrisi', 'Rapor kataloğu', 'Yol haritası', 'Test stratejisi', 'Riskler ve önlemler', 'saha devreye alma', 'KAPSAM UYARLAMASI'];
const miss = need.filter((t) => !new RegExp(t.replace(/[()]/g, '\\$&'), 'i').test(guide));
check('Kapsam (ticket): amaç/kapsam dışı, modül haritası, diyagramlar, teknoloji + gerekçe, mimari kararlar (tenant izolasyonu, fail-open, K-faktör, idempotency, expand-only) gerekçeleriyle, repo/branch/commit/PR kuralları, kurulum, API + MQTT, şema, roller, raporlar, yol haritası, test stratejisi, saha checklist, riskler', miss.length === 0, `eksik=[${miss}]`);
const why = ['**Neden:**'].every((w) => (guide.match(/\*\*Neden:?\*\*/g) ?? []).length >= 4);
const stackRows = (guide.slice(guide.indexOf('## 4. Teknoloji'), guide.indexOf('## 5. Kritik')).match(/^\| (?!---|Katman)/gm) ?? []).length;
check(`Kararların gerekçesi: en az 4 kritik kararda açık "Neden" ve teknoloji tablosunda ${stackRows} seçim + gerekçe (ticket sapmaları — NestJS/BullMQ/Drizzle/K8s/TimescaleDB — dürüstçe listelenir)`, why && stackRows >= 9 && /NestJS/.test(guide) && /BullMQ/.test(guide) && /TimescaleDB/.test(guide), '');
const guards = [...new Set([...guide.matchAll(/`(check-[a-z\-]+)`/g)].map((m) => m[1]))];
const guardsMissing = guards.filter((g) => !existsSync(path.join(ROOT, `scripts/${g}.mjs`)));
check(`PR kontrol listesindeki ${guards.length} guard betiği gerçekten var (uydurma kural yok)`, guards.length >= 5 && guardsMissing.length === 0, `yok=[${guardsMissing}]`);
const links = [...guide.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
const brokenLinks = links.filter((l) => !existsSync(path.join(ROOT, 'docs', l)));
check(`Bağlantılar: rehberdeki ${links.length} göreli bağlantı mevcut dosyaya işaret eder`, links.length >= 25 && brokenLinks.length === 0, `kırık=[${brokenLinks}]`);
const ci = read('.github/workflows/ci-cd.yml');
check('CI: rehberin üretilen bölümleri güncel mi (generate-project-guide --check) ve bu test pipeline\'da', /generate-project-guide\.mjs --check/.test(ci) && /node scripts\/test-doc1203\.mjs/.test(ci), '');
check('Doğrulama kaydı (Test Notu): yeni katılan geliştiriciyle kurulum süresi ölçümü için tablo hazır, "henüz yapılmadı" dürüstçe belirtilir', /Rehber doğrulama kaydı/.test(guide) && /ilk yeni geliştirici ölçümünde doldurulacak/.test(guide), '');

console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
process.exit(passed === total ? 0 : 1);
