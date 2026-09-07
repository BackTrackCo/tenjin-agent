import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Bench-1 is stdlib Python and its fake end-to-end path (manifest, fake
// executor, verifier, immutable record, reducer, report) is what a token
// savings claim will later rest on. `evals/benchmark/selftest.py` drives it
// with no model, no network and no spend; this bridge puts it in the same CI
// gate as everything else, the way the harness scoring self-test already is.
const SELFTEST = fileURLToPath(new URL('../evals/benchmark/selftest.py', import.meta.url));

describe('benchmark foundation', () => {
  it('the fake end-to-end self-test passes', () => {
    const result = spawnSync('python3', [SELFTEST], { encoding: 'utf8', timeout: 60_000 });

    expect(result.error, 'python3 is required to run the benchmark self-test').toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 60_000);
});
