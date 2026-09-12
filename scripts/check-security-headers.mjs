#!/usr/bin/env node
// ==============================================================================
// TEST_PLAN.md §5.1 — Güvenlik yanıt başlıkları denetimi.
//
// NEDEN STATİK (canlı istek yerine):
//   Bu başlıkların çoğu nginx tarafından ekleniyor, ama CI'daki
//   auth-integration-test işinde nginx HİÇ YOK (backend çıplak, port 5000).
//   Canlı bir curl testi CI'da çalışamaz; yapılandırmanın kendisini
//   denetlemek hem CI'da çalışır hem de başlığın SİLİNMESİNİ yakalar.
//   Canlı doğrulama ayrıca elle yapıldı (curl -I ile CSP'nin gerçekten
//   döndüğü ve uygulamanın çalışmaya devam ettiği görüldü).
//
// NEDEN ÖNEMLİ: access/refresh token'lar localStorage'da tutuluyor
// (AppContext.tsx), yani bir XSS doğrudan oturum ele geçirmeye dönüşür.
// CSP bu senaryoda son savunma hattıdır — ve bir CSP'nin en kolay
// "kazara etkisizleştirilme" yolu script-src'ye 'unsafe-inline' eklemektir.
// Bu script tam olarak onu engeller.
//
// Kullanım: node scripts/check-security-headers.mjs
// ==============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const NGINX_CONF = path.join(REPO_ROOT, 'frontend', 'nginx.conf');
const BACKEND_INDEX = path.join(REPO_ROOT, 'backend', 'src', 'index.ts');

const problems = [];

// ── 1) nginx: zorunlu güvenlik başlıkları ────────────────────────────────
if (!existsSync(NGINX_CONF)) {
  problems.push({ where: 'frontend/nginx.conf', msg: 'Dosya bulunamadı.' });
} else {
  const conf = readFileSync(NGINX_CONF, 'utf-8');

  const REQUIRED_HEADERS = [
    { name: 'X-Frame-Options', why: 'clickjacking koruması' },
    { name: 'X-Content-Type-Options', why: 'MIME sniffing koruması' },
    { name: 'Referrer-Policy', why: 'URL/token sızıntısı koruması' },
    { name: 'Content-Security-Policy', why: 'XSS son savunma hattı (token\'lar localStorage\'da)' }
  ];

  for (const h of REQUIRED_HEADERS) {
    // `add_header X "..." always;` biçimini ara (yorum satırları hariç)
    const re = new RegExp(`^\\s*add_header\\s+${h.name}\\s`, 'im');
    if (!re.test(conf)) {
      problems.push({ where: 'frontend/nginx.conf', msg: `'${h.name}' başlığı eksik — ${h.why}.` });
    }
  }

  // ── 2) CSP içeriği: kritik direktifler gevşetilmemiş olmalı ────────────
  const cspLine = conf
    .split('\n')
    .find((l) => /add_header\s+Content-Security-Policy/i.test(l) && !l.trim().startsWith('#'));

  if (cspLine) {
    // script-src'nin KENDİ değeri içinde 'unsafe-inline'/'unsafe-eval' var mı?
    // (style-src'de 'unsafe-inline' KABUL EDİLİYOR — React style={{...}} prop'u
    //  ve Google Fonts stylesheet'i bunu gerektiriyor; risk sınıfı script'ten
    //  çok daha düşük.)
    const scriptSrc = /script-src([^;"]*)/i.exec(cspLine)?.[1] ?? '';
    for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'"]) {
      if (scriptSrc.includes(unsafe)) {
        problems.push({
          where: 'frontend/nginx.conf',
          msg:
            `CSP script-src içinde ${unsafe} var — bu, CSP'nin XSS korumasının ` +
            'büyük kısmını etkisiz kılar. Build çıktısında inline script YOK ' +
            "(dist/index.html yalnızca harici bundle yükler), bu yüzden buna GEREK DE YOK."
        });
      }
    }

    for (const directive of ['default-src', 'object-src', 'base-uri', 'frame-ancestors']) {
      if (!new RegExp(directive, 'i').test(cspLine)) {
        problems.push({ where: 'frontend/nginx.conf', msg: `CSP'de '${directive}' direktifi eksik.` });
      }
    }
  }
}

// ── 3) backend: X-Powered-By parmak izi kapalı olmalı ────────────────────
if (!existsSync(BACKEND_INDEX)) {
  problems.push({ where: 'backend/src/index.ts', msg: 'Dosya bulunamadı.' });
} else {
  const src = readFileSync(BACKEND_INDEX, 'utf-8');
  const hasDisable = /app\s*\.\s*disable\s*\(\s*['"]x-powered-by['"]\s*\)/i.test(src);
  if (!hasDisable) {
    problems.push({
      where: 'backend/src/index.ts',
      msg:
        "app.disable('x-powered-by') yok — Express her yanıta " +
        "'X-Powered-By: Express' ekler ve saldırgana bedava yığın parmak izi verir."
    });
  }
}

if (problems.length > 0) {
  console.error('[check-security-headers] HATA: güvenlik başlığı yapılandırmasında sorun bulundu:\n');
  for (const p of problems) {
    console.error(`  ${p.where}`);
    console.error(`    ${p.msg}\n`);
  }
  process.exit(1);
}

console.log(
  '[check-security-headers] OK — nginx güvenlik başlıkları (CSP dahil) yerinde, ' +
  "CSP script-src gevşetilmemiş, backend X-Powered-By kapalı."
);
