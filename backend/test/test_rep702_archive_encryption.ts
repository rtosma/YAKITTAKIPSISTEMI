import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { Client } from 'pg';
import { resetLoginRateLimit } from './helpers/loginRateLimit';

/**
 * TEST_PLAN.md / GitHub #165 [REP-702] — GERÇEK AES-256 şifreleme + manifest
 * bütünlük doğrulaması.
 *
 * test_res905_graceful_degradation.ts / test_iot305_.../test_fuel406_...
 * İLE AYNI gerekçeyle bu dosya CI'a EKLENMEZ, host'tan MANUEL çalıştırılır:
 * `docker` CLI'a erişim gerektirir (bir p7zip konteyneri) ve backend'in
 * `--network container:backend` içinden DEĞİL, nginx üzerinden (host'un
 * `localhost:3000`'i) erişilebilir olması gerekir — GH Actions'ın `services:`
 * modeli `docker run` çağrısını desteklemez.
 *
 * Node'un standart kütüphanesinde/npm ekosisteminde WinZip AE-x (AES-256
 * ZIP) şifresini açabilen sağlam, saf-JS bir paket YOK (arşivleme sırasında
 * kullanılan `archiver-zip-encrypted` tek yönlüdür — yalnızca ŞİFRELER).
 * Bu yüzden gerçek doğrulama, bu özelliğin geliştirilmesi sırasında ELLE
 * yapılan doğrulamayla AYNI yöntemle otomatikleştirildi: gerçek 7-Zip
 * (p7zip, standart Linux `unzip`'in AKSİNE bu şifrelemeyi destekler) içeren
 * bir kullan-at Alpine konteyneri.
 *
 * ÇALIŞTIRMA: (host'tan, backend + nginx + postgres docker compose ile ayakta)
 *   API_URL=http://localhost:3000/api/v1 npx tsx test/test_rep702_archive_encryption.ts
 */

const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';

function pg(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB || 'yakittakip_db'
  });
}

async function login(username: string): Promise<string> {
  await resetLoginRateLimit();
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  });
  const body = await res.json();
  if (!body.accessToken) throw new Error(`'${username}' girişi başarısız: ${JSON.stringify(body)}`);
  return body.accessToken;
}

/** Kullan-at bir Alpine konteynerinde p7zip çalıştırır; `hostDir` `/data`'ya bind-mount edilir. */
function run7z(hostDir: string, args: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync('docker', ['run', '--rm', '-v', `${hostDir}:/data`, 'alpine:3.20', 'sh', '-c', `apk add --no-cache p7zip -q >/dev/null 2>&1 && ${args}`], {
      encoding: 'utf-8'
    });
    return { ok: true, output };
  } catch (err: any) {
    return { ok: false, output: String(err.stdout || '') + String(err.stderr || '') };
  }
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function run() {
  console.log('===========================================================');
  console.log('🧪 [TEST_PLAN / GitHub #165] REP-702 GERÇEK AES-256 ŞİFRELEME + MANİFEST');
  console.log('===========================================================\n');
  let passed = 0;
  let total = 0;
  const check = (name: string, condition: boolean, detail: string) => {
    total++;
    console.log(`${condition ? '✅ [PASS]' : '❌ [FAIL]'} ${name}\n   ${detail}\n`);
    if (condition) passed++;
  };

  const db = pg();
  await db.connect();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep702-'));
  let archiveId: string | undefined;

  try {
    const owner = await login('camsa');

    const created = await fetch(`${API_URL}/archives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` },
      body: JSON.stringify({ periodDays: 7 })
    });
    const createdBody = await created.json();
    check('Test 1: Manuel arşiv üretimi 201 döner', created.status === 201, `status=${created.status}`);
    archiveId = createdBody.data.archiveId;
    const password: string = createdBody.data.password;
    const downloadUrl: string = createdBody.data.downloadUrl;

    // `downloadUrl` API yanıtında ZATEN `/api/v1/...` ile başlar (bkz. routes.ts)
    // — `API_URL` de `/api/v1` içerdiğinden burada ORIGIN'e (şema+host+port)
    // eklenmeli, API_URL'e DEĞİL (aksi halde /api/v1 İKİ KEZ tekrarlanır).
    const origin = API_URL.replace(/\/api\/v1\/?$/, '');
    const zipRes = await fetch(`${origin}${downloadUrl}`);
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    fs.writeFileSync(path.join(tmpDir, 'archive.zip'), zipBuffer);

    const wrongPasswordTest = run7z(tmpDir, `7z t -p'kesinlikle-yanlis-bir-parola' /data/archive.zip`);
    check(
      'Test 2: YANLIŞ parola ile bütünlük testi BAŞARISIZ olur (p7zip "Wrong password")',
      !wrongPasswordTest.ok && /wrong password/i.test(wrongPasswordTest.output),
      `ok=${wrongPasswordTest.ok}, output=${wrongPasswordTest.output.slice(-300)}`
    );

    const correctPasswordTest = run7z(tmpDir, `7z t -p'${password}' /data/archive.zip`);
    check(
      'Test 3: DOĞRU parola ile bütünlük testi BAŞARILI olur (p7zip "Everything is Ok")',
      correctPasswordTest.ok && /everything is ok/i.test(correctPasswordTest.output),
      `ok=${correctPasswordTest.ok}, output=${correctPasswordTest.output.slice(-300)}`
    );

    const extract = run7z(tmpDir, `mkdir -p /data/extracted && 7z x -y -o/data/extracted -p'${password}' /data/archive.zip`);
    check('Test 4: DOĞRU parola ile çıkarma başarılı', extract.ok, `ok=${extract.ok}, output=${extract.output.slice(-300)}`);

    const extractedDir = path.join(tmpDir, 'extracted');
    const manifestBuffer = fs.readFileSync(path.join(extractedDir, 'manifest.json'));
    const manifest = JSON.parse(manifestBuffer.toString('utf-8'));

    check(
      'Test 5: manifest.json AC\'nin gerektirdiği alanları (periyot, dönem, dosya listesi) içerir',
      manifest.periodDays === 7 && typeof manifest.periodStart === 'string' && typeof manifest.periodEnd === 'string' && Array.isArray(manifest.files) && manifest.files.length === 3,
      `manifest=${JSON.stringify(manifest)}`
    );

    let allHashesMatch = true;
    const hashDetails: string[] = [];
    for (const fileEntry of manifest.files as Array<{ name: string; sizeBytes: number; sha256: string }>) {
      const actualBuffer = fs.readFileSync(path.join(extractedDir, fileEntry.name));
      const actualHash = sha256Hex(actualBuffer);
      const matches = actualHash === fileEntry.sha256 && actualBuffer.length === fileEntry.sizeBytes;
      if (!matches) allHashesMatch = false;
      hashDetails.push(`${fileEntry.name}: manifest=${fileEntry.sha256.slice(0, 12)}… gerçek=${actualHash.slice(0, 12)}… boyutEşleşti=${actualBuffer.length === fileEntry.sizeBytes}`);
    }
    check(
      'Test 6: AC — manifest.json\'daki SHA-256 + boyut, GERÇEK çıkarılan dosyalarla eşleşir (bütünlük)',
      allHashesMatch,
      hashDetails.join(' | ')
    );

    const csvBuffer = fs.readFileSync(path.join(extractedDir, 'ikmal-hareketleri.csv'));
    check(
      'Test 7: ikmal-hareketleri.csv UTF-8 BOM + başlık satırıyla başlar',
      csvBuffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && csvBuffer.toString('utf-8').includes('Şantiye'),
      `ilk-bytes=${csvBuffer.subarray(0, 20).toString('utf-8')}`
    );

    const telemetryJson = JSON.parse(fs.readFileSync(path.join(extractedDir, 'telemetri-ozeti.json'), 'utf-8'));
    check(
      'Test 8: telemetri-ozeti.json geçerli JSON + beklenen alanlar (kapsam uyarlaması notuyla)',
      typeof telemetryJson.registeredDeviceCount === 'number' && typeof telemetryJson.note === 'string' && telemetryJson.note.length > 0,
      `telemetryJson=${JSON.stringify(telemetryJson)}`
    );

    const pdfBuffer = fs.readFileSync(path.join(extractedDir, 'ozet-rapor.pdf'));
    check('Test 9: ozet-rapor.pdf geçerli bir PDF (%PDF- sihirli byte\'ları)', pdfBuffer.subarray(0, 5).toString('latin1') === '%PDF-', `ilk-bytes=${pdfBuffer.subarray(0, 8).toString('latin1')}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (archiveId) {
      await db.query('DELETE FROM tenant_archives WHERE id = $1', [archiveId]);
      await db.query('DELETE FROM audit_logs WHERE target_id = $1', [archiveId]);
    }
    await db.end();
    await resetLoginRateLimit();
  }

  console.log('===========================================================');
  console.log(`SONUÇ: ${passed}/${total} test geçti.`);
  console.log('===========================================================');
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('🔥 Test çalıştırılırken beklenmeyen hata:', err);
  process.exit(1);
});
