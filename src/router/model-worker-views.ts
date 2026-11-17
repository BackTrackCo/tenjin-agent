import type { ModelWorkerActivity, ModelWorkerActivitySnapshot } from './model-worker-activity';

const MAX_ENTRIES = 16;
/** Readers that may wait on one worker at once: the viewer's step and a row or two. */
const MAX_WAITERS = 4;
const BEFORE_START_MS = 30_000;
type Waiter = {
  resolve: (snapshot: ModelWorkerActivitySnapshot | null) => void;
  signal: AbortSignal;
  abort: () => void;
  /** Wake once the activity has moved past this sequence; without it, only at the end. */
  after?: number;
  timer?: ReturnType<typeof setTimeout>;
};
type Entry = {
  begun: boolean;
  finished: boolean;
  activity?: ModelWorkerActivity;
  waiters: Set<Waiter>;
  unlisten?: () => void;
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
    for (const waiter of entry.waiters) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    try {
      entry.activity = create();
      entry.unlisten = entry.activity.onChange(() => this.moved(entry));
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
    entry.unlisten?.();
    const snapshot = this.snapshot(entry);
    for (const waiter of [...entry.waiters]) this.resolve(entry, waiter, snapshot);
    // Keep recently completed mirrors available for replay, while retaining a hard bound.
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  /**
   * A mirror can arrive before the controller. Waiting never starts or cancels a worker.
   * Without `after` it answers at the end; with it, also once the activity has moved past
   * that sequence, so a reader that shows the run as it goes wakes for each change.
   */
  follow(
    id: string,
    signal: AbortSignal,
    after?: number,
  ): Promise<ModelWorkerActivitySnapshot | null> {
    if (this.stopped || !this.validId(id) || signal.aborted) return Promise.resolve(null);
    const entry = this.entry(id);
    if (!entry || entry.waiters.size >= MAX_WAITERS) return Promise.resolve(null);
    if (entry.finished) return Promise.resolve(this.snapshot(entry));
    if (after !== undefined) {
      const now = this.snapshot(entry);
      if (now && now.sequence > after) return Promise.resolve(now);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        signal,
        ...(after === undefined ? {} : { after }),
        abort: () => this.release(id, entry, waiter),
      };
      entry.waiters.add(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      if (!entry.begun)
        waiter.timer = setTimeout(() => this.release(id, entry, waiter), BEFORE_START_MS);
      // An already-disconnected client cannot leave a waiter behind.
      if (signal.aborted) waiter.abort();
    });
  }

  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      entry.unlisten?.();
      for (const waiter of [...entry.waiters]) this.resolve(entry, waiter, null);
    }
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
    const entry: Entry = { begun: false, finished: false, waiters: new Set() };
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

  /** The activity changed: wake each reader waiting past a sequence it has now passed. */
  private moved(entry: Entry): void {
    if (entry.finished) return;
    const waiting = [...entry.waiters].filter((waiter) => waiter.after !== undefined);
    if (!waiting.length) return;
    const now = this.snapshot(entry);
    if (!now) return;
    for (const waiter of waiting)
      if (now.sequence > waiter.after!) this.resolve(entry, waiter, now);
  }

  /** One reader gave up: it alone is answered, and a mirror nothing began is dropped. */
  private release(id: string, entry: Entry, waiter: Waiter): void {
    this.resolve(entry, waiter, null);
    if (!entry.waiters.size && !entry.begun && !entry.finished && this.entries.get(id) === entry)
      this.entries.delete(id);
  }

  private resolve(
    entry: Entry,
    waiter: Waiter,
    snapshot: ModelWorkerActivitySnapshot | null,
  ): void {
    if (!entry.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve(snapshot);
  }
}
