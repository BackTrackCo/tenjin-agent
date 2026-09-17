/**
 * PLACEHOLDER ORACLE. Copied into the worktree AFTER the agent finishes, so the
 * agent never sees it and cannot special-case it.
 *
 * A real oracle asserts the behaviour the task asked for, against the agent's
 * own diff, and nothing else. It must be runnable as a single named file:
 * `pnpm vitest run <this path>`. Never a whole-suite command.
 */
import { describe, expect, it } from 'vitest';

describe('bench-lite placeholder oracle (producer)', () => {
  it('is replaced before a real run', () => {
    expect(true).toBe(true);
  });
});
