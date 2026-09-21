#!/usr/bin/env node
// ==============================================================================
// DOC-1204 (#41) — SUNUM DEMO PROVASI: docs/SUNUM-REHBERI.md §5'teki demo senaryosunu
// GERÇEK çalışan sistemde (API + Postgres + Redis) adım adım koşturur ve her adımın
// sunumda söylenecek sonucunu DOĞRULAR. "Demo senaryosu gerçek sistemde prova edilmelidir."
//
// Kullanım (yerelde nginx üzerinden):  DEMO_API_URL=http://localhost:3000/api/v1 node scripts/demo-provasi.mjs
//          (CI'da backend 5000 portunda; varsayılan budur.)
// Cihaz sırrı: HW_SECRET_ESP32_PUMP_01 (yoksa repo kökündeki .env okunur, o da yoksa seed varsayılanı).
// Her koşuda YENİ bir idempotency anahtarı/sıra numarası kullanılır — art arda çalıştırılabilir.
// Çıktı: adım adım "SUNUMDA GÖRÜNEN" özet + son satır SONUÇ: n/m. --json ile makine-okunur.
// ==============================================================================
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.DEMO_API_URL || 'http://localhost:5000/api/v1').replace(/\/$/, '');
const DEVICE_ID = 'ESP32-PUMP-01';
export const DEMO = {
  owner: { username: 'camsa', password: '123456' },
  otherTenantOwner: { username: 'kusak', password: '123456' },
  card: 'CARD-881201', unknownCard: 'CARD-BILINMEYEN', driver: 'Ahmet Yılmaz',
  vehicleId: 'veh-1', plate: '34 CTP 82', tankId: 'tank-gebze-1', tankName: 'Gebze Ana Tank (T-1)', site: 'Gebze Ana Şantiye',
  dispenseLiters: 50, offlineLiters: [30, 45]
};

function deviceSecret() {
  if (process.env.HW_SECRET_ESP32_PUMP_01) return process.env.HW_SECRET_ESP32_PUMP_01;
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) { const m = /^HW_SECRET_ESP32_PUMP_01=(.*)$/m.exec(readFileSync(envFile, 'utf8')); if (m) return m[1].trim(); }
  return 'secret_gebze_pump_8849';
}
const SECRET = deviceSecret();

async function http(method, p, { body, token, hw } = {}) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (hw) {
    const ts = Date.now().toString(); const nonce = crypto.randomBytes(16).toString('hex');
    Object.assign(headers, { 'X-Device-ID': DEVICE_ID, 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Hardware-Signature': crypto.createHmac('sha256', SECRET).update(`${ts}.${nonce}.${raw}`).digest('hex') });
  }
  const res = await fetch(`${API}${p}`, { method, headers, body: raw });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const login = async (u) => (await http('POST', '/auth/login', { body: u })).data.accessToken;

const json = process.argv.includes('--json');
// --canli: sunum sırasında pompa/cihaz tarafı adımları sunucunun komutuyla (Enter) ilerler.
const live = process.argv.includes('--canli');
async function pause(msg) {
  if (!live) return;
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question(`\n⏸  ${msg} — devam için Enter… `, () => { rl.close(); r(); }));
}
let passed = 0; let total = 0; const steps = [];
function step(title, ok, seen) { total++; if (ok) passed++; steps.push({ title, ok, seen }); if (!json) console.log(`${ok ? '✅' : '❌'} ${title}\n   SUNUMDA GÖRÜNEN: ${seen}`); }

async function main() {
  const health = await http('GET', '/health');
  if (health.status !== 200) { console.error(`❌ Sistem ayakta değil (${API}/health → ${health.status}). Demo öncesi bunu kontrol edin.`); process.exit(2); }

  // ── ADIM 1: yönetici girişi + tank stoku ─────────────────────────────────────
  const token = await login(DEMO.owner);
  const tanks1 = await http('GET', '/tanks', { token });
  const tankBefore = (tanks1.data.data ?? []).find((t) => t.id === DEMO.tankId);
  step('1. Yönetici giriş yapar, şantiye tanklarının anlık stokunu görür', !!token && !!tankBefore, tankBefore ? `${tankBefore.name}: ${Number(tankBefore.current_level_liters)} / ${Number(tankBefore.capacity_liters)} L, durum ${tankBefore.status}` : 'tank bulunamadı');
  const levelBefore = Number(tankBefore?.current_level_liters);

  // Ön hazırlık (sunum öncesi yapılır, sunumda anlatılmaz): aracı sürücüye ata.
  await http('PUT', `/vehicles/${DEMO.vehicleId}`, { token, body: { assignedDriver: DEMO.driver } });

  // ── ADIM 2: tanınmayan kart reddedilir ───────────────────────────────────────
  await pause('D2 — yetkisiz kart okutulacak');
  const bad = await http('POST', '/dispense/request-auth', { hw: true, body: { rfidCardId: DEMO.unknownCard, tankName: DEMO.tankName } });
  step('2. Kayıtlı olmayan bir kart okutulur — pompa AÇILMAZ', bad.status === 403 && bad.data?.details?.error === 'CARD_UNKNOWN', `pompa reddi: ${bad.data?.details?.error} (HTTP ${bad.status})`);

  // ── ADIM 3: geçerli kartla ikmal ─────────────────────────────────────────────
  await pause('D3+D4 — kayıtlı sürücü kartını okutacak ve 50 L ikmal yapacak');
  const auth = await http('POST', '/dispense/request-auth', { hw: true, body: { rfidCardId: DEMO.card, tankName: DEMO.tankName } });
  const sid = auth.data?.data?.sessionId;
  step('3. Sürücü kartını okutur — sistem sürücüyü ve aracı tanır, izin verilen litreyi söyler', auth.status === 200 && auth.data?.data?.state === 'AUTHORIZED' && auth.data.data.vehiclePlate === DEMO.plate && Number(auth.data.data.maxAllowedLiters) > 0, `${auth.data?.data?.driverName} · ${auth.data?.data?.vehiclePlate} · en fazla ${auth.data?.data?.maxAllowedLiters} L (${auth.data?.data?.state})`);
  const start = 5000 + Math.floor(Math.random() * 1000);
  const hb1 = await http('POST', '/dispense/heartbeat', { hw: true, body: { sessionId: sid, totalizerLiters: start, flowRateLpm: 25 } });
  const hb2 = await http('POST', '/dispense/heartbeat', { hw: true, body: { sessionId: sid, totalizerLiters: start + DEMO.dispenseLiters, flowRateLpm: 24 } });
  step('   Pompalama sürerken cihaz kısa aralıklarla "çalışıyorum" der; sistem devam komutu verir', hb1.data?.command === 'CONTINUE' && hb2.data?.command === 'CONTINUE' && hb2.data?.state === 'PUMPING', `komut: ${hb2.data?.command}, durum: ${hb2.data?.state}`);
  const key = `demo-provasi-${Date.now()}`;
  const fin = await http('POST', '/dispense/finalize', { hw: true, body: { sessionId: sid, endTotalizerLiters: start + DEMO.dispenseLiters, reportedLiters: DEMO.dispenseLiters, idempotencyKey: key } });
  step(`4. İkmal biter: sayaç farkından ${DEMO.dispenseLiters} L kaydedilir ve "doğrulandı" işaretlenir`, fin.status === 200 && Number(fin.data?.data?.amount_liters) === DEMO.dispenseLiters && fin.data.data.verification_status === 'DOĞRULANDI' && !!fin.data.data.hash_signature, `${fin.data?.data?.amount_liters} L · ${fin.data?.data?.verification_status} · mühür ${String(fin.data?.data?.hash_signature ?? '').slice(0, 12)}…`);

  // ── ADIM 5: panelde anında görünür ───────────────────────────────────────────
  await pause('D5 — panelde tank ve hareketleri yenileyin');
  const tanks2 = await http('GET', '/tanks', { token });
  const levelAfter = Number((tanks2.data.data ?? []).find((t) => t.id === DEMO.tankId)?.current_level_liters);
  const txs = await http('GET', '/transactions?limit=20', { token });
  const mine = (txs.data.data ?? []).find((t) => t.idempotency_key === key);
  step(`5. Panelde aynı anda: tank ${DEMO.dispenseLiters} L azalır, hareket listesinde yeni ikmal görünür`, Math.abs(levelBefore - levelAfter - DEMO.dispenseLiters) < 0.01 && !!mine && mine.vehicle_plate === DEMO.plate, `tank ${levelBefore} → ${levelAfter} L (fark ${(levelBefore - levelAfter).toFixed(0)} L) · listede: ${mine?.vehicle_plate} ${mine?.amount_liters} L`);

  // ── ADIM 6: internet kesintisi — çevrimdışı kuyruk, çift kayıt yok ──────────
  await pause('D6 — çevrimdışı biriken ikmaller gönderilecek');
  const base = Date.now();
  const recs = DEMO.offlineLiters.map((l, i) => ({ localSequenceId: base + i, deviceTimestamp: new Date(base - (DEMO.offlineLiters.length - i) * 60000).toISOString(), siteName: DEMO.site, vehiclePlate: DEMO.plate, tankName: DEMO.tankName, amountLiters: l, flowRateLpm: 24 }));
  const sync1 = await http('POST', '/telemetry/sync-batch', { hw: true, body: { records: recs } });
  const ok1 = (sync1.data.results ?? []).filter((r) => r.status === 'ACCEPTED').length;
  const sync2 = await http('POST', '/telemetry/sync-batch', { hw: true, body: { records: recs } });
  const dup2 = (sync2.data.results ?? []).filter((r) => r.status === 'DUPLICATE_SKIPPED').length;
  step(`6. İnternet kesintisi: cihaz ${recs.length} ikmali kendi hafızasında tutmuş; bağlantı gelince ikisi de işlenir, paket yeniden gönderilse ÇİFT kayıt olmaz`, sync1.status === 200 && ok1 === recs.length && dup2 === recs.length, `1. gönderim: ${ok1} kabul · 2. gönderim (tekrar): ${dup2} "zaten var" olarak atlandı`);

  // ── ADIM 7: rapor ─────────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const rep = await http('GET', `/reports/rep-711?startDate=${today}&endDate=${today}&siteName=${encodeURIComponent(DEMO.site)}`, { token });
  const rows = rep.data?.data?.rows ?? rep.data?.rows ?? rep.data?.data ?? [];
  step('7. Yönetici "İkmal Hareket Raporu"nu açar — bugünün ikmalleri satır satır listelenir', rep.status === 200 && Array.isArray(rows) && rows.length >= 1 + recs.length, `rapor durumu HTTP ${rep.status}, ${Array.isArray(rows) ? rows.length : '?'} satır (Gebze Ana Şantiye, bugün)`);

  // ── ADIM 8: firma verisi yalıtımı ─────────────────────────────────────────────
  const otherToken = await login(DEMO.otherTenantOwner);
  const otherTanks = await http('GET', '/tanks', { token: otherToken });
  const leaked = (otherTanks.data.data ?? []).some((t) => t.id === DEMO.tankId || t.tenant_id === 'comp-camsa');
  const otherTx = await http('GET', '/transactions?limit=200', { token: otherToken });
  const leakedTx = (otherTx.data.data ?? []).some((t) => t.idempotency_key === key);
  step('8. Başka bir firmanın yöneticisi giriş yapar — bizim tankımızı ve ikmalimizi GÖREMEZ', !!otherToken && otherTanks.status === 200 && !leaked && !leakedTx, `diğer firma: ${(otherTanks.data.data ?? []).length} tank görüyor, bizden sızan: ${leaked || leakedTx ? 'VAR' : 'yok'}`);

  if (json) console.log(JSON.stringify({ api: API, passed, total, steps }, null, 1));
  else console.log(`\nSONUÇ: ${passed}/${total} adım geçti.`);
  process.exit(passed === total ? 0 : 1);
}
main().catch((e) => { console.error('Provada beklenmeyen hata:', e); process.exit(2); });
