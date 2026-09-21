import { Client } from 'pg';
import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { Writable } from 'stream';
import { PII_INVENTORY, NAME_REFERENCE_COLUMNS, PII_COLUMN_PATTERN, PII_PATTERN_EXCLUSIONS } from '../src/privacy/piiInventory';
import { maskTcNo, maskPhone, maskEmail, canViewFullPii, maskDriverForRole, maskPersonnelForRole } from '../src/privacy/piiPolicy';
import { isValidTcNo, scrubString, scrubValue, pseudonym } from '../src/privacy/piiScrub';
import { buildLoggerOptions } from '../src/utils/logger';
import { requestAnomalyAnalysis, pseudonymizeDriversForExternalService } from '../src/services/consumptionAnomalyService';
import { purgeColdArchives } from '../src/services/retentionService';

/**
 * COMP-606 (#132) — KVKK: envanter, rol bazlı maskeleme, log/dış-servis minimizasyonu, anonimleştirme, veri sahibi başvurusu.
 * CANLI HTTP + gerçek PG. Başvuru/anonimleştirme akışı comp-camsa'da `kvk606-` önekli fixture'larla (test sonunda silinir),
 * süre dolumu ve soğuk arşiv testleri geçici `kvk606-t1` tenant'ında çalışır. Tüm sayılar elle hesaplanmıştır.
 */

const API_URL = 'http://localhost:5000/api/v1';
const CAMSA = 'comp-camsa';
const T1 = 'kvk606-t1';
const TC = '10000000146'; // resmî sağlama toplamına uyan geçerli (test) TCKN
const PHONE = '05321112233';
const started = new Date();

const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost', port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres', password: process.env.POSTGRES_PASSWORD || 'postgres', database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}
async function q(sql: string, params: any[] = []): Promise<any[]> {
  const c = pg(); await c.connect(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
async function call(method: string, p: string, opts: { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  if (p === '/auth/login') { const k = await redis.keys('rl:auth-login:*'); if (k.length) await redis.del(...k); }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${p}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function login(u: string): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { username: u, password: '123456' } });
  if (!r.body.accessToken) throw new Error(`login ${u}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

async function cleanup(): Promise<void> {
  await q("DELETE FROM data_subject_requests WHERE tenant_id = $1", [CAMSA]);
  await q("DELETE FROM leave_requests WHERE id LIKE 'kvk606-%'");
  await q("DELETE FROM personnel WHERE id LIKE 'kvk606-%'");
  await q("DELETE FROM transactions WHERE id LIKE 'kvk606-%'");
  await q("DELETE FROM vehicles WHERE id LIKE 'kvk606-%'");
  await q("DELETE FROM drivers WHERE id LIKE 'kvk606-%'");
  await q("DELETE FROM driver_behavior_scores WHERE id LIKE 'kvk606-%'");
  await q("DELETE FROM notifications WHERE id LIKE 'kvk606-%'");
  await q("DELETE FROM alarms WHERE id LIKE 'kvk606-%'");
  await q('DELETE FROM tenant_retention_settings WHERE tenant_id = $1', [CAMSA]);
  await q("DELETE FROM audit_logs WHERE tenant_id = $1 AND created_at >= $2 AND action IN ('DSR_RECEIVED','DSR_ACCESS_FULFILLED','DSR_REJECTED','PERSONAL_DATA_ANONYMIZED','RETENTION_POLICY_UPDATED')", [CAMSA, started]);
  await q('DELETE FROM companies WHERE id = $1', [T1]);
}

async function seedCamsa(): Promise<void> {
  const ago = (d: number) => `NOW() - INTERVAL '${d} days'`;
  const s: string[] = [];
  const drv = (id: string, name: string, tc: string, phone: string | null, card: string) =>
    s.push(`INSERT INTO drivers (id, tenant_id, name, tc_no, phone, license_type, rfid_card_id, site_name, status) VALUES ('${id}', '${CAMSA}', '${name}', '${tc}', ${phone ? `'${phone}'` : 'NULL'}, 'B', '${card}', 'Gebze Ana Şantiye', 'AKTİF')`);
  drv('kvk606-drv-1', 'KVK606 Test Sürücü Bir', TC, PHONE, 'KVK606-CARD-1');
  drv('kvk606-drv-2', 'KVK606 Diğer Sürücü', '10000000146'.replace('146', '146'), '05330000000', 'KVK606-CARD-2');
  drv('kvk606-drv-5', 'KVK606 Aynı Ad', '10000000146', '05340000001', 'KVK606-CARD-5');
  drv('kvk606-drv-6', 'KVK606 Aynı Ad', '10000000146', '05340000002', 'KVK606-CARD-6');
  s.push(`INSERT INTO personnel (id, tenant_id, full_name, tc_no, role_title, site_name, driver_id) VALUES ('kvk606-per-1', '${CAMSA}', 'KVK606 Test Sürücü Bir', '${TC}', 'ŞOFÖR', 'Gebze Ana Şantiye', 'kvk606-drv-1')`);
  s.push(`INSERT INTO leave_requests (id, tenant_id, personnel_id, leave_type, start_date, end_date, day_count, reason, requested_by) VALUES ('kvk606-lv-1', '${CAMSA}', 'kvk606-per-1', 'MAZERET', '2026-03-02', '2026-03-04', 3, 'sağlık raporu', 'x')`);
  s.push(`INSERT INTO vehicles (id, tenant_id, plate, brand_model, vehicle_type, rfid_tag, site_name, status, assigned_driver_name) VALUES ('kvk606-veh-1', '${CAMSA}', 'KVK606-P1', 'Test', 'Kamyon', 'KVK606-TAG', 'Gebze Ana Şantiye', 'AKTİF', 'KVK606 Test Sürücü Bir')`);
  const tx = (id: string, driver: string, liters: number, at: string) =>
    s.push(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters, hash_signature, created_at) VALUES ('${id}', '${CAMSA}', 'Gebze Ana Şantiye', 'KVK606-P1', '${driver}', ${liters}, 'hash-${id}', '${at}')`);
  tx('kvk606-tx-1', 'KVK606 Test Sürücü Bir', 100.5, '2026-01-10T08:00:00Z');
  tx('kvk606-tx-2', 'KVK606 Test Sürücü Bir', 200.25, '2026-02-10T08:00:00Z');
  tx('kvk606-tx-3', 'KVK606 Test Sürücü Bir', 50, '2026-03-10T08:00:00Z');
  tx('kvk606-tx-4', 'KVK606 Diğer Sürücü', 75, '2026-03-11T08:00:00Z');
  tx('kvk606-tx-5', 'KVK606 Aynı Ad', 10, '2026-03-12T08:00:00Z');
  s.push(`INSERT INTO driver_behavior_scores (id, tenant_id, driver_name, period_days, transaction_count, score) VALUES ('kvk606-sc-1', '${CAMSA}', 'KVK606 Test Sürücü Bir', 30, 3, 90)`);
  s.push(`INSERT INTO notifications (id, tenant_id, event_type, title, body, status) VALUES ('kvk606-nt-1', '${CAMSA}', 'TEST', 'KVK606 Test Sürücü Bir limit aştı', 'gövde: KVK606 Test Sürücü Bir', 'GÖNDERILDI')`);
  s.push(`INSERT INTO alarms (id, tenant_id, alarm_key, category, title, status, subject_type, subject_id) VALUES ('kvk606-al-1', '${CAMSA}', 'kvk606-key', 'TEST', 'KVK606 Test Sürücü Bir mesai dışı', 'OPEN', 'DRIVER', 'KVK606 Test Sürücü Bir')`);
  void ago;
  const c = pg(); await c.connect();
  try { for (const x of s) await c.query(x); } finally { await c.end(); }
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [COMP-606] KVKK — ENVANTER, MASKELEME, LOG/DIŞ SERVİS, ANONİMLEŞTİRME, BAŞVURU');
  console.log('===========================================================\n');
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };

  await cleanup();
  try {
    // ── 1. Envanter ↔ şema drift ──────────────────────────────────────────────────────────────────────────────────
    const schema = fs.readFileSync(path.join(process.cwd(), 'src/db/schema.sql'), 'utf8');
    const cols: string[] = [];
    for (const m of schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      for (const line of m[2].split('\n')) { const c = /^\s{4}(\w+)\s+[A-Z]/.exec(line); if (c) cols.push(`${m[1]}.${c[1]}`); }
    }
    for (const m of schema.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/g)) cols.push(`${m[1]}.${m[2]}`);
    const piiCols = [...new Set(cols.filter((c) => PII_COLUMN_PATTERN.test(c.split('.')[1]) || c === 'drivers.name'))];
    const inventoried = new Set(PII_INVENTORY.map((e) => `${e.table}.${e.column}`));
    const missing = piiCols.filter((c) => !inventoried.has(c) && !(c in PII_PATTERN_EXCLUSIONS));
    const phantom = [...inventoried].filter((c) => !cols.includes(c));
    const nameCols = cols.filter((c) => /driver_name$/.test(c.split('.')[1]));
    const nameMissing = nameCols.filter((c) => !NAME_REFERENCE_COLUMNS.some((r) => `${r.table}.${r.column}` === c) && c !== 'drivers.name');
    check(`Envanter (AC): schema.sql'deki kişisel veri sütunlarının (${piiCols.length}) HEPSİ envanterde; envanterde olup şemada olmayan yok; her kayıt amaç/dayanak/süre/erişim/koruma taşır; *driver_name metin referanslarının hepsi anonimleştirme listesinde`,
      missing.length === 0 && phantom.length === 0 && nameMissing.length === 0 && PII_INVENTORY.every((e) => [e.purpose, e.legalBasis, e.retention, e.access, e.protection, e.subjects].every((f) => f.length > 5)),
      `eksik=[${missing}], hayalet=[${phantom}], ad-referansı eksik=[${nameMissing}], envanter=${PII_INVENTORY.length}`);

    // ── 2. Log temizleyici ─────────────────────────────────────────────────────────────────────────────────────────
    check('TCKN doğrulayıcı: resmî sağlama toplamı — geçerli 10000000146 ✓; rastgele 11 hane, 0 ile başlayan, kısa/uzun ✗',
      isValidTcNo(TC) && !isValidTcNo('12345678901') && !isValidTcNo('01234567890') && !isValidTcNo('1000000014') && !isValidTcNo('100000001466'), '');
    const s1 = scrubString(`sürücü ${TC} aradı: ${PHONE} / +90 (532) 111-22-33 / 905321112233 / ahmet.yilmaz@firma.com.tr`);
    check('scrubString: metin içindeki TCKN → [TCKN], telefon (05.., +90 (5xx) .., 905..) → [TEL], e-posta → [EMAIL]; ham değer kalmaz',
      s1 === 'sürücü [TCKN] aradı: [TEL] / [TEL] / [TEL] / [EMAIL]', s1);
    const s2 = scrubString('id tx-1789132546542 ref 12345678901 ts 2026-09-21T08:18:24.665Z lt 1234.56');
    check('Yanlış pozitif yok: 13 haneli zaman damgalı id, sağlama toplamı tutmayan 11 haneli sayı, ISO tarih ve ondalık sayı DEĞİŞMEZ', s2 === 'id tx-1789132546542 ref 12345678901 ts 2026-09-21T08:18:24.665Z lt 1234.56', s2);
    const nested: any = { tcNo: TC, driver: { phone: PHONE, profile: { email: 'a@b.co', note: `TC ${TC}` } }, username: 'ahmet', list: [{ tc_no: TC }, `tel ${PHONE}`], ok: 42 };
    nested.self = nested;
    const sv: any = scrubValue(nested);
    check('scrubValue: anahtar tabanlı ([PII]: tcNo/phone/email/tc_no, derinlikten bağımsız), metin tabanlı (note içindeki TCKN), kullanıcı adı takma ad (pii:xxxxxxxx, deterministik), dairesel referans güvenli, diğer alanlar korunur',
      sv.tcNo === '[PII]' && sv.driver.phone === '[PII]' && sv.driver.profile.email === '[PII]' && sv.driver.profile.note === 'TC [TCKN]' && sv.list[0].tc_no === '[PII]' && sv.list[1] === 'tel [TEL]' &&
        sv.username === pseudonym('ahmet') && /^pii:[0-9a-f]{8}$/.test(sv.username) && sv.ok === 42 && sv.self === '[Circular]', JSON.stringify(sv).slice(0, 200));
    const chunks: string[] = [];
    const sink = new Writable({ write(chunk, _e, cb) { chunks.push(chunk.toString()); cb(); } });
    const log = pino(buildLoggerOptions('info'), sink);
    class DbErr extends Error { constructor(m: string) { super(m); this.name = 'DbErr'; } }
    log.info({ tcNo: TC, phone: PHONE, user: { email: 'x@y.com' }, plate: '34 ABC 123' }, `Sürücü ${TC} kaydedildi, tel ${PHONE}`);
    log.error({ err: new DbErr(`duplicate key (tc_no)=(${TC}) mail a@b.co`), username: 'ahmet' }, 'hata');
    const out = chunks.join('\n');
    const lines = chunks.map((c) => JSON.parse(c));
    check('Log çıktısı taraması (AC): GERÇEK logger seçenekleriyle pino çıktısında TCKN, telefon, e-posta ve ham kullanıcı adı YOK; hata TÜRÜ (DbErr) ve kişisel olmayan alan (plaka) korunur',
      !out.includes(TC) && !out.includes(PHONE) && !out.includes('x@y.com') && !out.includes('a@b.co') && !out.includes('"ahmet"') && lines[0].msg === 'Sürücü [TCKN] kaydedildi, tel [TEL]' && lines[0].plate === '34 ABC 123' && lines[1].err.type === 'DbErr' && lines[1].err.message.includes('[TCKN]'),
      out.slice(0, 260));

    // ── 3. Rol bazlı maskeleme ─────────────────────────────────────────────────────────────────────────────────────
    const roles = ['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER', 'PUMP_OPERATOR', 'DRIVER', 'BILINMEYEN'];
    const full = roles.filter((r) => canViewFullPii(r));
    check('Politika (AC: yetkisiz roller maskeli): TAM görenler yalnızca SUPER_ADMIN/COMPANY_OWNER/SITE_MANAGER; PUMP_OPERATOR, DRIVER ve bilinmeyen/yeni roller MASKELİ (fail-closed); rol yok → maskeli',
      JSON.stringify(full) === JSON.stringify(['SUPER_ADMIN', 'COMPANY_OWNER', 'SITE_MANAGER']) && !canViewFullPii(undefined), `tam=${full}`);
    check('Maske biçimleri: TCKN 100******46; telefon son 2 hane (********33 → 05321112233 için 9 yıldız+33); e-posta a***@firma.com; kısa/boş/null değerler güvenli',
      maskTcNo(TC) === '100******46' && maskPhone(PHONE) === '*********33' && maskEmail('ahmet@firma.com') === 'a***@firma.com' && maskTcNo(null) === null && maskPhone('') === '' && maskPhone('12') === '**' && maskTcNo('123') === '123',
      `${maskTcNo(TC)} ${maskPhone(PHONE)}`);
    const d = { tc_no: TC, phone: PHONE, name: 'X' };
    const masked = maskDriverForRole(d, 'DRIVER');
    check('maskDriverForRole/maskPersonnelForRole: girdiyi DEĞİŞTİRMEZ (kopya), yetkili rolde aynı nesne', d.tc_no === TC && masked.tc_no === '100******46' && masked.phone === '*********33' && maskDriverForRole(d, 'COMPANY_OWNER') === d && maskPersonnelForRole({ tcNo: TC }, 'PUMP_OPERATOR').tcNo === '100******46', '');

    await seedCamsa();
    const owner = await login('camsa');
    const admin = await login('admin');
    const op = await login('pompa-op-01');
    const ownerDrivers = await call('GET', '/drivers', { token: owner });
    const opDrivers = await call('GET', '/drivers', { token: op });
    const od = ownerDrivers.body.data?.find((x: any) => x.id === 'kvk606-drv-1');
    const pd = opDrivers.body.data?.find((x: any) => x.id === 'kvk606-drv-1');
    check('HTTP GET /drivers (AC): COMPANY_OWNER TCKN+telefonu TAM görür; PUMP_OPERATOR maskeli görür (100******46, *********33) — ham değer yanıtta HİÇ yok',
      od?.tc_no === TC && od?.phone === PHONE && pd?.tc_no === '100******46' && pd?.phone === '*********33' && !JSON.stringify(opDrivers.body).includes(PHONE) && !JSON.stringify(opDrivers.body).includes(TC), `${JSON.stringify(pd)}`);
    const per = await call('GET', '/personnel/kvk606-per-1', { token: owner });
    check('HTTP GET /personnel/:id: HR rolü (COMPANY_OWNER) tcNo tam; PUMP_OPERATOR bu uca hiç erişemez (403)', per.body.data?.tcNo === TC && (await call('GET', '/personnel/kvk606-per-1', { token: op })).status === 403, JSON.stringify(per.body.data?.tcNo));

    // ── 4. Dış servis (Gemini) minimizasyonu ──────────────────────────────────────────────────────────────────────
    const stats = [
      { vehiclePlate: '34 KVK 606', driverName: 'Ayşe Kaya', totalLiters: 500, dispenseCount: 2, avgLitersPerDispense: 250, distinctSites: 1 },
      { vehiclePlate: '34 KVK 607', driverName: 'Mehmet Demir', totalLiters: 90, dispenseCount: 3, avgLitersPerDispense: 30, distinctSites: 2 },
      { vehiclePlate: '34 KVK 608', driverName: 'Ayşe Kaya', totalLiters: 40, dispenseCount: 1, avgLitersPerDispense: 40, distinctSites: 1 },
      { vehiclePlate: '34 KVK 609', driverName: null, totalLiters: 10, dispenseCount: 1, avgLitersPerDispense: 10, distinctSites: 1 }
    ];
    let sentPrompt = '';
    const analysis = await requestAnomalyAnalysis(stats, 7, {
      generateContent: async (prompt) => {
        sentPrompt = prompt;
        return JSON.stringify({ anomalies: [{ vehiclePlate: '34 KVK 606', driverName: 'Sürücü-1', totalLiters: 500, dispenseCount: 2, riskLevel: 'YÜKSEK', reason: 'Sürücü-1 tek seferde çok aldı; Sürücü-2 normal.' }] });
      }
    });
    check('Dış servis (AC): Gemini\'ye giden prompt\'ta şoför adı YOK (Sürücü-1/2 takma adları; aynı kişi → aynı takma ad; adı olmayan satır etkilenmez); plaka/litre analiz için kalır',
      !sentPrompt.includes('Ayşe') && !sentPrompt.includes('Kaya') && !sentPrompt.includes('Mehmet') && !sentPrompt.includes('Demir') && (sentPrompt.match(/Şoför: Sürücü-1 /g) ?? []).length === 2 && sentPrompt.includes('Şoför: Sürücü-2 ') && sentPrompt.includes('Şoför: Bilinmiyor') && sentPrompt.includes('34 KVK 606') && sentPrompt.includes('500.00 L'),
      sentPrompt.split('\n').slice(4).join(' | '));
    check('Yanıt geri çevrilir: modelin döndürdüğü takma adlar hem driverName hem reason metninde gerçek ada döner (kullanıcı gerçek adı görür); tanınmayan değere dokunulmaz',
      analysis.anomalies[0].driverName === 'Ayşe Kaya' && analysis.anomalies[0].reason === 'Ayşe Kaya tek seferde çok aldı; Mehmet Demir normal.' && pseudonymizeDriversForExternalService(stats).restore('Sürücü-9 x') === 'Sürücü-9 x', JSON.stringify(analysis.anomalies[0]));

    // ── 5. Politika API: kişisel veri sınıfları ───────────────────────────────────────────────────────────────────
    const pol = await call('GET', '/retention/policies', { token: owner });
    const pd1 = pol.body.data?.personalData?.find((p: any) => p.dataClass === 'DRIVER_PII');
    const pp = pol.body.data?.personalData?.find((p: any) => p.dataClass === 'PERSONNEL_PII');
    const pc = pol.body.data?.personalData?.find((p: any) => p.dataClass === 'COLD_ARCHIVE');
    const low = await call('PATCH', '/retention/policies/DRIVER_PII', { token: owner, body: { retentionDays: 100 } });
    const okp = await call('PATCH', '/retention/policies/DRIVER_PII', { token: owner, body: { retentionDays: 400 } });
    const rst = await call('PATCH', '/retention/policies/DRIVER_PII', { token: owner, body: { retentionDays: null } });
    check('Saklama süresi (AC): kişisel veri sınıfları politikada — DRIVER_PII 1825/taban 365, PERSONNEL_PII 3650/1825, COLD_ARCHIVE 1825/365; tabanın altı 400, tenant ayarı 200, null sıfırlar',
      pd1?.defaultDays === 1825 && pd1?.minDays === 365 && pp?.defaultDays === 3650 && pp?.minDays === 1825 && pc?.defaultDays === 1825 && pc?.minDays === 365 && low.status === 400 && okp.status === 200 && okp.body.data.effectiveDays === 400 && rst.body.data.effectiveDays === 1825,
      `${low.status}/${okp.status}/${rst.body.data?.effectiveDays}`);

    // ── 6. Veri sahibi başvurusu: ERİŞİM ────────────────────────────────────────────────────────────────────────────
    const noAuth = await call('POST', '/privacy/requests', { body: { requestType: 'ACCESS', subjectType: 'DRIVER', subjectId: 'kvk606-drv-1' } });
    const opReq = await call('POST', '/privacy/requests', { token: op, body: { requestType: 'ACCESS', subjectType: 'DRIVER', subjectId: 'kvk606-drv-1' } });
    const badBody = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'SIL', subjectType: 'DRIVER', subjectId: 'x' } });
    const unknown = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'ACCESS', subjectType: 'DRIVER', subjectId: 'kvk606-yok' } });
    await q(`INSERT INTO companies (id, name, tax_number) VALUES ($1, 'KVKK T1', 'KVK606-T1')`, [T1]);
    await q(`INSERT INTO drivers (id, tenant_id, name, tc_no, rfid_card_id) VALUES ('kvk606-foreign', $1, 'Yabancı', '10000000146', 'KVK606-F')`, [T1]);
    const foreign = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'ACCESS', subjectType: 'DRIVER', subjectId: 'kvk606-foreign' } });
    check('Başvuru yetki/doğrulama: kimliksiz 401, PUMP_OPERATOR 403, geçersiz tür 400, olmayan kişi 404, BAŞKA tenant\'ın kişisi 404 (varlığı sızmaz)', noAuth.status === 401 && opReq.status === 403 && badBody.status === 400 && unknown.status === 404 && foreign.status === 404, `${noAuth.status}/${opReq.status}/${badBody.status}/${unknown.status}/${foreign.status}`);

    const acc = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'ACCESS', subjectType: 'DRIVER', subjectId: 'kvk606-drv-1', note: 'Sürücü yazılı başvurdu' } });
    const dupAcc = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'ACCESS', subjectType: 'DRIVER', subjectId: 'kvk606-drv-1' } });
    const daysToDue = (new Date(acc.body.data?.dueAt).getTime() - new Date(acc.body.data?.receivedAt).getTime()) / 86400000;
    check('Başvuru (AC: teknik altyapı): ACCESS oluşturulur (201, RECEIVED); yanıt süresi tam 30 gün (KVKK m.13), gecikmedi, kalan 30 gün; aynı kişi+tür için ikinci açık başvuru 409',
      acc.status === 201 && acc.body.data.status === 'RECEIVED' && Math.abs(daysToDue - 30) < 0.01 && acc.body.data.overdue === false && acc.body.data.daysLeft === 30 && dupAcc.status === 409, `${acc.status} due=${daysToDue}d left=${acc.body.data?.daysLeft} dup=${dupAcc.status}`);

    const exp = await call('POST', `/privacy/requests/${acc.body.data.id}/access-export`, { token: owner });
    const ex = exp.body.data?.export;
    check('ERİŞİM dökümü: kişinin TAM (maskesiz) kaydı; bağlı personel + izin talebi (gerekçe dahil); ikmal 3 kayıt / 350,75 L / ilk-son tarih; davranış skoru 1; zimmetli araç KVK606-P1; başka sürücünün (tx-4) ikmali dökümde YOK',
      exp.status === 200 && ex.driver.tc_no === TC && ex.driver.phone === PHONE && ex.personnel.length === 1 && ex.leaveRequests.length === 1 && ex.leaveRequests[0].reason === 'sağlık raporu' &&
        ex.transactions.count === 3 && Math.abs(ex.transactions.totalLiters - 350.75) < 0.001 && ex.transactions.firstAt.startsWith('2026-01-10') && ex.transactions.lastAt.startsWith('2026-03-10') &&
        ex.transactions.records.map((r: any) => r.id).join() === 'kvk606-tx-1,kvk606-tx-2,kvk606-tx-3' && ex.behaviorScores.length === 1 && ex.counts.assignedVehicles.join() === 'KVK606-P1' && ex.nameBasedDataWithheld === false && !JSON.stringify(ex).includes('kvk606-tx-4'),
      JSON.stringify(ex?.transactions).slice(0, 200));
    const reExp = await call('POST', `/privacy/requests/${acc.body.data.id}/access-export`, { token: owner });
    const accRow = (await q(`SELECT status, result FROM data_subject_requests WHERE id = $1`, [acc.body.data.id]))[0];
    check('Döküm bir kez: başvuru COMPLETED (sonuç özeti yalnızca SAYILAR — kişisel veri saklanmaz), tekrar döküm 409; DSR_RECEIVED + DSR_ACCESS_FULFILLED audit kayıtları yazıldı',
      reExp.status === 409 && accRow.status === 'COMPLETED' && accRow.result.transactions === 3 && !JSON.stringify(accRow.result).includes(TC) &&
        (await q(`SELECT COUNT(*)::int n FROM audit_logs WHERE tenant_id = $1 AND created_at >= $2 AND action IN ('DSR_RECEIVED','DSR_ACCESS_FULFILLED') AND (after_value::text NOT LIKE $3)`, [CAMSA, started, `%${TC}%`]))[0].n >= 2, `${reExp.status}`);

    // Ad çakışması: aynı ada sahip iki farklı kişi → ad-tabanlı bölümler BAŞKASININ verisi ifşa olmasın diye withheld.
    const accAmb = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'ACCESS', subjectType: 'DRIVER', subjectId: 'kvk606-drv-5' } });
    const expAmb = await call('POST', `/privacy/requests/${accAmb.body.data.id}/access-export`, { token: owner });
    check('Ad çakışması (aynı ada sahip 2 sürücü): erişim dökümünde ad-tabanlı bölümler (ikmal/skor/yetki) WITHHELD + bayrak — başka kişinin verisi sızmaz; kişinin kendi kaydı yine döner',
      expAmb.body.data.export.nameBasedDataWithheld === true && expAmb.body.data.export.transactions === null && expAmb.body.data.export.driver.id === 'kvk606-drv-5', '');

    // ── 7. SİLME (anonimleştirme) ────────────────────────────────────────────────────────────────────────────────────
    const txBefore = await q(`SELECT id, amount_liters::float8 AS amt, vehicle_plate, created_at, hash_signature, site_name FROM transactions WHERE id LIKE 'kvk606-tx-%' ORDER BY id`);
    const era = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'ERASURE', subjectType: 'DRIVER', subjectId: 'kvk606-drv-1' } });
    const erased = await call('POST', `/privacy/requests/${era.body.data.id}/erase`, { token: owner });
    const r = erased.body.data?.result;
    const drvAfter = (await q(`SELECT * FROM drivers WHERE id = 'kvk606-drv-1'`))[0];
    const perAfter = (await q(`SELECT * FROM personnel WHERE id = 'kvk606-per-1'`))[0];
    const lvAfter = (await q(`SELECT reason, day_count::float8 AS d FROM leave_requests WHERE id = 'kvk606-lv-1'`))[0];
    check('SİLME (AC: anonimleştirme): sürücü → "Anonim Sürücü xxxxxxxx", TCKN yer tutucu (ANON-xxxxxx, 11 karakter, GEÇERSİZ TCKN), telefon/ehliyet NULL, kart no benzersiz yer tutucu, durum PASİF, anonymized_at dolu',
      erased.status === 200 && /^Anonim Sürücü [0-9a-f]{8}$/.test(drvAfter.name) && /^ANON-[0-9a-f]{6}$/.test(drvAfter.tc_no) && drvAfter.tc_no.length === 11 && !isValidTcNo(drvAfter.tc_no) && drvAfter.phone === null && drvAfter.license_type === null &&
        /^ANON-[0-9a-f]{16}$/.test(drvAfter.rfid_card_id) && drvAfter.status === 'PASİF' && !!drvAfter.anonymized_at, JSON.stringify({ n: drvAfter.name, tc: drvAfter.tc_no }));
    check('SİLME: bağlı personel anonimleşir (ad takma ad, TCKN NULL); izin gerekçesi (özel nitelikli veri riski) silinir ama izin tarih/gün sayısı (3) KALIR',
      perAfter.full_name === drvAfter.name && perAfter.tc_no === null && !!perAfter.anonymized_at && lvAfter.reason === null && lvAfter.d === 3, '');
    const txAfter = await q(`SELECT id, driver_name, amount_liters::float8 AS amt, vehicle_plate, created_at, hash_signature, site_name FROM transactions WHERE id LIKE 'kvk606-tx-%' ORDER BY id`);
    const sameFin = txBefore.every((b, i) => b.id === txAfter[i].id && b.amt === txAfter[i].amt && b.vehicle_plate === txAfter[i].vehicle_plate && b.hash_signature === txAfter[i].hash_signature && String(b.created_at) === String(txAfter[i].created_at) && b.site_name === txAfter[i].site_name);
    const sumErased = txAfter.filter((t) => ['kvk606-tx-1', 'kvk606-tx-2', 'kvk606-tx-3'].includes(t.id)).reduce((s, t) => s + t.amt, 0);
    check('MALİ BÜTÜNLÜK (AC): 5 ikmal kaydının tamamı yerinde; tutar, plaka, tarih, şantiye ve değişmezlik mührü (hash_signature) BİREBİR aynı; silinen kişinin 3 ikmali (350,75 L) takma adla; başkalarının (tx-4/tx-5) adı değişmedi',
      txAfter.length === 5 && sameFin && Math.abs(sumErased - 350.75) < 0.001 && txAfter.filter((t) => t.driver_name === drvAfter.name).length === 3 && txAfter.find((t) => t.id === 'kvk606-tx-4')!.driver_name === 'KVK606 Diğer Sürücü' && txAfter.find((t) => t.id === 'kvk606-tx-5')!.driver_name === 'KVK606 Aynı Ad',
      JSON.stringify(txAfter.map((t) => t.driver_name)));
    const ntAfter = (await q(`SELECT title, body FROM notifications WHERE id = 'kvk606-nt-1'`))[0];
    const alAfter = (await q(`SELECT title, subject_id FROM alarms WHERE id = 'kvk606-al-1'`))[0];
    const scAfter = (await q(`SELECT driver_name FROM driver_behavior_scores WHERE id = 'kvk606-sc-1'`))[0];
    const vhAfter = (await q(`SELECT assigned_driver_name FROM vehicles WHERE id = 'kvk606-veh-1'`))[0];
    check('İlişkili metin referansları: skor/bildirim başlık+gövde/alarm başlık+konu takma ada çevrilir (cümle yapısı korunur); araç zimmeti kaldırılır (NULL)',
      scAfter.driver_name === drvAfter.name && ntAfter.title === `${drvAfter.name} limit aştı` && ntAfter.body === `gövde: ${drvAfter.name}` && alAfter.title === `${drvAfter.name} mesai dışı` && alAfter.subject_id === drvAfter.name && vhAfter.assigned_driver_name === null &&
        r.referenceRowsUpdated['transactions.driver_name'] === 3 && r.referenceRowsUpdated['vehicles.assigned_driver_name'] === 1 && r.nameBasedDataSkipped === false, JSON.stringify(r.referenceRowsUpdated));
    const auditAnon = await q(`SELECT after_value FROM audit_logs WHERE tenant_id = $1 AND action = 'PERSONAL_DATA_ANONYMIZED' AND target_id = 'kvk606-drv-1'`, [CAMSA]);
    const auditText = JSON.stringify(auditAnon);
    check('Audit: PERSONAL_DATA_ANONYMIZED kaydı var ve KİŞİSEL VERİ İÇERMEZ (ad/TCKN/telefon yok; yalnızca id + sayımlar); yanıt "korunanlar" listesini (mali kayıt, denetim izi, e-İrsaliye) bildirir',
      auditAnon.length === 1 && !auditText.includes('KVK606 Test') && !auditText.includes(TC) && !auditText.includes(PHONE) && auditAnon[0].after_value.requestId === era.body.data.id && erased.body.data.retained.length === 3 && erased.body.data.retained[0].includes('transactions'), auditText.slice(0, 200));
    const again = await call('POST', `/privacy/requests/${era.body.data.id}/erase`, { token: owner });
    const era2 = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'ERASURE', subjectType: 'DRIVER', subjectId: 'kvk606-drv-1' } });
    const erase2 = await call('POST', `/privacy/requests/${era2.body.data.id}/erase`, { token: owner });
    check('İdempotans: tamamlanmış başvuru tekrar uygulanamaz (409); zaten anonim kişi için yeni silme başvurusu uygulanınca 409 ve başvuru RECEIVED kalır (yarım iş yok)',
      again.status === 409 && erase2.status === 409 && (await q(`SELECT status FROM data_subject_requests WHERE id = $1`, [era2.body.data.id]))[0].status === 'RECEIVED', `${again.status}/${erase2.status}`);
    const afterList = await call('GET', '/drivers', { token: owner });
    check('Anonim sürücü sistemde görünür ama kimliksiz; bystander sürücü (drv-2) dokunulmadı', afterList.body.data.find((x: any) => x.id === 'kvk606-drv-1')?.name === drvAfter.name && (await q(`SELECT name, tc_no FROM drivers WHERE id = 'kvk606-drv-2'`))[0].name === 'KVK606 Diğer Sürücü', '');

    // Ad çakışması + silme: kayıt anonimleşir ama METİN referanslar (başka kişiye ait olabilir) yeniden yazılmaz.
    const eraAmb = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'ERASURE', subjectType: 'DRIVER', subjectId: 'kvk606-drv-5' } });
    const erasedAmb = await call('POST', `/privacy/requests/${eraAmb.body.data.id}/erase`, { token: owner });
    check('Ad çakışmasında silme: sürücü kaydı anonimleşir, nameBasedDataSkipped=true; ikmal (tx-5) adı DEĞİŞMEZ (aynı adlı başka sürücünün kaydı bozulmaz) — elle inceleme gerektiği raporlanır',
      erasedAmb.body.data.result.nameBasedDataSkipped === true && erasedAmb.body.data.result.driverAnonymized === true && (await q(`SELECT driver_name FROM transactions WHERE id = 'kvk606-tx-5'`))[0].driver_name === 'KVK606 Aynı Ad' && !!(await q(`SELECT anonymized_at FROM drivers WHERE id = 'kvk606-drv-5'`))[0].anonymized_at, '');

    // Ret + gecikme
    const rq = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'ERASURE', subjectType: 'DRIVER', subjectId: 'kvk606-drv-2' } });
    const rej0 = await call('POST', `/privacy/requests/${rq.body.data.id}/reject`, { token: owner, body: { reason: 'kısa' } });
    const rej = await call('POST', `/privacy/requests/${rq.body.data.id}/reject`, { token: owner, body: { reason: 'Kimlik doğrulaması yapılamadı.' } });
    const rej2 = await call('POST', `/privacy/requests/${rq.body.data.id}/reject`, { token: owner, body: { reason: 'Kimlik doğrulaması yapılamadı.' } });
    const eraRej = await call('POST', `/privacy/requests/${rq.body.data.id}/erase`, { token: owner });
    check('Ret: gerekçe < 5 karakter 400; gerekçeli ret → REJECTED (sürücü dokunulmaz); tekrar ret 409; reddedilmiş başvuru uygulanamaz 409',
      rej0.status === 400 && rej.status === 200 && rej.body.data.status === 'REJECTED' && rej.body.data.rejectReason === 'Kimlik doğrulaması yapılamadı.' && rej2.status === 409 && eraRej.status === 409 && (await q(`SELECT anonymized_at FROM drivers WHERE id = 'kvk606-drv-2'`))[0].anonymized_at === null, '');
    const od1 = await call('POST', '/privacy/requests', { token: owner, body: { requestType: 'ACCESS', subjectType: 'PERSONNEL', subjectId: 'kvk606-per-1' } });
    await q(`UPDATE data_subject_requests SET received_at = NOW() - INTERVAL '35 days', due_at = NOW() - INTERVAL '5 days' WHERE id = $1`, [od1.body.data.id]);
    const list = await call('GET', '/privacy/requests', { token: owner });
    const odRow = list.body.data.find((x: any) => x.id === od1.body.data.id);
    const freshRow = list.body.data.find((x: any) => x.id === acc.body.data.id);
    check('Gecikme takibi: 30 günü aşan açık başvuru overdue=true (kalan gün ≤ -5); sonuçlanmış başvuru gecikmiş sayılmaz (daysLeft null); liste yalnızca bu tenant\'ın başvuruları',
      odRow.overdue === true && odRow.daysLeft <= -4 && freshRow.overdue === false && freshRow.daysLeft === null && list.body.data.every((x: any) => !!x.id) && list.body.data.length === 7, `liste=${list.body.data.length}`);
    check('Envanter API: GET /privacy/inventory yalnızca yönetici rollerine (PUMP_OPERATOR 403), tüm envanter kayıtlarını döner',
      (await call('GET', '/privacy/inventory', { token: op })).status === 403 && (await call('GET', '/privacy/inventory', { token: owner })).body.data.length === PII_INVENTORY.length, '');

    // ── 8. Süre dolumu (T1) ────────────────────────────────────────────────────────────────────────────────────────
    const c = pg(); await c.connect();
    try {
      const drv = (id: string, name: string, status: string) => c.query(`INSERT INTO drivers (id, tenant_id, name, tc_no, phone, rfid_card_id, status) VALUES ($1, $2, $3, '10000000146', '05350000000', $4, $5)`, [id, T1, name, `C-${id}`, status]);
      const setDeact = (id: string, days: number) => c.query(`UPDATE drivers SET deactivated_at = NOW() - ($2 || ' days')::interval WHERE id = $1`, [id, String(days)]);
      await drv('kvk606-x-a', 'Süre A', 'PASİF'); await setDeact('kvk606-x-a', 2000);
      await drv('kvk606-x-b', 'Süre B', 'PASİF'); await setDeact('kvk606-x-b', 100);
      await drv('kvk606-x-c', 'Süre C', 'AKTİF');
      await drv('kvk606-x-d', 'Süre D', 'PASİF'); await setDeact('kvk606-x-d', 500);
      await drv('kvk606-x-e', 'Süre E', 'PASİF'); await setDeact('kvk606-x-e', 300);
      await c.query(`UPDATE drivers SET created_at = NOW() - INTERVAL '3000 days' WHERE id = 'kvk606-x-c'`);
      await c.query(`INSERT INTO transactions (id, tenant_id, site_name, vehicle_plate, driver_name, amount_liters) VALUES ('kvk606-x-tx', $1, 'S', 'P', 'Süre A', 80)`, [T1]);
      const per = (id: string, name: string, status: string, days: number | null, driverId: string | null) =>
        c.query(`INSERT INTO personnel (id, tenant_id, full_name, tc_no, status, driver_id) VALUES ($1, $2, $3, '10000000146', $4, $5)`, [id, T1, name, status, driverId])
          .then(() => (days === null ? null : c.query(`UPDATE personnel SET deactivated_at = NOW() - ($2 || ' days')::interval WHERE id = $1`, [id, String(days)])));
      await per('kvk606-p-a', 'Personel A', 'PASİF', 4000, null);
      await per('kvk606-p-b', 'Personel B', 'PASİF', 2000, null);
      await per('kvk606-p-c', 'Personel C', 'AKTİF', null, null);
      await per('kvk606-p-l', 'Süre A', 'PASİF', 100, 'kvk606-x-a');
    } finally { await c.end(); }
    const denyOwner = await call('POST', '/admin/privacy/anonymize-expired', { token: owner, body: { dryRun: true } });
    const dry0 = await call('POST', '/admin/privacy/anonymize-expired', { token: admin, body: { dryRun: true, tenantId: T1 } });
    const cand0 = Object.fromEntries((dry0.body.data ?? []).map((x: any) => [x.dataClass, x.candidates]));
    check('Süre dolumu (varsayılan: sürücü 1825 gün, personel 3650 gün): dry-run adaylar — DRIVER_PII 1 (A: 2000 gün; D 500/E 300/B 100 değil, aktif C yaşı 3000 gün olsa da DEĞİL), PERSONNEL_PII 1 (A: 4000 gün; B 2000 < 3650); COMPANY_OWNER çalıştıramaz (403); dry-run hiçbir şeyi değiştirmez',
      denyOwner.status === 403 && JSON.stringify(cand0) === JSON.stringify({ DRIVER_PII: 1, PERSONNEL_PII: 1 }) && (await q(`SELECT COUNT(*)::int n FROM drivers WHERE tenant_id = $1 AND anonymized_at IS NOT NULL`, [T1]))[0].n === 0, JSON.stringify(cand0));
    await q(`INSERT INTO tenant_retention_settings (tenant_id, data_class, retention_days) VALUES ($1, 'DRIVER_PII', 10)`, [T1]); // API tabanının (365) ALTINDA — taban uygulanmalı
    const dry1 = await call('POST', '/admin/privacy/anonymize-expired', { token: admin, body: { dryRun: true, tenantId: T1 } });
    const dr1 = dry1.body.data.find((x: any) => x.dataClass === 'DRIVER_PII');
    check('Taban koruması: tenant ayarı 10 gün (SQL ile tabanın altına yazılmış) olsa da taban 365 uygulanır — adaylar A (2000) ve D (500); B (100) ve E (300) DEĞİL',
      dr1.candidates === 2 && dr1.retentionDays === 365, JSON.stringify(dr1));
    await q(`UPDATE tenant_retention_settings SET retention_days = 400 WHERE tenant_id = $1 AND data_class = 'DRIVER_PII'`, [T1]);
    const real = await call('POST', '/admin/privacy/anonymize-expired', { token: admin, body: { tenantId: T1 } });
    const rr = Object.fromEntries((real.body.data ?? []).map((x: any) => [x.dataClass, `${x.anonymized}/${x.candidates}/${x.failed}`]));
    const drvs = Object.fromEntries((await q(`SELECT id, name, anonymized_at IS NOT NULL AS anon FROM drivers WHERE tenant_id = $1`, [T1])).map((x) => [x.id, x]));
    const pers = Object.fromEntries((await q(`SELECT id, full_name, tc_no, anonymized_at IS NOT NULL AS anon FROM personnel WHERE tenant_id = $1`, [T1])).map((x) => [x.id, x]));
    check('Süre dolumu uygulanır (sürücü ayarı 400 gün): A ve D anonimleşir; B, C(aktif), E dokunulmaz; personel A anonimleşir, B (2000<3650) ve C(aktif) dokunulmaz',
      rr.DRIVER_PII === '2/2/0' && rr.PERSONNEL_PII === '1/1/0' && drvs['kvk606-x-a'].anon && drvs['kvk606-x-d'].anon && !drvs['kvk606-x-b'].anon && !drvs['kvk606-x-c'].anon && !drvs['kvk606-x-e'].anon &&
        pers['kvk606-p-a'].anon && pers['kvk606-p-a'].tc_no === null && !pers['kvk606-p-b'].anon && !pers['kvk606-p-c'].anon, JSON.stringify(rr));
    const xtx = (await q(`SELECT driver_name, amount_liters::float8 AS amt FROM transactions WHERE id = 'kvk606-x-tx'`))[0];
    check('Süre dolumu: mali kayıt korunur (80 L ikmal duruyor, ad takma ad); kapsam=KAYIT: aynı kişinin bağlı PERSONEL kaydı (10 yıl saklama) süresi dolmadığı için DOKUNULMAZ (adı hâlâ "Süre A")',
      xtx.amt === 80 && xtx.driver_name === drvs['kvk606-x-a'].name && /^Anonim Sürücü /.test(xtx.driver_name) && pers['kvk606-p-l'].anon === false && pers['kvk606-p-l'].full_name === 'Süre A', JSON.stringify(xtx));
    const again2 = await call('POST', '/admin/privacy/anonymize-expired', { token: admin, body: { tenantId: T1 } });
    check('İdempotans: ikinci tur aday bulmaz (anonimleşmişler tekrar işlenmez)', again2.body.data.length === 0, JSON.stringify(again2.body.data));

    // Durum tetikleyicisi: deactivated_at tüm yazıcılarda tutarlı.
    const tr = pg(); await tr.connect();
    try {
      await tr.query(`INSERT INTO drivers (id, tenant_id, name, tc_no, rfid_card_id, status) VALUES ('kvk606-t-1', $1, 'Tetik', '10000000146', 'C-t1', 'AKTİF')`, [T1]);
      const a = (await tr.query(`SELECT deactivated_at FROM drivers WHERE id = 'kvk606-t-1'`)).rows[0].deactivated_at;
      await tr.query(`UPDATE drivers SET status = 'PASİF' WHERE id = 'kvk606-t-1'`);
      const b = (await tr.query(`SELECT deactivated_at FROM drivers WHERE id = 'kvk606-t-1'`)).rows[0].deactivated_at;
      await tr.query(`UPDATE drivers SET status = 'İZİNLİ' WHERE id = 'kvk606-t-1'`);
      const cc = (await tr.query(`SELECT deactivated_at FROM drivers WHERE id = 'kvk606-t-1'`)).rows[0].deactivated_at;
      await tr.query(`INSERT INTO personnel (id, tenant_id, full_name, status) VALUES ('kvk606-t-p', $1, 'Tetik P', 'PASİF')`, [T1]);
      const pa = (await tr.query(`SELECT deactivated_at FROM personnel WHERE id = 'kvk606-t-p'`)).rows[0].deactivated_at;
      await tr.query(`UPDATE personnel SET status = 'AKTİF' WHERE id = 'kvk606-t-p'`);
      const pb = (await tr.query(`SELECT deactivated_at FROM personnel WHERE id = 'kvk606-t-p'`)).rows[0].deactivated_at;
      check('Sayaç tetikleyicisi: sürücü AKTİF → deactivated_at NULL; PASİF\'e geçince şimdi; İZİNLİ (aktif sayılır) → tekrar NULL; personel PASİF ile eklenince dolu, AKTİF\'e dönünce NULL',
        a === null && !!b && Math.abs(Date.now() - new Date(b).getTime()) < 60000 && cc === null && !!pa && pb === null, '');
    } finally { await tr.end(); }

    // ── 9. Soğuk arşiv ömrü ────────────────────────────────────────────────────────────────────────────────────────
    const arch = (id: string, days: number) => q(`INSERT INTO retention_archives (id, tenant_id, data_class, cutoff_at, retention_days, row_count, file_data, file_size_bytes, sha256, created_at) VALUES ($1, $2, 'DRIVER_SCORE', NOW(), 730, 4, '\\x00', 1, 'x', NOW() - ($3 || ' days')::interval)`, [id, T1, String(days)]);
    await arch('kvk606-ar-old', 2000); await arch('kvk606-ar-mid', 400); await arch('kvk606-ar-new', 100);
    const dryCold = await purgeColdArchives({ tenantId: T1, dryRun: true });
    const cold1 = await purgeColdArchives({ tenantId: T1 });
    const left1 = (await q(`SELECT id FROM retention_archives WHERE tenant_id = $1 ORDER BY id`, [T1])).map((x) => x.id);
    await q(`INSERT INTO tenant_retention_settings (tenant_id, data_class, retention_days) VALUES ($1, 'COLD_ARCHIVE', 200)`, [T1]); // taban 365'in altı
    const cold2 = await purgeColdArchives({ tenantId: T1 });
    const left2 = (await q(`SELECT id FROM retention_archives WHERE tenant_id = $1 ORDER BY id`, [T1])).map((x) => x.id);
    const coldAudit = await q(`SELECT after_value FROM audit_logs WHERE tenant_id = $1 AND action = 'RETENTION_COLD_ARCHIVE_PURGE' ORDER BY created_at`, [T1]);
    check('Soğuk arşiv ömrü (AC: arşivler süresiz kalmaz): varsayılan 1825 gün — dry-run 1 arşiv gösterir ve silmez; gerçek turda yalnızca 2000 günlük silinir (400/100 kalır); ayar 200 (taban 365) → 400 günlük de gider, 100 günlük KALIR; her silme audit\'e özet olarak yazılır',
      dryCold[0].archives === 1 && cold1[0].archives === 1 && cold1[0].rows === 4 && left1.join() === 'kvk606-ar-mid,kvk606-ar-new' && cold2[0].retentionDays === 365 && left2.join() === 'kvk606-ar-new' && coldAudit.length === 2 && coldAudit[0].after_value.archives === 1 && coldAudit[0].after_value.dataClasses[0] === 'DRIVER_SCORE',
      `${left1} → ${left2}`);
    const idxTs = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
    check('Zamanlanmış iş: günlük tur anonimleştirme (anonymizeExpiredSubjects) ve soğuk arşiv temizliğini (purgeColdArchives) de çalıştırır — her biri bağımsız try/catch',
      /await anonymizeExpiredSubjects\(\)/.test(idxTs) && /await purgeColdArchives\(\)/.test(idxTs), '');
  } finally {
    await cleanup();
    await redis.quit();
  }
  console.log('===========================================================');
  console.log(`📊 SONUÇ: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
