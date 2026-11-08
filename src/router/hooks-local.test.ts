import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './fixture-test-utils';

/**
 * THE LOCAL LEGS. A miss is the common case, on every shell command, search
 * and edit, so it must read no file and make no request: every fs call is
 * recorded while `touched.on` is set, and every request goes to one spy.
 */
const touched = vi.hoisted(() => ({ on: false, calls: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    wrapped[name] =
      typeof value === 'function'
        ? (...args: unknown[]) => {
            if (touched.on) touched.calls.push(`${name} ${String(args[0])}`);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value;
  }
  return { ...wrapped, default: wrapped };
});

const { HINT_SOURCE, runDelegationHook, runLocalHook, runPromptHook } = await import('./hooks');
const { LocalMemory, readLocalRules, writeLocalRules } = await import('./local-rules');
const { fillLocalLine, localCommand, platformPair } = await import('./local-tools');
const { runRequestTool } = await import('./tool');
const { admitCodexHookEvent, admitLocalEvent } = await import('./hook-session');
const { ROUTER_PATH } = await import('./decision');
type Memory = InstanceType<typeof LocalMemory>;
type Rules = Parameters<typeof writeLocalRules>[1];

const BASE = 'https://tenjin.sh';
const HERE = platformPair();
/** The served list, qualified on the pair this suite runs on. */
const SERVED = fixture('wire-local-rules.json').localRules as Rules;
const RULES: Rules = { ...SERVED, rules: SERVED.rules.map((r) => ({ ...r, platforms: [HERE] })) };
const rule = (id: string) => RULES.rules.find((r) => r.rule === id)!;
const HOOK_LOCAL = fixture('wire-hook-local.json');
const knipOffer = (over: Record<string, unknown> = {}) => ({
  ...HOOK_LOCAL,
  decision: { ...(HOOK_LOCAL.decision as object), platforms: [HERE], ...over },
});
const KNIP_ID = (HOOK_LOCAL.decision as { id: string }).id;
const KNIP_LINE = fillLocalLine((HOOK_LOCAL.decision as { hint: string }).hint, 'knip');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-local-'));
  await mkdir(join(dir, '.git'));
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'bin', 'npx'), '');
  await writeFile(join(dir, 'package.json'), '{}');
  await writeFile(join(dir, 'config.json'), '{}');
  touched.on = false;
  touched.calls.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The legs' memory with `rules` loaded, and `npx` on its PATH. */
async function memoryWith(rules: Rules = RULES, path = join(dir, 'bin')): Promise<Memory> {
  await writeLocalRules(dir, rules, Date.now());
  const memory = new LocalMemory({ PATH: path });
  memory.use(await readLocalRules(dir));
  return memory;
}

/** Every request the legs make: an outcome report is a 204, a decision `answer`. */
function net(answer: unknown = null) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    if (typeof body?.status === 'string') return new Response(null, { status: 204 });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const deps = (memory: Memory, fetchImpl: typeof fetch = net().fetchImpl) => ({
  dataDir: dir,
  baseUrl: BASE,
  env: {},
  homeDir: dir,
  fetchImpl,
  local: memory,
});

const bash = (command: unknown, over: Record<string, unknown> = {}) => ({
  hook_event_name: 'PostToolUse',
  session_id: 'sess-1',
  cwd: dir,
  tool_name: 'Bash',
  tool_input: { command, description: 'run it' },
  tool_use_id: 'toolu_1',
  tool_response: { stdout: '', stderr: '', interrupted: false },
  ...over,
});
const edit = (filePath: string, over: Record<string, unknown> = {}) => ({
  hook_event_name: 'PostToolUse',
  session_id: 'sess-1',
  cwd: dir,
  tool_name: 'Edit',
  tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
  tool_use_id: 'toolu_2',
  ...over,
});
const grep = (input: Record<string, unknown>) => ({
  hook_event_name: 'PostToolUse',
  session_id: 'sess-1',
  cwd: dir,
  tool_name: 'Grep',
  tool_input: input,
  tool_response: { mode: 'content', numFiles: 0 },
});
const promptEvent = (prompt: string) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 'sess-1',
  cwd: dir,
  prompt,
});

/** What a leg added for the agent, or null. */
const said = (out: { response: unknown }): string | null =>
  (out.response as { hookSpecificOutput?: { additionalContext?: string } } | null)
    ?.hookSpecificOutput?.additionalContext ?? null;

describe('the prompt leg', () => {
  it("shows the server's line with this build's command, and request({id}) answers it from memory", async () => {
    const memory = await memoryWith();
    const { fetchImpl, calls } = net(knipOffer());
    const out = await runPromptHook(
      promptEvent('find unused exports in this repo'),
      deps(memory, fetchImpl),
    );
    expect(said(out)).toBe(`${HINT_SOURCE}: ${KNIP_LINE}`);
    expect(KNIP_LINE).toContain(`\`${localCommand('knip')}\``);
    expect(out).toMatchObject({ action: 'local', id: KNIP_ID });
    expect(calls).toHaveLength(1);
    // The request tool never runs the tool, and needs no server for the line.
    const offline = vi.fn() as unknown as typeof fetch;
    const sink = { write: () => true } as unknown as NodeJS.WritableStream;
    const asked = await runRequestTool(
      { id: KNIP_ID },
      {
        ctx: {
          flags: { json: true, timeout: 5000, baseUrl: BASE },
          dataDir: dir,
          io: { stdout: sink, stderr: sink, isTTY: false },
        },
        cwd: dir,
        authorizer: {} as never,
        fetchImpl: offline,
        local: memory,
      },
    );
    expect(asked.summary).toBe(KNIP_LINE);
    expect(asked.envelope).toMatchObject({
      status: 'local',
      id: KNIP_ID,
      command: localCommand('knip'),
    });
    expect(offline).not.toHaveBeenCalled();
  });

  it('shows no line on an unlisted platform, with no npx, without package.json, or twice in a session', async () => {
    const line = async (memory: Memory, answer = knipOffer()) =>
      said(
        await runPromptHook(
          promptEvent('find unused exports'),
          deps(memory, net(answer).fetchImpl),
        ),
      );
    expect(await line(await memoryWith(), knipOffer({ platforms: ['plan9-mips'] }))).toBeNull();
    expect(await line(await memoryWith(RULES, join(dir, 'nowhere')))).toBeNull();
    const memory = await memoryWith();
    expect(await line(memory)).not.toBeNull();
    expect(await line(memory)).toBeNull();
    await rm(join(dir, 'package.json'));
    expect(await line(await memoryWith())).toBeNull();
  });

  it('asks the router nothing with the router off', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ router: { enabled: false } }));
    const { fetchImpl, calls } = net(knipOffer());
    const out = await runPromptHook(
      promptEvent('find unused exports'),
      deps(await memoryWith(), fetchImpl),
    );
    expect(out.response).toBeNull();
    expect(calls).toEqual([]);
  });

  it('offers a subagent the tool only when its definition grants Bash', async () => {
    await mkdir(join(dir, '.claude', 'agents'), { recursive: true });
    const agent = (name: string, tools: string) =>
      writeFile(
        join(dir, '.claude', 'agents', `${name}.md`),
        `---\nname: ${name}\ntools: ${tools}\n---\nA reviewer.\n`,
      );
    await agent('reader', 'Read, mcp__*');
    await agent('builder', 'Bash, Read, mcp__*');
    const transcript = join(dir, 'sess-1.jsonl');
    await writeFile(
      transcript,
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-1',
        message: { content: 'clean up the repo' },
      }),
    );
    const delegate = async (type: string) =>
      runDelegationHook(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'sess-1',
          cwd: dir,
          transcript_path: transcript,
          tool_name: 'Agent',
          tool_input: {
            description: 'dead code',
            prompt: 'Find unused exports in this repo.',
            subagent_type: type,
          },
        },
        deps(await memoryWith(), net(knipOffer()).fetchImpl),
      );
    expect((await delegate('reader')).response).toBeNull();
    const out = await delegate('builder');
    const prompt = (out.response as { hookSpecificOutput: { updatedInput: { prompt: string } } })
      .hookSpecificOutput.updatedInput.prompt;
    expect(prompt.startsWith('Find unused exports in this repo.\n\n')).toBe(true);
    expect(prompt).toContain(KNIP_LINE);
  });
});

describe('the shell and search leg', () => {
  it('reads no file and makes no request on a miss', async () => {
    const memory = await memoryWith();
    const { fetchImpl, calls } = net();
    touched.on = true;
    for (const event of [
      bash('ls -la && git status | head'),
      bash('npm pack lucide-react@1.31.0'),
      grep({ pattern: 'TODO', path: 'src' }),
      edit('src/index.ts'),
    ]) {
      expect((await runLocalHook(event, deps(memory, fetchImpl))).response).toBeNull();
    }
    touched.on = false;
    expect(touched.calls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('notes a generated migration after the command ran, and only on success', async () => {
    const memory = await memoryWith();
    const failed = await runLocalHook(
      bash('pnpm drizzle-kit generate', {
        hook_event_name: 'PostToolUseFailure',
        error: 'Exit code 1',
      }),
      deps(memory),
    );
    expect(failed.response).toBeNull();
    const out = await runLocalHook(bash('pnpm drizzle-kit generate'), deps(memory));
    expect(out.response).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `${HINT_SOURCE}: your shell command ran. Optional: ${fillLocalLine(rule('squawk-drizzle-generate').line, 'squawk')}`,
      },
    });
    expect(out.rule).toBe('squawk-drizzle-generate');
  });

  it('notes nothing on a platform pair the rule does not list, and runs no fallback', async () => {
    const elsewhere: Rules = {
      ...RULES,
      rules: RULES.rules.map((r) => ({ ...r, platforms: ['plan9-mips'] })),
    };
    const memory = await memoryWith(elsewhere);
    expect(
      (await runLocalHook(bash('pnpm drizzle-kit generate'), deps(memory))).response,
    ).toBeNull();
    expect(
      (await runLocalHook(grep({ pattern: 'x', multiline: true }), deps(memory))).response,
    ).toBeNull();
  });

  it('gives a multiline Grep the ast-grep line', async () => {
    const out = await runLocalHook(
      grep({ pattern: 'a.*\\n.*b', multiline: true }),
      deps(await memoryWith()),
    );
    expect(said(out)).toBe(
      `${HINT_SOURCE}: your Grep call ran. Optional: ${fillLocalLine(rule('ast-grep-grep-multiline').line, 'ast-grep')}`,
    );
  });

  it("notes a failure only from an output rule, from the failure's error, and never an interrupt", async () => {
    const error =
      "Exit code 1\nReferenceError: Cannot access 'db' before initialization\r\n    at main.ts:3";
    const failure = (over: Record<string, unknown> = {}) =>
      bash('node main.ts', {
        hook_event_name: 'PostToolUseFailure',
        tool_response: undefined,
        error,
        ...over,
      });
    expect(
      (await runLocalHook(failure({ is_interrupt: true }), deps(await memoryWith()))).response,
    ).toBeNull();
    const out = await runLocalHook(failure(), deps(await memoryWith()));
    expect(out.rule).toBe('dependency-cruiser-before-initialization');
    expect(
      (out.response as { hookSpecificOutput: { hookEventName: string } }).hookSpecificOutput
        .hookEventName,
    ).toBe('PostToolUseFailure');
  });

  it("sends no byte of a command's output anywhere", async () => {
    const { fetchImpl, calls } = net();
    const output = 'TOKEN=sk-live-123 ReferenceError: x before initialization';
    const out = await runLocalHook(
      bash('node main.ts', { tool_response: { stdout: output, stderr: '' } }),
      deps(await memoryWith(), fetchImpl),
    );
    expect(out.rule).toBe('dependency-cruiser-before-initialization');
    expect(calls).toEqual([]);
    const counts = await readFile(join(dir, 'router-memo', 'local-counts'), 'utf8');
    expect(counts).toBe('{"rule":"dependency-cruiser-before-initialization","shown":1}\n');
  });

  it('shows one line per tool per agent over every leg, and none for a tool the agent ran', async () => {
    const memory = await memoryWith();
    await runPromptHook(
      promptEvent('find unused exports'),
      deps(memory, net(knipOffer()).fetchImpl),
    );
    // The prompt leg already offered knip to the main agent.
    expect((await runLocalHook(bash('ts-prune'), deps(memory))).response).toBeNull();
    expect(
      (
        await runLocalHook(
          bash('ts-prune', { agent_id: 'a1', agent_type: 'general-purpose' }),
          deps(memory),
        )
      ).rule,
    ).toBe('knip-superseded');
    expect((await runLocalHook(bash('drizzle-kit generate'), deps(memory))).rule).toBe(
      'squawk-drizzle-generate',
    );
    expect((await runLocalHook(bash('prisma migrate dev'), deps(memory))).response).toBeNull();
    // An agent that already ran the tool, pinned or not, is told nothing about it.
    const ran = await memoryWith();
    await runLocalHook(bash('npx ast-grep run -p foo'), deps(ran));
    expect(
      (await runLocalHook(grep({ pattern: 'x', multiline: true }), deps(ran))).response,
    ).toBeNull();
  });

  it("notes a package's missing export with the installed-version attw command, apart from the --pack one", async () => {
    const failed = (memory: Memory) =>
      runLocalHook(
        bash('node scripts/build.mjs', {
          hook_event_name: 'PostToolUseFailure',
          tool_response: undefined,
          error:
            'Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath ./x is not defined by "exports"',
        }),
        deps(memory),
      );
    const packed = await memoryWith();
    // Running the --pack form says nothing about an installed dependency.
    await runLocalHook(bash(localCommand('attw')), deps(packed));
    const out = await failed(packed);
    expect(out.rule).toBe('attw-package-path-not-exported');
    expect(said(out)).toContain(
      `\`${localCommand('attw-npm')}\` in your shell followed by the installed`,
    );
    const read = await memoryWith();
    await runLocalHook(bash(`${localCommand('attw-npm')} zod@3.23.8`), deps(read));
    expect((await failed(read)).response).toBeNull();
  });

  it("reports a prompt offer's run once, fulfilled or failed, and counts a note's run", async () => {
    const memory = await memoryWith();
    const { fetchImpl, calls } = net(knipOffer());
    await runPromptHook(promptEvent('find unused exports'), deps(memory, fetchImpl));
    calls.length = 0;
    const run = bash(localCommand('knip'));
    await runLocalHook(run, deps(memory, fetchImpl));
    await runLocalHook(run, deps(memory, fetchImpl));
    expect(calls).toEqual([
      {
        url: `${BASE}${ROUTER_PATH}`,
        body: { schemaVersion: 1, id: KNIP_ID, harness: 'claude', status: 'fulfilled' },
      },
    ]);
    const failing = await memoryWith();
    const second = net(knipOffer());
    await runPromptHook(promptEvent('find unused exports'), deps(failing, second.fetchImpl));
    await runLocalHook(
      bash(localCommand('knip'), { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1' }),
      deps(failing, second.fetchImpl),
    );
    expect(second.calls.at(-1)?.body).toMatchObject({ id: KNIP_ID, status: 'failed' });
    // A note's tool run is counted against the rule that showed it.
    const noted = await memoryWith();
    await runLocalHook(bash('drizzle-kit generate'), deps(noted));
    await runLocalHook(bash(`${localCommand('squawk')} drizzle/0001.sql`), deps(noted));
    expect(await readFile(join(dir, 'router-memo', 'local-counts'), 'utf8')).toContain(
      '{"rule":"squawk-drizzle-generate","ran":1}',
    );
  });
});

describe('the edit leg', () => {
  const PATHS: Rules = {
    version: 'test',
    rules: [
      {
        ...rule('squawk-migration-path'),
        match: {
          kind: 'path',
          paths: ['.github/workflows/*', 'Dockerfile', '**/*.sh', '**/migrations/**/*.sql'],
        },
      },
    ],
  };

  it('matches a path relative to the git root, a Windows one too', async () => {
    const hit = async (path: string) =>
      (await runLocalHook(edit(path), deps(await memoryWith(PATHS)))).rule ?? null;
    expect(await hit('.github/workflows/ci.yml')).toBe('squawk-migration-path');
    expect(await hit(join(dir, 'Dockerfile'))).toBe('squawk-migration-path');
    expect(await hit('scripts/x.sh')).toBe('squawk-migration-path');
    expect(await hit('db/migrations/0001_init.sql')).toBe('squawk-migration-path');
    expect(await hit('.github\\workflows\\ci.yml')).toBe('squawk-migration-path');
    expect(await hit('docs/workflows.md')).toBeNull();
  });

  it('reads no field of the edit but its file path', async () => {
    const input = new Proxy(
      { file_path: 'Dockerfile' },
      {
        get: (target, key) => {
          if (key !== 'file_path') throw new Error(`read ${String(key)}`);
          return target.file_path;
        },
        ownKeys: () => {
          throw new Error('listed the input');
        },
      },
    );
    const out = await runLocalHook(
      edit('', { tool_input: input, tool_name: 'Write' }),
      deps(await memoryWith(PATHS)),
    );
    expect(said(out)).toMatch(
      new RegExp(`^${HINT_SOURCE.replace(/[()]/g, '\\$&')}: your Write call ran\\. Optional: `),
    );
  });

  it('notes the third distinct file one agent edits in a turn, once, and restarts at the next prompt', async () => {
    const memory = await memoryWith();
    const at = async (path: string) => (await runLocalHook(edit(path), deps(memory))).rule ?? null;
    expect(await at('src/a.ts')).toBeNull();
    expect(await at('src/a.ts')).toBeNull();
    expect(await at('src/b.ts')).toBeNull();
    expect(await at('src/a.ts')).toBeNull();
    expect(await at('src/c.ts')).toBe('ast-grep-edits');
    expect(await at('src/d.ts')).toBeNull();
    const fresh = await memoryWith();
    const next = async (path: string) => (await runLocalHook(edit(path), deps(fresh))).rule ?? null;
    expect(await next('src/a.ts')).toBeNull();
    expect(await next('src/b.ts')).toBeNull();
    await runPromptHook(promptEvent('/clear'), deps(fresh));
    expect(await next('src/c.ts')).toBeNull();
    expect(await next('src/d.ts')).toBeNull();
    expect(await next('src/e.ts')).toBe('ast-grep-edits');
  });
});

describe('the Codex shell leg', () => {
  const codex = (command: unknown, over: Record<string, unknown> = {}) => ({
    hook_event_name: 'PostToolUse',
    session_id: 'codex-sess',
    cwd: dir,
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'call_1',
    tool_response: 'done',
    ...over,
  });
  const codexDeps = async () => ({ ...deps(await memoryWith()), harness: 'codex' as const });

  it('reads the command as a string or as an argv, under either tool name', async () => {
    expect((await runLocalHook(codex('pnpm drizzle-kit generate'), await codexDeps())).rule).toBe(
      'squawk-drizzle-generate',
    );
    expect(
      (
        await runLocalHook(
          codex(['bash', '-lc', 'cd db && drizzle-kit generate']),
          await codexDeps(),
        )
      ).rule,
    ).toBe('squawk-drizzle-generate');
    expect(
      (
        await runLocalHook(
          codex('drizzle-kit generate', { tool_name: 'exec_command' }),
          await codexDeps(),
        )
      ).rule,
    ).toBe('squawk-drizzle-generate');
  });

  it("refuses a subagent's leg, as every Codex leg does", async () => {
    expect(
      (await runLocalHook(codex('drizzle-kit generate', { agent_id: 'child' }), await codexDeps()))
        .response,
    ).toBeNull();
    expect(
      await admitCodexHookEvent(codex('drizzle-kit generate'), { threadId: 'child-thread' }),
    ).toBeNull();
    expect(
      await admitCodexHookEvent(codex('drizzle-kit generate'), { threadId: 'codex-sess' }),
    ).not.toBeNull();
  });
});

describe('admitting a local leg', () => {
  it('checks its ids, reads no transcript, and drops a path it carried', () => {
    touched.on = true;
    expect(
      admitLocalEvent({ session_id: 'sess-1', transcript_path: '/etc/passwd', tool_name: 'Bash' }),
    ).toEqual({
      session_id: 'sess-1',
      tool_name: 'Bash',
    });
    expect(admitLocalEvent({ session_id: '../x' })).toBeNull();
    expect(admitLocalEvent({ session_id: 's', agent_id: 'a/b' })).toBeNull();
    touched.on = false;
    expect(touched.calls).toEqual([]);
  });
});

describe('the miss path', () => {
  it('takes under a millisecond on a 4 KiB command with 16 KiB of output', async () => {
    const memory = await memoryWith();
    const command = Array.from({ length: 128 }, (_, i) => `echo "line ${i}" | grep -v x`)
      .join(' && ')
      .slice(0, 4096);
    const event = bash(command, { tool_response: { stdout: 'o'.repeat(16 * 1024), stderr: '' } });
    const d = deps(memory);
    for (let i = 0; i < 20; i++) await runLocalHook(event, d);
    // The fastest of 20 batches: the handler's own cost, not a busy machine's.
    let fastest = Infinity;
    for (let batch = 0; batch < 20; batch++) {
      const start = performance.now();
      for (let i = 0; i < 10; i++) await runLocalHook(event, d);
      fastest = Math.min(fastest, (performance.now() - start) / 10);
    }
    expect(fastest).toBeLessThan(1);
  });
});
