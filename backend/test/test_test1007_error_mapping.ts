import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { traceMiddleware } from '../src/middleware/loggerMiddleware';
import { globalErrorHandler } from '../src/middleware/errorHandler';

/**
 * TEST-1007 (#198) — errorHandler'ın "veritabanına ulaşılamıyor" sınıflandırması (kaos testinde bulunan boşluk): Postgres durdurulunca
 * pg/Node hataları (ECONNREFUSED/ENOTFOUND/57P01/"Connection terminated"...) opak 500 + CRITICAL_UNHANDLED_EXCEPTION yerine
 * yeniden denenebilir 503 DB_UNAVAILABLE (+ Retry-After) döner. CI'da çalışır (docker gerekmez); bağımlılığı GERÇEKTEN durduran senaryolar:
 * test_test1007_chaos.ts (host).
 */
async function run() {
  let passed = 0, total = 0;
  const check = (n: string, c: boolean, d: string) => { total++; if (c) { console.log(`✅ [PASS] ${n}\n   ${d}\n`); passed++; } else { console.log(`❌ [FAIL] ${n}\n   ${d}\n`); } };
  const mk = (extra: object, msg = 'x') => Object.assign(new Error(msg), extra);
  const cases: Array<[string, Error]> = [
    ['ECONNREFUSED', mk({ code: 'ECONNREFUSED' }, 'connect ECONNREFUSED 172.18.0.2:5432')],
    ['ENOTFOUND', mk({ code: 'ENOTFOUND' }, 'getaddrinfo ENOTFOUND postgres')],
    ['EAI_AGAIN', mk({ code: 'EAI_AGAIN' }, 'getaddrinfo EAI_AGAIN postgres')],
    ['57P01 admin_shutdown', mk({ code: '57P01' }, 'terminating connection due to administrator command')],
    ['57P03 cannot_connect_now', mk({ code: '57P03' }, 'the database system is starting up')],
    ['bağlantı koptu (mesaj)', mk({}, 'Connection terminated unexpectedly')],
    ['ECONNRESET', mk({ code: 'ECONNRESET' }, 'read ECONNRESET')]
  ];
  const app = express();
  app.use(traceMiddleware);
  cases.forEach(([, err], i) => app.get(`/c${i}`, (_q, _r, next) => next(err)));
  app.get('/generic', (_q, _r, next) => next(new Error('beklenmeyen mantık hatası')));
  app.get('/busy', (_q, _r, next) => next(mk({ code: '57014' }, 'canceling statement due to statement timeout')));
  app.use(globalErrorHandler);
  const server = await new Promise<http.Server>((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [i, [name]] of cases.entries()) {
      const r = await fetch(`${base}/c${i}`); const b: any = await r.json();
      check(`Veritabanı erişilemez (${name}) → 503 DB_UNAVAILABLE + Retry-After; opak 500 değil, traceId var`, r.status === 503 && b.error === 'DB_UNAVAILABLE' && r.headers.get('retry-after') === '5' && !!b.traceId, `${r.status} ${b.error}`);
    }
    const g = await fetch(`${base}/generic`); const gb: any = await g.json();
    const bz = await fetch(`${base}/busy`); const bb: any = await bz.json();
    check('Sınıflandırma daralmadı: gerçek beklenmeyen hata hâlâ 500 INTERNAL_SERVER_ERROR; sorgu zaman aşımı (57014) hâlâ 503 DB_BUSY (ayrı sınıf)', g.status === 500 && gb.error === 'INTERNAL_SERVER_ERROR' && bz.status === 503 && bb.error === 'DB_BUSY', `${g.status}/${bz.status}`);
  } finally { server.close(); }
  console.log(`📊 SONUÇ: ${passed} / ${total} TEST BAŞARILI`);
  process.exit(passed === total ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
