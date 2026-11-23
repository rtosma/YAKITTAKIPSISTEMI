// ==============================================================================
// OPS-1108 — TATBİKAT sunucusu (yalnızca test/tatbikat; node:20-alpine konteynerinde çalışır, üretimde ASLA kullanılmaz).
// Üç rol tek süreçte:
//   GET  /metrics         → etkin senaryo serilerini Prometheus metni olarak yayınlar (sahte "backend" exporter'ı)
//   POST /scenario        → { series: [[seçici, 'a+bxN'|'a-bxN'|'now'], ...] } serileri değiştirir (sayaçlar dakikada b artar)
//   POST /hook/:receiver  → Alertmanager webhook alıcısı (nöbet/ekip/kalp atışı ayrı yollar); GET /received, POST /reset
// ==============================================================================
import { createServer } from 'node:http';

// Seri durumu: seçici → { spec, origin }. Sayaçlar (a+bxN, b>0) YENİ eklendiklerinde/değiştiklerinde 5 dakikalık GEÇMİŞLE başlar
// (origin = şimdi − 5 dk): Prometheus rate() [5m] penceresi ilk kazımada kararlı-durum hızını görür (promtool'daki `0+bx60` serisiyle aynı anlam;
// aksi halde pencere dolana kadar ~5 dk beklemek gerekirdi). DEĞİŞMEYEN seriler kesintisiz devam eder (sayaç sıfırlanmaz).
let series = new Map();
const received = [];
const WARMUP_MS = 5 * 60_000;

const parse = (sel) => {
  const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?$/.exec(sel);
  return { name: m[1], labels: m[2] || '' };
};
const valueAt = (spec, minutes) => {
  if (spec === 'now') return Date.now() / 1000;   // zaman damgası metrikleri (sağlıklı taban çizgisi)
  const m = /^(-?[\d.]+)([+-])([\d.]+)x(\d+)$/.exec(spec);
  const a = Number(m[1]); const step = Number(m[3]) * (m[2] === '-' ? -1 : 1); const n = Number(m[4]);
  return a + step * Math.min(minutes, n);
};

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => resolve(b)); });

createServer(async (req, res) => {
  const url = req.url || '';
  if (req.method === 'GET' && url === '/metrics') {
    const lines = [...series].map(([sel, e]) => {
      const { name, labels } = parse(sel);
      // İlk kazımada sayaç BAŞLANGIÇ değerinde görünür (önceki örnek yok → rate() için "artış" oluşmaz); sonraki kazımalarda 5 dk'lık geçmişe atlar:
      // Prometheus ilk iki örnek arasında 5 dakikalık bir artış görür ve rate() [5m] penceresi hemen kararlı-durum hızını verir.
      const minutes = e.pendingWarmup ? 0 : (Date.now() - e.origin) / 60000;
      const v = valueAt(e.spec, minutes);
      if (e.pendingWarmup) { e.pendingWarmup = false; e.origin = Date.now() - WARMUP_MS; }
      return `${name}${labels} ${v}`;
    });
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    return res.end(lines.join('\n') + '\n');
  }
  if (req.method === 'POST' && url === '/scenario') {
    const body = JSON.parse(await readBody(req));
    const next = new Map();
    for (const [sel, spec] of body.series) {
      const prev = series.get(sel);
      const isCounter = /^-?[\d.]+\+[\d.]+x\d+$/.test(spec) && !/^-?[\d.]+\+0x/.test(spec);
      next.set(sel, prev && prev.spec === spec ? prev : { spec, origin: Date.now(), pendingWarmup: isCounter });
    }
    series = next;
    res.writeHead(200); return res.end('ok');
  }
  if (req.method === 'POST' && url.startsWith('/hook/')) {
    const body = await readBody(req);
    let payload = {}; try { payload = JSON.parse(body); } catch { /* düz metin */ }
    received.push({ receiver: url.slice('/hook/'.length), at: Date.now(), payload });
    res.writeHead(200); return res.end('ok');
  }
  if (req.method === 'GET' && url === '/received') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(received)); }
  if (req.method === 'POST' && url === '/reset') { received.length = 0; res.writeHead(200); return res.end('ok'); }
  res.writeHead(404); res.end();
}).listen(8080, () => console.log('drill-server :8080'));
