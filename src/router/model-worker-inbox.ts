/**
 * What a parent writes to a DeepSeek worker while it runs, in order. The worker's input
 * stream takes each message as a user message at its next turn, as a native subagent
 * takes a message sent during its run. The inbox closes when the worker has reported:
 * a message after that is refused with `closed`, never accepted and dropped.
 */
export class WorkerInbox {
  private queue: string[] = [];
  private waiting: ((text: string | null) => void) | undefined;
  private shut = false;

  /** `delivered` once the message is in the worker's input line; `closed` once it cannot be. */
  push(text: string): 'delivered' | 'closed' {
    if (this.shut) return 'closed';
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = undefined;
      wake(text);
    } else this.queue.push(text);
    return 'delivered';
  }

  /** A message accepted but not yet handed to the worker's input. */
  get queued(): number {
    return this.queue.length;
  }

  /** The next message, in order; null once the inbox is closed. */
  next(): Promise<string | null> {
    if (this.shut) return Promise.resolve(null);
    const first = this.queue.shift();
    if (first !== undefined) return Promise.resolve(first);
    if (this.shut) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /**
   * Closes the inbox when the worker has reported with nothing waiting to be sent.
   * Returns false, and stays open, when a message is still queued: the worker's next
   * turn takes it, so the report that ended its last turn is not its last.
   */
  closeIfEmpty(): boolean {
    if (this.queue.length) return false;
    this.close();
    return true;
  }

  /**
   * Stops taking messages and ends the worker's reader, and keeps what was queued and never
   * read, for whoever reports the end: {@link close} returns it.
   */
  seal(): void {
    this.shut = true;
    this.waiting?.(null);
    this.waiting = undefined;
  }

  /** Closes for good, whatever is queued (the worker ended another way), and returns it. */
  close(): string[] {
    this.shut = true;
    const left = this.queue.splice(0);
    this.waiting?.(null);
    this.waiting = undefined;
    return left;
  }
}
