import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Harness } from '../adapters/types';
import { runFire } from '../hooks/fire';
import type { Deps } from '../hooks/types';
import {
  HEADERS_TIMEOUT_MS,
  IDLE_SYNC_WARN_MS,
  MAX_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
} from '../hooks/constants';
import { authorized } from './auth';

/**
 * One route per harness, `POST /hook/:harness`, plus an unauthenticated
 * `GET /health`. The body is the harness's native payload; the response is
 * the adapter's `encode` with 200, or 204 when there is nothing to say.
 *
 * The harness closing its socket before we answer is the "client left"
 * signal: `res.on('close')` with `writableFinished === false`. NOT
 * `req.on('close')`, which fires when the request BODY is consumed (Node docs,
 * changed v16; probed on 24.19.0) and would cancel every leg at parse time.
 */

export interface ServerDeps {
  deps: Deps;
  token: string;
  version: string;
  dataDir: string;
  startedAt: number;
  /** Called on every request; the idle timer's `touch`. */
  onRequest(): void;
  lastRequestAt(): number;
  /** Called with the port once known (for `/health`). */
  port(): number;
  /** Refresh config if `config.json` changed; awaited before each fire. */
  refreshConfig(): Promise<void>;
}

export interface HookServer {
  server: Server;
  /** Resolves when no fire is in flight. */
  drain(): Promise<void>;
}

/**
 * Read the body up to `max`; past it, keep DRAINING but stop keeping, and
 * resolve null at the end. Never `req.destroy()` here: Node's
 * `IncomingMessage._destroy` tears down the socket when the body has not
 * ended, and the response shares that socket, so the 413 the caller sends
 * would arrive as ECONNRESET (found by the smoke test).
 */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: string): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createHookServer(d: ServerDeps): HookServer {
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const done = () => {
    inFlight -= 1;
    if (inFlight === 0) while (waiters.length > 0) waiters.shift()?.();
  };

  const server = createServer((req, res) => {
    d.onRequest();
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/health') {
      const now = d.deps.clock();
      send(
        res,
        200,
        JSON.stringify({
          version: d.version,
          pid: process.pid,
          port: d.port(),
          uptime_ms: now - d.startedAt,
          idle_ms: now - d.lastRequestAt(),
          data_dir: d.dataDir,
          rss: process.memoryUsage().rss,
        }),
      );
      return;
    }
    const m = /^\/hook\/([a-z]+)$/.exec(url);
    if (req.method !== 'POST' || m === null) {
      send(res, 404);
      return;
    }
    if (!authorized(req, d.token)) {
      send(res, 401);
      return;
    }
    const name = m[1] ?? '';
    const adapter = Object.hasOwn(d.deps.adapters, name)
      ? d.deps.adapters[name as Harness]
      : undefined;
    if (adapter === undefined) {
      send(res, 404);
      return;
    }
    inFlight += 1;
    // The ledger write is deferred past the response, so the request stays
    // in flight until it has run: `drain()` must not let shutdown close the
    // db under the last fire's row.
    let commit: (() => void) | null = null;
    void (async () => {
      try {
        const body = await readBody(req, MAX_BODY_BYTES);
        if (body === null) {
          d.deps.log(`413: ${m[1]} body over ${MAX_BODY_BYTES} bytes`);
          send(res, 413);
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          send(res, 400);
          return;
        }
        await d.refreshConfig();
        const clientLeft = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) clientLeft.abort();
        });
        const t0 = performance.now();
        const input = adapter.decode(raw);
        if (input === null) {
          send(res, 204);
          return;
        }
        const fire = await runFire(input, d.deps, clientLeft.signal);
        // Captured HERE, not after the response: the fire may already have
        // cached a verdict and burned a `seen:` mark, and a throw in `encode` or
        // `send` would otherwise end it with no row at all.
        commit = fire.commit;
        const sync = performance.now() - t0;
        if (sync > IDLE_SYNC_WARN_MS && fire.emit === null) {
          // A fire with no legs that still took this long was synchronous work.
          d.deps.log(`slow fire: ${input.event} ${sync.toFixed(1)} ms on the loop`);
        }
        if (!clientLeft.signal.aborted) {
          const encoded = adapter.encode(fire.emit, input);
          if (encoded === null) send(res, 204);
          else send(res, 200, JSON.stringify(encoded));
        }
        // The row itself is written in `finally`, after the response has
        // flushed, never on the harness's clock.
      } catch (err) {
        d.deps.log(
          `hook ${m[1]}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
        if (!res.headersSent) send(res, 500);
      } finally {
        const pending = commit;
        if (pending === null) done();
        else
          setImmediate(() => {
            try {
              pending();
            } finally {
              done();
            }
          });
      }
    })();
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = 5000;

  return {
    server,
    drain: () => (inFlight === 0 ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
  };
}
