import { spawnSync } from 'child_process';
import path from 'path';
import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * DOC-1204 (#41) — Sunum demo senaryosunun GERÇEK sistemde provası.
 *
 * docs/SUNUM-REHBERI.md §4'teki demo adımları (kart reddi, yetkili ikmal, panelde anında görünme, çevrimdışı
 * kuyruk + çift kayıt engeli, rapor, firmalar arası yalıtım) scripts/demo-provasi.mjs ile canlı API'ye karşı
 * koşturulur; betik her adımın sonucunu doğrular. Böylece "demo gerçek sistemde prova edilmelidir" şartı,
 * belgenin ellerle değil her CI koşusunda kanıtlanan bir sözleşmesi olur.
 *
 * Login rate-limit hijyeni (TEST_PLAN §0.3): betik 2 giriş yapar → önce sayaç temizlenir.
 */
const TANK_ID = 'tank-gebze-1';

async function run() {
  await resetLoginRateLimit();
  // Prova ortak tohum verisini (tank seviyesi, ikmal kayıtları) değiştirir; diğer testleri etkilememek için geri alınır.
  const db = new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
  await db.connect();
  const before = await db.query(`SELECT current_level_liters FROM tanks WHERE id = $1`, [TANK_ID]);
  const startedAt = new Date();
  // CI'da 'cd backend' ile koşar; repo kökünden de çalışır.
  const root = path.basename(process.cwd()) === 'backend' ? path.resolve(process.cwd(), '..') : process.cwd();
  const script = path.join(root, 'scripts/demo-provasi.mjs');
  const r = spawnSync('node', [script, '--json'], { encoding: 'utf8', env: process.env, timeout: 60000 });
  let out: any = null;
  try { out = JSON.parse(r.stdout); } catch { /* aşağıda başarısız sayılır */ }
  let passed = 0;
  let total = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    total++;
    if (ok) { passed++; console.log(`✅ [PASS] ${name}${detail ? `\n   ${detail}` : ''}`); }
    else console.error(`❌ [FAIL] ${name}${detail ? `\n   ${detail}` : ''}`);
  };
  // Temizlik (çevrimdışı kayıtların created_at'ı cihaz saatidir → sıra numarası = koşu başlangıç ms'inden büyük olanlar): provanın yarattığı ikmal kayıtlarını sil, tank seviyesini geri yükle (transactions tetikleyicilerine takılmamak için tek ifade).
  const cleaned = await db.query(`DELETE FROM transactions WHERE tenant_id = 'comp-camsa' AND ((created_at >= $1 AND idempotency_key LIKE 'demo-provasi-%') OR (device_id = 'ESP32-PUMP-01' AND local_sequence_id >= $2))`, [startedAt, startedAt.getTime()]).catch((e) => ({ rowCount: -1, err: e.message }));
  await db.query(`UPDATE tanks SET current_level_liters = $2 WHERE id = $1`, [TANK_ID, before.rows[0].current_level_liters]);
  await db.end();
  check('Prova betiği çıktı üretti ve başarıyla bitti', r.status === 0 && !!out, `çıkış=${r.status} ${r.stderr?.slice(0, 200) ?? ''}`);
  check('Demo senaryosunun 9 adımının HEPSİ gerçek sistemde geçti', out?.passed === 9 && out?.total === 9, `${out?.passed}/${out?.total}`);
  for (const s of out?.steps ?? []) check(s.title, s.ok === true, s.seen);
  console.log(`\nSONUÇ: ${passed}/${total} test geçti.`);
  process.exit(passed === total ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
