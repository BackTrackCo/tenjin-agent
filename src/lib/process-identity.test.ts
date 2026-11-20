import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { holderGone, processStartToken } from './process-identity';

it.skipIf(process.platform === 'win32')(
  'names a process by a token that is stable for it and differs for another',
  async () => {
    const mine = processStartToken(process.pid);
    expect(mine).toBeDefined();
    expect(processStartToken(process.pid)).toBe(mine);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      stdio: 'ignore',
    });
    try {
      const other = processStartToken(child.pid!);
      expect(other).toBeDefined();
      expect(other).not.toBe(mine);
    } finally {
      child.kill();
    }
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

it('reads a holder once per wait', () => {
  const read = new Map<number, string | undefined>();
  holderGone(process.pid, 'x', () => true, read);
  read.set(process.pid, 'cached');
  expect(holderGone(process.pid, 'cached', () => true, read)).toBe(false);
});
