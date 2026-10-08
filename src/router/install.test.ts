import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import { hookToolInput, type HookKind } from './hook-tool';
import { ALLOW_RULE, DENY_RULE, MCP_ADD_COMMAND, runRouterInstall } from './install';
import { runRouterUninstall } from './uninstall';
import { STATUS_LINE_COMMAND } from './status-line-wiring';
import type { CommandContext } from '../context';

let home: string;
let data: string;
/** A git root of its own for doctor to run from, so `router.*` never
 *  resolves from the suite's cwd. */
let work: string;
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-install-'));
  home = join(root, 'home');
  data = join(root, 'data');
  work = join(root, 'work');
  await mkdir(join(work, '.git'), { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(data, { recursive: true });
  // Install ends with a reachability probe; no test here reaches the network.
  vi.stubGlobal('fetch', probe400);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(join(home, '..'), { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: data,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const probe400 = (async () =>
  new Response('{}', {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

/** A refresh converges the scope it ran in and returns that install. */
function onlyInstall(result: { data: unknown }): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

/** The `mcp` check from a doctor run over a project install. */
async function mcpDetail(
  home: string,
  cwd: string,
  ctx: () => CommandContext,
): Promise<{ status: string; detail: string }> {
  return runRouterDoctorFor(home, cwd, ctx);
}

async function runRouterDoctorFor(
  home: string,
  cwd: string,
  ctx: () => CommandContext,
  extra: Record<string, unknown> = {},
): Promise<{ status: string; detail: string }> {
  const { runRouterDoctor } = await import('./doctor');
  const out = await runRouterDoctor(ctx(), {
    homeDir: home,
    cwd,
    project: true,
    env: {},
    which: () => true,
    fetchImpl: probe400,
    ...extra,
  }).catch((e: unknown) => e);
  const checks =
    out instanceof CliError
      ? (out.details as { checks: { name: string; status: string; detail: string }[] })
      : (out as { data: { checks: { name: string; status: string; detail: string }[] } }).data;
  return checks.checks.find((c) => c.name === 'mcp')!;
}

const settingsPath = () => join(home, '.claude', 'settings.json');
const readSettings = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(settingsPath(), 'utf8')) as Record<string, unknown>;

/** An entry as builds before the `mcp_tool` legs wrote it. */
const handler = (command: string, timeout = 5) => [{ type: 'command', command, timeout }];
/** One routing leg as this build writes it: an `mcp_tool` call to the router
 *  server's `hook` tool, with the event's fields substituted. */
const leg = (kind: HookKind, timeout = 5) => [
  { type: 'mcp_tool', server: 'x402', tool: 'hook', input: hookToolInput(kind), timeout },
];
/** The after-call entries wait for a search's free docs, so they get longer. */
const afterCall = leg('shortfall', 15);
/** Exactly what this build writes into an empty `hooks` key. */
const CURRENT_HOOKS = {
  UserPromptSubmit: [{ hooks: leg('prompt') }],
  PreToolUse: [
    { matcher: 'WebSearch|WebFetch', hooks: leg('native') },
    { matcher: 'Agent|Task', hooks: leg('agent') },
    { matcher: 'AskUserQuestion', hooks: leg('ask') },
  ],
  PostToolUse: [
    { matcher: 'WebSearch|WebFetch', hooks: afterCall },
    { matcher: 'AskUserQuestion', hooks: leg('answer') },
  ],
  PostToolUseFailure: [{ matcher: 'WebSearch|WebFetch', hooks: afterCall }],
};

/**
 * A settings file shaped like every alpha install before tenjin-agent#387,
 * with the user's own entries beside ours: a PreToolUse hook on Bash and a
 * second WebFetch hook of theirs, both of which must survive a refresh.
 */
function alphaSettings(): Record<string, unknown> {
  return {
    model: 'opus',
    hooks: {
      UserPromptSubmit: [{ hooks: handler('tenjin hook prompt') }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard' }] },
        { matcher: 'WebSearch|WebFetch', hooks: handler('tenjin hook native') },
        { matcher: 'WebFetch', hooks: [{ type: 'command', command: 'my-fetch-logger' }] },
      ],
    },
    permissions: { allow: ['mcp__x402__request', 'Bash(git status)'] },
    statusLine: { type: 'command', command: 'tenjin status-line', refreshInterval: 1 },
  };
}

const ADDRESS = '0x3c0D84055994c3062819Ce8730869D0aDeA4c3Bf';

/** Wallet seams are always stubbed: the real create writes to the OS keychain. */
/** What a run that could not ask prints for the agent that ran it. */
/** The routing fee's terms, as the selector shows them. */
const FEE_TERMS =
  'Routing costs $0.003 a call, paid from channel deposits of up to $0.25 that stay yours until spent; each deposit counts against these limits.';
const ASK_LINES = [
  '! Automatic payments are off until the user approves a spend limit',
  `  Ask the user: May Tenjin pay for tool calls without asking you each time, up to $0.25 a call and $5 a day? ${FEE_TERMS} Using these limits or choosing your own also approves the routing fee.`,
  '  Yes: tenjin install --accept-defaults',
  '  Other amounts: tenjin config set maxAutoSpend <usd> and tenjin config set sessionBudget <usd|none>',
  '  No: run nothing, the router then pays for nothing on its own, and the question stays open until tenjin install in a terminal or tenjin config set answers it',
];

function deps(over: Record<string, unknown> = {}) {
  return {
    homeDir: home,
    env: {},
    which: () => true,
    registerMcp: vi.fn(async () => undefined),
    walletExists: async () => false,
    createWallet: vi.fn(async () => ADDRESS),
    walletAddress: async () => ADDRESS,
    listMcpProcesses: async () => [],
    ...over,
  };
}

describe('tenjin install', () => {
  it('writes the seven hook entries, the allow and deny rules and the MCP registration', async () => {
    const registerMcp = vi.fn(async () => undefined);
    const result = await runRouterInstall({}, ctx(), deps({ registerMcp }));
    const settings = await readSettings();
    expect(settings.hooks).toEqual(CURRENT_HOOKS);
    expect(settings.permissions).toEqual({ allow: [ALLOW_RULE], deny: [DENY_RULE] });
    expect(DENY_RULE).toBe('mcp__x402__hook');
    expect(result.data).toMatchObject({
      permissions: { rule: ALLOW_RULE, added: true, denyRule: DENY_RULE, denyAdded: true },
    });
    expect(registerMcp).toHaveBeenCalledWith(MCP_ADD_COMMAND, {
      scope: 'user',
      cwd: expect.any(String) as unknown as string,
    });
    expect(JSON.stringify(result.data)).not.toContain('daemon');
  });

  it('with nobody to approve, writes no limit and keeps automatic spend at zero', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ confirm: 'always' }));
    const result = await runRouterInstall({}, ctx(), deps());
    const config = await loadRawConfig(data);
    expect(config.maxAutoSpend).toBeUndefined();
    expect(config.sessionBudget).toBeUndefined();
    expect(config.confirm).toBeUndefined();
    expect(config.bazaarPay).toBeUndefined();
    expect(result.data).toMatchObject({
      spend: {
        removed: ['confirm'],
        set: [],
        kept: [],
        effective: { maxAutoSpend: '0', sessionBudget: '5' },
        approval: {
          question: `May Tenjin pay for tool calls without asking you each time, up to $0.25 a call and $5 a day? ${FEE_TERMS} Using these limits or choosing your own also approves the routing fee.`,
          limits: { maxAutoSpend: '0.25', sessionBudget: '5' },
          routingFee: FEE_TERMS,
          approve: 'tenjin install --accept-defaults',
          own: 'tenjin config set maxAutoSpend <usd> and tenjin config set sessionBudget <usd|none>',
        },
      },
    });
    const { next } = (result.data as { spend: { approval: { next: string } } }).spend.approval;
    expect(next).toMatch(
      /^Show the user these limits and ask this question before you change any limit\./,
    );
    expect(next).toContain('If they say yes, run `tenjin install --accept-defaults`.');
    expect(next).toContain('If they say no, run nothing');
  });

  it('asks about the daily limit the file already names', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ sessionBudget: 'none' }));
    const result = await runRouterInstall({}, ctx(), deps());
    expect(result.data).toMatchObject({
      spend: {
        approval: {
          question: `May Tenjin pay for tool calls without asking you each time, up to $0.25 a call with no daily limit? ${FEE_TERMS} Using these limits or choosing your own also approves the routing fee.`,
          limits: { maxAutoSpend: '0.25', sessionBudget: 'none' },
        },
      },
    });
  });

  it('asks nothing of a user who already chose a zero per-call limit', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ maxAutoSpend: '0' }));
    const result = await runRouterInstall({}, ctx(), deps());
    expect(result.data).not.toHaveProperty('spend.approval');
    expect(result.humanLines).toContain(
      '! Automatic payments are off: every paid lookup needs your approval',
    );
  });

  it('still succeeds, with a warning, when TENJIN_BASE_URL is not a URL', async () => {
    vi.stubEnv('TENJIN_BASE_URL', 'tenjin.blog');
    try {
      const result = await runRouterInstall({}, ctx(), deps());
      expect(result.data).toMatchObject({
        router: { status: 'warn', detail: 'the base URL "tenjin.blog" is not a URL' },
      });
      expect((await readSettings()).hooks).toEqual(CURRENT_HOOKS);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('doctor reaches the router check and its fix when TENJIN_BASE_URL is not a URL', async () => {
    const { runRouterDoctor } = await import('./doctor');
    await runRouterInstall({}, ctx(), deps());
    vi.stubEnv('TENJIN_BASE_URL', 'tenjin.blog');
    try {
      const out = await runRouterDoctor(ctx(), {
        homeDir: home,
        cwd: work,
        env: {},
        which: () => true,
        readMcp: async () => true,
        fetchImpl: probe400,
      }).catch((e: unknown) => e);
      expect(out).toBeInstanceOf(CliError);
      const checks = ((out as CliError).details as { checks: { name: string; detail: string }[] })
        .checks;
      expect(checks.find((c) => c.name === 'routing fee')?.detail).toBe(
        'not checked, because the base URL is not a URL',
      );
      expect(checks.find((c) => c.name === 'router')?.detail).toBe(
        'the base URL "tenjin.blog" is not a URL',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports no hooks directory, because the entries are plain commands', async () => {
    const result = await runRouterInstall({}, ctx(), deps());
    const hooks = (result.data as { hooks: Record<string, unknown> }).hooks;
    expect(hooks).toMatchObject({ entries: 7, wrote: true });
    expect(hooks).not.toHaveProperty('hooksDir');
  });

  it('turns the pay lane on and auto-approves at or below the per-call cap by default', async () => {
    await runRouterInstall({}, ctx(), deps());
    const config = await loadRawConfig(data);
    expect(config.confirm).toBeUndefined();
    expect(config.bazaarPay).toBeUndefined();
  });

  it('preserves every unrelated settings key byte for byte', async () => {
    const original = {
      model: 'opus',
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'someone-elses-hook' }] }] },
    };
    await writeFile(settingsPath(), JSON.stringify(original, null, 2) + '\n');
    await runRouterInstall({}, ctx(), deps());
    const settings = await readSettings();
    expect(settings.model).toBe('opus');
    expect(settings.env).toEqual({ FOO: 'bar' });
    expect(settings.permissions).toEqual({
      allow: ['Bash(ls:*)', ALLOW_RULE],
      deny: ['Bash(rm:*)', DENY_RULE],
    });
    expect((settings.hooks as Record<string, unknown[]>).Stop).toEqual(original.hooks.Stop);
  });

  it('leaves a deny key that is not a list as it is, and says so', async () => {
    await writeFile(settingsPath(), JSON.stringify({ permissions: { deny: 'Bash(rm:*)' } }) + '\n');
    const result = await runRouterInstall({}, ctx(), deps());
    const settings = await readSettings();
    expect(settings.permissions).toEqual({ deny: 'Bash(rm:*)', allow: [ALLOW_RULE] });
    expect(result.data).toMatchObject({
      permissions: {
        denyAdded: false,
        warning: expect.stringContaining('"permissions.deny" key that is not an array') as unknown,
      },
    });
  });

  it('is idempotent: a second run writes the same file', async () => {
    await runRouterInstall({}, ctx(), deps());
    const first = await readFile(settingsPath(), 'utf8');
    await runRouterInstall({}, ctx(), deps());
    expect(await readFile(settingsPath(), 'utf8')).toBe(first);
  });

  it('sweeps a legacy daemon installation, writing no daemon or shim file', async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [
                  {
                    type: 'command',
                    command: `node "${data}/hooks/tenjin-shim.mjs" --harness claude`,
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                matcher: 'WebSearch|WebFetch',
                hooks: [{ type: 'http', url: 'http://127.0.0.1:41234/hook/claude' }],
              },
            ],
            Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:41234/hook/claude' }] }],
          },
        },
        null,
        2,
      ) + '\n',
    );
    await runRouterInstall({}, ctx(), deps());
    const settings = await readSettings();
    const raw = JSON.stringify(settings);
    expect(raw).not.toContain('tenjin-shim.mjs');
    expect(raw).not.toContain('127.0.0.1');
    expect(Object.keys(settings.hooks as object).sort()).toEqual([
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'UserPromptSubmit',
    ]);
  });

  it('prints the command to run when the claude binary is absent', async () => {
    const result = await runRouterInstall({}, ctx(), deps({ which: () => false }));
    expect(result.data).toMatchObject({ mcp: { registered: false, command: MCP_ADD_COMMAND } });
    // Not "set up": the hooks would point at a request tool that is not there.
    expect(result.humanLines).toEqual([
      '! Almost done: Claude Code needs one command',
      `✓ Wallet created: ${ADDRESS}`,
      ...ASK_LINES,
      '  Live status line on: each lookup names its provider while it runs',
      '! Could not add the request tool to Claude Code. Run:',
      `  ${MCP_ADD_COMMAND}`,
      '',
      'Next: run the command above and tenjin wallet fund, then restart Claude Code',
    ]);
  });

  it('does not report a refresh as up to date when the registration is missing', async () => {
    await runRouterInstall({}, ctx(), deps());
    const result = await runRouterInstall({ refresh: true }, ctx(), deps({ which: () => false }));
    const text = result.humanLines!.join('\n');
    expect(text).not.toContain('up to date');
    expect(text).toContain(MCP_ADD_COMMAND);
  });

  it('prints a short summary: set up, the new wallet, the limits, the next step', async () => {
    const result = await runRouterInstall({}, ctx(), deps());
    expect(result.humanLines).toEqual([
      '✓ Tenjin is set up for Claude Code',
      `✓ Wallet created: ${ADDRESS}`,
      ...ASK_LINES,
      '  Live status line on: each lookup names its provider while it runs',
      '',
      'Next: tenjin wallet fund, then restart Claude Code',
    ]);
    // The data-handling detail is not dropped, it moves to --json and the docs.
    expect(result.data).toMatchObject({
      disclosure: expect.any(Array),
      router: { status: 'ok' },
    });
  });

  it('still succeeds, with a warning and the fix, when the router does not answer', async () => {
    // What an egress proxy that blocks tenjin.sh sends: a 403 with none of
    // the headers the deployment adds.
    const blocked = (async () => new Response('Forbidden', { status: 403 })) as typeof fetch;
    const result = await runRouterInstall({}, ctx(), deps({ fetchImpl: blocked }));
    const router = (result.data as { router: { status: string; detail: string; fix: string } })
      .router;
    expect(router.status).toBe('warn');
    expect(router.detail).toContain('a proxy, firewall or VPN on the way most likely refused');
    expect(router.fix).toContain('Allow tenjin.sh through your proxy, firewall or VPN');
    expect(router.fix).not.toContain('config set baseUrl');
    expect(result.humanLines).toContain(`! The router did not answer: ${router.detail}`);
    expect(result.humanLines).toContain(`  ${router.fix}`);
    expect((await readSettings()).hooks).toEqual(CURRENT_HOOKS);
  });

  it('names running servers that predate this install, with the reconnect fix, and stops none', async () => {
    const listMcpProcesses = vi.fn(async () => [{ pid: 9044, startedAt: 1 }]);
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({ listMcpProcesses, installedAt: async () => 2 }),
    );
    expect(result.data).toMatchObject({ mcpServer: { name: 'mcp server', status: 'warn' } });
    expect(result.humanLines!.join('\n')).toContain('started before this install');
    expect(result.humanLines!.join('\n')).toContain(
      'Reconnect x402 with /mcp, or start a new Claude Code session.',
    );
    // The refresh `tenjin update` runs says it too.
    const refreshed = await runRouterInstall(
      { refresh: true },
      ctx(),
      deps({ listMcpProcesses, installedAt: async () => 2 }),
    );
    expect(refreshed.humanLines!.join('\n')).toContain('Reconnect x402 with /mcp');
  });

  it('creates a wallet when there is none, without asking', async () => {
    const createWallet = vi.fn(async () => ADDRESS);
    const confirmWallet = vi.fn(async () => false);
    const result = await runRouterInstall({}, ctx(), deps({ createWallet, confirmWallet }));
    expect(createWallet).toHaveBeenCalledOnce();
    expect(confirmWallet).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ wallet: { status: 'created', address: ADDRESS } });
  });

  it('keeps the wallet this machine already has', async () => {
    const createWallet = vi.fn(async () => ADDRESS);
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({ createWallet, walletExists: async () => true }),
    );
    expect(createWallet).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ wallet: { status: 'existing', address: ADDRESS } });
    expect(result.humanLines).toContain(`✓ Wallet: ${ADDRESS}`);
    expect(result.humanLines!.at(-1)).toBe('Next: restart Claude Code');
  });

  it('creates no wallet with --no-wallet', async () => {
    const createWallet = vi.fn(async () => ADDRESS);
    const result = await runRouterInstall({ noWallet: true }, ctx(), deps({ createWallet }));
    expect(createWallet).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ wallet: { status: 'skipped', reason: 'flag' } });
    expect(result.humanLines!.join('\n')).toContain('tenjin wallet create');
  });

  it('still succeeds, with the fix, when the wallet cannot be created', async () => {
    const createWallet = vi.fn(async () => {
      throw new Error('disk full');
    });
    const result = await runRouterInstall({}, ctx(), deps({ createWallet }));
    const text = result.humanLines!.join('\n');
    expect(text).toContain('No wallet was created');
    expect(text).toContain('disk full');
    expect(text).toContain('tenjin wallet create');
  });

  it('writes into the project settings file with --project', async () => {
    const cwd = join(home, 'project');
    await mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    const project = JSON.parse(
      await readFile(join(cwd, '.claude', 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(project.hooks as object)).toContain('UserPromptSubmit');
    await expect(readFile(settingsPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/** A person at a terminal: human output, no `--json`. */
function humanCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000 },
    dataDir: data,
    io: { stdout: sink(), stderr: sink(), isTTY: true },
  };
}

/** Answers each amount question from the list, in order, and records what was asked. */
function amounts(answers: (string | null)[]) {
  const queue = [...answers];
  return vi.fn(async (_message: string, _placeholder: string) => {
    if (queue.length === 0) throw new Error('asked more often than the test answers');
    return queue.shift()!;
  });
}

const FEE_LINES =
  '\nRouting costs $0.003 a call, paid from channel deposits of up to $0.25 that stay yours until spent; each deposit counts against these limits.\nUsing these limits or choosing your own also approves the routing fee.';

describe('install asks a person to approve the spend limits', () => {
  it('"Use these limits" names the routing fee and writes the defaults it showed', async () => {
    const promptLimits = vi.fn(async () => 'approve' as const);
    const promptAmount = amounts([]);
    const result = await runRouterInstall(
      {},
      humanCtx(),
      deps({ isInteractive: true, promptLimits, promptAmount }),
    );
    expect(promptLimits).toHaveBeenCalledWith(
      `The router pays for tool calls without asking, up to:\n  $0.25 a call, $5 a day${FEE_LINES}`,
    );
    expect(promptAmount).not.toHaveBeenCalled();
    const config = await loadRawConfig(data);
    expect(config).toMatchObject({
      maxAutoSpend: '250000',
      sessionBudget: '5000000',
    });
    expect(result.humanLines).toContain(
      '  Automatic router: up to $0.25 per call; daily limit $5 a day',
    );
  });

  it('"Choose my own" writes the amounts typed, and the readout prints them', async () => {
    const result = await runRouterInstall(
      {},
      humanCtx(),
      deps({
        isInteractive: true,
        promptLimits: async () => 'own' as const,
        promptAmount: amounts(['0.10', '2']),
      }),
    );
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '100000',
      sessionBudget: '2000000',
    });
    expect(result.humanLines).toContain(
      '  Automatic router: up to $0.1 per call; daily limit $2 a day',
    );
  });

  it('takes none for the daily limit', async () => {
    await runRouterInstall(
      {},
      humanCtx(),
      deps({
        isInteractive: true,
        promptLimits: async () => 'own' as const,
        promptAmount: amounts(['0.25', 'none']),
      }),
    );
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '250000',
      sessionBudget: 'none',
    });
  });

  it('refuses zero and a negative amount and asks again', async () => {
    const promptAmount = amounts(['0', '-1', '0.5', '0', '3']);
    await runRouterInstall(
      {},
      humanCtx(),
      deps({ isInteractive: true, promptLimits: async () => 'own' as const, promptAmount }),
    );
    const messages = promptAmount.mock.calls.map(([message]) => message);
    expect(messages).toHaveLength(5);
    expect(messages[1]).toMatch(/^The limit must be more than zero\. /);
    expect(messages[2]).toMatch(/^Invalid USD amount: "-1"\. /);
    expect(messages[4]).toMatch(/^The limit must be more than zero\. /);
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '500000',
      sessionBudget: '3000000',
    });
  });

  it.each([
    ['at the selector', async () => null, amounts([])],
    ['at an amount', async () => 'own' as const, amounts(['0.10', null])],
  ])('a cancel %s writes nothing and exits non-zero', async (_at, promptLimits, promptAmount) => {
    const registerMcp = vi.fn(async () => undefined);
    const createWallet = vi.fn(async () => ADDRESS);
    const err = await runRouterInstall(
      {},
      humanCtx(),
      deps({ isInteractive: true, promptLimits, promptAmount, registerMcp, createWallet }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).not.toBe(0);
    await expect(readFile(join(data, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(settingsPath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(registerMcp).not.toHaveBeenCalled();
    expect(createWallet).not.toHaveBeenCalled();
  });

  it('does not ask when the file already names both limits', async () => {
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ maxAutoSpend: '10000', sessionBudget: 'none' }),
    );
    const promptLimits = vi.fn(async () => 'approve' as const);
    await runRouterInstall({}, humanCtx(), deps({ isInteractive: true, promptLimits }));
    expect(promptLimits).not.toHaveBeenCalled();
    const config = await loadRawConfig(data);
    expect(config).toMatchObject({ maxAutoSpend: '10000', sessionBudget: 'none' });
  });

  it('shows a limit the file already names and asks only for the missing one', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ sessionBudget: 'none' }));
    const promptLimits = vi.fn(async () => 'own' as const);
    const promptAmount = amounts(['0.05']);
    await runRouterInstall(
      {},
      humanCtx(),
      deps({ isInteractive: true, promptLimits, promptAmount }),
    );
    expect(promptLimits).toHaveBeenCalledWith(
      `The router pays for tool calls without asking, up to:\n  $0.25 a call, no daily limit${FEE_LINES}`,
    );
    expect(promptAmount).toHaveBeenCalledTimes(1);
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '50000',
      sessionBudget: 'none',
    });
  });

  it.each([
    ['a non-interactive run', () => humanCtx(), false],
    ['--json', () => ctx(), true],
  ])('%s asks nothing and writes no spend limit', async (_name, makeCtx, isInteractive) => {
    const promptLimits = vi.fn(async () => 'own' as const);
    const result = await runRouterInstall({}, makeCtx(), deps({ isInteractive, promptLimits }));
    expect(promptLimits).not.toHaveBeenCalled();
    // The state a cancel at the selector leaves: both keys absent, no literal 0.
    const config = await loadRawConfig(data);
    expect(config).not.toHaveProperty('maxAutoSpend');
    expect(config).not.toHaveProperty('sessionBudget');
    expect(result.data).toMatchObject({ spend: { set: [], kept: [] } });
    // An agent's shell has no terminal: the question goes to the agent instead.
    expect(result.humanLines).toEqual(expect.arrayContaining(ASK_LINES));
    // The rest of the install completes as it would after a yes.
    expect(onlyInstall(result)).toMatchObject({ mcp: { registered: true } });
  });

  it('a non-interactive run keeps a per-call limit the file already names', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ maxAutoSpend: '100000' }));
    const result = await runRouterInstall({}, ctx(), deps());
    expect(await loadRawConfig(data)).toEqual({ maxAutoSpend: '100000' });
    expect(result.data).toMatchObject({ spend: { set: [], kept: ['maxAutoSpend'] } });
    expect(result.data).not.toHaveProperty('spend.approval');
  });

  it('--accept-defaults writes the limits the question shows, as "Use these limits" does', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ sessionBudget: 'none' }));
    const promptLimits = vi.fn(async () => 'own' as const);
    const result = await runRouterInstall(
      { acceptDefaults: true },
      ctx(),
      deps({ isInteractive: false, promptLimits }),
    );
    expect(promptLimits).not.toHaveBeenCalled();
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '250000',
      sessionBudget: 'none',
    });
    expect(result.data).not.toHaveProperty('spend.approval');
  });

  it.each([
    ['--refresh', { refresh: true }],
    ['--project', { project: true }],
    ['--no-wallet', { noWallet: true }],
    ['--status-line', { statusLine: 'skip' as const }],
  ])('refuses --accept-defaults with %s', async (_flag, other) => {
    const err = await runRouterInstall({ acceptDefaults: true, ...other }, ctx(), deps()).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'USAGE' });
  });

  it('--accept-defaults answers the spend question and undoes no install choice', async () => {
    // The agent-run install was told to make no wallet and leave the status line alone.
    const createWallet = vi.fn(async () => ADDRESS);
    await runRouterInstall({ noWallet: true, statusLine: 'skip' }, ctx(), deps({ createWallet }));
    const before = await readFile(settingsPath(), 'utf8');
    const registerMcp = vi.fn(async () => undefined);
    const result = await runRouterInstall(
      { acceptDefaults: true },
      ctx(),
      deps({ createWallet, registerMcp }),
    );
    expect(createWallet).not.toHaveBeenCalled();
    expect(registerMcp).not.toHaveBeenCalled();
    expect(await readFile(settingsPath(), 'utf8')).toBe(before);
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '250000',
      sessionBudget: '5000000',
    });
    expect(result.data).toMatchObject({ spend: { set: ['maxAutoSpend', 'sessionBudget'] } });
    expect(result.humanLines).toEqual([
      '✓ Spend limits set: up to $0.25 per call; daily limit $5 a day.',
    ]);
  });

  it('--accept-defaults says it changed nothing when the file names both limits, a 0 included', async () => {
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ maxAutoSpend: '0', sessionBudget: '5000000' }),
    );
    const result = await runRouterInstall({ acceptDefaults: true }, ctx(), deps());
    expect(await loadRawConfig(data)).toMatchObject({ maxAutoSpend: '0' });
    expect(result.data).toMatchObject({
      spend: { set: [], kept: ['maxAutoSpend', 'sessionBudget'] },
    });
    const text = result.humanLines!.join('\n');
    expect(text).not.toContain('Spend limits set');
    expect(text).toContain(
      'Nothing changed: your config already names both limits (up to $0 per call',
    );
    expect(text).toContain('`tenjin config set maxAutoSpend <usd>`');
  });

  it('--accept-defaults names the limit it kept beside the one it set', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ sessionBudget: 'none' }));
    const result = await runRouterInstall({ acceptDefaults: true }, ctx(), deps());
    expect(result.humanLines!.join('\n')).toContain('Kept your own sessionBudget');
  });

  it('--refresh asks nothing and fills no absent limit', async () => {
    await runRouterInstall({}, ctx(), deps());
    await writeFile(join(data, 'config.json'), '{}');
    const promptLimits = vi.fn(async () => 'own' as const);
    await runRouterInstall(
      { refresh: true },
      humanCtx(),
      deps({ isInteractive: true, promptLimits }),
    );
    expect(promptLimits).not.toHaveBeenCalled();
    expect(await loadRawConfig(data)).toEqual({});
  });
});

describe('tenjin install --refresh', () => {
  it('re-registers what is already there and changes no config', async () => {
    await runRouterInstall({}, ctx(), deps());
    await writeFile(join(data, 'config.json'), JSON.stringify({ maxAutoSpend: '1' }));
    const registerMcp = vi.fn(async () => undefined);
    const result = await runRouterInstall({ refresh: true }, ctx(), deps({ registerMcp }));
    expect(onlyInstall(result)).toMatchObject({ refresh: true });
    // The registration IS re-checked: a new version can change the command it
    // registers. What a refresh must never do is decide anything about money.
    expect(registerMcp).toHaveBeenCalled();
    expect((await loadRawConfig(data)).maxAutoSpend).toBe('1');
    expect(result.humanLines).toEqual(['✓ Tenjin is up to date']);
  });

  /**
   * THE MIGRATION EVERY ALPHA INSTALL TAKES. `tenjin update` runs exactly this
   * refresh: the prompt and PreToolUse native entries stay, the delegation and
   * post-call entries arrive, and everything that is not ours stays byte for
   * byte, including the user's own PreToolUse and WebFetch hooks.
   */
  it("migrates an alpha install into mcp_tool legs, keeping the user's own entries", async () => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(home, '.claude'), { recursive: true });
    await fs.writeFile(settingsPath(), JSON.stringify(alphaSettings(), null, 2) + '\n');

    await runRouterInstall({ refresh: true }, ctx(), deps());
    const after = await readSettings();
    expect(after.hooks).toEqual({
      UserPromptSubmit: CURRENT_HOOKS.UserPromptSubmit,
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard' }] },
        { matcher: 'WebFetch', hooks: [{ type: 'command', command: 'my-fetch-logger' }] },
        ...CURRENT_HOOKS.PreToolUse,
      ],
      PostToolUse: CURRENT_HOOKS.PostToolUse,
      PostToolUseFailure: CURRENT_HOOKS.PostToolUseFailure,
    });
    // No command entry of ours is left: each became its `mcp_tool` leg.
    expect(JSON.stringify(after)).not.toContain('tenjin hook ');
    // The deny rule arrives beside the allow rule; nothing else outside the hooks moves.
    expect(after.permissions).toEqual({
      allow: ['mcp__x402__request', 'Bash(git status)'],
      deny: [DENY_RULE],
    });
    expect({ ...after, hooks: null, permissions: null }).toEqual({
      ...alphaSettings(),
      hooks: null,
      permissions: null,
    });

    // Converged: a second refresh writes nothing.
    const again = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect((onlyInstall(again) as { hooks: { wrote: boolean } }).hooks.wrote).toBe(false);
  });

  it('refuses on a machine that never installed', async () => {
    await expect(runRouterInstall({ refresh: true }, ctx(), deps())).rejects.toMatchObject({
      code: 'REFUSED',
    });
  });
});

describe('tenjin uninstall', () => {
  it('removes the entries, the rule and the registration, keeping the wallet', async () => {
    await writeFile(join(data, 'wallet.json'), '{"keystore":"kept"}');
    await runRouterInstall({}, ctx(), deps());
    const removeMcp = vi.fn(async () => undefined);
    const result = await runRouterUninstall({}, ctx(), {
      homeDir: home,
      env: {},
      which: () => true,
      removeMcp,
    });
    const settings = await readSettings();
    expect(JSON.stringify(settings)).not.toContain('tenjin hook ');
    expect(JSON.stringify(settings)).not.toContain('mcp_tool');
    expect(settings.permissions).toEqual({ allow: [], deny: [] });
    expect(result.humanLines?.[0]).toContain('and the permission rules from');
    expect(removeMcp).toHaveBeenCalled();
    expect(await readFile(join(data, 'wallet.json'), 'utf8')).toBe('{"keystore":"kept"}');
    expect(result.data).toMatchObject({ kept: ['wallet.json', 'spend.json', 'config.json'] });
  });

  it('leaves someone else’s entries and keys exactly as they are', async () => {
    const mine = { hooks: [{ type: 'command', command: 'someone-elses-hook' }] };
    const rules = { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)', 'mcp__x402'] };
    await writeFile(
      settingsPath(),
      JSON.stringify({ model: 'opus', hooks: { Stop: [mine] }, permissions: rules }, null, 2) +
        '\n',
    );
    await runRouterInstall({}, ctx(), deps());
    await runRouterUninstall({}, ctx(), { homeDir: home, env: {}, which: () => false });
    const settings = await readSettings();
    expect(settings.model).toBe('opus');
    expect((settings.hooks as Record<string, unknown[]>).Stop).toEqual([mine]);
    expect(settings.permissions).toEqual(rules);
  });

  it('says what to run by hand when the claude binary is absent', async () => {
    await runRouterInstall({}, ctx(), deps());
    const result = await runRouterUninstall({}, ctx(), {
      homeDir: home,
      env: {},
      which: () => false,
    });
    expect(result.humanLines?.join('\n')).toContain('claude mcp remove x402');
  });

  it('does nothing at all on a machine with no settings file', async () => {
    await rm(settingsPath(), { force: true });
    const result = await runRouterUninstall({}, ctx(), {
      homeDir: home,
      env: {},
      which: () => false,
    });
    expect(result.data).toMatchObject({ wrote: false });
  });

  it('leaves an x402 server that launches something else, as install does', async () => {
    await runRouterInstall({}, ctx(), deps());
    const other = { command: 'npx', args: ['-y', 'some-other-x402-server'] };
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { x402: other } }, null, 2) + '\n',
    );
    const removeMcp = vi.fn(async () => undefined);
    const result = await runRouterUninstall({}, ctx(), {
      homeDir: home,
      env: {},
      which: () => true,
      removeMcp,
    });
    expect(removeMcp).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ mcp: { removed: false, kept: 'foreign', scope: 'user' } });
    expect(result.humanLines?.join('\n')).toContain('left in place');
    expect(result.humanLines?.join('\n')).not.toContain('claude mcp remove');
    const kept = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(kept.mcpServers.x402).toEqual(other);
  });

  it('removes the x402 server when it is the router', async () => {
    await runRouterInstall({}, ctx(), deps());
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { x402: { command: 'tenjin', args: ['mcp'] } } }, null, 2) +
        '\n',
    );
    const removeMcp = vi.fn(async () => undefined);
    const result = await runRouterUninstall({}, ctx(), {
      homeDir: home,
      env: {},
      which: () => true,
      removeMcp,
    });
    expect(removeMcp).toHaveBeenCalled();
    expect(result.data).toMatchObject({ mcp: { removed: true, scope: 'user' } });
  });

  it('removes nothing from a registration file it cannot read', async () => {
    await runRouterInstall({}, ctx(), deps());
    await writeFile(join(home, '.claude.json'), '{ not json');
    const removeMcp = vi.fn(async () => undefined);
    const result = await runRouterUninstall({}, ctx(), {
      homeDir: home,
      env: {},
      which: () => true,
      removeMcp,
    });
    expect(removeMcp).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ mcp: { removed: false, kept: 'unreadable' } });
  });

  it('leaves a project-scope x402 that launches something else', async () => {
    const cwd = join(home, 'project');
    await mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { x402: { command: 'node', args: ['other.js'] } } }, null, 2) +
        '\n',
    );
    const removeMcp = vi.fn(async () => undefined);
    const result = await runRouterUninstall({ project: true }, ctx(), {
      homeDir: home,
      cwd,
      env: {},
      which: () => true,
      removeMcp,
    });
    expect(removeMcp).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      mcp: { removed: false, kept: 'foreign', scope: 'project' },
    });
  });
});

describe('a settings file this writer will not touch', () => {
  it('reports the refusal rather than rewriting it', async () => {
    await writeFile(settingsPath(), '{ not json');
    const result = await runRouterInstall({}, ctx(), deps());
    expect((result.data as { hooks: { skipped?: string } }).hooks.skipped).toBe('unparsable');
    expect(await readFile(settingsPath(), 'utf8')).toBe('{ not json');
    const text = result.humanLines!.join('\n');
    expect(text).toContain('left exactly as it is');
    expect(text).toContain('could not finish setting up');
    expect(text).not.toContain('✓ Tenjin is set up');
    // One file, one warning: the permission writer's copy is not repeated.
    expect(text.match(/is not valid JSON/g)).toHaveLength(1);
  });

  it('throws nothing an operator cannot act on when HOME is relative', async () => {
    await expect(runRouterInstall({}, ctx(), deps({ homeDir: 'relative' }))).rejects.toBeInstanceOf(
      CliError,
    );
  });
});

describe('the doctor this release registers', () => {
  /**
   * INFORMATIONAL: a custom agent that leaves the request tool out is named,
   * with the line that would change it, and never counts against the machine.
   * The file itself is only read.
   */
  it('names custom agents whose tools exclude the request tool, as a pass', async () => {
    const fs = await import('node:fs/promises');
    const { runRouterDoctor } = await import('./doctor');
    await runRouterInstall({}, ctx(), deps());
    const agents = join(home, '.claude', 'agents');
    await fs.mkdir(agents, { recursive: true });
    const reader = '---\nname: reader\ndescription: reads\ntools: Read, WebFetch\n---\nRead.\n';
    await fs.writeFile(join(agents, 'reader.md'), reader);
    await fs.writeFile(join(agents, 'free.md'), '---\nname: free\ndescription: all\n---\n');
    const result = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd: home,
      env: {},
      which: () => true,
      readMcp: async () => true,
      fetchImpl: probe400,
    }).catch((e: unknown) => e);
    type Check = { name: string; status: string; required: boolean; detail: string };
    const checks =
      result instanceof CliError
        ? (result.details as { checks: Check[] }).checks
        : (result as { data: { checks: Check[] } }).data.checks;
    const line = checks.find((c) => c.name === 'subagents');
    expect(line).toMatchObject({ status: 'ok', required: false });
    expect(line?.detail).toBe(
      'reader is offered no paid lookups: add mcp__x402__request to tools: to allow paid lookups there',
    );
    expect(await fs.readFile(join(agents, 'reader.md'), 'utf8')).toBe(reader);
  });

  it('checks the router wiring and prescribes no command the CLI lacks', async () => {
    const { runRouterDoctor } = await import('./doctor');
    await runRouterInstall({}, ctx(), deps());
    await writeFile(join(data, 'wallet.json'), '{"not":"a wallet"}');
    const fetchImpl = (async () =>
      new Response('{}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd: home,
      env: {},
      which: () => true,
      readMcp: async () => true,
      fetchImpl,
    }).catch((e: unknown) => e);
    const data_ =
      result instanceof CliError
        ? (result.details as { checks: { name: string; fix?: string }[] })
        : (result as { data: { checks: { name: string; fix?: string }[] } }).data;
    const names = data_.checks.map((c) => c.name);
    expect(names).toEqual([
      'node',
      'hooks',
      'status line',
      'mcp',
      'mcp server',
      'spend',
      'experimental',
      'routing fee',
      'wallet',
      'router',
    ]);
    // The experiment ships off, and doctor says so in its one line.
    const experimental = data_.checks.find((c) => c.name === 'experimental') as unknown as {
      status: string;
      detail: string;
    };
    expect(experimental.status).toBe('ok');
    expect(experimental.detail).toMatch(/^list: on; bazaar: off \(experimental\)/);
    const fixes = data_.checks.map((c) => c.fix ?? '').join(' ');
    for (const gone of ['tenjin daemon', 'tenjin search', 'tenjin publish', 'tenjin hooks']) {
      expect(fixes).not.toContain(gone);
    }
  });

  it.each([
    [
      'an agent-run install that left the limits unanswered',
      undefined,
      { status: 'warn', required: false },
    ],
    ['a 0 the user set', '0', { status: 'fail', required: true }],
  ])('reports %s, and the router probe still runs', async (_name, maxAutoSpend, expected) => {
    const { runRouterDoctor } = await import('./doctor');
    await runRouterInstall({}, ctx(), deps());
    if (maxAutoSpend !== undefined) {
      await writeFile(join(data, 'config.json'), JSON.stringify({ maxAutoSpend }));
    }
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
      });
    }) as typeof fetch;
    const out = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd: work,
      env: {},
      which: () => true,
      readMcp: async () => true,
      fetchImpl,
    }).catch((e: unknown) => e);
    type Check = { name: string; status: string; required: boolean; detail: string; fix?: string };
    const checks =
      out instanceof CliError
        ? (out.details as { checks: Check[] }).checks
        : (out as { data: { checks: Check[] } }).data.checks;
    const spend = checks.find((c) => c.name === 'spend');
    expect(spend).toMatchObject(expected);
    if (maxAutoSpend === undefined) {
      expect(spend?.detail).toContain(
        `Ask the user: May Tenjin pay for tool calls without asking you each time, up to $0.25 a call and $5 a day? ${FEE_TERMS}`,
      );
      expect(spend?.fix).toBe(
        'Answer the spend question: for a yes, run `tenjin install --accept-defaults`; for other amounts, `tenjin config set maxAutoSpend <usd>` and `tenjin config set sessionBudget <usd|none>`; or run `tenjin install` in a terminal to choose.',
      );
      // The open question is not the first required failure, so it never hides
      // the network diagnosis.
      expect(out instanceof CliError ? out.message : '').not.toContain('maxAutoSpend');
    } else {
      expect((out as CliError).message).toContain('maxAutoSpend is 0');
      // Install keeps a 0 it finds and never asks, so only `config set` changes it.
      expect(spend?.fix).toBe('Set a per-call limit with `tenjin config set maxAutoSpend <usd>`.');
    }
    expect(checks.find((c) => c.name === 'router')?.status).toBe('fail');
  });

  it('names a routing backoff in force while the router is still not reached, and ends it once it is', async () => {
    const { runRouterDoctor } = await import('./doctor');
    const { readRouterMemo, writeRouterMemo } = await import('./router-memo');
    await runRouterInstall({}, ctx(), deps());
    const now = 1_800_000_000_000;
    type Check = { name: string; status: string; detail: string };
    const refused = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    }) as typeof fetch;
    const routerLine = async (fetchImpl: typeof fetch = probe400) => {
      const out = await runRouterDoctor(ctx(), {
        homeDir: home,
        cwd: work,
        env: {},
        which: () => true,
        readMcp: async () => true,
        fetchImpl,
        now: () => now,
      }).catch((e: unknown) => e);
      const body =
        out instanceof CliError
          ? (out.details as { checks: Check[]; baseUrl: string })
          : (out as { data: { checks: Check[]; baseUrl: string } }).data;
      return { check: body.checks.find((c) => c.name === 'router'), baseUrl: body.baseUrl };
    };
    const before = await routerLine();
    expect(before.check?.detail).not.toContain('skip the router');
    await writeRouterMemo(data, 'unreachable', before.baseUrl, {
      now: now - 15_000,
      ttlMs: 60_000,
    });
    const during = await routerLine(refused);
    expect(during.check?.status).toBe('fail');
    expect(during.check?.detail).toContain(
      'routing calls skip the router for 45s more, after one did not reach it',
    );
    // A probe the router answers ends the backoff for every routing leg.
    const after = await routerLine();
    expect(after.check?.status).toBe('ok');
    expect(after.check?.detail).not.toContain('skip the router');
    expect(await readRouterMemo(data, 'unreachable', before.baseUrl, now)).toBeNull();
  });

  it('fails with the command that fixes it on a machine that never installed', async () => {
    const { runRouterDoctor } = await import('./doctor');
    const fetchImpl = (async () => new Response('{}', { status: 400 })) as typeof fetch;
    const err = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd: work,
      env: {},
      which: () => false,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).fix).toContain('tenjin install');
  });

  it.each([
    [404, 'the router is not enabled at'],
    [401, 'answered 401 without the headers a Tenjin deployment sends'],
    [407, 'asked for its own credentials (407)'],
    [503, 'is unreachable or erroring (503)'],
  ])('reports the router endpoint answering %i as a failure', async (status, detail) => {
    const { runRouterDoctor } = await import('./doctor');
    await runRouterInstall({}, ctx(), deps());
    await writeFile(join(data, 'wallet.json'), '{"not":"a wallet"}');
    const fetchImpl = (async () => new Response('{}', { status })) as typeof fetch;
    const err = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd: work,
      env: {},
      which: () => true,
      readMcp: async () => true,
      fetchImpl,
    }).catch((e: unknown) => e);
    // The throw names the FIRST required failure, so the router's own verdict is
    // read off the check list every doctor envelope carries.
    const checks = (err as CliError).details as { checks: { name: string; detail: string }[] };
    const router = checks.checks.find((c) => c.name === 'router');
    expect(router?.detail).toContain(detail);
  });
});

describe('doctor and the router switch', () => {
  async function hooksCheck(cwd: string): Promise<{ status: string; detail: string }> {
    const { runRouterDoctor } = await import('./doctor');
    await writeFile(join(data, 'wallet.json'), '{"not":"a wallet"}');
    const result = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd,
      env: {},
      which: () => true,
      readMcp: async () => true,
      fetchImpl: probe400,
    }).catch((e: unknown) => e);
    const checks =
      result instanceof CliError
        ? (result.details as { checks: { name: string; status: string; detail: string }[] })
        : (result as { data: { checks: { name: string; status: string; detail: string }[] } }).data;
    return checks.checks.find((c) => c.name === 'hooks')!;
  }

  it('warns, naming the file, when the hooks are wired and the router is off here', async () => {
    await runRouterInstall({}, ctx(), deps());
    const repo = join(home, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, '.tenjin'), { recursive: true });
    const file = join(repo, '.tenjin', 'config.json');
    await writeFile(file, JSON.stringify({ router: { enabled: false } }));

    const off = await hooksCheck(repo);
    expect(off.status).toBe('warn');
    expect(off.detail).toContain(`router.enabled is false in ${file}`);

    const elsewhere = join(home, 'other');
    await mkdir(join(elsewhere, '.git'), { recursive: true });
    expect((await hooksCheck(elsewhere)).status).toBe('ok');
  });
});

describe('the permission rule goes through the shared writer', () => {
  it('leaves a settings file it cannot parse exactly as it is', async () => {
    await writeFile(settingsPath(), '{ not json');
    const result = await runRouterInstall({}, ctx(), deps());
    expect(await readFile(settingsPath(), 'utf8')).toBe('{ not json');
    expect((result.data as { permissions: { added: boolean } }).permissions.added).toBe(false);
  });

  it('refuses a permissions key that is not an object rather than replacing it', async () => {
    await writeFile(settingsPath(), JSON.stringify({ permissions: 'nope' }, null, 2) + '\n');
    const result = await runRouterInstall({}, ctx(), deps());
    const settings = await readSettings();
    expect(settings.permissions).toBe('nope');
    expect(
      (result.data as { permissions: { warning?: string } }).permissions.warning,
    ).toBeDefined();
  });
});

describe('the install readout and the status window', () => {
  it('prints the limits actually in force, not the defaults it would have set', async () => {
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ maxAutoSpend: '1000000', sessionBudget: '10000000' }),
    );
    const result = await runRouterInstall({}, ctx(), deps());
    const text = result.humanLines!.join('\n');
    expect(text).toContain('Automatic router: up to $1 per call; daily limit $10 a day');
    expect(text).not.toContain('$0.25');
    expect(result.data).toMatchObject({
      spend: { effective: { maxAutoSpend: '1', sessionBudget: '10' } },
    });
  });

  it('says so when an existing config has no daily ceiling at all', async () => {
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ maxAutoSpend: '500000', sessionBudget: 'none' }),
    );
    const result = await runRouterInstall({}, ctx(), deps());
    expect(result.humanLines!.join('\n')).toContain('no daily limit');
  });

  it('status applies the same expiry an authorization would', async () => {
    const { runRouterStatus } = await import('./status');
    const { createLocalSpendAuthorizer } = await import('../lib/wallet/spend');
    const auth = createLocalSpendAuthorizer({
      dir: data,
      policy: {
        maxAutoSpendAtomic: 1_000_000n,
        sessionBudgetAtomic: 1_000_000n,

        allowlistCreators: [],
      },
    });
    await auth.authorize({ amountAtomic: 10_000n, creator: 's', requestKey: 'k' });
    const fresh = await runRouterStatus(ctx());
    expect((fresh.data as { inFlight: unknown[] }).inFlight).toHaveLength(1);

    // Eleven minutes on, that reservation is past its TTL and an authorization
    // would not count it; the readout must not either.
    const later = Date.now() + 11 * 60 * 1000;
    const aged = await runRouterStatus(ctx(), { now: () => later });
    expect((aged.data as { inFlight: unknown[] }).inFlight).toHaveLength(0);

    // A day on, the whole window has rolled over.
    const nextDay = Date.now() + 25 * 60 * 60 * 1000;
    const rolled = await runRouterStatus(ctx(), { now: () => nextDay });
    expect(
      (rolled.data as { window: { committed: { atomic: string } } }).window.committed.atomic,
    ).toBe('0');
  });
});

describe('doctor on a --project install', () => {
  it('reads the project settings file, not the home one', async () => {
    const { runRouterDoctor } = await import('./doctor');
    const cwd = join(home, 'project');
    await import('node:fs/promises').then((fs) => fs.mkdir(cwd, { recursive: true }));
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    const fetchImpl = (async () =>
      new Response('{}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    // The home file has nothing in it: a doctor that looked there would report
    // a correctly wired machine as unwired and exit 3.
    const blind = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd: work,
      env: {},
      which: () => true,
      readMcp: async () => true,
      fetchImpl,
    }).catch((e: unknown) => e);
    const blindChecks = (blind as CliError).details as {
      checks: { name: string; status: string }[];
    };
    expect(blindChecks.checks.find((c) => c.name === 'hooks')?.status).toBe('fail');

    const aware = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd,
      project: true,
      env: {},
      which: () => true,
      readMcp: async () => true,
      fetchImpl,
    }).catch((e: unknown) => e);
    const checks =
      aware instanceof CliError
        ? (aware.details as { checks: { name: string; status: string; detail: string }[] })
        : (aware as { data: { checks: { name: string; status: string; detail: string }[] } }).data;
    const hooks = checks.checks.find((c) => c.name === 'hooks');
    expect(hooks?.status).toBe('ok');
    expect(hooks?.detail).toContain('UserPromptSubmit');
  });

  it('names the file it looked in, so the two installs are told apart', async () => {
    const { runRouterDoctor } = await import('./doctor');
    const cwd = join(home, 'other');
    const fetchImpl = (async () => new Response('{}', { status: 400 })) as typeof fetch;
    const err = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd,
      project: true,
      env: {},
      which: () => false,
      fetchImpl,
    }).catch((e: unknown) => e);
    const details = (err as CliError).details as { settingsPath: string };
    expect(details.settingsPath).toBe(join(cwd, '.claude', 'settings.json'));
  });
});

/**
 * A `--project` run touches this project and nothing else. The hooks already
 * went to the project settings file; the MCP registration has to follow them,
 * or the run reaches into `~/.claude.json` and `uninstall --project` leaves
 * that behind.
 */
describe('--project scopes the MCP registration too', () => {
  const userFiles = async (): Promise<Record<string, string | null>> => {
    const fs = await import('node:fs/promises');
    const out: Record<string, string | null> = {};
    for (const rel of ['.claude.json', '.claude/settings.json', '.claude/.mcp.json']) {
      out[rel] = await fs.readFile(join(home, rel), 'utf8').catch(() => null);
    }
    return out;
  };

  it('registers at project scope, in the project directory', async () => {
    const cwd = join(home, 'project');
    await import('node:fs/promises').then((fs) => fs.mkdir(cwd, { recursive: true }));
    const registerMcp = vi.fn(async () => undefined);
    const result = await runRouterInstall({ project: true }, ctx(), deps({ cwd, registerMcp }));
    expect(registerMcp).toHaveBeenCalledWith('claude mcp add x402 -s project -- tenjin mcp', {
      scope: 'project',
      cwd,
    });
    expect(result.data).toMatchObject({ mcp: { scope: 'project', registered: true } });
  });

  it('leaves every user-scope file byte-identical across install and uninstall', async () => {
    const cwd = join(home, 'project');
    const fs = await import('node:fs/promises');
    await fs.mkdir(cwd, { recursive: true });
    // A user-scope machine that already has its own MCP registration and its
    // own settings: neither may move because a project install ran.
    await fs.writeFile(join(home, '.claude.json'), '{"mcpServers":{"someone-else":{}}}\n');
    await fs.writeFile(join(home, '.claude', 'settings.json'), '{"model":"opus"}\n');
    const before = await userFiles();

    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    expect(await userFiles()).toEqual(before);

    await runRouterUninstall({ project: true }, ctx(), {
      homeDir: home,
      cwd,
      env: {},
      which: () => true,
      removeMcp: vi.fn(async () => undefined),
    });
    expect(await userFiles()).toEqual(before);
  });

  it('removes at project scope, from the project directory', async () => {
    const cwd = join(home, 'project');
    await import('node:fs/promises').then((fs) => fs.mkdir(cwd, { recursive: true }));
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    const removeMcp = vi.fn(async () => undefined);
    const result = await runRouterUninstall({ project: true }, ctx(), {
      homeDir: home,
      cwd,
      env: {},
      which: () => true,
      removeMcp,
    });
    expect(removeMcp).toHaveBeenCalledWith({ scope: 'project', cwd });
    expect(result.data).toMatchObject({ mcp: { scope: 'project', removed: true } });
    expect(result.humanLines?.join('\n')).toContain('project scope');
  });

  it('names the project-scope command by hand when the claude binary is absent', async () => {
    const cwd = join(home, 'project');
    await import('node:fs/promises').then((fs) => fs.mkdir(cwd, { recursive: true }));
    const result = await runRouterInstall(
      { project: true },
      ctx(),
      deps({ cwd, which: () => false }),
    );
    expect(result.humanLines?.join('\n')).toContain('claude mcp add x402 -s project');
  });

  it('doctor reads the project file, not the harness, for a project install', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    await fs.writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { x402: { command: 'tenjin', args: ['mcp'] } } }),
    );
    const readMcp = vi.fn(async () => true);
    const out = await runRouterDoctorFor(home, cwd, ctx, { readMcp });
    // The file the scope writes is the authority; `claude mcp get` resolves
    // ACROSS scopes and would say yes for a user-scope server here.
    expect(readMcp).not.toHaveBeenCalled();
    expect(out.status).toBe('ok');
    expect(out.detail).toContain('project scope');
  });
});

/**
 * An entry named `x402` proves nothing about what it runs. A stale one pointing
 * at another binary, or an empty object, would read as a working request tool
 * and send the operator looking anywhere but at the registration.
 */
describe('doctor checks that the registration launches the router', () => {
  it.each([
    ['an empty entry', {}, 'wrong-command'],
    ['another binary', { command: 'node', args: ['thing.js'] }, 'wrong-command'],
    [
      'the right binary with the wrong args',
      { command: 'tenjin', args: ['mcp', '--x'] },
      'wrong-command',
    ],
    ['no args at all', { command: 'tenjin' }, 'wrong-command'],
    ['a bare command', { command: 'tenjin', args: ['mcp'] }, 'ok'],
    ['an absolute install path', { command: '/opt/homebrew/bin/tenjin', args: ['mcp'] }, 'ok'],
  ])('classifies %s', async (_label, entry, expected) => {
    const { classifyMcpEntry } = await import('./install');
    expect(classifyMcpEntry(entry)).toBe(expected);
  });

  it.each([
    ['an empty entry', { mcpServers: { x402: {} } }],
    ['another binary', { mcpServers: { x402: { command: 'node', args: ['other.js'] } } }],
  ])('fails with the named reason on %s', async (_label, file) => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    await fs.writeFile(join(cwd, '.mcp.json'), JSON.stringify(file));
    const check = await mcpDetail(home, cwd, ctx);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('registered but not `tenjin mcp`');
  });

  it('passes and says what it runs on the correct entry', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    await fs.writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { x402: { command: 'tenjin', args: ['mcp'] } } }),
    );
    const check = await mcpDetail(home, cwd, ctx);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('`tenjin mcp`');
  });
});

/**
 * The upgrade path a user actually walks: router version N to N+1. `tenjin
 * update` swaps the binary and re-runs this writer, which owns its entries by
 * their marker, so it rewrites rather than appends.
 */
describe('tenjin update re-applies the install', () => {
  it('is a no-op by bytes when nothing changed', async () => {
    const fs = await import('node:fs/promises');
    await runRouterInstall({}, ctx(), deps());
    const before = await fs.readFile(settingsPath(), 'utf8');
    const result = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect(await fs.readFile(settingsPath(), 'utf8')).toBe(before);
    expect((onlyInstall(result) as { hooks: { wrote: boolean } }).hooks.wrote).toBe(false);
    expect(result.humanLines).toEqual(['✓ Tenjin is up to date']);
  });

  it('rewrites the entries ONCE when the new version changes their shape', async () => {
    const fs = await import('node:fs/promises');
    await runRouterInstall({}, ctx(), deps());
    // An older layout: our marker, a different command shape and timeout.
    const settings = await readSettings();
    (settings.hooks as Record<string, unknown[]>).UserPromptSubmit = [
      { hooks: [{ type: 'command', command: '/old/path/tenjin hook prompt', timeout: 10 }] },
    ];
    await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2) + '\n');

    const result = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect((onlyInstall(result) as { hooks: { wrote: boolean } }).hooks.wrote).toBe(true);
    const after = await readSettings();
    const prompt = (after.hooks as Record<string, { hooks: { command: string }[] }[]>)
      .UserPromptSubmit;
    // ONE entry, the current shape: rewritten in place, never appended beside.
    expect(prompt).toHaveLength(1);
    expect(prompt![0]!.hooks).toEqual(leg('prompt'));
    expect(JSON.stringify(after)).not.toContain('/old/path/tenjin');
  });

  /**
   * AN OLDER INSTALL'S COMMAND ENTRIES BECOME `mcp_tool` LEGS on every route
   * that writes the plan, including the refresh `tenjin update` spawns: each is
   * ours by its `tenjin hook` marker, so it is rewritten in place, never left
   * beside the new leg to route the same event twice, and the user's own
   * entries are not touched.
   */
  it.each([
    ['install', {}],
    ['install --refresh (what `tenjin update` spawns)', { refresh: true }],
  ])('rewrites old command entries into mcp_tool legs on %s', async (_label, args) => {
    const fs = await import('node:fs/promises');
    await runRouterInstall({}, ctx(), deps());
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    hooks.UserPromptSubmit = [{ hooks: handler('tenjin hook prompt', 3) }];
    hooks.PreToolUse = [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard' }] },
      { matcher: 'WebSearch|WebFetch', hooks: handler('tenjin hook native') },
      { matcher: 'Agent|Task', hooks: handler('tenjin hook agent') },
      { matcher: 'AskUserQuestion', hooks: handler('tenjin hook ask') },
    ];
    for (const event of ['PostToolUse', 'PostToolUseFailure']) {
      hooks[event] = [
        { matcher: 'WebSearch|WebFetch', hooks: handler('tenjin hook shortfall', 15) },
      ];
    }
    (hooks.PostToolUse as unknown[]).push({
      matcher: 'AskUserQuestion',
      hooks: handler('tenjin hook answer'),
    });
    await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2) + '\n');

    const result = await runRouterInstall(args, ctx(), deps());
    expect((onlyInstall(result) as { hooks: { wrote: boolean } }).hooks.wrote).toBe(true);
    expect((await readSettings()).hooks).toEqual({
      ...CURRENT_HOOKS,
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-bash-guard' }] },
        ...CURRENT_HOOKS.PreToolUse,
      ],
    });
    // Converged: the next run writes nothing.
    const again = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect((onlyInstall(again) as { hooks: { wrote: boolean } }).hooks.wrote).toBe(false);
  });

  /**
   * The kill budgets went back to 5 s per routing leg and 15 s after a search,
   * so a stuck server never holds a prompt longer. An install from the build
   * that wrote 20 s and 30 s is ours by marker, and the writer converges it on
   * every route, including the refresh `tenjin update` spawns.
   */
  it.each([
    ['install', {}],
    ['install --refresh (what `tenjin update` spawns)', { refresh: true }],
  ])('rewrites 20 s and 30 s legs to 5 s and 15 s on %s', async (_label, args) => {
    const fs = await import('node:fs/promises');
    await runRouterInstall({}, ctx(), deps());
    const settings = await readSettings();
    const longer = (entry: { hooks: { timeout: number }[] }) => ({
      ...entry,
      hooks: entry.hooks.map((hook) => ({ ...hook, timeout: hook.timeout === 15 ? 30 : 20 })),
    });
    settings.hooks = Object.fromEntries(
      Object.entries(CURRENT_HOOKS).map(([event, entries]) => [
        event,
        (entries as { hooks: { timeout: number }[] }[]).map(longer),
      ]),
    );
    await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
    expect(await fs.readFile(settingsPath(), 'utf8')).toContain('"timeout": 30');

    const result = await runRouterInstall(args, ctx(), deps());
    expect((onlyInstall(result) as { hooks: { wrote: boolean } }).hooks.wrote).toBe(true);
    const after = (await readSettings()).hooks as typeof CURRENT_HOOKS;
    expect(after.UserPromptSubmit).toEqual([{ hooks: leg('prompt') }]);
    expect(after.PostToolUseFailure).toEqual([{ matcher: 'WebSearch|WebFetch', hooks: afterCall }]);
    expect(after).toEqual(CURRENT_HOOKS);
  });

  it('stays in the project scope it was installed into, with no flag', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    const homeBefore = await fs.readFile(settingsPath(), 'utf8').catch(() => null);

    const registerMcp = vi.fn(async () => undefined);
    const result = await runRouterInstall({ refresh: true }, ctx(), deps({ cwd, registerMcp }));
    expect(onlyInstall(result)).toMatchObject({
      settingsPath: join(cwd, '.claude', 'settings.json'),
      scope: 'project',
    });
    expect(registerMcp).toHaveBeenCalledWith('claude mcp add x402 -s project -- tenjin mcp', {
      scope: 'project',
      cwd,
    });
    // The user's file is exactly as it was, including still absent.
    expect(await fs.readFile(settingsPath(), 'utf8').catch(() => null)).toBe(homeBefore);
  });

  it('leaves the wallet, the ledger and the config alone', async () => {
    const fs = await import('node:fs/promises');
    await runRouterInstall({}, ctx(), deps());
    await fs.writeFile(join(data, 'wallet.json'), '{"keystore":"kept"}');
    await fs.writeFile(join(data, 'spend.json'), '{"schemaVersion":2}');
    await fs.writeFile(join(data, 'config.json'), JSON.stringify({ maxAutoSpend: '1' }));
    const before = await Promise.all(
      ['wallet.json', 'spend.json', 'config.json'].map((f) => fs.readFile(join(data, f), 'utf8')),
    );
    await runRouterInstall({ refresh: true }, ctx(), deps());
    const after = await Promise.all(
      ['wallet.json', 'spend.json', 'config.json'].map((f) => fs.readFile(join(data, f), 'utf8')),
    );
    expect(after).toEqual(before);
  });

  it('doctor passes after an update, in both scopes', async () => {
    const fs = await import('node:fs/promises');
    const { runRouterDoctor } = await import('./doctor');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    await fs.writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { x402: { command: 'tenjin', args: ['mcp'] } } }),
    );
    await runRouterInstall({ refresh: true }, ctx(), deps({ cwd }));
    const check = await mcpDetail(home, cwd, ctx);
    expect(check.status).toBe('ok');
    const out = await runRouterDoctor(ctx(), {
      homeDir: home,
      cwd,
      project: true,
      env: {},
      which: () => true,
      fetchImpl: probe400,
    }).catch((e: unknown) => e);
    const checks =
      out instanceof CliError
        ? (out.details as { checks: { name: string; status: string }[] })
        : (out as { data: { checks: { name: string; status: string }[] } }).data;
    expect(checks.checks.find((c) => c.name === 'hooks')?.status).toBe('ok');
  });

  /**
   * AN ALPHA INSTALL, BEFORE AND AFTER ITS REFRESH. Doctor names the entries
   * it lacks, with the one command that adds them, and does not call its own
   * native entry stale; after that command it is clean.
   */
  it("doctor names an alpha install's drift, and the refresh clears it", async () => {
    const fs = await import('node:fs/promises');
    const { runRouterDoctor } = await import('./doctor');
    const cwd = join(home, 'project');
    await fs.mkdir(join(cwd, '.claude'), { recursive: true });
    await fs.writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { x402: { command: 'tenjin', args: ['mcp'] } } }),
    );
    const path = join(cwd, '.claude', 'settings.json');
    await fs.writeFile(path, JSON.stringify(alphaSettings(), null, 2) + '\n');
    type Check = { name: string; status: string; detail: string; fix?: string };
    const hooksCheck = async (): Promise<Check | undefined> => {
      const out = await runRouterDoctor(ctx(), {
        homeDir: home,
        cwd,
        project: true,
        env: {},
        which: () => true,
        fetchImpl: probe400,
      }).catch((e: unknown) => e);
      const checks =
        out instanceof CliError
          ? (out.details as { checks: Check[] })
          : (out as { data: { checks: Check[] } }).data;
      return checks.checks.find((c) => c.name === 'hooks');
    };

    const before = await hooksCheck();
    expect(before).toMatchObject({ status: 'warn', fix: 'Run `tenjin install --refresh`.' });
    // The alpha's command entries are stale, and every `mcp_tool` leg is missing.
    expect(before?.detail).toContain('stale UserPromptSubmit → tenjin hook prompt');
    expect(before?.detail).toContain('PreToolUse WebSearch|WebFetch → tenjin hook native');
    expect(before?.detail).toContain('PostToolUse WebSearch|WebFetch → x402 hook shortfall');
    expect(before?.detail).toContain('PostToolUseFailure WebSearch|WebFetch → x402 hook shortfall');
    expect(before?.detail).toContain('PreToolUse Agent|Task → x402 hook agent');
    // The user's own entries are theirs, never drift.
    expect(before?.detail).not.toContain('my-bash-guard');

    await runRouterInstall({ refresh: true }, ctx(), deps({ cwd }));
    expect(await hooksCheck()).toMatchObject({ status: 'ok' });
  });
});

/**
 * ONE SCOPE PER REFRESH. The fan-out that hunted recorded projects from HOME is
 * gone, along with the list it read and the failure mode where one project's
 * broken JSON decided what every other install got. What replaces it is
 * smaller: with no flag, the refresh converges the install that is actually
 * here, and `tenjin update` is a binary swap plus exactly that.
 */
describe('a refresh converges one scope', () => {
  it.each(['missing', 'dangling symlink', 'non-directory parent'])(
    'refreshes a project with an unavailable home: %s',
    async (kind) => {
      await runRouterInstall({ project: true }, ctx(), deps({ cwd: work }));
      const homeEntry = join(home, '..', 'unavailable-home');
      const unavailableHome =
        kind === 'non-directory parent' ? join(homeEntry, 'child') : homeEntry;
      if (kind === 'dangling symlink')
        await symlink(join(home, '..', 'missing-target'), unavailableHome, 'dir');
      if (kind === 'non-directory parent') await writeFile(homeEntry, 'not a directory');
      const registerMcp = vi.fn(async () => undefined);
      const originalHomeSettings = await readFile(settingsPath(), 'utf8').catch(() => null);

      const result = await runRouterInstall(
        { refresh: true },
        ctx(),
        deps({
          homeDir: unavailableHome,
          cwd: work,
          registerMcp,
        }),
      );

      expect(onlyInstall(result)).toMatchObject({
        refresh: true,
        scope: 'project',
        settingsPath: join(work, '.claude', 'settings.json'),
        mcp: { scope: 'project', registered: true },
      });
      expect(registerMcp).toHaveBeenCalledWith('claude mcp add x402 -s project -- tenjin mcp', {
        scope: 'project',
        cwd: work,
      });
      expect(await readFile(settingsPath(), 'utf8').catch(() => null)).toBe(originalHomeSettings);
      if (kind === 'non-directory parent')
        expect(await readFile(homeEntry, 'utf8')).toBe('not a directory');
      else
        await expect(readFile(join(unavailableHome, '.claude.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
    },
  );

  it.each([false, true])(
    'preserves a home project registration on unflagged refresh (user registration: %s)',
    async (userRegistered) => {
      await runRouterInstall({ project: true }, ctx(), deps({ cwd: home }));
      const config = JSON.stringify({ mcpServers: { x402: { command: 'tenjin', args: ['mcp'] } } });
      await writeFile(join(home, '.mcp.json'), config);
      if (userRegistered) await writeFile(join(home, '.claude.json'), config);
      const registerMcp = vi.fn(async () => undefined);

      const result = await runRouterInstall(
        { refresh: true },
        ctx(),
        deps({ cwd: home, registerMcp }),
      );

      expect(onlyInstall(result)).toMatchObject({
        scope: userRegistered ? 'user' : 'project',
        mcp: { registered: true, reconciled: 'already-registered' },
      });
      expect(registerMcp).not.toHaveBeenCalled();
      expect(await readFile(join(home, '.mcp.json'), 'utf8')).toBe(config);
      if (userRegistered) expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe(config);
      else
        await expect(readFile(join(home, '.claude.json'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
    },
  );

  it.each(['home', 'cwd'])('recognizes a symlinked %s as the user install', async (aliased) => {
    await runRouterInstall({}, ctx(), deps());
    const alias = join(home, '..', 'home-alias');
    await symlink(home, alias, 'dir');
    const config = JSON.stringify({ mcpServers: { x402: { command: 'tenjin', args: ['mcp'] } } });
    await writeFile(join(home, '.claude.json'), config);
    const registerMcp = vi.fn(async () => undefined);

    const result = await runRouterInstall(
      { refresh: true },
      ctx(),
      deps({
        homeDir: aliased === 'home' ? alias : home,
        cwd: aliased === 'cwd' ? alias : home,
        registerMcp,
      }),
    );

    expect(onlyInstall(result)).toMatchObject({ scope: 'user', mcp: { registered: true } });
    expect(registerMcp).not.toHaveBeenCalled();
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe(config);
    await expect(readFile(join(home, '.mcp.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['.claude.json', '.mcp.json'])(
    'does not infer a different scope from unreadable %s at home',
    async (file) => {
      await runRouterInstall({}, ctx(), deps());
      await writeFile(join(home, file), '{ broken');
      const registerMcp = vi.fn(async () => undefined);

      await expect(
        runRouterInstall({ refresh: true }, ctx(), deps({ cwd: home, registerMcp })),
      ).rejects.toMatchObject({ code: 'REFUSED' });

      expect(registerMcp).not.toHaveBeenCalled();
      expect(await readFile(join(home, file), 'utf8')).toBe('{ broken');
    },
  );

  it.each([false, true])(
    'refreshes user scope from home (existing MCP registration: %s)',
    async (registered) => {
      await runRouterInstall({}, ctx(), deps());
      const userMcpPath = join(home, '.claude.json');
      const entry = { command: 'tenjin', args: ['mcp'] };
      const userConfig = {
        mcpServers: {
          unrelated: { command: 'other-server' },
          ...(registered ? { x402: entry } : {}),
        },
      };
      await writeFile(userMcpPath, JSON.stringify(userConfig));
      const registerMcp = vi.fn(async (_command: string, opts: { scope: string }) => {
        const path = opts.scope === 'user' ? userMcpPath : join(home, '.mcp.json');
        await writeFile(
          path,
          JSON.stringify({
            ...userConfig,
            mcpServers: { ...userConfig.mcpServers, x402: entry },
          }),
        );
      });

      // This is the cwd and argument combination spawned by `tenjin update`.
      const result = await runRouterInstall(
        { refresh: true },
        ctx(),
        deps({ cwd: home, registerMcp }),
      );

      expect(onlyInstall(result)).toMatchObject({
        refresh: true,
        scope: 'user',
        settingsPath: settingsPath(),
        mcp: { scope: 'user', registered: true },
      });
      expect(registerMcp).toHaveBeenCalledTimes(registered ? 0 : 1);
      if (!registered) {
        expect(registerMcp).toHaveBeenCalledWith(MCP_ADD_COMMAND, { scope: 'user', cwd: home });
      }
      expect(JSON.parse(await readFile(userMcpPath, 'utf8'))).toEqual({
        ...userConfig,
        mcpServers: { ...userConfig.mcpServers, x402: entry },
      });
      await expect(readFile(join(home, '.mcp.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('honors an explicit project refresh even when the project is home', async () => {
    await runRouterInstall({ project: true }, ctx(), deps({ cwd: home }));
    const registerMcp = vi.fn(async () => undefined);

    const result = await runRouterInstall(
      { refresh: true, project: true },
      ctx(),
      deps({ cwd: home, registerMcp }),
    );

    expect(onlyInstall(result)).toMatchObject({ scope: 'project', mcp: { scope: 'project' } });
    expect(registerMcp).toHaveBeenCalledWith('claude mcp add x402 -s project -- tenjin mcp', {
      scope: 'project',
      cwd: home,
    });
  });

  it('takes the project install when this directory carries the entries', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    const homeBefore = await fs.readFile(settingsPath(), 'utf8').catch(() => null);

    const result = await runRouterInstall({ refresh: true }, ctx(), deps({ cwd }));
    expect(onlyInstall(result)).toMatchObject({
      refresh: true,
      scope: 'project',
      settingsPath: join(cwd, '.claude', 'settings.json'),
    });
    // And the home file is untouched, since nothing of ours was there.
    expect(await fs.readFile(settingsPath(), 'utf8').catch(() => null)).toBe(homeBefore);
  });

  it('takes the home install from a directory with nothing of ours in it', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'elsewhere');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({}, ctx(), deps());
    const result = await runRouterInstall({ refresh: true }, ctx(), deps({ cwd }));
    expect(onlyInstall(result)).toMatchObject({ refresh: true, scope: 'user' });
  });

  it('refuses when there is nothing of ours in either place', async () => {
    const cwd = join(home, 'empty');
    const fs = await import('node:fs/promises');
    await fs.mkdir(cwd, { recursive: true });
    await expect(runRouterInstall({ refresh: true }, ctx(), deps({ cwd }))).rejects.toMatchObject({
      code: 'REFUSED',
    });
  });

  it('refuses a refresh over an unparsable settings file instead of calling it unwired', async () => {
    const fs = await import('node:fs/promises');
    await runRouterInstall({}, ctx(), deps());
    await fs.writeFile(settingsPath(), '{ not json');
    const err = await runRouterInstall({ refresh: true, project: false }, ctx(), deps()).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).code).toBe('CONFIG_INVALID');
    expect((err as CliError).message).toContain(settingsPath());
  });
});

/**
 * `claude mcp add` is NOT idempotent: Claude Code 2.1.280 exits 1 on a second
 * identical add ("MCP server x402 already exists in .mcp.json"). The mock below
 * reproduces that, so a run that re-adds blindly fails the test the way the
 * real CLI fails the machine.
 */
describe('the MCP registration is reconciled, not re-added', () => {
  /** An `add` that behaves like the real one: it refuses an existing entry. */
  function addOnce(existing: { present: boolean }) {
    return vi.fn(async () => {
      if (existing.present) {
        throw new Error(`MCP server x402 already exists in .mcp.json`);
      }
      existing.present = true;
    });
  }

  async function writeMcpJson(cwd: string, entry: unknown): Promise<void> {
    const fs = await import('node:fs/promises');
    await fs.writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { x402: entry } }));
  }

  it('spawns nothing when the scope already registers `tenjin mcp`', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    await writeMcpJson(cwd, { command: 'tenjin', args: ['mcp'] });

    const registerMcp = addOnce({ present: true });
    const result = await runRouterInstall({ refresh: true }, ctx(), deps({ cwd, registerMcp }));
    expect(registerMcp).not.toHaveBeenCalled();
    expect(onlyInstall(result).mcp).toMatchObject({
      registered: true,
      reconciled: 'already-registered',
    });
    expect(result.humanLines?.join('\n')).not.toContain('claude mcp add');
  });

  /**
   * A REGISTRATION THIS COMMAND DID NOT WRITE IS NOT ITS TO DELETE. An `x402`
   * entry pointing at another binary may be a tool of the user's that happens
   * to share the name, and an installer that removes it to make room has
   * destroyed configuration nobody asked it to touch. It refuses, names the
   * conflict, and prints the two commands that resolve it.
   */
  it('refuses a same-name entry that launches something else, and removes nothing', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    await writeMcpJson(cwd, { command: 'node', args: ['stale.js'] });

    const registerMcp = addOnce({ present: true });
    const result = await runRouterInstall({ project: true }, ctx(), deps({ cwd, registerMcp }));
    expect(registerMcp).not.toHaveBeenCalled();
    const mcp = (result.data as { mcp: Record<string, unknown> }).mcp;
    expect(mcp).toMatchObject({ registered: false, reconciled: 'unrepaired' });
    expect(String(mcp.reason)).toContain('will not remove a registration it did not write');
    // Both commands, in the order they have to be run.
    expect(String(mcp.command)).toContain('claude mcp remove x402 -s project');
    expect(String(mcp.command)).toContain('claude mcp add x402 -s project -- tenjin mcp');
    // And the entry is exactly as it was.
    const after = JSON.parse(await fs.readFile(join(cwd, '.mcp.json'), 'utf8')) as {
      mcpServers: { x402: unknown };
    };
    expect(after.mcpServers.x402).toEqual({ command: 'node', args: ['stale.js'] });
  });

  it('repairs nothing and fails the refresh while that entry stands', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    await writeMcpJson(cwd, { command: 'node', args: ['stale.js'] });

    const registerMcp = addOnce({ present: true });
    const err = await runRouterInstall({ refresh: true }, ctx(), deps({ cwd, registerMcp })).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).code).toBe('REFUSED');
    expect((err as CliError).message).toContain('could not repair');
    expect(registerMcp).not.toHaveBeenCalled();
  });

  it('adds when the scope has no entry at all', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    const registerMcp = addOnce({ present: false });
    const result = await runRouterInstall({ project: true }, ctx(), deps({ cwd, registerMcp }));
    expect(registerMcp).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ mcp: { registered: true, reconciled: 'added' } });
  });

  it('refuses to write over a registration file it cannot parse', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(join(cwd, '.mcp.json'), '{ not json');
    const registerMcp = vi.fn(async () => undefined);
    const result = await runRouterInstall({ project: true }, ctx(), deps({ cwd, registerMcp }));
    expect(registerMcp).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      mcp: { registered: false, reconciled: 'unrepaired' },
    });
  });

  /**
   * A READ ERROR IS NOT AN ABSENCE. Only ENOENT is. A registration file that
   * exists and cannot be read says nothing about what is registered in it, and
   * calling that "missing" sent the refresh on to `claude mcp add` over a file
   * it had never read: the failed add then looked like a machine that merely
   * lacks the tooling, and `tenjin update` exited 0 over whatever was in there.
   *
   * The fixture is a DIRECTORY at the file's path (EISDIR), because that is a
   * real filesystem error on every machine, including one running as root where
   * a `chmod 000` file stays readable.
   */
  it('treats a registration file it cannot read as unreadable rather than missing', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(join(cwd, '.mcp.json'), { recursive: true });
    const registerMcp = vi.fn(async () => undefined);
    const result = await runRouterInstall({ project: true }, ctx(), deps({ cwd, registerMcp }));
    expect(registerMcp).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ mcp: { registered: false, reconciled: 'unrepaired' } });
  });

  it('fails the refresh, rather than claiming convergence, over an unreadable registration', async () => {
    const fs = await import('node:fs/promises');
    const cwd = join(home, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    await fs.mkdir(join(cwd, '.mcp.json'), { recursive: true });

    const registerMcp = vi.fn(async () => undefined);
    const err = await runRouterInstall({ refresh: true }, ctx(), deps({ cwd, registerMcp })).catch(
      (e: unknown) => e,
    );
    expect((err as CliError).code).toBe('REFUSED');
    expect((err as CliError).message).toContain('could not repair');
    expect(registerMcp).not.toHaveBeenCalled();
  });
});

describe('the live status line', () => {
  it('is registered by a fresh install, with a one-second refresh', async () => {
    const result = await runRouterInstall({}, ctx(), deps());

    expect((await readSettings()).statusLine).toEqual({
      type: 'command',
      command: STATUS_LINE_COMMAND,
      refreshInterval: 1,
    });
    expect((result.humanLines ?? []).join('\n')).toContain('status line');
  });

  it('leaves a status line the user already set, and prints the composition', async () => {
    const mine = { type: 'command', command: 'starship prompt' };
    await writeFile(settingsPath(), JSON.stringify({ statusLine: mine }, null, 2));

    const result = await runRouterInstall({}, ctx(), deps());

    expect((await readSettings()).statusLine).toEqual(mine);
    const printed = (result.humanLines ?? []).join('\n');
    expect(printed).toContain('left exactly as it is');
    expect(printed).toContain('starship prompt');
    expect(printed).toContain(STATUS_LINE_COMMAND);
  });

  it('is added by --status-line compose, wrapping what was there', async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({ statusLine: { type: 'command', command: 'starship prompt' } }, null, 2),
    );

    await runRouterInstall({ statusLine: 'compose' }, ctx(), deps());

    const written = (await readSettings()).statusLine as { command: string };
    expect(written.command).toContain('starship prompt');
    expect(written.command).toContain(STATUS_LINE_COMMAND);
  });

  it('is not added by a refresh on a machine that never had one', async () => {
    await runRouterInstall({}, ctx(), deps());
    const settings = await readSettings();
    delete settings.statusLine;
    await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);

    await runRouterInstall({ refresh: true }, ctx(), deps());

    expect((await readSettings()).statusLine).toBeUndefined();
  });

  it('is removed by uninstall, with the rest of the file intact', async () => {
    await runRouterInstall({}, ctx(), deps());

    await runRouterUninstall({}, ctx(), { homeDir: home, env: {}, which: () => false });

    const settings = await readSettings();
    expect(settings.statusLine).toBeUndefined();
    expect(settings.hooks).toEqual({});
  });
});

describe('payment configuration and obsolete skill cutover', () => {
  it.each(['0', 'none', '1200000'])(
    'preserves explicit daily limit %s and all related opt-outs across install and refresh',
    async (sessionBudget) => {
      const config = {
        sessionBudget,
        maxAutoSpend: '0',
        router: { enabled: false },
        bazaarRegistries: ['https://custom.test'],
      };
      await writeFile(join(data, 'config.json'), JSON.stringify(config));
      await runRouterInstall({}, ctx(), deps());
      await runRouterInstall({ refresh: true }, ctx(), deps());
      expect(await loadRawConfig(data)).toMatchObject(config);
    },
  );
  it.each([false, true, null])(
    'cleans retired values %s on install and refresh, with reports',
    async (value) => {
      const current = {
        sessionBudget: '0',
        maxAutoSpend: '0',
        router: { enabled: false },
        future: { kept: true },
      };
      const legacy = { ...current, bazaarPay: value, confirm: value };
      await writeFile(join(data, 'config.json'), JSON.stringify(legacy));
      const result = await runRouterInstall({}, ctx(), deps());
      expect(await loadRawConfig(data)).toMatchObject(current);
      expect(await loadRawConfig(data)).not.toHaveProperty('confirm');
      expect(await loadRawConfig(data)).not.toHaveProperty('bazaarPay');
      expect(result.data).toMatchObject({ spend: { removed: ['bazaarPay', 'confirm'] } });
      expect(result.humanLines?.join('\n')).toContain(
        'Removed retired settings: bazaarPay, confirm',
      );
      await writeFile(join(data, 'config.json'), JSON.stringify(legacy));
      const refresh = await runRouterInstall({ refresh: true }, ctx(), deps());
      expect(refresh.data).toMatchObject({ spend: { removed: ['bazaarPay', 'confirm'], set: [] } });
      expect(await loadRawConfig(data)).toEqual(current);
      const again = await runRouterInstall({ refresh: true }, ctx(), deps());
      expect(again.data).toMatchObject({ spend: { removed: [] } });
    },
  );
  it('refresh removes the owned old payment skill while preserving user files', async () => {
    await runRouterInstall({}, ctx(), deps());
    const path = join(home, '.claude', 'skills', 'tenjin-pay');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'SKILL.md'), '---\nname: tenjin-pay\n---\nold');
    await writeFile(join(path, 'notes.md'), 'mine');
    const result = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect(result.data).toMatchObject({ removedSkills: [path] });
    await expect(readFile(join(path, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(path, 'notes.md'), 'utf8')).toBe('mine');
  });
});

describe('daily limit readouts', () => {
  it.each(['0', 'none', '2000000'])(
    'status distinguishes %s and labels the automatic threshold honestly',
    async (sessionBudget) => {
      await writeFile(join(data, 'config.json'), JSON.stringify({ sessionBudget }));
      const { runRouterStatus } = await import('./status');
      const result = await runRouterStatus(ctx());
      expect(result.data).toMatchObject({
        window: { budget: sessionBudget === 'none' ? null : { atomic: sessionBudget } },
      });
      expect(result.humanLines?.join('\n')).toContain('automatic router up to');
      expect(result.humanLines?.join('\n')).not.toContain('per call at most');
    },
  );
});

it('status warns about ignored retired keys and reports automatic exposure separately', async () => {
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({ bazaarPay: false, confirm: 'always' }),
  );
  await writeFile(
    join(data, 'spend.json'),
    JSON.stringify({
      schemaVersion: 2,
      windowStartMs: Date.now(),
      committedAtomic: '9000000',
      automaticCommittedAtomic: '100000',
      reservations: [{ id: 'm', amountAtomic: '500000', mode: 'manual', atMs: Date.now() }],
    }),
  );
  const { runRouterStatus } = await import('./status');
  const result = await runRouterStatus(ctx());
  expect(result.data).toMatchObject({
    warnings: [expect.stringContaining('bazaarPay, confirm')],
    window: {
      committed: { atomic: '9000000' },
      automaticExposure: { atomic: '100000' },
      budget: { atomic: '5000000' },
    },
  });
  expect(result.humanLines?.join('\n')).toContain('manual pay always requires consent');
});
