import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import { runRouterInstall } from './install';
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
const ASK_LINES = [
  '! Automatic payments are off until the user approves a spend limit',
  `  Ask the user in this session: May Tenjin pay for tool calls without asking you each time, up to $0.25 a call and $5 a day? ${FEE_TERMS} Using these limits or choosing your own also approves the routing fee.`,
  '  Yes: tenjin install --yes',
  '  Other amounts: tenjin config set maxAutoSpend <usd> and tenjin config set sessionBudget <usd|none>',
  '  No: run nothing, the router then pays for nothing on its own, and the question stays open until the user answers it',
];
const RELOAD =
  'type /reload-plugins in this Claude Code session, or start a new session, so Tenjin loads';

/** Wallet seams are always stubbed: the real create writes to the OS keychain. */
function deps(over: Record<string, unknown> = {}) {
  return {
    homeDir: home,
    env: {},
    findClaude: () => null,
    walletExists: async () => false,
    createWallet: vi.fn(async () => ADDRESS),
    walletAddress: async () => ADDRESS,
    listMcpProcesses: async () => [],
    ...over,
  };
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
          approve: 'tenjin install --yes',
          own: 'tenjin config set maxAutoSpend <usd> and tenjin config set sessionBudget <usd|none>',
        },
      },
    });
    const { next } = (result.data as { spend: { approval: { next: string } } }).spend.approval;
    expect(next).toMatch(
      /^In this session, show the user these limits and ask this question before you change any limit\./,
    );
    expect(next).toContain(
      'If they say yes, run the same install again with --yes: `tenjin install --yes`.',
    );
    expect(next).toContain('If they say no, run nothing');
    expect(next).not.toMatch(/terminal/i);
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
      `Next: fund the wallet with \`tenjin wallet fund\`, then ${RELOAD}`,
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
    expect(result.humanLines!.join('\n')).toContain(
      'Type /reload-plugins in this Claude Code session, or start a new session.',
    );
    // The refresh `tenjin update` runs says it too.
    const refreshed = await runRouterInstall(
      { refresh: true },
      ctx(),
      deps({ listMcpProcesses, installedAt: async () => 2 }),
    );
    expect(refreshed.humanLines!.join('\n')).toContain('Type /reload-plugins');
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
    expect(result.data).toMatchObject({ plugin: { state: 'written' } });
  });

  it('a non-interactive run keeps a per-call limit the file already names', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ maxAutoSpend: '100000' }));
    const result = await runRouterInstall({}, ctx(), deps());
    expect(await loadRawConfig(data)).toEqual({ maxAutoSpend: '100000' });
    expect(result.data).toMatchObject({ spend: { set: [], kept: ['maxAutoSpend'] } });
    expect(result.data).not.toHaveProperty('spend.approval');
  });

  it('--yes writes the limits the question shows, as "Use these limits" does', async () => {
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
    expect(result.data).not.toHaveProperty('spend.approval');
  });

  it('hands the agent its own command with --yes, and that run keeps every install choice', async () => {
    // The agent-run install was told to make no wallet.
    const createWallet = vi.fn(async () => ADDRESS);
    const first = await runRouterInstall({ noWallet: true }, ctx(), deps({ createWallet }));
    const { approve } = (first.data as { spend: { approval: { approve: string } } }).spend.approval;
    expect(approve).toBe('tenjin install --no-wallet --yes');
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
    expect(result.data).not.toHaveProperty('spend.approval');
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
      expect(spend?.detail).toContain(
        `Ask the user: May Tenjin pay for tool calls without asking you each time, up to $0.25 a call and $5 a day? ${FEE_TERMS}`,
      );
      expect(spend?.fix).toBe(
        'Answer the spend question: for a yes, run `tenjin config set maxAutoSpend 0.25`; for other amounts, `tenjin config set maxAutoSpend <usd>` and `tenjin config set sessionBudget <usd|none>`.',
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
  const result = await runRouterStatus(ctx(), { routingCredit: async () => 240_000n });
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
  const result = await runRouterStatus(ctx(), { routingCredit: async () => 0n });
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
