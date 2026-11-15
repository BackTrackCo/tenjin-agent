import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it as test } from 'vitest';
import type { CodexAppRequest } from '../lib/codex-app-server';
import {
  codexInstructionProfile,
  readCodexInstructionFilesOnServer,
} from './codex-instruction-reader';
import type { CodexModelPolicy } from './codex-model-gates';

// The fixed native reader is qualified only for the Unix command surface.
const it = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
let root: string;
let calls: { method: string; params: Record<string, unknown> }[];
let files: Map<string, Buffer>;
let denied: boolean;
let mutate: (() => Promise<void>) | undefined;
let policy: CodexModelPolicy;
let request: CodexAppRequest;
let profileMutation: ((profile: Record<string, unknown>) => void) | undefined;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tenjin-instruction-read-')));
  await mkdir(join(root, 'repo'));
  calls = [];
  files = new Map();
  denied = false;
  mutate = undefined;
  profileMutation = undefined;
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
  request = (async (method, raw) => {
    const params = raw as Record<string, unknown>;
    calls.push({ method, params });
    if (method === 'config/read') {
      const profile = codexInstructionProfile(options([]))!;
      const actual: Record<string, unknown> = structuredClone(profile.expected);
      profileMutation?.(actual);
      return { config: { permissions: { [profile.name]: actual } } };
    }
    if (method !== 'command/exec') return {};
    await mutate?.();
    if (denied) return { exitCode: 1, stdout: '', stderr: 'Operation not permitted' };
    const command = params.command as string[];
    return { exitCode: 0, stdout: files.get(command[2]!)?.toString('base64') ?? '', stderr: '' };
  }) as CodexAppRequest;
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
async function readFiles(input: ReturnType<typeof options> & { signal?: AbortSignal }) {
  return readCodexInstructionFilesOnServer(
    request,
    input,
    input.paths,
    input.maxBytes,
    input.signal ?? new AbortController().signal,
  );
}
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
  const result = await readFiles(options([global, local]));
  expect(result?.map(({ path, contents, bytes }) => ({ path, contents, bytes }))).toEqual([
    { path: global, contents: 'global\n', bytes: 7 },
    { path: local, contents: 'local\n', bytes: 6 },
  ]);
  expect(result?.every((file) => /^[a-f0-9]{64}$/.test(file.stamp))).toBe(true);
  expect(calls.filter((c) => c.method === 'command/exec').map((c) => c.params.command)).toEqual([
    ['/usr/bin/base64', '-i', global],
    ['/usr/bin/base64', '-i', local],
  ]);
  expect(
    calls.every((c) =>
      ['config/read', 'command/exec', 'command/exec/terminate'].includes(c.method),
    ),
  ).toBe(true);
});

it.each(['extra grant', 'extends', 'workspace roots'] as const)(
  'refuses a merged native reader profile with %s before running its fixed command',
  async (changed) => {
    const path = await source('AGENTS.md', 'selected native instructions');
    profileMutation = (profile) => {
      if (changed === 'extra grant')
        (profile.filesystem as Record<string, unknown>)['/outside'] = 'read';
      else if (changed === 'extends') profile.extends = 'unbounded-lower-layer';
      else profile.workspace_roots = { '/outside': true };
    };
    expect(await readFiles(options([path]))).toBeNull();
    expect(calls.some((call) => call.method === 'command/exec')).toBe(false);
  },
);

it('keeps dotted and quoted filesystem paths inside the whole inline table value', () => {
  const path = join(root, 'folder.with.dots', 'quoted "directory"');
  const original = policy.permissionProfile as { file_system: { entries: unknown[] } };
  original.file_system.entries.push({ path: { type: 'path', path }, access: 'read' });
  const profile = codexInstructionProfile(options([]))!;
  const filesystem = profile.overrides.find((value) =>
    value.startsWith(`permissions.${profile.name}.filesystem=`),
  )!;
  const equals = filesystem.indexOf('=');
  expect(filesystem.slice(0, equals)).toBe(`permissions.${profile.name}.filesystem`);
  expect(filesystem.slice(equals + 1)).toContain(`${JSON.stringify(path)} = "read"`);
});

it('never substitutes an unsandboxed host read when native read permission is denied', async () => {
  const path = await source('AGENTS.md', 'host-readable but native-denied');
  denied = true;
  expect(await readFiles(options([path]))).toBeNull();
  expect(calls.some((c) => c.method === 'command/exec')).toBe(true);
});

it.each([Buffer.from([255]), Buffer.from('contains\0binary')])(
  'rejects invalid UTF-8 or binary source bytes',
  async (bytes) => {
    expect(await readFiles(options([await source('AGENTS.md', bytes)]))).toBeNull();
  },
);

it('rejects symlinks and pre-existing hardlinks without invoking the native reader', async () => {
  const path = await source('AGENTS.md', 'private');
  const symbolic = join(root, 'alias.md'),
    hard = join(root, 'hard.md');
  await symlink(path, symbolic);
  await link(path, hard);
  expect(await readFiles(options([symbolic]))).toBeNull();
  expect(await readFiles(options([hard]))).toBeNull();
  expect(calls).toEqual([]);
});

it('bounds the complete file set instead of returning a truncated partial context', async () => {
  const first = await source('AGENTS.md', 'first'),
    second = await source('repo/AGENTS.md', 'second');
  expect(await readFiles(options([first, second], 8))).toBeNull();
  expect(calls.filter((c) => c.method === 'command/exec')).toHaveLength(1);
});

it('rejects replacement of a source during the native read', async () => {
  const path = await source('AGENTS.md', 'original');
  mutate = async () => {
    const replacement = join(root, 'replacement');
    await writeFile(replacement, 'original');
    await rename(replacement, path);
  };
  expect(await readFiles(options([path]))).toBeNull();
});

it('terminates a native read on cancellation and releases no source bytes', async () => {
  const path = await source('AGENTS.md', 'must not be released');
  const controller = new AbortController();
  mutate = async () => controller.abort();
  expect(await readFiles({ ...options([path]), signal: controller.signal })).toBeNull();
  expect(calls.some((c) => c.method === 'command/exec/terminate')).toBe(true);
});

it.each(['.env.local', 'auth.json', 'wallet.json', 'secret.pem'])(
  'refuses credential/environment source %s before reading',
  async (name) => {
    expect(await readFiles(options([await source(name, 'never read')]))).toBeNull();
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
