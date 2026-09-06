import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * The one guarded route is `POST /hook/:harness`. The bearer keeps other local
 * accounts out; the content-type check keeps a web page's simple POST out
 * (a browser cannot send `application/json` cross-origin without a preflight,
 * and the daemon answers no preflight). Failures are 401 with no body.
 *
 * Digests, not the raw strings: `timingSafeEqual` throws on unequal lengths,
 * which would turn a short bad token into an uncaught exception.
 */

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

export function bearerOf(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string') return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return m ? m[1] : undefined;
}

export function isJson(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'];
  return typeof ct === 'string' && /^application\/json\b/i.test(ct.trim());
}

export function authorized(req: IncomingMessage, token: string): boolean {
  return isJson(req) && tokenMatches(bearerOf(req), token);
}
