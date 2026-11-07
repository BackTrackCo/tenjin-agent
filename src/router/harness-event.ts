/** A session id as the hook schemas take one: a string of 1 to 200 characters. */
export function sessionIdOf(event: unknown): string | null {
  if (event === null || typeof event !== 'object') return null;
  const id = (event as { session_id?: unknown }).session_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : null;
}

/**
 * The harness event on stdin, as text. Rejects past `maxBytes`, or when no end
 * arrives within `timeoutMs`: the harness writes the event at once, so the
 * wait is a liveness check.
 */
export function readCappedStdin(maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => reject(new Error('no harness event')), timeoutMs);
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        clearTimeout(timer);
        reject(new Error('harness event too large'));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.once('error', () => {
      clearTimeout(timer);
      reject(new Error('harness event unreadable'));
    });
  });
}
