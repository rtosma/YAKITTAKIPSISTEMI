import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import crypto from 'crypto';
import { StringDecoder } from 'string_decoder';
import Redis from 'ioredis';
import mqtt from 'mqtt';
import { Client } from 'pg';

/**
 * FW-1307 / FW-1314 / FUEL-401 — GERÇEK firmware ile GERÇEK sunucu, donanımsız.
 *
 * ESP32 firmware'i (sdkconfig.qemu: emüle Ethernet + geliştirme konsolu) ESP32 QEMU'sunda
 * çalışır ve bu süreçte ayakta olan backend'e (QEMU kullanıcı ağında 10.0.2.2:5000) gerçek
 * HMAC imzalı isteklerle bağlanır. Kart okutma ve akışmetre palsleri seri konsoldan verilir;
 * gerisi (imza, saat eşitleme, oturum durum makinesi, heartbeat, finalize, NVS) cihaz kodudur.
 *
 * Senaryolar:
 *   A) Normal ikmal: kart → yetki → 30 L akış → akış durur → finalize → DOĞRULANDI
 *   B) İkmal ortasında güç kesintisi (QEMU anında kapatılır) → yeniden açılış → yarım oturum
 *      NVS'ten kurtarılır → finalize recoveredAfterRestart → DOĞRULAMA_BEKLIYOR; kayıp ≤ 5 L
 *   D) MQTT (FW_E2E_MQTT_URL verilmişse; backend aynı broker'a bağlı olmalı):
 *      presence ONLINE; portaldan kalibrasyon → cihaz uygular → HTTP ACK → sunucuda ONAYLANDI ve
 *      yeniden açılışta K korunur; ikmal sürerken kalibrasyon → NACK (DISPENSE_IN_PROGRESS);
 *      broker'dan FORCE_CUTOFF → röle kesilir, IOT-305 ack'i gelir, ikmal kaydedilir
 *
 * Girdiler (ortam):
 *   FW_E2E_FLASH  QEMU'nun göreceği flash imajı yolu (make_e2e_image.sh çıktısı)
 *   FW_QEMU_CMD   qemu-system-xtensa çağrısı (ör. CI'da `docker run -i --rm --network host …`)
 *   FW_E2E_MQTT_URL  broker (test sürecinden görüldüğü haliyle, ör. mqtt://localhost:1883);
 *                    kimlik MQTT_USERNAME / MQTT_PASSWORD
 */

const FLASH = process.env.FW_E2E_FLASH;
const QEMU_CMD = process.env.FW_QEMU_CMD || 'qemu-system-xtensa';
const DEVICE_ID = 'ESP32-PUMP-01';
const CARD = 'CARD-881201';
const MQTT_URL = process.env.FW_E2E_MQTT_URL;
const API_URL = 'http://localhost:5000/api/v1';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

class Device {
  private proc: ChildProcessWithoutNullStreams;
  private lines: string[] = [];
  private cursor = 0;
  private exited = false;

  constructor(label: string) {
    const args = `-nographic -machine esp32 -m 4M -drive file=${FLASH},if=mtd,format=raw -nic user,model=open_eth`;
    this.proc = spawn('bash', ['-c', `${QEMU_CMD} ${args}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Çok baytlı UTF-8 karakterler (ğ, ş, ı…) parçalar arasında bölünebilir: akış çözücü şart.
    const decoder = new StringDecoder('utf8');
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += decoder.write(chunk);
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(ANSI, '').replace(/\r$/, '');
        buf = buf.slice(i + 1);
        this.lines.push(line);
        if (/yakittakip|yt_net|yt_http|konsol|Guru|abort|task_wdt/.test(line)) console.log(`   [${label}] ${line}`);
      }
    };
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.proc.on('exit', () => { this.exited = true; });
  }

  /** Şimdiye kadarki TÜM satırlarda ara (sıra önemsizse — ör. arka planda bağlanan MQTT). */
  async seen(re: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const line of this.lines) {
        const m = line.match(re);
        if (m) return m;
      }
      if (this.exited) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${timeoutMs / 1000} sn içinde görülmedi: ${re}`);
  }

  /** Bir sonraki eşleşen satırı bekler (daha önce okunanlar atlanır). */
  async waitFor(re: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (; this.cursor < this.lines.length; this.cursor++) {
        if (/Guru Meditation|abort\(\)|task_wdt: Task watchdog/.test(this.lines[this.cursor])) {
          throw new Error(`firmware çöktü: ${this.lines[this.cursor]}`);
        }
        const m = this.lines[this.cursor].match(re);
        if (m) {
          this.cursor++;
          return m;
        }
      }
      if (this.exited) throw new Error(`QEMU kapandı, beklenen: ${re}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${timeoutMs / 1000} sn içinde gelmedi: ${re}`);
  }

  send(line: string): void {
    this.proc.stdin.write(`${line}\n`);
  }

  /** Güç kesintisi: QEMU'yu anında kapat (Ctrl-A x). Flash'a yazılmış olan kalır. */
  async powerCut(): Promise<void> {
    if (this.exited) return;
    this.proc.stdin.write('\x01x');
    const deadline = Date.now() + 10000;
    while (!this.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!this.exited) this.proc.kill('SIGKILL');
  }
}

async function run() {
  console.log('===========================================================');
  console.log('🔌 [FW-1307/FW-1314] FIRMWARE (QEMU) ↔ BACKEND UÇTAN UCA TESTİ');
  console.log('===========================================================\n');

  if (!FLASH) {
    console.error('FW_E2E_FLASH tanımlı değil (firmware/test/qemu/make_e2e_image.sh çıktısı).');
    process.exit(1);
  }

  let passed = 0;
  let total = 0;
  function check(name: string, condition: boolean, detail: string) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${name}\n   ${detail}\n`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}\n   ${detail}\n`);
    }
  }

  const db = new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
  await db.connect();

  // Ön koşul (test_fuel401 ile aynı): kart sahibinin aracı ata; tank seviyesini sonra geri koy.
  await db.query(`UPDATE vehicles SET assigned_driver_name = 'Ahmet Yılmaz' WHERE id = 'veh-1'`);
  const tankBefore = await db.query(`SELECT current_level_liters FROM tanks WHERE id = 'tank-gebze-1'`);
  const levelBefore = Number(tankBefore.rows[0].current_level_liters);
  const keys: string[] = [];
  const calibrationIds: string[] = [];
  let dev: Device | null = null;
  await db.query('UPDATE hardware_devices SET k_factor = 450 WHERE device_id = $1', [DEVICE_ID]);

  const txOf = async (sessionId: string) => {
    const r = await db.query('SELECT amount_liters, verification_status FROM transactions WHERE idempotency_key = $1',
      [`${DEVICE_ID}:${sessionId}`]);
    return r.rows;
  };

  try {
    // === A) Normal ikmal ===
    dev = new Device('A');
    await dev.waitFor(/HMAC öz-testi geçti/, 30000);
    await dev.waitFor(/ağ hazır, IP/, 30000);
    dev.send(`kart ${CARD}`);
    const authA = await dev.waitFor(/yetki verildi: oturum (\S+),/, 30000);
    const sessionA = authA[1];
    keys.push(`${DEVICE_ID}:${sessionA}`);
    check('A1: Kart okutuldu, cihaz HMAC imzalı request-auth ile yetki aldı', !!sessionA, `oturum=${sessionA}`);

    dev.send('akis 30 120'); // 30 L, 120 L/dk → 15 sn
    const endA = await dev.waitFor(/ikmal bitti \((\w+)\), ([\d.]+) L/, 60000);
    check('A2: Akış durunca cihaz ikmali kendisi bitirdi (FLOW_STOPPED, 30 L)',
      endA[1] === 'FLOW_STOPPED' && Math.abs(Number(endA[2]) - 30) < 0.01, `sebep=${endA[1]}, litre=${endA[2]}`);

    const savedA = await dev.waitFor(/ikmal kaydedildi: oturum (\S+), ([\d.]+) L, (\S+)/, 30000);
    check('A3: Finalize kabul edildi — sunucu 30 L, DOĞRULANDI döndü',
      savedA[1] === sessionA && Number(savedA[2]) === 30 && savedA[3] === 'DOĞRULANDI',
      `oturum=${savedA[1]}, litre=${savedA[2]}, durum=${savedA[3]}`);

    const rowsA = await txOf(sessionA);
    check('A4: Veritabanında TEK kayıt, 30 L, DOĞRULANDI (idempotency anahtarı cihazın)',
      rowsA.length === 1 && Number(rowsA[0].amount_liters) === 30 && rowsA[0].verification_status === 'DOĞRULANDI',
      JSON.stringify(rowsA));

    // === B) İkmal ortasında güç kesintisi ===
    await dev.waitFor(/yeni karta hazır/, 10000); // sonuç ekranı (3 sn) bitti
    dev.send(`kart ${CARD}`);
    const authB = await dev.waitFor(/yetki verildi: oturum (\S+),/, 30000);
    const sessionB = authB[1];
    keys.push(`${DEVICE_ID}:${sessionB}`);
    dev.send('akis 100 120'); // 2 L/sn
    await new Promise((r) => setTimeout(r, 9000));
    dev.send('durum');
    const st = await dev.waitFor(/durum: PUMPING, totalizatör [\d.]+ L, ikmal ([\d.]+) L/, 5000);
    const litersAtCut = Number(st[1]);
    await dev.powerCut();
    check('B1: İkmal sürerken güç kesildi', litersAtCut > 6, `kesinti anında ${litersAtCut} L akmıştı`);

    dev = new Device('B');
    const rec = await dev.waitFor(/oturum (\S+) kurtarıldı/, 30000);
    check('B2: Açılışta yarım oturum NVS\'ten kurtarıldı', rec[1] === sessionB, `kurtarılan=${rec[1]}, beklenen=${sessionB}`);

    const savedB = await dev.waitFor(/ikmal kaydedildi: oturum (\S+), ([\d.]+) L, (\S+)/, 60000);
    const recovered = Number(savedB[2]);
    check('B3: Kurtarılan ikmal recoveredAfterRestart ile kaydedildi → DOĞRULAMA_BEKLIYOR',
      savedB[1] === sessionB && savedB[3] === 'DOĞRULAMA_BEKLIYOR', `oturum=${savedB[1]}, durum=${savedB[3]}`);
    // "durum" okuması ile kesinti arasında ~1 sn daha akar (2 L/sn); arada bir commit olabilir.
    check('B4: FW-1314 AC — güç kesintisinde kayıp en fazla 5 L',
      recovered <= litersAtCut + 2.0 && litersAtCut - recovered <= 5.0,
      `kesinti anında ${litersAtCut} L, kaydedilen ${recovered} L, kayıp ${(litersAtCut - recovered).toFixed(3)} L`);

    const rowsB = await txOf(sessionB);
    check('B5: Veritabanında TEK kayıt, operatör onayı bekliyor',
      rowsB.length === 1 && rowsB[0].verification_status === 'DOĞRULAMA_BEKLIYOR', JSON.stringify(rowsB));

    // Kayıt silinmiş olmalı: bir sonraki açılışta kurtarılacak oturum yok.
    await new Promise((r) => setTimeout(r, 1500));
    await dev.powerCut();
    dev = new Device('C');
    await dev.waitFor(/K-faktörü [\d.]+ pals\/L, totalizatör ([\d.]+) L/, 30000);
    await dev.waitFor(/ağ hazır, IP/, 30000);
    dev.send('durum');
    const idle = await dev.waitFor(/durum: (\w+),/, 5000);
    check('C1: Finalize sonrası oturum kaydı silindi — yeni açılış boşta (IDLE)', idle[1] === 'IDLE', `durum=${idle[1]}`);

    if (MQTT_URL) dev = await mqttScenarios(dev, db, check, keys, calibrationIds);
  } finally {
    if (dev) await dev.powerCut();
    if (keys.length) await db.query('DELETE FROM transactions WHERE idempotency_key = ANY($1)', [keys]);
    await db.query(`UPDATE tanks SET current_level_liters = $1, status = 'GÜVENLİ' WHERE id = 'tank-gebze-1'`, [levelBefore]);
    await db.query(`UPDATE vehicles SET assigned_driver_name = NULL WHERE id = 'veh-1'`);
    if (calibrationIds.length) {
      await db.query('DELETE FROM calibration_commands WHERE id = ANY($1)', [calibrationIds]).catch(() => undefined);
    }
    await db.query('UPDATE hardware_devices SET k_factor = 450 WHERE device_id = $1', [DEVICE_ID]);
    await db.end();
  }

  console.log('===========================================================');
  console.log(`📊 TEST SONUÇLARI: ${passed} / ${total} TEST BAŞARILI`);
  console.log('===========================================================');
  if (passed !== total) process.exit(1);
}

type Check = (name: string, condition: boolean, detail: string) => void;

async function api(method: string, path: string, body?: object, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function mqttScenarios(dev: Device, db: Client, check: Check, keys: string[], calibrationIds: string[]): Promise<Device> {
  const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) });
  const broker = await mqtt.connectAsync(MQTT_URL as string, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    clientId: `fw-e2e-${crypto.randomBytes(4).toString('hex')}`
  });
  const acks: Array<{ commandId?: string; status?: string }> = [];
  await broker.subscribeAsync(`command/v1/${DEVICE_ID}/ack`, { qos: 1 });
  broker.on('message', (_topic, payload) => {
    try { acks.push(JSON.parse(payload.toString())); } catch { /* yok say */ }
  });

  try {
    // D1 — presence: cihaz LWT'li bağlanır ve ONLINE yayınlar; sunucu Redis'e yazar.
    await dev.seen(/MQTT bağlandı/, 30000);
    let state: string | null = null;
    for (let i = 0; i < 30 && state !== 'ONLINE'; i++) {
      state = await redis.get(`device:${DEVICE_ID}:state`);
      if (state !== 'ONLINE') await new Promise((r) => setTimeout(r, 500));
    }
    check('D1: Cihaz MQTT\'ye bağlandı, sunucu presence\'ı ONLINE gördü', state === 'ONLINE', `device:${DEVICE_ID}:state=${state}`);

    // D2 — uzaktan kalibrasyon: portal → MQTT SET_K_FACTOR → cihaz uygular → HTTP ACK → ONAYLANDI.
    for (const k of await redis.keys('rl:auth-login:*')) await redis.del(k);
    const login = await api('POST', '/auth/login', { username: 'camsa', password: '123456' });
    const token = login.body.accessToken as string;
    const cal = await api('POST', `/devices/${DEVICE_ID}/calibration`, { newKFactor: 459, reason: 'QEMU uçtan uca test' }, token);
    if (cal.body?.data?.id) calibrationIds.push(cal.body.data.id);
    await dev.waitFor(/kalibrasyon uygulandı: K=459\.0000/, 20000);
    await dev.waitFor(/kalibrasyon sunucuda onaylandı: K=459\.0000/, 20000);
    const calRow = await db.query(
      `SELECT cc.status, hd.k_factor FROM calibration_commands cc JOIN hardware_devices hd ON hd.device_id = cc.device_id WHERE cc.id = $1`,
      [cal.body?.data?.id]);
    check('D2: Portal kalibrasyonu cihaza ulaştı, uygulandı, sunucuda ONAYLANDI ve k_factor=459',
      calRow.rows[0]?.status === 'ONAYLANDI' && Number(calRow.rows[0]?.k_factor) === 459, JSON.stringify(calRow.rows[0]));

    // D3 — yeni K kalıcı: güç kesilip açılınca 459 ile başlar.
    await dev.powerCut();
    dev = new Device('D');
    const kLine = await dev.waitFor(/K-faktörü ([\d.]+) pals\/L/, 30000);
    check('D3: Kalibre edilen K-faktörü yeniden başlatmada korundu (NVS)', Number(kLine[1]) === 459, `K=${kLine[1]}`);
    await dev.waitFor(/ağ hazır, IP/, 30000);
    await dev.seen(/MQTT bağlandı/, 30000);

    // D4 — ikmal sürerken kalibrasyon REDDEDİLİR (o ikmalin litresi tutarsız olurdu).
    dev.send(`kart ${CARD}`);
    const auth = await dev.waitFor(/yetki verildi: oturum (\S+),/, 30000);
    keys.push(`${DEVICE_ID}:${auth[1]}`);
    dev.send('akis 100 120');
    await dev.waitFor(/akış: /, 5000);
    const busy = await api('POST', `/devices/${DEVICE_ID}/calibration`, { newKFactor: 455, reason: 'QEMU — ikmal sırasında' }, token);
    if (busy.body?.data?.id) calibrationIds.push(busy.body.data.id);
    await dev.waitFor(/kalibrasyon reddedildi \(DISPENSE_IN_PROGRESS\)/, 20000);
    await dev.waitFor(/kalibrasyon reddi sunucuya iletildi/, 20000);
    const busyRow = await db.query(
      `SELECT cc.status, hd.k_factor FROM calibration_commands cc JOIN hardware_devices hd ON hd.device_id = cc.device_id WHERE cc.id = $1`,
      [busy.body?.data?.id]);
    check('D4: İkmal sürerken gelen kalibrasyon NACK edildi (REDDEDILDI), k_factor 459 kaldı',
      busyRow.rows[0]?.status === 'REDDEDILDI' && Number(busyRow.rows[0]?.k_factor) === 459, JSON.stringify(busyRow.rows[0]));

    // D5 — broker'dan FORCE_CUTOFF (IOT-305, commandId'li): röle kesilir, ack gelir, ikmal kaydedilir.
    const commandId = `e2e-${crypto.randomBytes(6).toString('hex')}`;
    await broker.publishAsync(`command/v1/${DEVICE_ID}`,
      JSON.stringify({ command: 'FORCE_CUTOFF', reason: 'E2E_TEST', commandId, issuedAt: new Date().toISOString() }), { qos: 1 });
    await dev.waitFor(/MQTT kesme emri: FORCE_CUTOFF \(E2E_TEST\)/, 10000);
    const end = await dev.waitFor(/ikmal bitti \((\w+)\), ([\d.]+) L/, 10000);
    let ack: { commandId?: string; status?: string } | undefined;
    for (let i = 0; i < 50 && !ack; i++) {
      ack = acks.find((a) => a.commandId === commandId);
      if (!ack) await new Promise((r) => setTimeout(r, 100));
    }
    check('D5: MQTT FORCE_CUTOFF röleyi kesti ve IOT-305 ack\'i yayınlandı',
      end[1] === 'FORCE_CUTOFF' && ack?.status === 'ACK', `sebep=${end[1]}, litre=${end[2]}, ack=${JSON.stringify(ack)}`);
    const saved = await dev.waitFor(/ikmal kaydedildi: oturum (\S+), ([\d.]+) L, (\S+)/, 30000);
    check('D6: Kesilen ikmal akan litreyle kaydedildi',
      Math.abs(Number(saved[2]) - Number(end[2])) < 0.01, `kesilen=${end[2]} L, kaydedilen=${saved[2]} L, ${saved[3]}`);
  } finally {
    await broker.endAsync().catch(() => undefined);
    redis.disconnect();
  }
  return dev;
}

run().catch((err) => {
  console.error('💥 Test çalıştırılamadı:', err);
  process.exit(1);
});
