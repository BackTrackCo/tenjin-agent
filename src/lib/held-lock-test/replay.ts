/**
 * Replays a stress log (`E <pid>` on entry, `X <pid>` on exit, `K <pid>` written by the parent
 * before it kills a worker). An `E` while another holder's entry is still open, and that holder
 * was not killed, is an overlap. A killed holder's later lines do not count: it logs until the
 * kill lands. Not a test file.
 */
export function replay(log: string): { entries: number; overlaps: number } {
  const inside = new Set<string>();
  const killed = new Set<string>();
  let overlaps = 0;
  let entries = 0;
  for (const line of log.split('\n')) {
    const [kind, pid] = line.split(' ');
    if (!pid) continue;
    if (kind === 'K') {
      killed.add(pid);
      inside.delete(pid);
      continue;
    }
    if (killed.has(pid)) continue;
    if (kind === 'E') {
      entries++;
      if (inside.size > 0) overlaps++;
      inside.add(pid);
    } else inside.delete(pid);
  }
  return { entries, overlaps };
}
