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
// The fixture children are not real: no group signal may reach a real process group.
let groupKill: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  groupKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  groupKill.mockRestore();
});

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
    // Its own process group, which a drain signals after the child.
    ...(globalThis.process.platform === 'win32' ? {} : { detached: true }),
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

it('writes the settings to a file only this user can read, removed once the child closed', async () => {
  // The failure: settings given to the SDK as an object put the job's GitHub token and
  // bridge token in a `--settings {...}` argument, which the process table shows and the
  // SDK's debug log records.
  const child = new Child();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const token = `gho_${'Z9y8'.repeat(9)}`;
  const settings = { env: { GH_TOKEN: token, ANTHROPIC_API_KEY: 'bridge-0x5f' } };
  const process = claudeWorkerProcess({ secrets: () => [token, 'bridge-0x5f'] });
  const file = process.settingsFile(settings);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(settings);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  process.spawn({ ...options(), args: ['--input-format', 'stream-json', '--settings', file] });
  child.exitCode = 0;
  child.emit('close', 0, null);
  await process.drain();
  expect(existsSync(dirname(file))).toBe(false);
});

it('starts no child whose command line would still carry a secret', () => {
  // Settings given inline, never through a file, fail closed.
  const process = claudeWorkerProcess({ secrets: () => ['bridge-0x5f'] });
  expect(() =>
    process.spawn({ ...options(), args: ['--settings={"env":{"K":"bridge-0x5f"}}'] }),
  ).toThrow(/command line/);
  expect(spawn).not.toHaveBeenCalled();
});

// A child can close before its descendants, including ones that ignore TERM
// and closed their inherited stdio. Draining must still kill their group.
it.skipIf(process.platform === 'win32')(
  'terminates the warm child and its group immediately',
  async () => {
    const child = new Child();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const worker = claudeWorkerProcess();
    worker.spawn(options());

    const stopped = worker.drain({ now: true });
    expect(groupKill).toHaveBeenCalledWith(-child.pid!, 'SIGTERM');
    child.signalCode = 'SIGTERM';
    child.emit('close', null, 'SIGTERM');

    await expect(stopped).resolves.toEqual({ successful: false });
    expect(groupKill).toHaveBeenLastCalledWith(-child.pid!, 'SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  },
);
