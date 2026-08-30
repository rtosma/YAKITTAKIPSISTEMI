import fs from 'fs';
import path from 'path';

function runOps1102Tests() {
  console.log('\n=============================================================');
  console.log('🧪 [TEST-OPS-1102] GitHub Actions CI/CD Pipeline Testi');
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
  const workflowPath = path.join(rootDir, '.github', 'workflows', 'ci-cd.yml');

  // 1. Workflow file existence check
  assert(fs.existsSync(workflowPath), '.github/workflows/ci-cd.yml dosyası var olmalı');

  if (fs.existsSync(workflowPath)) {
    const content = fs.readFileSync(workflowPath, 'utf-8');

    // 2. Trigger check
    assert(content.includes('on:') && content.includes('push:') && content.includes('pull_request:'), 'Workflow push ve pull_request tetikleyicilerini içermeli');

    // 3. Job structure checks
    assert(content.includes('quality-and-tests:'), 'quality-and-tests job\'ı tanımlanmış olmalı');
    assert(content.includes('build-bundle:'), 'build-bundle job\'ı tanımlanmış olmalı');
    assert(content.includes('docker-security-scan:'), 'docker-security-scan job\'ı tanımlanmış olmalı');

    // 4. Quality & Integration test execution check
    assert(content.includes('npm run lint'), 'Lint / TypeScript denetimi çalıştırılmalı');
    assert(content.includes('server/test_res902.ts'), 'test_res902.ts entegrasyon testi çalıştırılmalı');
    assert(content.includes('server/test_ops1101.ts'), 'test_ops1101.ts entegrasyon testi çalıştırılmalı');

    // 5. Standalone build check
    assert(content.includes('npm run build:server'), 'Server standalone build komutu çalıştırılmalı');

    // 6. Trivy Security Vulnerability Scanner check (AC Rule: CVE Critical/High breaks build)
    assert(content.includes('aquasecurity/trivy-action'), 'Aquasecurity Trivy vulnerability scanner eklentisi bulunmalı');
    assert(content.includes("exit-code: '1'"), 'Trivy exit-code: 1 ile güvenlik açığında build kırmalı');
    assert(content.includes("CRITICAL,HIGH"), 'Trivy CRITICAL ve HIGH seviye CVE taraması yapmalı');
  }

  console.log('\n-------------------------------------------------------------');
  console.log(`📊 Test Sonucu: ${passedCount} Başarılı, ${failedCount} Başarısız`);
  console.log('-------------------------------------------------------------\n');

  process.exit(failedCount === 0 ? 0 : 1);
}

runOps1102Tests();
