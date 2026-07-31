import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The eval harness is Python and its scoring gates are the one part of it that
// must never be wrong: they decide whether a run that did not happen gets
// counted as a run that produced a result. `evals/harness/scoring_selftest.py`
// tests them without a model call, a network call or a cent of spend, and this
// is what puts it in the same CI gate as everything else rather than in a
// README instruction someone remembers to follow.
const SELFTEST = fileURLToPath(new URL('../evals/harness/scoring_selftest.py', import.meta.url));

describe('eval harness scoring gates', () => {
  it('the harness self-test passes', () => {
    const result = spawnSync('python3', [SELFTEST], { encoding: 'utf8' });

    // A missing interpreter is a red build rather than a skip: the harness these
    // guard is unusable without it, so silently passing here would report a
    // guard that never ran.
    expect(result.error, 'python3 is required to run the eval harness self-test').toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
