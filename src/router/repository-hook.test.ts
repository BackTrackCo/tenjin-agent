import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context';
import type { HookResponse } from './decision';
import type { JevgrepGrant } from './jevgrep/grants';
import { repositoryGrepQuery, runRepositoryHook, type RepositoryHookDeps } from './repository-hook';
import { repositorySource } from './repository-hook-source';
import type { RequestToolResult } from './tool';
import hookFixture from './fixtures/wire-hook-jevgrep.json';

let directory: string, root: string, dataDir: string, transcript: string, commit: string;
const human =
  'I think retries can charge twice. Trace the payment flow and explain where the duplicate protection lives.';
const code = 'export function charge() {\n  return "deduplicated";\n}';
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'repository-hook-')));
  root = join(directory, 'repo');
  dataDir = join(directory, 'profile');
  transcript = join(directory, 'session.jsonl');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/a.ts'), code);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-C',
        root,
        ...args,
      ],
      { stdio: 'pipe' },
    );
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  commit = git('rev-parse', 'HEAD').toString().trim();
  await history(human);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function history(text: string) {
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'user',
      sessionId: 'session',
      message: { role: 'user', content: text },
    }) + '\n',
  );
}
function context(): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return {
    dataDir,
    flags: { json: true, timeout: 5000 },
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
}
function grant(): JevgrepGrant {
  return {
    version: 1,
    id: 'ac3cc90d-e45d-4c29-b39b-0b0579901278',
    enabled: true,
    root,
    source: 'committed-tracked',
    supplier: 'jev-x402',
    shareSource: true,
    maxRunAtomic: '50000',
    runtime: { kind: 'local-artifact', path: '/unused.tgz', sha256: 'a'.repeat(64) },
  };
}
function event(id = 'call-1') {
  return {
    session_id: 'session',
    tool_use_id: id,
    tool_name: 'Grep',
    cwd: root,
    transcript_path: transcript,
    tool_input: { pattern: 'payment|retry', path: root },
  };
}
function result(): RequestToolResult {
  return {
    isError: false,
    summary: 'complete',
    envelope: {
      status: 'fulfilled',
      executor: 'jevgrep-search-v1',
      snapshot: { commit, files: 1, source: 'git-head-committed-only' },
      result: `Jevgrep: 1 relevant files.\n- "src/a.ts" — helper; source below\n\nSource block "src/a.ts" lines 1-3:\n\x60\x60\x60\n${code}\n\x60\x60\x60\nEnd context.`,
    },
  };
}
function deps(): RepositoryHookDeps & {
  decide: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    ctx: context(),
    eligible: vi.fn(async () => grant()),
    decide: vi.fn(async () => ({
      status: 'decided' as const,
      decision: hookFixture as HookResponse,
    })),
    execute: vi.fn(async () => result()),
  };
}

describe('repository hook admission and execution', () => {
  it('requires an explicit grant before reading or routing anything', async () => {
    const d = deps();
    d.eligible = async () => null;
    expect((await runRepositoryHook(event(), d)).reason).toBe('repository not granted');
    expect(d.decide).not.toHaveBeenCalled();
    expect(d.execute).not.toHaveBeenCalled();
  });
  it('keeps Bash and count searches native', async () => {
    const d = deps();
    expect((await runRepositoryHook({ ...event(), tool_name: 'Bash' }, d)).response).toBeNull();
    expect(
      (
        await runRepositoryHook(
          { ...event(), tool_input: { pattern: 'x', output_mode: 'count' } },
          d,
        )
      ).response,
    ).toBeNull();
    expect(d.decide).not.toHaveBeenCalled();
  });
  it.each([{ path: 'src/a.ts' }, { path: '.', glob: 'src/a.ts' }, { path: 'src', glob: 'a.ts' }])(
    'keeps an already named source file native: %j',
    async (input) => {
      const d = deps();
      expect(
        (
          await runRepositoryHook(
            {
              ...event(),
              tool_input: { pattern: 'deduplicated', ...input },
            },
            d,
          )
        ).reason,
      ).toBe('unsupported search');
      expect(d.decide).not.toHaveBeenCalled();
      expect(d.execute).not.toHaveBeenCalled();
    },
  );
  it('keeps missing human context native', async () => {
    const d = deps();
    await writeFile(transcript, '');
    expect((await runRepositoryHook(event(), d)).reason).toBe('history unavailable');
    expect(d.execute).not.toHaveBeenCalled();
  });
  it.each([
    'Do not upload source.',
    'Use native tools only; no paid calls.',
    'Offline-only please.',
  ])('honors disclosure restriction: %s', async (restriction) => {
    const d = deps();
    await history(`${restriction}\n${human}`);
    expect((await runRepositoryHook(event(), d)).reason).toBe('source disclosure forbidden');
    expect(d.decide).not.toHaveBeenCalled();
  });
  it('retains the actual human and search separately, with a relative path', async () => {
    const d = deps();
    await runRepositoryHook(event(), d);
    expect(d.decide.mock.calls[0]![0]).toMatchObject({
      current: { text: human },
      pendingCall: {
        tool: 'Grep',
        query: JSON.stringify({ pattern: 'payment|retry', path: '.' }),
      },
    });
    expect(JSON.parse(d.execute.mock.calls[0]![0].query as string)).toEqual({
      originalHumanPrompt: human,
      plannedRepositorySearch: { pattern: 'payment|retry', path: '.' },
    });
  });
  it('obeys semantic native and needs-input answers without executing', async () => {
    for (const action of ['native', 'needs_input']) {
      const d = deps();
      d.decide.mockResolvedValue({ status: 'decided', decision: { decision: { action } } });
      expect((await runRepositoryHook(event(action), d)).response).toBeNull();
      expect(d.execute).not.toHaveBeenCalled();
    }
  });
  it('only denies after actual complete committed source has been checked', async () => {
    const d = deps();
    const out = await runRepositoryHook(event(), d);
    expect(out.reason).toBe('replaced with source');
    expect(out.response).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        additionalContext: expect.stringContaining(code) as unknown as string,
      },
    });
    expect(JSON.stringify(out.response)).toContain('Untrusted source evidence');
  });
  it.each(['partial', 'failed', 'cancelled', 'needs_input'])(
    'keeps %s execution native',
    async (status) => {
      const d = deps();
      const r = result();
      r.envelope.status = status;
      d.execute.mockResolvedValue(r);
      expect((await runRepositoryHook(event(), d)).response).toBeNull();
    },
  );
  it('never retries a paid attempt after failure, even with a new tool id', async () => {
    const d = deps();
    d.execute.mockRejectedValue(new Error('lost response'));
    await runRepositoryHook(event(), d);
    await runRepositoryHook(event('call-2'), d);
    expect(d.execute).toHaveBeenCalledTimes(1);
  });
  it('deduplicates the same snapshot and query across repeated human turns', async () => {
    const d = deps();
    await runRepositoryHook(event(), d);
    const prior = JSON.parse(await readFile(transcript, 'utf8')) as unknown;
    await writeFile(
      transcript,
      [
        prior,
        {
          type: 'user',
          sessionId: 'session',
          message: { role: 'user', content: human },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );
    expect((await runRepositoryHook(event('next-turn'), d)).reason).toBe(
      'snapshot retrieval already attempted',
    );
    expect(d.execute).toHaveBeenCalledTimes(1);
  });
  it('leaves the tool native after cancellation without signing', async () => {
    const d = deps();
    d.signal = AbortSignal.abort();
    expect((await runRepositoryHook(event(), d)).response).toBeNull();
    expect(d.decide).not.toHaveBeenCalled();
    expect(d.execute).not.toHaveBeenCalled();
  });
  it('does not route credential-shaped current text', async () => {
    const d = deps();
    await history(`Use ghp_${'a'.repeat(36)} to find the payment code`);
    expect((await runRepositoryHook(event(), d)).reason).toBe('sensitive context');
    expect(d.decide).not.toHaveBeenCalled();
  });
  it('admits concurrent hooks only once for paid execution', async () => {
    const d = deps();
    await Promise.all([runRepositoryHook(event(), d), runRepositoryHook(event('call-2'), d)]);
    expect(d.execute).toHaveBeenCalledTimes(1);
    await runRepositoryHook(event(), d);
    expect(d.execute).toHaveBeenCalledTimes(1);
  });
  it('bounds free classification at three calls in one human turn', async () => {
    const d = deps();
    d.decide.mockResolvedValue({ status: 'failed', reason: 'offline' });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => runRepositoryHook(event(`call-${i}`), d)),
    );
    expect(d.decide).toHaveBeenCalledTimes(3);
    expect(d.execute).not.toHaveBeenCalled();
  });
  it('retains private hash-only replay markers', async () => {
    const d = deps();
    await runRepositoryHook(event(), d);
    const base = join(dataDir, 'jevgrep/repository-hooks');
    const session = join(base, (await readdir(base))[0]!);
    for (const file of await readdir(session)) {
      expect(file).not.toContain('session');
      expect(await readFile(join(session, file), 'utf8')).toBe('{"version":1}');
      expect((await stat(join(session, file))).mode & 0o777).toBe(0o600);
    }
  });
});

describe('repository path and source checks', () => {
  it('refuses outside-root paths, symlink escapes, unknown switches and parent globs', async () => {
    await symlink(directory, join(root, 'outside'));
    for (const extra of [{ path: '..' }, { path: 'outside' }, { unknown: true }, { glob: '../*' }])
      expect(await repositoryGrepQuery({ pattern: 'x', ...extra }, root)).toBeNull();
  });
  it.each(['', 'locations only', 'Jevgrep: 0 relevant files.\nEnd context.'])(
    'does not deny on empty or location-only results',
    async (output) => {
      const r = result();
      r.envelope.result = output;
      expect(await repositorySource(r, root, commit)).toBeNull();
    },
  );
  it('refuses fabricated source despite a complete result', async () => {
    const r = result();
    r.envelope.result = String(r.envelope.result).replace('deduplicated', 'fabricated');
    expect(await repositorySource(r, root, commit)).toBeNull();
  });
  it('refuses truncated evidence or a mismatching snapshot', async () => {
    const r = result();
    r.envelope.result = String(r.envelope.result).replace('End context.', '');
    expect(await repositorySource(r, root, commit)).toBeNull();
    expect(await repositorySource(result(), root, 'b'.repeat(40))).toBeNull();
  });
});
