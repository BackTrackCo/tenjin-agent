import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ensureDaemon, forward, logDown, resolveDataDir } from './shim';

/** Entry for `tenjin-shim.mjs`: `--harness <id>` forwards stdin; `--ensure` only starts. */
const startedAt = Date.now();
const dataDir = resolveDataDir();
try {
  const { values } = parseArgs({
    options: { harness: { type: 'string' }, ensure: { type: 'boolean' } },
    strict: false,
  });
  if (typeof values.harness === 'string') {
    const stdin = readFileSync(0, 'utf8');
    await forward(dataDir, values.harness, stdin, startedAt);
  } else {
    const r = await ensureDaemon(dataDir);
    if (!r.ok) logDown(dataDir, r.reason);
  }
} catch (err) {
  logDown(dataDir, `shim: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
