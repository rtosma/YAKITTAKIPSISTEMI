import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { scrubSentryEvent } from './sentryScrub';

/**
 * RES-907 (#192) — tarayıcı olayları için same-origin Sentry TÜNELİ: `POST /api/v1/monitoring/sentry-tunnel`.
 *
 * NEDEN tünel: (1) nginx CSP'si `connect-src 'self'` — tarayıcının doğrudan Sentry'ye bağlanması için CSP'yi gevşetmek gerekirdi;
 * (2) reklam engelleyiciler sentry.io'yu keser, kendi origin'imize giden istek kesilmez; (3) KİŞİSEL VERİ KAPISI: her olay
 * sunucuda, backend olaylarıyla AYNI kural motorundan (sentryScrub.ts) tekrar geçer — istemci koduna güvenilmez; (4) tarayıcıdan
 * Sentry'ye giden isteğin IP/başlık bilgisi sızmaz (Sentry yalnızca sunucumuzu görür).
 *
 * AÇIK RÖLE OLMAMASI: yalnızca yapılandırılmış DSN'e giden zarflar kabul edilir (başlıktaki dsn'in anahtar+proje+host'u eşleşmezse 403);
 * gövde ≤ 256 KB; yalnızca event/transaction/session(s)/client_report öğeleri iletilir — ek dosya (attachment), replay, profil gibi
 * kişisel veri taşıyabilecek öğeler ATILIR; her öğenin uzunluğu temizlemeden sonra yeniden hesaplanır.
 */
export const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_ITEMS = 20;
const FORWARD_TIMEOUT_MS = 3000;
const ALLOWED_ITEM_TYPES = new Set(['event', 'transaction', 'session', 'sessions', 'client_report']);

export interface ParsedDsn { publicKey: string; projectId: string; origin: string; pathPrefix: string; }

export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    const segments = u.pathname.split('/').filter(Boolean);
    const projectId = segments.pop();
    if (!u.username || !projectId) return null;
    return { publicKey: u.username, projectId, origin: `${u.protocol}//${u.host}`, pathPrefix: segments.length ? `/${segments.join('/')}` : '' };
  } catch {
    return null;
  }
}

export interface EnvelopeItem { header: Record<string, any>; payload: Buffer; }
export interface ParsedEnvelope { header: Record<string, any>; items: EnvelopeItem[]; }

/** Sentry zarf biçimi: `<zarf başlığı JSON>\n(<öğe başlığı JSON>\n<yük>\n)*`. Öğe başlığındaki `length` varsa yük tam o kadar bayttır. */
export function parseEnvelope(buf: Buffer): ParsedEnvelope {
  let pos = 0;
  const readLine = (): Buffer => {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl === -1 ? buf.length : nl;
    const line = buf.subarray(pos, end);
    pos = nl === -1 ? buf.length : nl + 1;
    return line;
  };
  const header = JSON.parse(readLine().toString('utf8'));
  const items: EnvelopeItem[] = [];
  while (pos < buf.length) {
    const headerLine = readLine();
    if (headerLine.length === 0) continue;
    const itemHeader = JSON.parse(headerLine.toString('utf8'));
    let payload: Buffer;
    if (typeof itemHeader.length === 'number') {
      if (itemHeader.length < 0 || pos + itemHeader.length > buf.length) throw new Error('Geçersiz öğe uzunluğu');
      payload = buf.subarray(pos, pos + itemHeader.length);
      pos += itemHeader.length;
      if (buf[pos] === 0x0a) pos++;
    } else {
      payload = readLine();
    }
    items.push({ header: itemHeader, payload });
    if (items.length > MAX_ITEMS) throw new Error('Çok fazla öğe');
  }
  return { header, items };
}

export function serializeEnvelope(header: Record<string, any>, items: EnvelopeItem[]): Buffer {
  const parts: Buffer[] = [Buffer.from(JSON.stringify(header) + '\n')];
  for (const it of items) {
    parts.push(Buffer.from(JSON.stringify({ ...it.header, length: it.payload.length }) + '\n'), it.payload, Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

export type ForwardFn = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
const defaultForward: ForwardFn = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body as any, signal: init.signal });
  return { ok: res.ok, status: res.status };
};

export interface TunnelDeps { getDsn?: () => string | undefined; forward?: ForwardFn; }

export interface TunnelOutcome { status: number; forwarded: number; dropped: number; }

/** Saf çekirdek (HTTP'den bağımsız) — testler doğrudan çağırabilir. */
export async function processEnvelope(body: Buffer, deps: TunnelDeps = {}): Promise<TunnelOutcome> {
  const dsn = (deps.getDsn ?? (() => config.SENTRY_DSN))();
  if (!dsn) return { status: 204, forwarded: 0, dropped: 0 };
  const target = parseDsn(dsn);
  if (!target) return { status: 204, forwarded: 0, dropped: 0 };

  let env: ParsedEnvelope;
  try {
    env = parseEnvelope(body);
  } catch {
    return { status: 400, forwarded: 0, dropped: 0 };
  }
  const claimed = typeof env.header.dsn === 'string' ? parseDsn(env.header.dsn) : null;
  if (!claimed) return { status: 400, forwarded: 0, dropped: 0 };
  if (claimed.publicKey !== target.publicKey || claimed.projectId !== target.projectId || claimed.origin !== target.origin || claimed.pathPrefix !== target.pathPrefix) {
    return { status: 403, forwarded: 0, dropped: 0 };
  }

  const kept: EnvelopeItem[] = [];
  let dropped = 0;
  for (const item of env.items) {
    const type = item.header.type as string;
    if (!ALLOWED_ITEM_TYPES.has(type)) { dropped++; continue; }
    if (type === 'event' || type === 'transaction') {
      try {
        const cleaned = scrubSentryEvent(JSON.parse(item.payload.toString('utf8')));
        kept.push({ header: { type, ...(item.header.content_type ? { content_type: item.header.content_type } : {}) }, payload: Buffer.from(JSON.stringify(cleaned)) });
      } catch {
        dropped++;
      }
    } else {
      kept.push({ header: { type }, payload: item.payload });
    }
  }
  if (kept.length === 0) return { status: 200, forwarded: 0, dropped };

  // Başlıktan yalnızca güvenli alanlar; SDK/sent_at korunur, dsn yapılandırılmış DSN olarak yazılır (tarayıcının gönderdiği ham başlık taşınmaz).
  const outHeader: Record<string, any> = { dsn, ...(env.header.event_id ? { event_id: String(env.header.event_id).slice(0, 64) } : {}), ...(env.header.sent_at ? { sent_at: env.header.sent_at } : {}) };
  const url = `${target.origin}${target.pathPrefix}/api/${target.projectId}/envelope/?sentry_key=${encodeURIComponent(target.publicKey)}&sentry_version=7`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FORWARD_TIMEOUT_MS);
  try {
    const r = await (deps.forward ?? defaultForward)(url, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body: serializeEnvelope(outHeader, kept), signal: ctl.signal });
    if (!r.ok) logger.warn({ status: r.status }, '⚠️ [RES-907] Sentry tüneli: upstream olayı reddetti.');
  } catch (err) {
    // Sentry erişilemezse tarayıcıyı hata fırtınasına sokmayız (200); yalnızca sunucu loguna yazılır.
    logger.warn({ err }, '⚠️ [RES-907] Sentry tüneli: upstream erişilemedi.');
  } finally {
    clearTimeout(timer);
  }
  return { status: 200, forwarded: kept.length, dropped };
}

export function createSentryTunnelHandlers(deps: TunnelDeps = {}): RequestHandler[] {
  // Tarayıcı SDK'sı `text/plain` (veya application/x-sentry-envelope) gönderir → her türü ham Buffer olarak al.
  const raw = express.raw({ type: () => true, limit: MAX_ENVELOPE_BYTES });
  const handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length === 0) { res.status(400).json({ success: false, error: 'BAD_REQUEST', message: 'Boş zarf.' }); return; }
      const out = await processEnvelope(body, deps);
      if (out.status === 204) { res.status(204).end(); return; }
      if (out.status !== 200) { res.status(out.status).json({ success: false, error: out.status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST', message: out.status === 403 ? 'DSN eşleşmiyor.' : 'Geçersiz Sentry zarfı.' }); return; }
      res.status(200).json({});
    } catch (err) {
      next(err);
    }
  };
  return [raw, handler];
}
