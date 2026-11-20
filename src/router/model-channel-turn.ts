/**
 * ONE PAID CALL AT A TIME ON A RUN'S OWN CHANNEL, inside this process. Only the process that
 * runs a worker signs on that worker's channel, and recovery is kept off it by the run lock, not
 * by this one, so no file is needed: a queue per channel key, in the order calls asked.
 *
 * A turn covers the read of the channel's total, the signature, the paid request and its answer.
 * A caller that is aborted while it waits leaves the queue without a turn, and the calls behind
 * it keep their order: its place passes on only when the call ahead of it ends.
 */
const tails = new Map<string, Promise<void>>();

export async function withChannelTurn<T>(
  key: string,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  const ahead = tails.get(key) ?? Promise.resolve();
  let end!: () => void;
  const mine = new Promise<void>((resolve) => {
    end = resolve;
  });
  tails.set(key, mine);
  const leave = () => {
    end();
    if (tails.get(key) === mine) tails.delete(key);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void ahead.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
    signal.throwIfAborted();
  } catch (error) {
    // Its place passes on only when the call ahead ends.
    void ahead.then(leave);
    throw error;
  }
  try {
    return await fn();
  } finally {
    leave();
  }
}
