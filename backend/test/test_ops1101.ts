import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

async function runOps1101Tests() {
  console.log('\n=============================================================');
  console.log('🧪 [TEST-OPS-1101] Multi-Stage Dockerfile & Graceful Shutdown Testi');
  console.log('=============================================================\n');

  let passedCount = 0;
  let failedCount = 0;

  const assert = (condition: boolean, title: string, failureReason?: string) => {
    if (condition) {
      console.log(`  ✅ [PASS] ${title}`);
      passedCount++;
    } else {
      console.error(`  ❌ [FAIL] ${title} - ${failureReason || 'Beklenen koşul sağlanamadı'}`);
      failedCount++;
    }
  };

  const rootDir = process.cwd();

  // 1. Check Dockerfile exists & includes multi-stage build structure
  const dockerfilePath = fs.existsSync(path.join(rootDir, 'Dockerfile'))
    ? path.join(rootDir, 'Dockerfile')
    : path.join(rootDir, 'backend', 'Dockerfile');
  assert(fs.existsSync(dockerfilePath), 'Dockerfile oluşturulmuş olmalı');
  
  if (fs.existsSync(dockerfilePath)) {
    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
    assert(dockerfileContent.includes('FROM node:20-alpine AS builder'), 'Dockerfile Stage 1 (builder) içermeli');
    assert(dockerfileContent.includes('FROM node:20-alpine AS runner'), 'Dockerfile Stage 2 (runner) içermeli');
    assert(dockerfileContent.includes('USER node'), 'Dockerfile non-root node kullanıcısı içermeli');
    assert(dockerfileContent.includes('/sbin/tini'), 'Dockerfile tini init sinyal işleyicisi içermeli');
    assert(dockerfileContent.includes('HEALTHCHECK'), 'Dockerfile HEALTHCHECK tanımı içermeli');
  }

  // 2. Check .dockerignore exists & ignores node_modules / .git / .env
  const dockerIgnorePath = fs.existsSync(path.join(rootDir, '.dockerignore'))
    ? path.join(rootDir, '.dockerignore')
    : path.join(rootDir, 'backend', '.dockerignore');
  assert(fs.existsSync(dockerIgnorePath), '.dockerignore oluşturulmuş olmalı');

  if (fs.existsSync(dockerIgnorePath)) {
    const ignoreContent = fs.readFileSync(dockerIgnorePath, 'utf-8');
    assert(ignoreContent.includes('node_modules'), '.dockerignore node_modules içermeli');
    assert(ignoreContent.includes('.git'), '.dockerignore .git içermeli');
    assert(ignoreContent.includes('.env'), '.dockerignore .env içermeli');
  }

  // 3. Check Standalone Server Bundle (dist/server.cjs)
  const bundlePath = fs.existsSync(path.join(rootDir, 'dist', 'server.cjs'))
    ? path.join(rootDir, 'dist', 'server.cjs')
    : path.join(rootDir, 'backend', 'dist', 'server.cjs');
  assert(fs.existsSync(bundlePath), 'dist/server.cjs derlenmiş bundle mevcut olmalı');
  if (fs.existsSync(bundlePath)) {
    const stat = fs.statSync(bundlePath);
    assert(stat.size > 100000, `dist/server.cjs makul büyüklükte olmalı (Mevcut: ${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  // 4. Test Graceful Shutdown Signal (SIGTERM)
  console.log('\n  ⚙️ Sunucu prosesi SIGTERM sinyali testi başlatılıyor (Port 5088)...');
  
  // bootstrap.ts is the real process entry point (see package.json dev/build) —
  // it loads .env BEFORE index.ts's own imports evaluate. Spawning index.ts
  // directly would skip that and hit tokenService's JWT_SECRET fail-fast guard.
  const bootstrapPath = fs.existsSync(path.join(rootDir, 'src', 'bootstrap.ts'))
    ? 'src/bootstrap.ts'
    : 'backend/src/bootstrap.ts';

  // Sunucu `npx tsx` ile DEĞİL, doğrudan `node --import tsx` ile başlatılır.
  // npx bir sarmalayıcı süreç: SIGTERM ona da ulaşınca handler'ı olmadığı için
  // 143 (128+15) ile ölür — handler'sız öldürülmüş bir sunucuyla AYNI kod.
  // Önceki `code === 0 || signal === 'SIGTERM'` koşulu da tam bu yüzden
  // "güvenli kapandı" ile "öldürüldü"yü ayırt edemiyordu. Artık çıkış kodu
  // doğrudan sunucunun kendi process.exit(0)'ı (utils/shutdown.ts).
  const serverProcess = spawn(process.execPath, ['--import', 'tsx', bootstrapPath], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: '5088',
      LOG_LEVEL: 'info',
      // CI has no .env file; these must be present for the server to boot at
      // all now that tokenService refuses to start with a hardcoded fallback.
      JWT_SECRET: process.env.JWT_SECRET || 'test_only_ops1101_access_secret_do_not_reuse',
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'test_only_ops1101_refresh_secret_do_not_reuse',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let processOutput = '';
  serverProcess.stdout?.on('data', (data) => {
    processOutput += data.toString();
  });
  serverProcess.stderr?.on('data', (data) => {
    processOutput += data.toString();
  });

  // Sabit bir bekleme (eski 2500 ms) yavaş makinede SIGTERM'i handler
  // kurulmadan ÖNCE gönderip testi rastgele kırıyordu. setupGracefulShutdown
  // listen() ile aynı senkron adımda kurulur; "Başlatıldı" logu (listen
  // callback'i) göründüğünde handler kesinlikle yerindedir.
  const started = await new Promise<boolean>((resolve) => {
    const deadline = Date.now() + 30000;
    const poll = setInterval(() => {
      if (processOutput.includes('Sunucusu Başlatıldı')) { clearInterval(poll); resolve(true); }
      else if (Date.now() > deadline || serverProcess.exitCode !== null) { clearInterval(poll); resolve(false); }
    }, 100);
  });
  assert(started, 'Sunucu (DB olmadan, POSTGRES_HOST=__CI_SKIP__) dinlemeye başladı', `çıktı: ${processOutput.slice(-600)}`);

  serverProcess.kill('SIGTERM');

  // Wait up to 10 seconds for graceful shutdown to finish
  const exitResult = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    if (serverProcess.exitCode !== null) return resolve({ code: serverProcess.exitCode, signal: null });
    const timer = setTimeout(() => {
      serverProcess.kill('SIGKILL');
      resolve({ code: -1, signal: 'SIGKILL' });
    }, 10000);

    serverProcess.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  assert(exitResult.code === 0, 'Sunucu SIGTERM sinyali ile güvenli bir şekilde kapandı (Exit 0)', `çıkış=${JSON.stringify(exitResult)}`);
  assert(processOutput.includes('[Graceful Shutdown] SIGTERM') && processOutput.includes('HTTP sunucusu yeni bağlantıları kapattı'), 'Graceful Shutdown log mesajı üretilmiş olmalı');

  console.log('\n-------------------------------------------------------------');
  console.log(`📊 Test Sonucu: ${passedCount} Başarılı, ${failedCount} Başarısız`);
  console.log('-------------------------------------------------------------\n');

  process.exit(failedCount === 0 ? 0 : 1);
}

runOps1101Tests();
