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
  
  const indexPath = fs.existsSync(path.join(rootDir, 'src', 'index.ts'))
    ? 'src/index.ts'
    : 'backend/src/index.ts';

  const serverProcess = spawn('npx', ['tsx', indexPath], {
    cwd: rootDir,
    env: { ...process.env, PORT: '5088', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let processOutput = '';
  serverProcess.stdout?.on('data', (data) => {
    processOutput += data.toString();
  });
  serverProcess.stderr?.on('data', (data) => {
    processOutput += data.toString();
  });

  // Wait 2 seconds for server to start listening
  await new Promise((resolve) => setTimeout(resolve, 2500));

  // Send SIGTERM signal to server child process
  serverProcess.kill('SIGTERM');

  // Wait up to 4 seconds for graceful shutdown to finish
  const exitResult = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const timer = setTimeout(() => {
      serverProcess.kill('SIGKILL');
      resolve({ code: -1, signal: 'SIGKILL' });
    }, 4000);

    serverProcess.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  assert(exitResult.code === 0 || exitResult.signal === 'SIGTERM', 'Sunucu SIGTERM sinyali ile güvenli bir şekilde kapandı (Exit 0)');
  assert(processOutput.includes('Graceful Shutdown') || processOutput.includes('SIGTERM'), 'Graceful Shutdown log mesajı üretilmiş olmalı');

  console.log('\n-------------------------------------------------------------');
  console.log(`📊 Test Sonucu: ${passedCount} Başarılı, ${failedCount} Başarısız`);
  console.log('-------------------------------------------------------------\n');

  process.exit(failedCount === 0 ? 0 : 1);
}

runOps1101Tests();
