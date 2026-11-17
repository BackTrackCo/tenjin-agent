import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claudeWorkerProcess } from './claude-worker-process';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill = vi.fn(() => true);
}
const options = () => ({
  command: '/fixture/claude',
  args: ['--input-format', 'stream-json'],
  cwd: '/repo',
  env: { HOME: '/fixture/home', ANTHROPIC_AUTH_TOKEN: 'fixture-only' },
  signal: new AbortController().signal,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it('preserves the SDK command, args, cwd, environment and forwarded abort signal', async () => {
  const child = new Child();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const process = claudeWorkerProcess(),
    supplied = options();
  expect(process.spawn(supplied)).toBe(child);
  expect(spawn).toHaveBeenCalledWith(supplied.command, supplied.args, {
    cwd: supplied.cwd,
    env: supplied.env,
    signal: supplied.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  expect(vi.mocked(spawn).mock.calls[0]![2]?.signal).toBe(supplied.signal);
  child.exitCode = 0;
  child.emit('close', 0, null);
  await process.drain();
  expect(child.kill).not.toHaveBeenCalled();
});

it('does not report quiescence at process exit while owned stdio is still open', async () => {
  const child = new Child();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const process = claudeWorkerProcess();
  process.spawn(options());
  let quiescent = false;
  const drain = process.drain().then(() => {
    quiescent = true;
  });
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await Promise.resolve();
  expect(quiescent).toBe(false);
  child.emit('close', 0, null);
  await drain;
  expect(quiescent).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds failed SDK cleanup with signals to only the owned child and never treats a forced close as success', async () => {
  const child = new Child();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const process = claudeWorkerProcess();
  process.spawn(options());
  const outcome = process.drain().catch((error) => error);
  await vi.advanceTimersByTimeAsync(8000);
  expect(child.kill).toHaveBeenLastCalledWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(2000);
  expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
  child.signalCode = 'SIGKILL';
  child.emit('close', null, 'SIGKILL');
  expect(await outcome).toEqual({ successful: false });
  expect(vi.getTimerCount()).toBe(0);
});

it('refuses an unconfirmed close and handles spawn failure without hanging', async () => {
  const child = new Child();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const process = claudeWorkerProcess();
  process.spawn(options());
  const outcome = process.drain().catch((error) => error);
  await vi.advanceTimersByTimeAsync(12000);
  expect((await outcome).message).toContain('did not drain');
  const failed = new Child();
  failed.pid = undefined;
  vi.mocked(spawn).mockReturnValue(failed as unknown as ReturnType<typeof spawn>);
  const other = claudeWorkerProcess();
  other.spawn(options());
  failed.emit('error', new Error('spawn failed'));
  await expect(other.drain()).resolves.toEqual({ successful: false });
  expect(vi.getTimerCount()).toBe(0);
});

it('moves the settings off the command line into a file only this user can read, removed once the child closed', async () => {
  // The failure: the SDK's `--settings {...}` argument put the job's GitHub token and
  // bridge token in the process table, where other processes read them.
  const child = new Child();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const token = `gho_${'Z9y8'.repeat(9)}`;
  const settings = JSON.stringify({ env: { GH_TOKEN: token, ANTHROPIC_API_KEY: 'bridge-0x5f' } });
  const process = claudeWorkerProcess({ secrets: () => [token, 'bridge-0x5f'] });
  process.spawn({ ...options(), args: ['--input-format', 'stream-json', '--settings', settings] });
  const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
  expect(args.join(' ')).not.toContain(token);
  const file = args[args.indexOf('--settings') + 1]!;
  expect(readFileSync(file, 'utf8')).toBe(settings);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  child.exitCode = 0;
  child.emit('close', 0, null);
  await process.drain();
  expect(existsSync(dirname(file))).toBe(false);
});

it('starts no child whose command line would still carry a secret', () => {
  // A form the move does not know (here a value given inline) fails closed.
  const process = claudeWorkerProcess({ secrets: () => ['bridge-0x5f'] });
  expect(() =>
    process.spawn({ ...options(), args: ['--settings={"env":{"K":"bridge-0x5f"}}'] }),
  ).toThrow(/command line/);
  expect(spawn).not.toHaveBeenCalled();
});
