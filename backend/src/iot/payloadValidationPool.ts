import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { logger } from '../utils/logger';
import type { ValidationRequest, ValidationResult } from './payloadValidationWorker';

// Bu dosya ESM ("type": "module") — `require` global olarak yok. esbuild'i
// yalnızca dev/test fallback dalında (aşağıda) LAZY olarak yükleyebilmek için
// (prod'da devDependency olarak mevcut değil, static `import esbuild from
// 'esbuild'` prod bundle'ında ERR_MODULE_NOT_FOUND ile patlardı) elle bir
// require() oluşturuluyor. `import.meta.url` YERİNE process.cwd() tabanlı bir
// yol veriliyor — despatchAdviceXmlService.ts'teki AYNI gerekçe: esbuild
// dist/server.cjs'e gömdüğünde import.meta.url'ün cjs shim'i (`import_meta`)
// bu modül bağımlılık grafiğinin İÇİNDE bulunduğunda tanımsız kalabiliyor
// (canlı doğrulandı: "Received undefined" ile ERR_INVALID_ARG_VALUE) —
// process.cwd()/package.json her zaman geçerli, somut bir dosya yolu.
const require = createRequire(path.join(process.cwd(), 'package.json'));

/**
 * IOT-301.3 AC: "MQTT telemetri payload'ı worker thread'de doğrulanmalı/
 * ayrıştırılmalıdır." mqttClient.ts'in `message` handler'ı önceden JSON.parse
 * ve LoRaWAN binary decode'u DOĞRUDAN ana thread'de, senkron çalıştırıyordu.
 * Tek başına bu işlemler mikro-saniyeler mertebesinde (bkz. lorawanDecoder.ts
 * doc yorumu) — asıl gerekçe HAM cihaz payload'ının ayrıştırılmasını ana
 * event loop'tan (HTTP istekleri, Socket.io, TÜM diğer cihazların telemetrisi)
 * İZOLE etmek: bir worker çökerse/donarsa yalnızca o worker yeniden
 * başlatılır, ana thread ve ondan geçen diğer trafik ETKİLENMEZ. Bu, tek bir
 * kötü niyetli/bozuk cihazın (örn. çok derin iç içe geçmiş bir JSON ile
 * ana thread'i bloke etmeye çalışması) TÜM tenantların telemetrisini
 * etkilemesine karşı savunma hattıdır.
 *
 * Worker script'i ÖNCEDEN DERLENMİŞ bir .cjs dosyası olarak çalıştırılır —
 * .ts dosyasını doğrudan worker_threads'e vermek prod'da (esbuild'in TEK bir
 * dist/server.cjs'e gömdüğü, devDependencies'in `npm ci --omit=dev` ile
 * silindiği ortamda) çalışmaz: worker'ın kendi thread'i tsx/ts-node'un
 * ana thread'e ÖZEL modül yükleyici kancasını miras ALMAZ (canlı doğrulandı:
 * `new Worker(url)` bir .ts dosyasıyla `ERR_UNKNOWN_FILE_EXTENSION` fırlatıyor,
 * `execArgv: ['--import', 'tsx/esm']` ile bile). Bu yüzden:
 *  - PROD: `npm run build` (bkz. package.json) `dist/payloadValidationWorker.cjs`'i
 *    `dist/server.cjs` ile AYNI anda, esbuild ile önceden derler; Dockerfile
 *    onu da runner stage'e kopyalar.
 *  - DEV/TEST (tsx ile çalışırken `npm run build` hiç çalışmamış olabilir):
 *    dosya yoksa burada esbuild'in (devDependency) buildSync API'siyle
 *    KENDİLİĞİNDEN, tek seferlik derlenir — dev makinesinde/CI'da ekstra bir
 *    build adımı gerektirmez.
 */

const POOL_SIZE = 2;
const REQUEST_TIMEOUT_MS = 5000;

function resolveWorkerScriptPath(): string {
  // process.cwd() tercih edilir — despatchAdviceXmlService.ts'teki AYNI
  // desen: esbuild bundle'ı içine gömüldüğünde __dirname/import.meta.url
  // kaynak dosyanın değil, bundle'ın (dist/) konumunu verir. Dockerfile'da
  // WORKDIR /app, container her zaman oradan başlatılır.
  const compiledPath = path.join(process.cwd(), 'dist', 'payloadValidationWorker.cjs');
  if (fs.existsSync(compiledPath)) return compiledPath;

  // Yalnızca dev/test yolu: kaynak .ts dosyasını esbuild ile tek seferlik
  // dist/payloadValidationWorker.cjs'e derler (prod imajında esbuild
  // devDependency olduğundan mevcut değildir — orada dosya `npm run build`
  // ile ZATEN üretilmiş olmalı, bu dal hiç tetiklenmez).
  const sourcePath = path.join(process.cwd(), 'src', 'iot', 'payloadValidationWorker.ts');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const esbuild = require('esbuild');
  fs.mkdirSync(path.dirname(compiledPath), { recursive: true });
  esbuild.buildSync({
    entryPoints: [sourcePath],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: compiledPath
  });
  return compiledPath;
}

interface PendingRequest {
  resolve: (result: ValidationResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class PayloadValidationPool {
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private started = false;

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    const scriptPath = resolveWorkerScriptPath();
    for (let i = 0; i < POOL_SIZE; i++) {
      this.spawnWorker(i, scriptPath);
    }
    logger.info({ poolSize: POOL_SIZE }, '🧵 [IOT-301.3] Payload doğrulama worker havuzu başlatıldı.');
  }

  private spawnWorker(slot: number, scriptPath: string): void {
    const worker = new Worker(scriptPath);

    worker.on('message', (result: ValidationResult) => {
      const req = this.pending.get(result.id);
      if (!req) return; // zaman aşımına uğramış/zaten çözülmüş bir istek
      clearTimeout(req.timer);
      this.pending.delete(result.id);
      req.resolve(result);
    });

    const handleWorkerDeath = (err?: Error) => {
      // Bu worker'a atanmış BEKLEYEN istekleri reddet — ana thread'i asla
      // sonsuza dek askıda bırakma (bkz. sınıf üstü AC yorumu: izolasyon).
      for (const [id, req] of this.pending) {
        // Not: hangi isteklerin BU worker'a gittiğini burada ayırt etmiyoruz
        // (round-robin dağıtım basit tutuldu) — worker çöktüğünde TÜM
        // bekleyen istekler reddedilir, çağıran (mqttClient.ts) her mesajı
        // zaten kendi try/catch'i içinde işliyor, bu nadir olayda birkaç
        // mesajın yeniden denenmesi/atlanması kabul edilebilir.
        clearTimeout(req.timer);
        req.reject(err ?? new Error('Worker thread beklenmedik şekilde sonlandı.'));
        this.pending.delete(id);
      }
      logger.error({ err, slot }, '🚨 [IOT-301.3] Payload doğrulama worker çöktü — yeniden başlatılıyor.');
      this.spawnWorker(slot, scriptPath);
    };

    worker.on('error', (err) => handleWorkerDeath(err));
    worker.on('exit', (code) => {
      if (code !== 0) handleWorkerDeath(new Error(`Worker exit code ${code}`));
    });

    this.workers[slot] = worker;
  }

  /** Round-robin dağıtım — cihaz/tenant başına yapışkanlık gerekmiyor, tüm istekler eşdeğer. */
  public validatePayload(deviceType: string, messageStr: string): Promise<ValidationResult> {
    this.ensureStarted();
    const id = this.nextRequestId++;
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;

    return new Promise<ValidationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Payload doğrulama worker'ı ${REQUEST_TIMEOUT_MS}ms içinde yanıt vermedi.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const req: ValidationRequest = { id, deviceType, messageStr };
      worker.postMessage(req);
    });
  }

  /** Testler/graceful shutdown için — tüm worker'ları sonlandırır. */
  public async shutdown(): Promise<void> {
    if (!this.started) return;
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.started = false;
  }
}

export const payloadValidationPool = new PayloadValidationPool();
