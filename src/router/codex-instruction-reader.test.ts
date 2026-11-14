import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it as test, vi } from 'vitest';
import { withAppServer } from '../lib/codex-app-server';
import { codexInstructionProfile, readCodexInstructionFiles } from './codex-instruction-reader';
import type { CodexModelPolicy } from './codex-model-gates';

vi.mock('../lib/codex-app-server', () => ({ withAppServer: vi.fn() }));
// The fixed native reader is qualified only for the Unix command surface.
const it = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
let root: string;
let calls: { method: string; params: Record<string, unknown> }[];
let files: Map<string, Buffer>;
let denied: boolean;
let mutate: (() => Promise<void>) | undefined;
let policy: CodexModelPolicy;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tenjin-instruction-read-')));
  await mkdir(join(root, 'repo'));
  calls = [];
  files = new Map();
  denied = false;
  mutate = undefined;
  policy = {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'read-only' },
    permissionProfile: {
      type: 'managed',
      network: 'restricted',
      file_system: {
        type: 'restricted',
        entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }],
      },
    },
  };
  vi.mocked(withAppServer).mockReset();
  vi.mocked(withAppServer).mockImplementation(async (_home, _env, _timeout, fn) =>
    fn(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      calls.push({ method, params });
      if (method !== 'command/exec') return {};
      await mutate?.();
      if (denied) return { exitCode: 1, stdout: '', stderr: 'Operation not permitted' };
      const command = params.command as string[];
      return { exitCode: 0, stdout: files.get(command[2]!)?.toString('base64') ?? '', stderr: '' };
    }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const options = (paths: string[], maxBytes = 1000) => ({
  cwd: join(root, 'repo'),
  policy,
  dataDir: join(root, 'wallet'),
  paths,
  maxBytes,
});
async function source(name: string, contents: string | Buffer) {
  const path = join(root, name),
    bytes = Buffer.from(contents);
  await writeFile(path, bytes);
  files.set(path, bytes);
  return path;
}

it('reads selected outside-root instructions through a fixed native argv and preserves exact bytes/order', async () => {
  const global = await source('AGENTS.md', 'global\n'),
    local = await source('repo/AGENTS.md', 'local\n');
  const result = await readCodexInstructionFiles(options([global, local]));
  expect(result?.map(({ path, contents, bytes }) => ({ path, contents, bytes }))).toEqual([
    { path: global, contents: 'global\n', bytes: 7 },
    { path: local, contents: 'local\n', bytes: 6 },
  ]);
  expect(result?.every((file) => /^[a-f0-9]{64}$/.test(file.stamp))).toBe(true);
  expect(calls.filter((c) => c.method === 'command/exec').map((c) => c.params.command)).toEqual([
    ['/usr/bin/base64', '-i', global],
    ['/usr/bin/base64', '-i', local],
  ]);
  expect(calls.every((c) => ['command/exec', 'command/exec/terminate'].includes(c.method))).toBe(
    true,
  );
});

it('never substitutes an unsandboxed host read when native read permission is denied', async () => {
  const path = await source('AGENTS.md', 'host-readable but native-denied');
  denied = true;
  expect(await readCodexInstructionFiles(options([path]))).toBeNull();
  expect(calls.some((c) => c.method === 'command/exec')).toBe(true);
});

it.each([Buffer.from([255]), Buffer.from('contains\0binary')])(
  'rejects invalid UTF-8 or binary source bytes',
  async (bytes) => {
    expect(await readCodexInstructionFiles(options([await source('AGENTS.md', bytes)]))).toBeNull();
  },
);

it('rejects symlinks and pre-existing hardlinks without invoking the native reader', async () => {
  const path = await source('AGENTS.md', 'private');
  const symbolic = join(root, 'alias.md'),
    hard = join(root, 'hard.md');
  await symlink(path, symbolic);
  await link(path, hard);
  expect(await readCodexInstructionFiles(options([symbolic]))).toBeNull();
  expect(await readCodexInstructionFiles(options([hard]))).toBeNull();
  expect(calls).toEqual([]);
});

it('bounds the complete file set instead of returning a truncated partial context', async () => {
  const first = await source('AGENTS.md', 'first'),
    second = await source('repo/AGENTS.md', 'second');
  expect(await readCodexInstructionFiles(options([first, second], 8))).toBeNull();
  expect(calls.filter((c) => c.method === 'command/exec')).toHaveLength(1);
});

it('rejects replacement of a source during the native read', async () => {
  const path = await source('AGENTS.md', 'original');
  mutate = async () => {
    const replacement = join(root, 'replacement');
    await writeFile(replacement, 'original');
    await rename(replacement, path);
  };
  expect(await readCodexInstructionFiles(options([path]))).toBeNull();
});

it('terminates a native read on cancellation and releases no source bytes', async () => {
  const path = await source('AGENTS.md', 'must not be released');
  const controller = new AbortController();
  mutate = async () => controller.abort();
  expect(
    await readCodexInstructionFiles({ ...options([path]), signal: controller.signal }),
  ).toBeNull();
  expect(calls.some((c) => c.method === 'command/exec/terminate')).toBe(true);
});

it.each(['.env.local', 'auth.json', 'wallet.json', 'secret.pem'])(
  'refuses credential/environment source %s before reading',
  async (name) => {
    expect(await readCodexInstructionFiles(options([await source(name, 'never read')]))).toBeNull();
    expect(calls).toEqual([]);
  },
);

it('preserves native denies in the named profile and refuses unrepresentable entries', () => {
  const p = policy.permissionProfile as { file_system: { entries: unknown[] } };
  const denied = join(root, 'denied');
  p.file_system.entries.push({ path: { type: 'path', path: denied }, access: 'deny' });
  expect(
    codexInstructionProfile(options([]))?.overrides.some((v) =>
      v.includes(JSON.stringify(denied) + ' = "deny"'),
    ),
  ).toBe(true);
  p.file_system.entries.push({ path: { type: 'futureGlob' }, access: 'read' });
  expect(codexInstructionProfile(options([]))).toBeNull();
});

it('removes wallet/provider environment from the broker and publishes no command interface to a model', async () => {
  const path = await source('AGENTS.md', 'safe');
  await readCodexInstructionFiles({
    ...options([path]),
    env: {
      TENJIN_WALLET_PASSPHRASE: 'fixture-wallet',
      DEEPSEEK_API_KEY: 'fixture-provider',
    },
  });
  const [, env, , , appOptions] = vi.mocked(withAppServer).mock.calls[0]!;
  expect(env.TENJIN_WALLET_PASSPHRASE).toBeUndefined();
  expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  expect(appOptions?.configOverrides).toContain('shell_environment_policy.inherit="none"');
  expect(calls.find((c) => c.method === 'command/exec')?.params.permissionProfile).toMatch(
    /^tenjin-instructions-/,
  );
});
