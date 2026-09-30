import { jevgrepProfile, type JevgrepProfileId } from './profile';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { canonicalHash } from '../../lib/request-schema';
import type { JevgrepAnswerCache } from './answer-cache';
import {
  NativeRequestValidationError,
  validateNativeRequest,
  validateNativeResponse,
} from './protocol.js';
import type { NativeEvaluationRequest, NativeEvaluationResponse } from './protocol.js';
import { encodeMapleRequest } from './maple';
import type { JevgrepSupplier } from './supplier';

/** Dropped connections and supplier overload before payment are retried by the
 *  child; past this many in one search the failure is reported as terminal. */
const TRANSIENT_FAILURE_LIMIT = 32;

/** A closed-vocabulary payer diagnostic for a failure that may pass on retry. */
function transientFailure(diagnostic: unknown): boolean {
  if (typeof diagnostic !== 'object' || diagnostic === null) return false;
  const { code, status, reason } = diagnostic as {
    code?: unknown;
    status?: unknown;
    reason?: unknown;
  };
  if (reason === 'insufficient_funds') return false;
  if (code === 'NETWORK_ERROR' || reason === 'balance_unavailable') return true;
  return typeof status === 'number' && (status === 408 || status === 429 || status >= 500);
}

export type JevgrepEvaluate = (
  request: NativeEvaluationRequest,
  signal: AbortSignal,
) => Promise<NativeEvaluationResponse>;

export async function startJevgrepProxy(options: {
  evaluate: JevgrepEvaluate;
  profile?: JevgrepProfileId;
  supplier?: JevgrepSupplier;
  cache?: JevgrepAnswerCache;
  signal?: AbortSignal;
}) {
  const limits = jevgrepProfile(options.profile).limits;
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  let host = '';
  let active = 0;
  let transientFailures = 0;
  let requests = 0;
  let bytes = 0;
  let localRequests = 0;
  let localBytes = 0;
  let cacheHits = 0;
  let joined = 0;
  const evaluations = new Map<string, Promise<NativeEvaluationResponse>>();
  let stopReason: string | undefined;
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const respond = (status: number, error: string) => {
      response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error }));
    };
    // The pinned evaluator treats 401/403 as bad credentials and retries 5xx.
    // A closed run is a terminal state conflict, never an authentication failure.
    const stopped = () => respond(409, `Local search stopped: ${stopReason ?? 'cancelled'}`);
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
      stopped();
      return;
    }
    if (stopReason) {
      stopped();
      return;
    }
    if (active >= limits.concurrency) {
      respond(429, 'Local concurrency limit');
      return;
    }
    if (localRequests >= limits.localRequests) {
      stopReason = 'local-request-limit';
      stopped();
      return;
    }
    localRequests++;
    active++;
    const task = (async () => {
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const part = Buffer.from(chunk);
          size += part.length;
          // Bound loopback ingress independently; only cache misses reserve
          // the unchanged supplier request/egress budget below.
          localBytes += part.length;
          if (size > limits.requestBytes || localBytes > limits.localRequestBytes) {
            stopReason ??= size > limits.requestBytes ? 'request-byte-limit' : 'local-byte-limit';
            respond(413, 'Local request byte limit');
            return;
          }
          chunks.push(part);
        }
        if (controller.signal.aborted) {
          stopped();
          return;
        }
        let body: NativeEvaluationRequest;
        try {
          body = validateNativeRequest(
            JSON.parse(Buffer.concat(chunks).toString('utf8')),
            options.profile,
          );
        } catch (error) {
          // Report only our closed vocabulary, never parse messages, question
          // text, repository content, or a remote supplier error.
          const reason =
            error instanceof NativeRequestValidationError ? error.reason : 'invalid-json';
          stopReason ??= 'invalid-request';
          respond(400, `Invalid native evaluation request: ${reason}`);
          return;
        }
        const cached = await options.cache?.get(body);
        if (stopReason || controller.signal.aborted) {
          stopped();
          return;
        }
        let answer: NativeEvaluationResponse;
        if (cached) {
          answer = validateNativeResponse(cached, body);
          cacheHits++;
        } else {
          const key = canonicalHash(body);
          const pending = options.cache ? evaluations.get(key) : undefined;
          if (pending) {
            answer = await pending;
            joined++;
          } else {
            if (requests >= limits.requests) {
              stopReason ??= 'request-limit';
              stopped();
              return;
            }
            let supplierBytes = size;
            if (options.supplier?.id === 'maple-jev') {
              try {
                supplierBytes = Buffer.byteLength(encodeMapleRequest(body, options.profile));
              } catch {
                stopReason ??= 'request-byte-limit';
                respond(413, 'Local request byte limit');
                return;
              }
            }
            if (bytes + supplierBytes > limits.totalRequestBytes) {
              stopReason ??= 'total-byte-limit';
              respond(413, 'Local request byte limit');
              return;
            }
            // Reserve synchronously across concurrent misses before dispatch.
            requests++;
            bytes += supplierBytes;
            const operation = (async () => {
              const upstream = await options.evaluate(
                JSON.parse(JSON.stringify(body)) as NativeEvaluationRequest,
                controller.signal,
              );
              const valid = validateNativeResponse(upstream, body);
              if (!controller.signal.aborted)
                await options.cache?.put(body, valid).catch(() => undefined);
              return valid;
            })();
            if (options.cache) evaluations.set(key, operation);
            try {
              answer = await operation;
            } finally {
              evaluations.delete(key);
            }
          }
        }
        if (controller.signal.aborted || response.destroyed) return;
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify(answer));
      } catch (error) {
        const details =
          error && typeof error === 'object' && 'details' in error ? error.details : undefined;
        const paymentReason =
          details && typeof details === 'object' && 'reason' in details
            ? details.reason
            : undefined;
        const diagnostic =
          details && typeof details === 'object' && 'diagnostic' in details
            ? details.diagnostic
            : undefined;
        if (
          !stopReason &&
          !controller.signal.aborted &&
          paymentReason === 'provider' &&
          transientFailure(diagnostic) &&
          transientFailures < TRANSIENT_FAILURE_LIMIT
        ) {
          // Nothing was signed, so Jevgrep may retry after its own back-off
          // instead of the whole search stopping on one dropped connection.
          transientFailures++;
          if (!response.headersSent && !response.destroyed)
            respond(429, 'Transient supplier failure before payment; retry');
          return;
        }
        stopReason ??= controller.signal.aborted
          ? 'cancelled'
          : typeof paymentReason === 'string' &&
              ['budget', 'provider', 'payment_uncertain'].includes(paymentReason)
            ? paymentReason
            : 'provider-failure';
        if (!response.headersSent && !response.destroyed) stopped();
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
  // Jevgrep keeps up to `limits.concurrency` requests open plus its retries.
  server.maxConnections = limits.concurrency * 2;
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
    summary: () => ({
      requests,
      requestBytes: bytes,
      cacheHits,
      joined,
      transientFailures,
      localRequests,
      localRequestBytes: localBytes,
      active,
      stopReason,
    }),
  };
}
