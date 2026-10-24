import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import { loadStep, NEW_SESSION_STEP, RELOAD_STEP, runRouterInstall } from './install';
import { NEW_SESSION_FIX, RECONNECT_FIX } from './mcp-processes';
import { ASK_FOR_REPAIR, REPAIR_CLAUSE, WALLET_REASONS } from './wallet-reasons';
import type { CommandContext } from '../context';

/**
 * `tenjin install`'s own decisions: the wallet, the spend question and its
 * answers, the readout, and the router probe. How the plugin is registered is
 * `plugin-install.test.ts`, through a fake `claude`; here no binary is found,
 * so the plugin goes to its folder under `~/.claude/skills/`.
 */

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

const settingsPath = () => join(home, '.claude', 'settings.json');
const folder = () => join(home, '.claude', 'skills', 'tenjin-router');

const ADDRESS = '0x3c0D84055994c3062819Ce8730869D0aDeA4c3Bf';

/** The routing fee's terms, as the selector shows them. */
const FEE_TERMS =
  'Routing costs $0.003 a call, paid from channel deposits of up to $0.25 that stay yours until spent; each deposit counts against these limits.';
/** What a run that could not ask prints for the agent that ran it. */
const QUESTION = `Use the defaults ($5 a day, $0.25 a call) or set your own limits. ${FEE_TERMS} Either answer also approves the routing fee.`;
const ASK_LINES = [
  '  Automatic router: up to $0.25 per call; daily limit $5 a day',
  `  Ask the person in this session: ${QUESTION}`,
  '  Use the defaults (recommended): tenjin install --yes',
  '  Set my own limits: tenjin install --max-auto-spend <usd> --session-budget <usd|none>',
];
/** What Claude Code exports to the commands its agent runs. */
const HARNESS_ENV = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-1' };
const RELOAD =
  'run `/reload-plugins` in this conversation so Tenjin loads, then continue your task';

/** Wallet seams are always stubbed: the real create writes to the OS keychain. */
function deps(over: Record<string, unknown> = {}) {
  return {
    homeDir: home,
    env: {},
    findClaude: () => null,
    walletExists: async () => false,
    createWallet: vi.fn(async () => ADDRESS),
    walletAddress: async () => ADDRESS,
    // A wallet the keychain unlocks, unless a test says otherwise.
    walletSigning: async () => ({
      signing: { status: 'ready' as const, source: 'keychain' as const },
    }),
    observedSigning: async () => false,
    listMcpProcesses: async () => [],
    walletBalance: async () => 0n,
    ...over,
  };
}

/** The spend question install handed over, from `nextSteps`, its only place. */
type SpendStep = { question: string; options: { command: string }[]; next: string };
function spendStepOf(result: { data: unknown }): SpendStep | undefined {
  const steps = (result.data as { nextSteps?: (SpendStep & { id: string })[] }).nextSteps;
  return steps?.find((q) => q.id === 'spend');
}

/** The doctor's checks, from a pass or from the refusal that carries them. */
async function doctorChecks(over: Record<string, unknown> = {}): Promise<{
  out: unknown;
  checks: { name: string; status: string; required: boolean; detail: string; fix?: string }[];
}> {
  const { runRouterDoctor } = await import('./doctor');
  const out = await runRouterDoctor(ctx(), {
    homeDir: home,
    cwd: work,
    env: {},
    findClaude: () => null,
    fetchImpl: probe400,
    listMcpProcesses: async () => [],
    ...over,
  }).catch((e: unknown) => e);
  type Check = { name: string; status: string; required: boolean; detail: string; fix?: string };
  const checks =
    out instanceof CliError
      ? (out.details as { checks: Check[] }).checks
      : (out as { data: { checks: Check[] } }).data.checks;
  return { out, checks };
}

describe('tenjin install', () => {
  it('with nobody to answer, writes no limit and the $0.25 and $5 defaults hold', async () => {
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
        effective: { maxAutoSpend: '0.25', sessionBudget: '5' },
      },
      nextSteps: [
        {
          id: 'spend',
          question: QUESTION,
          options: [
            {
              id: 'default',
              label: 'Use the defaults',
              recommended: true,
              command: 'tenjin install --yes',
            },
            {
              id: 'custom',
              label: 'Set my own limits',
              recommended: false,
              ask: [
                'The most Tenjin may pay in a day, in USD, or none for no daily limit',
                'The most it may pay for one call, in USD, at least 0.25',
              ],
              command: 'tenjin install --max-auto-spend <usd> --session-budget <usd|none>',
            },
          ],
        },
      ],
    });
    // nextSteps is the only place the question appears.
    expect(result.data).not.toHaveProperty('spend.approval');
    const approval = spendStepOf(result)!;
    expect(approval.options).toHaveLength(2);
    expect(approval.next).toMatch(
      /^In this session, ask the person this question with your question tool, offering these two options/,
    );
    expect(approval.next).toContain('The defaults are already in effect.');
    expect(approval.next).toContain('Use the defaults: run `tenjin install --yes`.');
    expect(approval.next).toContain(
      'then run `tenjin install --max-auto-spend <usd> --session-budget <usd|none>` with their amounts',
    );
    expect(approval.next).toContain('never joined with another command');
    expect(approval.next).toContain('never ask them to run a command');
    expect(approval.next).not.toMatch(/terminal|config set|wallet fund|no automatic/i);
    // Outside an agent harness the spend question is the only step handed over.
    expect((result.data as { nextSteps: { id: string }[] }).nextSteps.map((q) => q.id)).toEqual([
      'spend',
    ]);
  });

  it.each([{ sessionBudget: 'none' }, { maxAutoSpend: '2000000' }])(
    'asks nothing again of a file that already names a limit: %j',
    async (file) => {
      await writeFile(join(data, 'config.json'), JSON.stringify(file));
      const result = await runRouterInstall({}, ctx(), deps());
      expect(spendStepOf(result)).toBeUndefined();
      expect(await loadRawConfig(data)).toEqual(file);
    },
  );

  it('keeps a per-call limit an earlier release left below $0.25, and asks nothing', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ maxAutoSpend: '100000' }));
    const result = await runRouterInstall({}, ctx(), deps());
    expect(spendStepOf(result)).toBeUndefined();
    expect(result.humanLines).toContain(
      '  Automatic router: up to $0.1 per call; daily limit $5 a day',
    );
    expect(await loadRawConfig(data)).toEqual({ maxAutoSpend: '100000' });
  });

  it('still succeeds, with a warning, when TENJIN_BASE_URL is not a URL', async () => {
    vi.stubEnv('TENJIN_BASE_URL', 'tenjin.blog');
    try {
      const result = await runRouterInstall({}, ctx(), deps());
      expect(result.data).toMatchObject({
        router: { status: 'warn', detail: 'the base URL "tenjin.blog" is not a URL' },
        plugin: { state: 'written' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('doctor reaches the router check and its fix when TENJIN_BASE_URL is not a URL', async () => {
    await runRouterInstall({}, ctx(), deps());
    vi.stubEnv('TENJIN_BASE_URL', 'tenjin.blog');
    try {
      const { out, checks } = await doctorChecks();
      expect(out).toBeInstanceOf(CliError);
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

  it('turns the pay lane on and auto-approves at or below the per-call cap by default', async () => {
    await runRouterInstall({}, ctx(), deps());
    const config = await loadRawConfig(data);
    expect(config.confirm).toBeUndefined();
    expect(config.bazaarPay).toBeUndefined();
  });

  it('writes nothing into the settings file itself', async () => {
    await runRouterInstall({}, ctx(), deps());
    await expect(readFile(settingsPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prints a short summary: set up, the new wallet, the limits, the next step', async () => {
    const result = await runRouterInstall({}, ctx(), deps());
    expect(result.humanLines).toEqual([
      '✓ Tenjin is set up for Claude Code (plugin tenjin@skills-dir)',
      `✓ Wallet created: ${ADDRESS}`,
      ...ASK_LINES,
      `  Plugin tenjin@skills-dir written to ${folder()} (no claude binary on PATH or in CLAUDE_CODE_EXECPATH)`,
      '',
      `Next: fund the wallet with \`tenjin wallet fund 5\`, then ${RELOAD}`,
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
  });

  it('names running servers that predate this install, with the in-session fix, and stops none', async () => {
    const listMcpProcesses = vi.fn(async () => [{ pid: 9044, startedAt: 1 }]);
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({ listMcpProcesses, installedAt: async () => 2 }),
    );
    expect(result.data).toMatchObject({ mcpServer: { name: 'mcp server', status: 'warn' } });
    expect(result.humanLines!.join('\n')).toContain('started before this install');
    expect(result.humanLines!.join('\n')).toContain(RECONNECT_FIX);
    // The refresh `tenjin update` runs says it too.
    const refreshed = await runRouterInstall(
      { refresh: true },
      ctx(),
      deps({ listMcpProcesses, installedAt: async () => 2 }),
    );
    expect(refreshed.humanLines!.join('\n')).toContain(RECONNECT_FIX);
  });

  it('keeps the conversation for a fresh install and requires a new session for a settings upgrade', () => {
    expect(loadStep(false)).toBe(RELOAD_STEP);
    expect(loadStep(false)).toContain('/reload-plugins');
    expect(loadStep(true)).toBe(NEW_SESSION_STEP);
    for (const text of [NEW_SESSION_STEP, RECONNECT_FIX, NEW_SESSION_FIX]) {
      expect(text).not.toContain('/reload-plugins');
    }
  });

  it('a refresh brings the plugin up to this build and changes no config', async () => {
    await runRouterInstall({}, ctx(), deps());
    await writeFile(join(data, 'config.json'), JSON.stringify({ maxAutoSpend: '1' }));
    const result = await runRouterInstall({ refresh: true }, ctx(), deps());
    expect(result.data).toMatchObject({ refresh: true, plugin: { state: 'written' } });
    expect((await loadRawConfig(data)).maxAutoSpend).toBe('1');
    expect(result.humanLines![0]).toBe('✓ Tenjin is up to date (plugin tenjin@skills-dir)');
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
    expect(result.humanLines!.at(-1)).toBe(`Next: ${RELOAD}`);
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

  it('writes the plugin folder into the project with --project', async () => {
    const cwd = join(home, 'project');
    await mkdir(cwd, { recursive: true });
    const result = await runRouterInstall({ project: true }, ctx(), deps({ cwd }));
    expect(result.data).toMatchObject({
      plugin: { scope: 'local', path: join(cwd, '.claude', 'skills', 'tenjin-router') },
    });
    await expect(readFile(settingsPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws nothing an operator cannot act on when HOME is relative', async () => {
    const err = await runRouterInstall({}, ctx(), deps({ homeDir: 'relative' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).fix).toContain('HOME');
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

const SELECTOR = `Use the defaults ($5 a day, $0.25 a call) or set your own limits.\n${FEE_TERMS}\nEither answer also approves the routing fee.`;

describe('install asks a person the spend question once', () => {
  it('"Use the defaults" names the routing fee and writes $0.25 a call and $5 a day', async () => {
    const promptLimits = vi.fn(async () => 'approve' as const);
    const promptAmount = amounts([]);
    const result = await runRouterInstall(
      {},
      humanCtx(),
      deps({ isInteractive: true, promptLimits, promptAmount }),
    );
    expect(promptLimits).toHaveBeenCalledWith(SELECTOR);
    expect(promptAmount).not.toHaveBeenCalled();
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '250000',
      sessionBudget: '5000000',
    });
    expect(result.humanLines).toContain(
      '  Automatic router: up to $0.25 per call; daily limit $5 a day',
    );
  });

  it('"Set my own limits" asks the daily amount, then the per-call one, and writes both', async () => {
    const promptAmount = amounts(['2', '0.5']);
    const result = await runRouterInstall(
      {},
      humanCtx(),
      deps({ isInteractive: true, promptLimits: async () => 'own' as const, promptAmount }),
    );
    expect(promptAmount.mock.calls.map(([message]) => message)).toEqual([
      'Most it may pay in a day, in USD, or none',
      'Most it may pay for one call, in USD, at least 0.25',
    ]);
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '500000',
      sessionBudget: '2000000',
    });
    expect(result.humanLines).toContain(
      '  Automatic router: up to $0.5 per call; daily limit $2 a day',
    );
  });

  it('takes none for the daily limit', async () => {
    await runRouterInstall(
      {},
      humanCtx(),
      deps({
        isInteractive: true,
        promptLimits: async () => 'own' as const,
        promptAmount: amounts(['none', '0.25']),
      }),
    );
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '250000',
      sessionBudget: 'none',
    });
  });

  it('refuses zero, a negative amount and a per-call limit under $0.25, and asks again', async () => {
    const promptAmount = amounts(['0', '-1', '3', '0.1', '0', '0.3']);
    await runRouterInstall(
      {},
      humanCtx(),
      deps({ isInteractive: true, promptLimits: async () => 'own' as const, promptAmount }),
    );
    const messages = promptAmount.mock.calls.map(([message]) => message);
    expect(messages).toHaveLength(6);
    expect(messages[1]).toMatch(
      /^The limit must be more than zero; `tenjin config set router\.enabled false` turns the router off\. /,
    );
    expect(messages[2]).toMatch(/^Invalid USD amount: "-1"\. /);
    expect(messages[4]).toMatch(/^The per-call limit is at least \$0\.25\. /);
    expect(messages[5]).toMatch(/^The per-call limit is at least \$0\.25\. /);
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '300000',
      sessionBudget: '3000000',
    });
  });

  it.each([
    ['at the selector', async () => null, amounts([])],
    ['at the amount', async () => 'own' as const, amounts([null])],
  ])('a cancel %s writes nothing and exits non-zero', async (_at, promptLimits, promptAmount) => {
    const createWallet = vi.fn(async () => ADDRESS);
    const err = await runRouterInstall(
      {},
      humanCtx(),
      deps({ isInteractive: true, promptLimits, promptAmount, createWallet }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).not.toBe(0);
    await expect(readFile(join(data, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(settingsPath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(createWallet).not.toHaveBeenCalled();
  });

  it.each([
    { maxAutoSpend: '2000000', sessionBudget: 'none' },
    { sessionBudget: 'none' },
    { maxAutoSpend: '2000000' },
  ])('does not ask when the file already names a limit: %j', async (file) => {
    await writeFile(join(data, 'config.json'), JSON.stringify(file));
    const promptLimits = vi.fn(async () => 'approve' as const);
    await runRouterInstall({}, humanCtx(), deps({ isInteractive: true, promptLimits }));
    expect(promptLimits).not.toHaveBeenCalled();
    expect(await loadRawConfig(data)).toEqual(file);
  });

  it.each([
    ['a non-interactive run', () => humanCtx(), false],
    ['--json', () => ctx(), true],
  ])(
    '%s asks nothing, writes no limit, and the defaults hold',
    async (_name, makeCtx, isInteractive) => {
      const promptLimits = vi.fn(async () => 'own' as const);
      const result = await runRouterInstall({}, makeCtx(), deps({ isInteractive, promptLimits }));
      expect(promptLimits).not.toHaveBeenCalled();
      const config = await loadRawConfig(data);
      expect(config).not.toHaveProperty('maxAutoSpend');
      expect(config).not.toHaveProperty('sessionBudget');
      expect(result.data).toMatchObject({
        spend: { set: [], kept: [], effective: { maxAutoSpend: '0.25', sessionBudget: '5' } },
      });
      // An agent's shell has no terminal: the question goes to the agent instead.
      expect(result.humanLines).toEqual(expect.arrayContaining(ASK_LINES));
      expect(result.data).toMatchObject({ plugin: { state: 'written' } });
    },
  );

  it('--yes writes the defaults, as "Use the defaults" does, and keeps a limit the file names', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ sessionBudget: 'none' }));
    const promptLimits = vi.fn(async () => 'own' as const);
    const result = await runRouterInstall(
      { yes: true },
      ctx(),
      deps({ isInteractive: false, promptLimits }),
    );
    expect(promptLimits).not.toHaveBeenCalled();
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '250000',
      sessionBudget: 'none',
    });
    expect(spendStepOf(result)).toBeUndefined();
  });

  it('hands the agent its own command with --yes, and that run keeps every install choice', async () => {
    // The agent-run install was told to make no wallet.
    const createWallet = vi.fn(async () => ADDRESS);
    const first = await runRouterInstall({ noWallet: true }, ctx(), deps({ createWallet }));
    expect(spendStepOf(first)?.options[0]?.command).toBe('tenjin install --no-wallet --yes');
    const manifest = join(folder(), '.claude-plugin', 'plugin.json');
    const before = await readFile(manifest, 'utf8');
    const result = await runRouterInstall(
      { noWallet: true, yes: true },
      ctx(),
      deps({ createWallet }),
    );
    expect(createWallet).not.toHaveBeenCalled();
    expect(await readFile(manifest, 'utf8')).toBe(before);
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '250000',
      sessionBudget: '5000000',
    });
    expect(result.data).toMatchObject({ spend: { set: ['maxAutoSpend', 'sessionBudget'] } });
    expect(spendStepOf(result)).toBeUndefined();
  });

  it('--yes keeps a 0 the file names', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ maxAutoSpend: '0' }));
    await runRouterInstall({ yes: true }, ctx(), deps());
    expect(await loadRawConfig(data)).toMatchObject({ maxAutoSpend: '0' });
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
      findClaude: () => null,
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
      'reader is offered no paid lookups: add mcp__plugin_tenjin_router__request to tools: to allow paid lookups there',
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
      findClaude: () => null,
      fetchImpl,
    }).catch((e: unknown) => e);
    const data_ =
      result instanceof CliError
        ? (result.details as { checks: { name: string; fix?: string }[] })
        : (result as { data: { checks: { name: string; fix?: string }[] } }).data;
    const names = data_.checks.map((c) => c.name);
    expect(names).toEqual([
      'node',
      'claude code',
      'plugin',
      'routing',
      'mcp server',
      'spend',
      'experimental',
      'routing fee',
      'wallet',
      'claude session',
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
      'an agent-run install nobody answered: the $0.25 and $5 defaults',
      undefined,
      {
        status: 'ok',
        required: false,
        detail: 'automatic approval up to 0.25 USD a call, 5 USD a day',
      },
    ],
    [
      'a 0 an earlier release let the user set',
      '0',
      {
        status: 'fail',
        required: true,
        detail: 'maxAutoSpend is 0, so every lookup needs approval and none can pay',
      },
    ],
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
      findClaude: () => null,
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
      expect(spend?.fix).toBeUndefined();
      expect(JSON.stringify(checks)).not.toMatch(/not answered|spend question/);
    } else {
      // Install keeps a limit it finds and never asks, so only `config set` changes it.
      expect(spend?.fix).toBe('Raise it with `tenjin config set maxAutoSpend 0.25`.');
    }
    if (maxAutoSpend === '0') expect((out as CliError).message).toContain('maxAutoSpend is 0');
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
        findClaude: () => null,
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
      findClaude: () => null,
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
      findClaude: () => null,
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
      findClaude: () => null,
      fetchImpl: probe400,
    }).catch((e: unknown) => e);
    const checks =
      result instanceof CliError
        ? (result.details as { checks: { name: string; status: string; detail: string }[] })
        : (result as { data: { checks: { name: string; status: string; detail: string }[] } }).data;
    return checks.checks.find((c) => c.name === 'routing')!;
  }

  it('warns, naming the file, when the router is off here', async () => {
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
    const fresh = await runRouterStatus(ctx(), { wallet: async () => null });
    expect((fresh.data as { inFlight: unknown[] }).inFlight).toHaveLength(1);

    // Eleven minutes on, that reservation is past its TTL and an authorization
    // would not count it; the readout must not either.
    const later = Date.now() + 11 * 60 * 1000;
    const aged = await runRouterStatus(ctx(), { wallet: async () => null, now: () => later });
    expect((aged.data as { inFlight: unknown[] }).inFlight).toHaveLength(0);

    // A day on, the whole window has rolled over.
    const nextDay = Date.now() + 25 * 60 * 60 * 1000;
    const rolled = await runRouterStatus(ctx(), { wallet: async () => null, now: () => nextDay });
    expect(
      (rolled.data as { window: { committed: { atomic: string } } }).window.committed.atomic,
    ).toBe('0');
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
      const result = await runRouterStatus(ctx(), { wallet: async () => null });
      expect(result.data).toMatchObject({
        window: { budget: sessionBudget === 'none' ? null : { atomic: sessionBudget } },
      });
      expect(result.humanLines?.join('\n')).toContain('automatic router up to');
      expect(result.humanLines?.join('\n')).not.toContain('per call at most');
    },
  );
});

it('status shows the routing deposit as prepaid credit, apart from lookups, and counts both', async () => {
  const now = Date.now();
  await writeFile(
    join(data, 'spend.json'),
    JSON.stringify({
      schemaVersion: 2,
      windowStartMs: now,
      committedAtomic: '300000',
      automaticCommittedAtomic: '300000',
      reservations: [],
      exposures: [
        { nonce: 'routing-deposit:r1', amountAtomic: '250000', atMs: now, mode: 'automatic' },
        { nonce: `0x${'1'.repeat(64)}`, amountAtomic: '50000', atMs: now, mode: 'automatic' },
      ],
    }),
  );
  const { runRouterStatus } = await import('./status');
  const result = await runRouterStatus(ctx(), {
    wallet: async () => null,
    routingCredit: async () => 240_000n,
  });
  expect(result.data).toMatchObject({
    window: {
      committed: { atomic: '300000' },
      lookups: { atomic: '50000' },
      routingDeposits: { atomic: '250000' },
      automaticExposure: { atomic: '300000' },
    },
    routingCredit: { remaining: { atomic: '240000' }, calls: 80 },
  });
  expect(result.humanLines?.slice(0, 2)).toEqual([
    'lookups 0.05 USD · routing credit 0.25 USD prepaid, 0.24 USD left (~80 calls)',
    'counted toward the daily limit: 0.3 USD of 5 USD in the rolling 24h window',
  ]);
});

it('status shows no routing credit before any deposit', async () => {
  const { runRouterStatus } = await import('./status');
  const result = await runRouterStatus(ctx(), {
    wallet: async () => null,
    routingCredit: async () => 0n,
  });
  expect(result.humanLines?.[0]).toBe('lookups 0 USD');
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
  const result = await runRouterStatus(ctx(), { wallet: async () => null });
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

describe('install applies the spend answer an agent relays, in one command', () => {
  it('--max-auto-spend and --session-budget write the amounts named, as "Set my own limits" does', async () => {
    const promptLimits = vi.fn(async () => 'approve' as const);
    const result = await runRouterInstall(
      { maxAutoSpend: '0.40', sessionBudget: '2' },
      ctx(),
      deps({ isInteractive: false, promptLimits }),
    );
    expect(promptLimits).not.toHaveBeenCalled();
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '400000',
      sessionBudget: '2000000',
    });
    expect(spendStepOf(result)).toBeUndefined();
  });

  it('takes none for the daily limit, and the default for a limit left out', async () => {
    await runRouterInstall({ sessionBudget: 'none' }, ctx(), deps());
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '250000',
      sessionBudget: 'none',
    });
  });

  it('replaces a limit the file already names with the one named', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ sessionBudget: 'none' }));
    const result = await runRouterInstall({ maxAutoSpend: '1', sessionBudget: '3' }, ctx(), deps());
    expect(await loadRawConfig(data)).toMatchObject({
      maxAutoSpend: '1000000',
      sessionBudget: '3000000',
    });
    expect(result.data).toMatchObject({
      spend: { set: ['maxAutoSpend', 'sessionBudget'], kept: [] },
    });
  });

  it.each([
    [{ maxAutoSpend: '0' }, 'The per-call limit is at least $0.25.'],
    [{ maxAutoSpend: '0.24' }, 'The per-call limit is at least $0.25.'],
    [{ maxAutoSpend: 'none' }, 'Invalid USD amount'],
    [{ sessionBudget: '0' }, 'The limit must be more than zero'],
    [{ sessionBudget: '-1' }, 'Invalid USD amount'],
  ])('refuses %o before writing anything', async (args, message) => {
    const err = await runRouterInstall(args, ctx(), deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('USAGE');
    expect((err as CliError).message).toContain(message);
    await expect(readFile(join(data, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('says why the per-call limit is at least $0.25', async () => {
    const err = (await runRouterInstall({ maxAutoSpend: '0.1' }, ctx(), deps()).catch(
      (e: unknown) => e,
    )) as CliError;
    expect(err.message).toBe('--max-auto-spend 0.1: The per-call limit is at least $0.25.');
    expect(err.fix).toBe(
      'Give 0.25 USD or more, for example `--max-auto-spend 0.5`. The $0.25 minimum is the routing deposit: below it, routing cannot pay at all. To stop automatic payments, turn the router off with `tenjin config set router.enabled false`.',
    );
  });

  it('refuses a named limit on --refresh, which writes none', async () => {
    const err = await runRouterInstall(
      { refresh: true, maxAutoSpend: '0.25' },
      ctx(),
      deps(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe(
      '--max-auto-spend sets a spend limit, and --refresh writes none.',
    );
  });

  it('keeps --project and --no-wallet in the commands it hands over', async () => {
    const cwd = join(home, 'project');
    await mkdir(cwd, { recursive: true });
    const result = await runRouterInstall({ project: true, noWallet: true }, ctx(), deps({ cwd }));
    expect(spendStepOf(result)?.options.map((o) => o.command)).toEqual([
      'tenjin install --project --no-wallet --yes',
      'tenjin install --project --no-wallet --max-auto-spend <usd> --session-budget <usd|none>',
    ]);
  });
});

describe('install run by an agent asks each question where its answer is needed', () => {
  type Step = {
    id: string;
    question: string;
    options: { id: string; label: string; command: string | null }[];
    next: string;
    address?: string;
    show?: string;
  };
  const stepsOf = (result: { data: unknown }) => (result.data as { nextSteps: Step[] }).nextSteps;

  it('asks only the spend question first, with no funding question', async () => {
    const result = await runRouterInstall({}, ctx(), deps({ env: HARNESS_ENV }));
    expect(stepsOf(result).map((q) => q.id)).toEqual(['spend']);
    expect(stepsOf(result)[0]).toMatchObject({ question: QUESTION });
    expect(result.humanLines).toEqual(expect.arrayContaining(ASK_LINES));
    expect(result.humanLines).not.toContain('  Ask the person: Add $5 to Tenjin now?');
    const { next } = result.data as { next: string };
    expect(next).toBe(
      `ask the person the question in nextSteps, then run what the answer names, then ${RELOAD}`,
    );
    expect(next).not.toContain('wallet fund');
  });

  it('the completed install asks the funding question, with the address and the command for each answer', async () => {
    // No link is minted: nothing reaches the fund route, and no wallet unlock is needed.
    const routes: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      routes.push(String(input));
      return new Response('{}', { status: 503 });
    });
    let result: Awaited<ReturnType<typeof runRouterInstall>>;
    try {
      result = await runRouterInstall({ yes: true }, ctx(), deps({ env: HARNESS_ENV }));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(routes.filter((r) => r.includes('/api/fund/'))).toEqual([]);
    const steps = stepsOf(result);
    expect(steps.map((q) => q.id)).toEqual(['fund']);
    const fund = steps[0]!;
    const show =
      'You can ask your agent to add funds to Tenjin later. Paid tools need funds; your usual tools keep working.';
    expect(fund).toMatchObject({
      question: 'Add $5 to Tenjin now?',
      options: [
        { id: 'fund', label: 'Add $5', command: 'tenjin wallet fund 5' },
        { id: 'later', label: 'Not now', command: null },
      ],
      address: ADDRESS,
      show,
    });
    expect(fund).not.toHaveProperty('url');
    expect(fund.next).toContain('The install is done.');
    expect(fund.next).toContain('Never run `tenjin wallet fund 5` without this yes.');
    expect(fund.next).toContain('never ask them to run a command');
    expect(result.humanLines).toEqual(
      expect.arrayContaining([
        '  Ask the person: Add $5 to Tenjin now?',
        '  Add $5: tenjin wallet fund 5',
        `  Not now: run nothing, show them: ${show}`,
      ]),
    );
    expect(result.humanLines!.at(-1)).toBe(
      `Next: ask the person the question in nextSteps, then run what the answer names, then ${RELOAD}`,
    );
    expect((result.data as { next: string }).next).not.toContain('wallet fund');
  });

  it('the custom-limits install asks the funding question too', async () => {
    const result = await runRouterInstall(
      { maxAutoSpend: '0.50', sessionBudget: 'none' },
      ctx(),
      deps({ env: HARNESS_ENV }),
    );
    expect(stepsOf(result).map((q) => q.id)).toEqual(['fund']);
  });

  it('asks only the funding question when the limits were answered earlier', async () => {
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ maxAutoSpend: '250000', sessionBudget: '5000000' }),
    );
    const result = await runRouterInstall({}, ctx(), deps({ env: HARNESS_ENV }));
    expect(stepsOf(result).map((q) => q.id)).toEqual(['fund']);
  });

  it('asks nothing about funds for a wallet that already holds USDC', async () => {
    const result = await runRouterInstall(
      { yes: true },
      ctx(),
      deps({
        env: HARNESS_ENV,
        walletExists: async () => true,
        walletBalance: async () => 1_000_000n,
      }),
    );
    expect(stepsOf(result)).toEqual([]);
    expect(result.humanLines!.at(-1)).toBe(`Next: ${RELOAD}`);
  });

  it('does not suggest adding money when an existing balance cannot be checked', async () => {
    const result = await runRouterInstall(
      { yes: true },
      ctx(),
      deps({
        env: HARNESS_ENV,
        walletExists: async () => true,
        walletBalance: async () => {
          throw new Error('rpc down');
        },
      }),
    );
    expect(stepsOf(result)).toEqual([]);
    expect(result.data).toMatchObject({
      fundingWarning: expect.stringContaining('Could not check your Tenjin funds'),
    });
    expect(result.humanLines!.join(' ')).toContain('Your usual tools keep working');
    expect(result.humanLines!.join(' ')).not.toContain('Add $5');
    expect(result.humanLines!.at(-1)).toBe(`Next: ${RELOAD}`);
  });

  it('a person at a terminal gets what it always got: no questions handed over', async () => {
    const result = await runRouterInstall(
      {},
      humanCtx(),
      deps({
        env: HARNESS_ENV,
        isInteractive: true,
        promptLimits: async () => 'approve' as const,
      }),
    );
    expect(stepsOf(result)).toEqual([]);
    expect(result.humanLines!.at(-1)).toBe(
      `Next: fund the wallet with \`tenjin wallet fund 5\`, then ${RELOAD}`,
    );
  });

  it('a script outside any harness gets the spend question and no funding question', async () => {
    const result = await runRouterInstall({}, ctx(), deps());
    expect(stepsOf(result).map((q) => q.id)).toEqual(['spend']);
  });
});

describe('the wallet line: can Claude Code unlock it', () => {
  const PERSON_REPAIR_FIX = WALLET_REASONS.passphrase_missing.fix;
  const blocked = {
    signing: {
      status: 'blocked',
      reason: 'passphrase_missing',
      detail: 'no saved wallet passphrase can be reached',
      fix: PERSON_REPAIR_FIX,
    },
  };
  /** Every line and the `next` of a run, for the sweeps below. */
  const everything = (r: { data: unknown; humanLines?: string[] }) =>
    [...(r.humanLines ?? []), (r.data as { next: string }).next].join('\n');

  it('an agent (no TTY) relays a blocked wallet with the agent wording', async () => {
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({ walletExists: async () => true, walletSigning: async () => blocked }),
    );
    const lines = result.humanLines!;
    expect(lines.some((l) => l.includes('✓ Wallet'))).toBe(false);
    const at = lines.indexOf(
      `! Wallet ${ADDRESS} cannot be unlocked by Claude Code: no saved wallet passphrase can be reached.`,
    );
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(`  ${ASK_FOR_REPAIR}`);
    const next = (result.data as { next: string }).next;
    expect(next).toMatch(
      /^ask the person to run `tenjin wallet repair` in their own terminal \(never ask for the passphrase\), then /,
    );
    expect(result.data).toMatchObject({ wallet: { status: 'existing', signing: blocked.signing } });
  });

  it('a person at a terminal gets the person wording, with the repair clause', async () => {
    const result = await runRouterInstall(
      { yes: true },
      humanCtx(),
      deps({ walletExists: async () => true, walletSigning: async () => blocked }),
    );
    const lines = result.humanLines!;
    const at = lines.findIndex((l) => l.includes('cannot be unlocked by Claude Code'));
    expect(lines[at + 1]).toBe(`  ${PERSON_REPAIR_FIX}`);
    const next = (result.data as { next: string }).next;
    expect(next).toMatch(/^run `tenjin wallet repair` yourself /);
    expect(next).toContain(REPAIR_CLAUSE);
    // Every person-facing string that names repair carries the clause.
    for (const line of [...lines, next].filter((l) => l.includes('tenjin wallet repair'))) {
      expect(line).toContain(REPAIR_CLAUSE);
    }
  });

  it.each([
    [false, 'Never ask for the passphrase'],
    [true, REPAIR_CLAUSE],
  ])(
    'a wallet only TENJIN_WALLET_PASSPHRASE in this shell unlocks is no ✓ (TTY %s)',
    async (tty, says) => {
      const result = await runRouterInstall(
        { yes: true },
        tty ? humanCtx() : ctx(),
        deps({
          walletExists: async () => true,
          walletSigning: async () => ({
            signing: { status: 'ready', source: 'passphrase-env' },
            shellOnly: 'passphrase',
          }),
        }),
      );
      const text = result.humanLines!.join('\n');
      expect(text).not.toContain('✓ Wallet');
      const line = result.humanLines!.find((l) => l.startsWith(`! Wallet: ${ADDRESS}`))!;
      expect(line).toContain('TENJIN_WALLET_PASSPHRASE in this shell');
      expect(line).toContain('tenjin wallet repair');
      expect(line).toContain(says);
      expect(result.data).toMatchObject({ wallet: { shellOnly: 'passphrase' } });
    },
  );

  it('a router that served a session and signs for it clears the shell-only line', async () => {
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({
        walletExists: async () => true,
        walletSigning: async () => ({
          signing: { status: 'ready', source: 'passphrase-env' },
          shellOnly: 'passphrase',
        }),
        observedSigning: async () => true,
      }),
    );
    expect(result.humanLines).toContain(`✓ Wallet: ${ADDRESS}`);
    expect((result.data as { wallet: { shellOnly?: string } }).wallet.shellOnly).toBeUndefined();
  });

  it('a TENJIN_WALLET_KEY with no file is the existing wallet: nothing created, no ✓', async () => {
    const key = `0x${'1'.repeat(64)}`;
    const createWallet = vi.fn(async () => ADDRESS);
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({
        env: { TENJIN_WALLET_KEY: key },
        walletAddress: undefined,
        walletSigning: undefined,
        createWallet,
      }),
    );
    expect(createWallet).not.toHaveBeenCalled();
    const wallet = (result.data as { wallet: { status: string; address: string } }).wallet;
    expect(wallet).toMatchObject({ status: 'existing', shellOnly: 'key' });
    expect(result.humanLines!.join('\n')).not.toContain('✓ Wallet');
    expect(result.humanLines).toContain(
      `! Wallet: ${wallet.address} signs here only through TENJIN_WALLET_KEY in this shell; Claude Code must have the same variable.`,
    );
  });

  it('a created wallet whose passphrase went to the file prints the ✓ and create’s one line', async () => {
    const note = `No keyring reachable from this session; passphrase saved to ${join(data, 'passphrase.x.plain')} (readable only by you).`;
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({
        createWallet: async () => ({
          address: ADDRESS,
          passphrase: {
            store: 'file',
            location: join(data, 'passphrase.x.plain'),
            durable: true,
            note,
          },
        }),
      }),
    );
    expect(result.humanLines!.slice(1, 3)).toEqual([`✓ Wallet created: ${ADDRESS}`, `  ${note}`]);
    expect(result.data).toMatchObject({
      wallet: { status: 'created', signing: { status: 'ready', source: 'file' } },
    });
  });

  it('an env passphrase create could not save is shell-only', async () => {
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({
        createWallet: async () => ({
          address: ADDRESS,
          passphrase: {
            store: 'env',
            location: 'TENJIN_WALLET_PASSPHRASE',
            durable: false,
            note: 'n',
          },
        }),
      }),
    );
    expect(result.data).toMatchObject({ wallet: { status: 'created', shellOnly: 'passphrase' } });
    expect(result.humanLines!.join('\n')).not.toContain('✓ Wallet');
  });

  it('a reinstall with an empty existing wallet keeps today’s next step and funding question (S6)', async () => {
    const result = await runRouterInstall(
      { yes: true },
      ctx(),
      deps({ env: HARNESS_ENV, walletExists: async () => true, walletBalance: async () => 0n }),
    );
    const data_ = result.data as { next: string; nextSteps: { id: string; question: string }[] };
    expect(data_.next).toBe(
      `ask the person the question in nextSteps, then run what the answer names, then ${RELOAD}`,
    );
    expect(data_.nextSteps).toEqual([
      expect.objectContaining({
        id: 'fund',
        question: 'Add $5 to Tenjin now?',
      }),
    ]);
  });

  it('a create a killed keychain probe refused is a locked-store skip, never --insecure-storage', async () => {
    const { StoreExecError } = await import('../lib/wallet/passphrase');
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({
        createWallet: undefined,
        walletPassphrase: {
          platform: 'darwin',
          isTTY: false,
          exec: async () => {
            throw new StoreExecError('security', { killed: true, signal: 'SIGKILL' });
          },
        },
      }),
    );
    const wallet = (result.data as { wallet: { status: string; reason: string; fix: string } })
      .wallet;
    expect(wallet).toMatchObject({ status: 'skipped', reason: 'passphrase-store-locked' });
    expect(wallet.fix).toContain('Unlock your keychain');
    expect(everything(result)).not.toContain('--insecure-storage');
  });

  it('a file-store write that failed is no-passphrase-store, and never names a keychain', async () => {
    const { FILE_STORE_FAILED_FIX } = await import('../lib/wallet-unlock');
    const path = join(data, 'passphrase.0xabc.plain');
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({
        createWallet: async () => {
          throw new CliError('REFUSED', 'Tenjin could not save the passphrase.', {
            fix: FILE_STORE_FAILED_FIX(path),
            details: { passphraseStore: { kind: 'file-write-failed', path } },
          });
        },
      }),
    );
    const wallet = (result.data as { wallet: { status: string; reason: string; fix: string } })
      .wallet;
    expect(wallet).toMatchObject({ status: 'skipped', reason: 'no-passphrase-store' });
    expect(wallet.fix).toContain(FILE_STORE_FAILED_FIX(path));
    expect(everything(result)).not.toMatch(/keychain/i);
  });

  it('never prints an inline TENJIN_WALLET_PASSPHRASE= anywhere', async () => {
    for (const signing of [
      blocked,
      { signing: { status: 'ready', source: 'passphrase-env' }, shellOnly: 'passphrase' },
      {
        signing: {
          status: 'unknown',
          reason: 'keychain_locked',
          detail: 'the keychain did not answer',
        },
      },
    ]) {
      for (const c of [ctx(), humanCtx()]) {
        const result = await runRouterInstall(
          { yes: true },
          c,
          deps({ walletExists: async () => true, walletSigning: async () => signing }),
        );
        expect(everything(result)).not.toContain('TENJIN_WALLET_PASSPHRASE=');
        expect(JSON.stringify(result.data)).not.toContain('TENJIN_WALLET_PASSPHRASE=');
      }
    }
  });

  it('names no stale server for a router nothing Claude started', async () => {
    const result = await runRouterInstall(
      {},
      ctx(),
      deps({
        listMcpProcesses: async () => [
          { pid: 4242, startedAt: 1, kind: 'plugin', underClaude: false },
        ],
        installedAt: async () => Date.now(),
      }),
    );
    expect(result.humanLines!.join('\n')).not.toContain('started before this install');
  });

  it('counts only a router that served a Claude session as one that signs (B2)', async () => {
    const { writeObservation } = await import('./router-observation');
    const observation = (servedSession: boolean) => ({
      version: 1 as const,
      pid: 5151,
      startedAt: 1_000,
      at: 2_000,
      cliVersion: '0.0.0',
      harness: 'claude' as const,
      launchedByPlugin: true,
      cwd: work,
      address: ADDRESS,
      servedSession,
      env: { passphraseSet: true, keySet: false },
      sign: { status: 'ready' as const, source: 'passphrase-env' as const },
    });
    const run = () =>
      runRouterInstall(
        {},
        ctx(),
        deps({
          walletExists: async () => true,
          walletSigning: async () => ({
            signing: { status: 'ready', source: 'passphrase-env' },
            shellOnly: 'passphrase',
          }),
          observedSigning: undefined,
          listProcesses: async () => ({
            routers: [{ pid: 5151, startedAt: 1_000, kind: 'plugin', underClaude: true }],
            claude: [],
          }),
        }),
      );
    await writeObservation(data, observation(false));
    expect((await run()).humanLines!.join('\n')).not.toContain('✓ Wallet');
    await writeObservation(data, observation(true));
    expect((await run()).humanLines).toContain(`✓ Wallet: ${ADDRESS}`);
  });
});

describe('the default wallet steps, on a fake keychain', () => {
  // Real scrypt: the keystore is encrypted and opened for real.
  const SCRYPT_TIMEOUT_MS = 120_000;

  it(
    'a TENJIN_WALLET_PASSPHRASE the keychain also holds is a ✓: a saved passphrase opens it',
    async () => {
      const { encryptedRecord, KNOWN_PASSPHRASE } = await import('../lib/wallet/test-support');
      const { writeWalletRecord } = await import('../lib/wallet/store');
      const { generatePrivateKey } = await import('viem/accounts');
      const record = await encryptedRecord(generatePrivateKey());
      await writeWalletRecord(data, record);
      const exec = async (file: string, args: string[]) => {
        if (file === 'security' && args[0] === 'find-generic-password') {
          return { stdout: `${KNOWN_PASSPHRASE}\n`, stderr: '' };
        }
        throw new Error(`unexpected ${file} ${args.join(' ')}`);
      };
      const result = await runRouterInstall(
        {},
        ctx(),
        deps({
          env: { TENJIN_WALLET_PASSPHRASE: KNOWN_PASSPHRASE },
          walletExists: undefined,
          walletAddress: undefined,
          walletSigning: undefined,
          walletPassphrase: { platform: 'darwin', isTTY: false, exec },
        }),
      );
      expect(result.humanLines).toContain(`✓ Wallet: ${record.address}`);
      expect(result.data).toMatchObject({
        wallet: { status: 'existing', signing: { status: 'ready', source: 'keychain' } },
      });
    },
    SCRYPT_TIMEOUT_MS,
  );

  it(
    'headless Linux with no keyring creates the wallet with its passphrase in the 0600 file',
    async () => {
      const { NO_KEYRING_LINE } = await import('../lib/wallet-unlock');
      const { StoreExecError } = await import('../lib/wallet/passphrase');
      const result = await runRouterInstall(
        {},
        ctx(),
        deps({
          createWallet: undefined,
          walletPassphrase: {
            platform: 'linux',
            isTTY: false,
            exec: async (file: string) => {
              throw new StoreExecError(file, { code: 'ENOENT', enoent: true });
            },
          },
        }),
      );
      const wallet = (
        result.data as {
          wallet: { status: string; passphrase: { store: string; location: string; note: string } };
        }
      ).wallet;
      expect(wallet.status).toBe('created');
      expect(wallet.passphrase.store).toBe('file');
      expect(wallet.passphrase.note).toBe(NO_KEYRING_LINE(wallet.passphrase.location));
      expect(result.humanLines).toContain(`  ${wallet.passphrase.note}`);
    },
    SCRYPT_TIMEOUT_MS,
  );

  it.each([
    ['a terminal', true],
    ['no terminal', false],
  ])('the default create is told the context is %s', async (_label, tty) => {
    vi.resetModules();
    const runWalletCreate = vi.fn(async () => ({
      data: {
        address: ADDRESS,
        passphraseSource: 'keychain',
        passphraseLocation: 'your macOS keychain',
        passphraseDurable: true,
        passphraseNote: 'saved',
      },
    }));
    vi.doMock('../commands/wallet', () => ({ runWalletCreate }));
    try {
      const fresh = await import('./install');
      await fresh.runRouterInstall(
        { yes: true },
        tty ? humanCtx() : ctx(),
        deps({ createWallet: undefined }),
      );
      const opts = (runWalletCreate.mock.calls[0] as unknown[])[1] as {
        passphrase: { isTTY: boolean };
      };
      expect(opts.passphrase.isTTY).toBe(tty);
    } finally {
      vi.doUnmock('../commands/wallet');
      vi.resetModules();
    }
  });
});
