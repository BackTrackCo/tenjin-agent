import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { JEV_LIMITS, validateNativeRequest, validateNativeResponse } from './protocol.js';
import type { NativeEvaluationRequest, NativeEvaluationResponse } from './protocol.js';

export type JevgrepEvaluate = (
  request: NativeEvaluationRequest,
  signal: AbortSignal,
) => Promise<NativeEvaluationResponse>;

export async function startJevgrepProxy(options: {
  evaluate: JevgrepEvaluate;
  signal?: AbortSignal;
}) {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  let host = '';
  let active = 0;
  let requests = 0;
  let bytes = 0;
  let stopReason: string | undefined;
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const respond = (status: number, error: string) => {
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error }));
    };
    const auth = Buffer.from(request.headers.authorization ?? '');
    if (
      request.headers.host !== host ||
      request.headers.origin !== undefined ||
      request.headers['transfer-encoding'] !== undefined ||
      auth.length !== expectedAuth.length ||
      !timingSafeEqual(auth, expectedAuth)
    ) {
      respond(403, 'Local proxy access denied');
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/systemone') {
      respond(404, 'Unknown local proxy route');
      return;
    }
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
      respond(415, 'Expected application/json');
      return;
    }
    if (controller.signal.aborted) {
      respond(503, 'Local search stopped');
      return;
    }
    if (stopReason) {
      respond(403, 'Local search stopped');
      return;
    }
    if (active >= JEV_LIMITS.concurrency) {
      respond(429, 'Local concurrency limit');
      return;
    }
    if (requests >= JEV_LIMITS.requests) {
      stopReason = 'request-limit';
      respond(403, 'Local request limit');
      return;
    }
    active++;
    const task = (async () => {
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const part = Buffer.from(chunk);
          size += part.length;
          // Reserve bytes as they arrive across concurrent uploads, before dispatch.
          bytes += part.length;
          if (size > JEV_LIMITS.requestBytes || bytes > JEV_LIMITS.totalRequestBytes) {
            stopReason = size > JEV_LIMITS.requestBytes ? 'request-byte-limit' : 'total-byte-limit';
            respond(413, 'Local request byte limit');
            return;
          }
          chunks.push(part);
        }
        if (controller.signal.aborted) {
          respond(503, 'Local search stopped');
          return;
        }
        let body: NativeEvaluationRequest;
        try {
          body = validateNativeRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          respond(400, 'Invalid native evaluation request');
          return;
        }
        if (requests >= JEV_LIMITS.requests) {
          stopReason = 'request-limit';
          respond(403, 'Local request limit');
          return;
        }
        if (stopReason) {
          respond(403, 'Local search stopped');
          return;
        }
        requests++;
        const upstream = await options.evaluate(body, controller.signal);
        if (controller.signal.aborted || response.destroyed) return;
        const answer = validateNativeResponse(upstream, body);
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify(answer));
      } catch (error) {
        const details =
          error && typeof error === 'object' && 'details' in error ? error.details : undefined;
        const paymentReason =
          details && typeof details === 'object' && 'reason' in details
            ? details.reason
            : undefined;
        stopReason ??= controller.signal.aborted
          ? 'cancelled'
          : typeof paymentReason === 'string' &&
              ['budget', 'provider', 'payment_uncertain'].includes(paymentReason)
            ? paymentReason
            : 'provider-failure';
        if (!response.headersSent && !response.destroyed) respond(502, 'Local evaluation failed');
      } finally {
        active--;
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1;
  server.maxConnections = 8;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Proxy did not bind'));
        return;
      }
      host = `127.0.0.1:${address.port}`;
      resolve();
    });
  });
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    closePromise ??= (async () => {
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Payment operations receive cancellation but may retain uncertain exposure.
      // Their owner persists it; shutdown must not wait forever for a bad callback.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    })();
    return closePromise;
  }
  function abort() {
    void close();
  }
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) await close();
  return {
    baseURL: `http://${host}/v1`,
    token,
    close,
    summary: () => ({ requests, requestBytes: bytes, active, stopReason }),
  };
}
