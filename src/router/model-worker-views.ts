import type { ModelWorkerActivity, ModelWorkerActivitySnapshot } from './model-worker-activity';

const MAX_ENTRIES = 16;
const BEFORE_START_MS = 30_000;
type Waiter = {
  resolve: (snapshot: ModelWorkerActivitySnapshot | null) => void;
  signal: AbortSignal;
  abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
};
type Entry = {
  begun: boolean;
  finished: boolean;
  activity?: ModelWorkerActivity;
  waiter?: Waiter;
};

/** Native mirror lifecycle only. Entries grant no execution, payment or cancellation authority. */
export class ModelWorkerViews {
  private entries = new Map<string, Entry>();
  private stopped = false;
  private stopping: Promise<void> | undefined;

  begin(id: string, create: () => ModelWorkerActivity): ModelWorkerActivity | undefined {
    if (this.stopped || !this.validId(id)) return undefined;
    const entry = this.entry(id);
    if (!entry) return undefined;
    if (entry.begun || entry.finished) return entry.activity;
    entry.begun = true;
    if (entry.waiter?.timer !== undefined) {
      clearTimeout(entry.waiter.timer);
      entry.waiter.timer = undefined;
    }
    try {
      entry.activity = create();
    } catch {
      // Missing display data must not change execution or falsely finish its mirror early.
    }
    return entry.activity;
  }

  get(id: string): ModelWorkerActivity | undefined {
    return this.stopped ? undefined : this.entries.get(id)?.activity;
  }

  finished(id: string): void {
    if (this.stopped || !this.validId(id)) return;
    const entry = this.entry(id);
    if (!entry || entry.finished) return;
    entry.finished = true;
    this.resolve(entry, this.snapshot(entry));
    // Keep recently completed mirrors available for replay, while retaining a hard bound.
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  /** A mirror can arrive before the controller. Waiting never starts or cancels a worker. */
  follow(id: string, signal: AbortSignal): Promise<ModelWorkerActivitySnapshot | null> {
    if (this.stopped || !this.validId(id) || signal.aborted) return Promise.resolve(null);
    const entry = this.entry(id);
    if (!entry || entry.waiter) return Promise.resolve(null);
    if (entry.finished) return Promise.resolve(this.snapshot(entry));
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        signal,
        abort: () => {
          this.resolve(entry, null);
          if (!entry.begun && !entry.finished && this.entries.get(id) === entry)
            this.entries.delete(id);
        },
      };
      entry.waiter = waiter;
      signal.addEventListener('abort', waiter.abort, { once: true });
      if (!entry.begun)
        waiter.timer = setTimeout(() => {
          this.resolve(entry, null);
          if (!entry.begun && !entry.finished && this.entries.get(id) === entry)
            this.entries.delete(id);
        }, BEFORE_START_MS);
      // An already-disconnected client cannot leave a waiter behind.
      if (signal.aborted) waiter.abort();
    });
  }

  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) this.resolve(entry, null);
    this.stopping = Promise.resolve();
    return this.stopping;
  }

  private validId(id: string): boolean {
    return typeof id === 'string' && id.length > 0 && id.length <= 200;
  }

  private entry(id: string): Entry | undefined {
    const previous = this.entries.get(id);
    if (previous) return previous;
    if (this.entries.size >= MAX_ENTRIES) {
      for (const [key, entry] of this.entries) {
        if (!entry.finished) continue;
        this.entries.delete(key);
        break;
      }
    }
    if (this.entries.size >= MAX_ENTRIES) return undefined;
    const entry: Entry = { begun: false, finished: false };
    this.entries.set(id, entry);
    return entry;
  }

  private snapshot(entry: Entry): ModelWorkerActivitySnapshot | null {
    try {
      return entry.activity?.snapshot() ?? null;
    } catch {
      return null;
    }
  }

  private resolve(entry: Entry, snapshot: ModelWorkerActivitySnapshot | null): void {
    const waiter = entry.waiter;
    if (!waiter) return;
    entry.waiter = undefined;
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve(snapshot);
  }
}
