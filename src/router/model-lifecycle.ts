import type { ModelSession } from './model-handoff';

type Operation = { abort: AbortController; done: Promise<void> };
/** Register before the first await, so interruption also owns a selection in flight. */
export class ModelLifecycle {
  private windows = new Map<string, Set<Operation>>();
  private fenced = new Set<string>();
  private stopped = false;
  private key(session: ModelSession) {
    return JSON.stringify([session.sessionId, session.turnId]);
  }
  async run<T>(
    session: ModelSession,
    signal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const key = this.key(session);
    if (this.stopped || this.fenced.has(key)) throw new Error('Delegation window interrupted');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let complete!: () => void;
    const operation = {
      abort,
      done: new Promise<void>((resolve) => {
        complete = resolve;
      }),
    };
    const active = this.windows.get(key) ?? new Set<Operation>();
    active.add(operation);
    this.windows.set(key, active);
    try {
      abort.signal.throwIfAborted();
      return await fn(abort.signal);
    } finally {
      active.delete(operation);
      if (!active.size) this.windows.delete(key);
      signal?.removeEventListener('abort', cancel);
      complete();
    }
  }
  fence(session: ModelSession): Promise<void> {
    const key = this.key(session);
    this.fenced.add(key);
    const active = [...(this.windows.get(key) ?? [])];
    for (const operation of active) operation.abort.abort();
    return Promise.all(active.map((operation) => operation.done)).then(() => undefined);
  }
  async stop() {
    this.stopped = true;
    const active = [...this.windows.values()].flatMap((window) => [...window]);
    for (const operation of active) operation.abort.abort();
    await Promise.all(active.map((operation) => operation.done));
  }
}
