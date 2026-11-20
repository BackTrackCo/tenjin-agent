import { expect, it } from 'vitest';
import { holderGone, processStartToken } from './process-identity';

it.skipIf(process.platform === 'win32')(
  'names a process by a token that is stable for it and differs for another',
  async () => {
    const mine = processStartToken(process.pid);
    expect(mine).toBeDefined();
    expect(processStartToken(process.pid)).toBe(mine);
    // A process that started earlier (the parent), as a macOS start has a second's resolution.
    const other = processStartToken(process.ppid);
    expect(other).toBeDefined();
    expect(other).not.toBe(mine);
  },
);

it('reads no token for a pid that is not a process, or on Windows', () => {
  expect(processStartToken(0)).toBeUndefined();
  expect(processStartToken(2 ** 30)).toBeUndefined();
  expect(processStartToken(process.pid, 'win32')).toBeUndefined();
});

it('is gone for a dead pid or another token, and alive for the same token, none or an unreadable one', () => {
  const alive = () => true;
  expect(holderGone(1, 'a', () => false)).toBe(true);
  expect(holderGone(process.pid, 'not:this', alive)).toBe(true);
  expect(holderGone(process.pid, processStartToken(process.pid), alive)).toBe(false);
  expect(holderGone(process.pid, undefined, alive)).toBe(false);
  // A pid whose token cannot be read now is alive: a doubt reads as alive.
  expect(holderGone(2 ** 30, 'a', alive)).toBe(false);
});

it('reads a holder once per wait, keyed by its pid and the token the lock recorded', () => {
  const real = processStartToken(process.pid)!;
  const memo = new Map<string, string | undefined>();
  // A memo of the same holder is honoured: one read per wait.
  memo.set(`${process.pid}:${real}`, 'cached-other');
  expect(holderGone(process.pid, real, () => true, memo)).toBe(true);
  // A lock another process took (another recorded token) is read afresh, whatever the memo holds
  // for the previous holder of the pid.
  const afresh = new Map<string, string | undefined>([[`${process.pid}:old-owner`, 'old-live']]);
  expect(holderGone(process.pid, real, () => true, afresh)).toBe(false);
  expect(afresh.get(`${process.pid}:${real}`)).toBe(real);
});
