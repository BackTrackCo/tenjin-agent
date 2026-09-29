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
import { runRequestTool, type RequestToolResult } from './tool';
import { executeJevgrep } from './jevgrep/executor';
import hookFixture from './fixtures/wire-hook-jevgrep.json';

vi.mock('./tool', () => ({ runRequestTool: vi.fn() }));
vi.mock('./jevgrep/executor', () => ({ executeJevgrep: vi.fn() }));

let directory: string, root: string, dataDir: string, transcript: string, commit: string;
const human =
  'I think retries can charge twice. Trace the payment flow and explain where the duplicate protection lives.';
const code = 'export function charge() {\n  return "deduplicated";\n}';
beforeEach(async () => {
  vi.clearAllMocks();
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
function bash(command: string, id = 'bash-1') {
  return { ...event(id), tool_name: 'Bash', tool_input: { command } };
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
} {
  return {
    ctx: context(),
    homeDir: join(directory, 'home'),
    eligible: vi.fn(async () => grant()),
    decide: vi.fn(async () => ({
      status: 'decided' as const,
      decision: hookFixture as HookResponse,
    })),
  };
}

describe('repository hook classification and agent-authored query offers', () => {
  it('requires an explicit grant before reading or routing anything', async () => {
    const d = deps();
    d.eligible = async () => null;
    expect((await runRepositoryHook(event(), d)).reason).toBe('repository not granted');
    expect(d.decide).not.toHaveBeenCalled();
  });
  it('honors router off before eligibility and transcript reads', async () => {
    const d = deps();
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({ router: { enabled: false } }));
    expect((await runRepositoryHook(event(), d)).reason).toBe('router disabled');
    expect(d.eligible).not.toHaveBeenCalled();
    expect(d.decide).not.toHaveBeenCalled();
  });
  it('keeps malformed Bash and count searches native', async () => {
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
  it('redirects standalone Bash to an agent-authored natural-language query', async () => {
    const d = deps();
    const out = await runRepositoryHook(bash(`rg -n 'payment|retry' '${root}/src'`), d);
    expect(out.reason).toBe('redirected to repository request');
    expect(out.response).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining(
          'mcp__x402__request({query: <',
        ) as unknown as string,
      },
    });
    expect(JSON.stringify(out.response)).toContain(
      'Write a focused natural-language repository question',
    );
    expect(JSON.stringify(out.response)).toContain('do not copy the grep regex or shell command');
    expect(JSON.stringify(out.response)).not.toContain('payment|retry');
    const packet = d.decide.mock.calls[0]![0];
    expect(packet.current.text).toBe(human);
    expect(packet.pendingCall.tool).toBe('Grep');
    expect(JSON.parse(packet.pendingCall.query)).toMatchObject({
      pattern: 'payment|retry',
      path: 'src',
      originTool: 'Bash',
      shell: { executable: 'rg', argv: ['-n', 'payment|retry', '<repository-path>'] },
    });
    expect(packet.pendingCall.query).not.toContain(root);
    expect(runRequestTool).not.toHaveBeenCalled();
    expect(executeJevgrep).not.toHaveBeenCalled();
  });
  it('redirects compound searches once and explicitly preserves the original command for retry', async () => {
    const d = deps();
    const input = bash(
      `cd '${root}' && git ls-files | grep -v node_modules | head -300; grep -rniE "quiet|suppress|cooldown|debounce|dirty|recent.?edit" --include=* -l . --exclude-dir=node_modules --exclude-dir=.git | head -50`,
    );
    const before = JSON.stringify(input);
    const out = await runRepositoryHook(input, d);
    expect(out.reason).toBe('redirected to repository request');
    expect(out.response).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining(
          'This entire compound Bash command has not executed. After the Jevgrep attempt succeeds or fails, reissue the exact original Bash tool input',
        ) as unknown as string,
      },
    });
    expect(JSON.stringify(input)).toBe(before);
    const search = JSON.parse(d.decide.mock.calls[0]![0].pendingCall.query);
    expect(search.pattern).toBe('quiet|suppress|cooldown|debounce|dirty|recent.?edit');
    expect(search.shell.argv).toContain('--exclude-dir=node_modules');
    expect(runRequestTool).not.toHaveBeenCalled();
    expect(executeJevgrep).not.toHaveBeenCalled();
    expect(
      (await runRepositoryHook({ ...input, tool_use_id: 'compound-retry' }, d)).response,
    ).toBeNull();
    expect(d.decide).toHaveBeenCalledOnce();
  });
  it('includes only a bounded, redacted agent-authored Bash description', async () => {
    const d = deps();
    const token = `ghp_${'a'.repeat(36)}`;
    await runRepositoryHook(
      {
        ...bash('rg payment src'),
        tool_input: {
          command: 'rg payment src',
          description: `Find payment protection using ${token}`,
          arbitrary: 'never transmit me',
        },
      },
      d,
    );
    const pending = d.decide.mock.calls[0]![0].pendingCall.query as string;
    expect(JSON.parse(pending).description).toContain('Find payment protection');
    expect(pending).not.toContain(token);
    expect(pending).not.toContain('never transmit me');
  });
  it('defers a relative cd explicitly and admits its unchanged retry', async () => {
    const d = deps();
    const input = bash('cd src && rg payment .');
    const out = await runRepositoryHook(input, d);
    expect(out.response).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining(
          'reissue the exact original Bash tool input from the same working directory',
        ) as unknown as string,
      },
    });
    expect(JSON.stringify(out.response)).not.toContain('updatedInput');
    expect(input.tool_input.command).toBe('cd src && rg payment .');
    expect((await runRepositoryHook({ ...input, tool_use_id: 'cd-retry' }, d)).response).toBeNull();
    expect(d.decide).toHaveBeenCalledOnce();
  });
  it('omits oversized descriptions rather than truncating secret-shaped input', async () => {
    const d = deps();
    await runRepositoryHook(
      {
        ...bash('rg payment src'),
        tool_input: {
          command: 'rg payment src',
          description: 'a'.repeat(501),
        },
      },
      d,
    );
    expect(JSON.parse(d.decide.mock.calls[0]![0].pendingCall.query).description).toBeUndefined();
  });
  it.each([
    'rg payment . && touch changed',
    'rg payment "$REPO"',
    'rg payment $(pwd)',
    'for p in src; do rg payment "$p"; done',
    'rg payment . > result.txt',
    'git fetch && rg payment .',
  ])('rejects unsupported Bash before eligibility or routing: %s', async (command) => {
    const d = deps();
    expect((await runRepositoryHook(bash(command), d)).response).toBeNull();
    expect(d.eligible).not.toHaveBeenCalled();
    expect(d.decide).not.toHaveBeenCalled();
  });
  it('keeps named files and escaped directories native', async () => {
    await symlink(directory, join(root, 'outside'));
    for (const command of [
      'rg deduplicated src/a.ts',
      `cd '${directory}' && rg payment .`,
      'cd outside && rg payment .',
      'rg payment outside',
    ]) {
      const d = deps();
      expect((await runRepositoryHook(bash(command), d)).response).toBeNull();
      expect(d.decide).not.toHaveBeenCalled();
    }
  });
  it.each([{ path: 'src/a.ts' }, { path: '.', glob: 'src/a.ts' }, { path: 'src', glob: 'a.ts' }])(
    'keeps an already named file native: %j',
    async (input) => {
      const d = deps();
      expect(
        (
          await runRepositoryHook(
            { ...event(), tool_input: { pattern: 'deduplicated', ...input } },
            d,
          )
        ).reason,
      ).toBe('unsupported search');
      expect(d.decide).not.toHaveBeenCalled();
    },
  );
  it('keeps missing human context native', async () => {
    const d = deps();
    await writeFile(transcript, '');
    expect((await runRepositoryHook(event(), d)).reason).toBe('history unavailable');
    expect(d.decide).not.toHaveBeenCalled();
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
  it('retains the human task and actual pending arguments as separate gate evidence', async () => {
    const d = deps();
    await runRepositoryHook(event(), d);
    expect(d.decide.mock.calls[0]![0]).toMatchObject({
      current: { text: human },
      pendingCall: {
        tool: 'Grep',
        query: JSON.stringify({ pattern: 'payment|retry', path: '.' }),
      },
    });
    expect(runRequestTool).not.toHaveBeenCalled();
    expect(executeJevgrep).not.toHaveBeenCalled();
  });
  it.each(['turn', 'session'])(
    'respects router.context=%s before sending the packet',
    async (scope) => {
      const d = deps();
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'config.json'), JSON.stringify({ router: { context: scope } }));
      await writeFile(
        transcript,
        ['A previous topic that is unrelated.', human]
          .map((text) =>
            JSON.stringify({
              type: 'user',
              sessionId: 'session',
              message: { role: 'user', content: text },
            }),
          )
          .join('\n'),
      );
      await runRepositoryHook(event(), d);
      const packet = d.decide.mock.calls[0]![0];
      expect(packet.current.text).toBe(human);
      expect(packet.history).toHaveLength(scope === 'turn' ? 0 : 1);
      if (scope === 'turn') expect(JSON.stringify(packet)).not.toContain('previous topic');
    },
  );
  it.each(['native', 'needs_input'])('obeys a semantic %s decision', async (action) => {
    const d = deps();
    d.decide.mockResolvedValue({ status: 'decided', decision: { decision: { action } } });
    expect((await runRepositoryHook(event(), d)).response).toBeNull();
    expect(runRequestTool).not.toHaveBeenCalled();
    expect(executeJevgrep).not.toHaveBeenCalled();
  });
  it('binds the offer to the human turn and committed snapshot without storing a query', async () => {
    const d = deps();
    const out = await runRepositoryHook(event(), d);
    expect(out.reason).toBe('redirected to repository request');
    const saved = JSON.parse(
      await readFile(join(dataDir, 'jevgrep/bindings', `${hookFixture.decision.id}.json`), 'utf8'),
    );
    expect(saved.repositoryTurn).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.snapshotCommit).toBe(commit);
    expect(saved.query).toBeUndefined();
    expect(JSON.stringify(out.response)).toContain('Tenjin router (installed by the user)');
    expect(JSON.stringify(out.response)).toContain('continue with native tools');
    expect(runRequestTool).not.toHaveBeenCalled();
    expect(executeJevgrep).not.toHaveBeenCalled();
  });
  it('never redirects twice in a human turn, including across Bash and Grep', async () => {
    const d = deps();
    const outcomes = await Promise.all([
      runRepositoryHook(bash('rg payment src'), d),
      runRepositoryHook(event(), d),
    ]);
    expect(outcomes.filter((outcome) => outcome.response !== null)).toHaveLength(1);
    expect((await runRepositoryHook(event('third-call'), d)).response).toBeNull();
    expect(runRequestTool).not.toHaveBeenCalled();
    expect(executeJevgrep).not.toHaveBeenCalled();
  });
  it('does not repeat a hook event', async () => {
    const d = deps();
    await runRepositoryHook(event(), d);
    expect((await runRepositoryHook(event(), d)).response).toBeNull();
    expect(d.decide).toHaveBeenCalledTimes(1);
  });
  it('skips another free classification once the human turn already has an offer', async () => {
    const d = deps();
    await runRepositoryHook(event(), d);
    expect((await runRepositoryHook(bash('rg payment src', 'next-call'), d)).reason).toBe(
      'turn already offered',
    );
    expect(d.decide).toHaveBeenCalledTimes(1);
  });
  it('leaves unknown or excluded MCP subagents native before routing', async () => {
    await mkdir(join(root, '.claude/agents'), { recursive: true });
    await writeFile(
      join(root, '.claude/agents/limited.md'),
      '---\nname: limited\ntools: Read, Bash\n---\nRead code.',
    );
    for (const agent_type of [undefined, 'missing-custom', 'limited', 'claude-code-guide']) {
      const d = deps();
      expect(
        (await runRepositoryHook({ ...event(), agent_id: 'agent-one', agent_type }, d)).reason,
      ).toBe('request tool unavailable');
      expect(d.decide).not.toHaveBeenCalled();
    }
  });
  it('allows a known MCP-capable subagent to write its own query', async () => {
    const d = deps();
    const out = await runRepositoryHook(
      { ...event(), agent_id: 'agent-one', agent_type: 'Explore' },
      d,
    );
    expect(out.response).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(runRequestTool).not.toHaveBeenCalled();
    expect(executeJevgrep).not.toHaveBeenCalled();
  });
  it('leaves cancellation and sensitive current text native', async () => {
    const d = deps();
    d.signal = AbortSignal.abort();
    expect((await runRepositoryHook(event(), d)).response).toBeNull();
    expect(d.decide).not.toHaveBeenCalled();
    delete d.signal;
    await history(`Use ghp_${'a'.repeat(36)} to find the payment code`);
    expect((await runRepositoryHook(event(), d)).reason).toBe('sensitive context');
    expect(d.decide).not.toHaveBeenCalled();
  });
  it('bounds free classification at three calls in one human turn', async () => {
    const d = deps();
    d.decide.mockResolvedValue({ status: 'failed', reason: 'offline' });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => runRepositoryHook(event(`call-${i}`), d)),
    );
    expect(d.decide).toHaveBeenCalledTimes(3);
  });
  it('retains private hash-only free-offer markers and creates no paid-attempt marker', async () => {
    const d = deps();
    await runRepositoryHook(event(), d);
    const base = join(dataDir, 'jevgrep/repository-hooks');
    const session = join(base, (await readdir(base))[0]!);
    for (const file of await readdir(session)) {
      expect(file).not.toMatch(/^(paid|snapshot)-/);
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
