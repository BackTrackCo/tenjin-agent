import { Worker } from 'node:worker_threads';
import type * as Keystore from 'ox/Keystore';

export interface KeystoreDerivationOptions {
  /** Pure computation only: this never cancels credential-store reads or writes. */
  signal?: AbortSignal;
  /** A single derivation's bound; interactive wallet callers allow up to two minutes. */
  timeoutMs?: number;
}

/**
 * Ox's asynchronous KDF yields microtasks, which can starve Node timers for the
 * entire derivation. Keep its exact parameters/encoding in a disposable worker:
 * native OpenSSL scrypt rejects the existing N=262144,r=1,p=8 wallet format.
 * No credential-store operation or payment signature runs in this worker.
 */
export async function deriveKeystoreKey(
  keystore: Keystore.Keystore,
  password: string,
  options: KeystoreDerivationOptions = {},
): Promise<Keystore.Key> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error('Keystore derivation timeout must be between 1 and 120000 milliseconds.');
  if (options.signal?.aborted) throw derivationError('AbortError');

  // Source tests run on the same Node 24 floor as the CLI (native type stripping).
  // Every bundled entry and code-split chunk is adjacent to the worker in dist.
  const url = new URL(
    import.meta.url.endsWith('.ts') ? './keystore-kdf-worker.ts' : './wallet-kdf-worker.mjs',
    import.meta.url,
  );
  return new Promise<Keystore.Key>((resolve, reject) => {
    const worker = new Worker(url, { workerData: { keystore, password }, execArgv: [] });
    let settled = false;
    const onAbort = () => finish(derivationError('AbortError'));
    function finish(error?: Error, key?: Keystore.Key): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      // Await termination before the caller continues, so timeout/success never
      // accumulates background KDF workers or leaves an abandoned key producer.
      void worker.terminate().then(
        () => (error ? reject(error) : resolve(key!)),
        () => reject(new Error('Keystore derivation worker could not terminate.')),
      );
    }
    worker.once('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'key' in message &&
        typeof message.key === 'string' &&
        /^0x[0-9a-fA-F]{64}$/.test(message.key)
      ) {
        finish(undefined, message.key as `0x${string}`);
      } else finish(new Error('Keystore derivation failed.'));
    });
    worker.once('error', () => finish(new Error('Keystore derivation worker failed.')));
    worker.once('exit', () => {
      if (!settled) finish(new Error('Keystore derivation worker exited without a result.'));
    });
    const timer = setTimeout(() => finish(derivationError('TimeoutError')), timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function derivationError(name: 'AbortError' | 'TimeoutError'): Error {
  return Object.assign(
    new Error(`Keystore derivation ${name === 'AbortError' ? 'aborted' : 'timed out'}.`),
    {
      name,
    },
  );
}
