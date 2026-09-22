import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import { ALLOW_RULE, MCP_ADD_COMMAND, runRouterInstall } from './install';
import { runRouterUninstall } from './uninstall';
import type { CommandContext } from '../context';

let home: string;
let data: string;
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'router-install-'));
  home = join(root, 'home');
  data = join(root, 'data');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(data, { recursive: true });
});
afterEach(async () => {
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

const probe402 = (async () =>
  new Response('{}', {
    status: 402,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

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
    fetchImpl: probe402,
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

function deps(over: Record<string, unknown> = {}) {
  return {
    homeDir: home,
    env: {},
    which: () => true,
    registerMcp: vi.fn(async () => undefined),
    ...over,
  };
}

describe('tenjin install', () => {
  it('writes the two hook entries, the allow rule and the MCP registration', async () => {
    const registerMcp = vi.fn(async () => undefined);
    const result = await runRouterInstall({}, ctx(), deps({ registerMcp }));
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, { matcher?: string; hooks: unknown[] }[]>;
    expect(hooks.UserPromptSubmit![0]!.hooks).toEqual([
      { type: 'command', command: 'tenjin hook prompt', timeout: 3 },
    ]);
    expect(hooks.PreToolUse![0]).toMatchObject({
      matcher: 'WebSearch|WebFetch',
      hooks: [{ type: 'command', command: 'tenjin hook native', timeout: 3 }],
    });
    expect((settings.permissions as { allow: string[] }).allow).toContain(ALLOW_RULE);
    expect(registerMcp).toHaveBeenCalledWith(MCP_ADD_COMMAND, {
      scope: 'user',
      cwd: expect.any(String) as unknown as string,
    });
    expect(JSON.stringify(result.data)).not.toContain('daemon');
  });

  it('sets the spend defaults only where the file is silent', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ confirm: 'always' }));
    const result = await runRouterInstall({}, ctx(), deps());
    const config = await loadRawConfig(data);
    expect(config.maxAutoSpend).toBe('100000');
    expect(config.sessionBudget).toBe('1000000');
    expect(config.confirm).toBe('always');
    expect(config.bazaarPay).toBe(true);
    expect((result.data as { spend: { kept: string[] } }).spend.kept).toEqual(['confirm']);
  });

  it('turns the pay lane on and auto-approves at or below the per-call cap by default', async () => {
    await runRouterInstall({}, ctx(), deps());
    const config = await loadRawConfig(data);
    expect(config.confirm).toBe('above:100000');
    expect(config.bazaarPay).toBe(true);
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
      deny: ['Bash(rm:*)'],
    });
    expect((settings.hooks as Record<string, unknown[]>).Stop).toEqual(original.hooks.Stop);
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
      'PreToolUse',
      'UserPromptSubmit',
    ]);
  });

  it('prints the command to run when the claude binary is absent', async () => {
    const result = await runRouterInstall({}, ctx(), deps({ which: () => false }));
    expect(result.data).toMatchObject({ mcp: { registered: false, command: MCP_ADD_COMMAND } });
    expect(result.humanLines?.join('\n')).toContain(MCP_ADD_COMMAND);
  });

  it('states what leaves the machine and what is kept', async () => {
    const result = await runRouterInstall({}, ctx(), deps());
    const text = result.humanLines!.join('\n');
    expect(text).toContain('sent to Tenjin for the free routing gate');
    expect(text).toContain('a hash of the arguments, and your wallet address');
    expect(text).toContain('your private key');
    expect(text).toContain('tenjin uninstall');
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

describe('tenjin install --refresh', () => {
  it('re-registers what is already there and changes no config', async () => {
    await runRouterInstall({}, ctx(), deps());
    await writeFile(join(data, 'config.json'), JSON.stringify({ maxAutoSpend: '1' }));
    const registerMcp = vi.fn(async () => undefined);
    const result = await runRouterInstall({ refresh: true }, ctx(), deps({ registerMcp }));
    expect(result.data).toMatchObject({ refresh: true });
    expect(registerMcp).not.toHaveBeenCalled();
    expect((await loadRawConfig(data)).maxAutoSpend).toBe('1');
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
    expect((settings.permissions as { allow: string[] }).allow).not.toContain(ALLOW_RULE);
    expect(removeMcp).toHaveBeenCalled();
    expect(await readFile(join(data, 'wallet.json'), 'utf8')).toBe('{"keystore":"kept"}');
    expect(result.data).toMatchObject({ kept: ['wallet.json', 'spend.json', 'config.json'] });
  });

  it('leaves someone else’s entries and keys exactly as they are', async () => {
    const mine = { hooks: [{ type: 'command', command: 'someone-elses-hook' }] };
    await writeFile(
      settingsPath(),
      JSON.stringify({ model: 'opus', hooks: { Stop: [mine] } }, null, 2) + '\n',
    );
    await runRouterInstall({}, ctx(), deps());
    await runRouterUninstall({}, ctx(), { homeDir: home, env: {}, which: () => false });
    const settings = await readSettings();
    expect(settings.model).toBe('opus');
    expect((settings.hooks as Record<string, unknown[]>).Stop).toEqual([mine]);
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
});

describe('a settings file this writer will not touch', () => {
  it('reports the refusal rather than rewriting it', async () => {
    await writeFile(settingsPath(), '{ not json');
    const result = await runRouterInstall({}, ctx(), deps());
    expect((result.data as { hooks: { skipped?: string } }).hooks.skipped).toBe('unparsable');
    expect(await readFile(settingsPath(), 'utf8')).toBe('{ not json');
    expect(result.humanLines?.join('\n')).toContain('left untouched');
  });

  it('throws nothing an operator cannot act on when HOME is relative', async () => {
    await expect(runRouterInstall({}, ctx(), deps({ homeDir: 'relative' }))).rejects.toBeInstanceOf(
      CliError,
    );
  });
});

describe('the doctor this release registers', () => {
  it('checks the router wiring and prescribes no command the CLI lacks', async () => {
    const { runRouterDoctor } = await import('./doctor');
    await runRouterInstall({}, ctx(), deps());
    await writeFile(join(data, 'wallet.json'), '{"not":"a wallet"}');
    const fetchImpl = (async () =>
      new Response('{}', {
        status: 402,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const result = await runRouterDoctor(ctx(), {
      homeDir: home,
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
    expect(names).toEqual(['node', 'hooks', 'mcp', 'spend', 'wallet', 'router']);
    const fixes = data_.checks.map((c) => c.fix ?? '').join(' ');
    for (const gone of ['tenjin daemon', 'tenjin search', 'tenjin publish', 'tenjin hooks']) {
      expect(fixes).not.toContain(gone);
    }
  });

  it('fails with the command that fixes it on a machine that never installed', async () => {
    const { runRouterDoctor } = await import('./doctor');
    const fetchImpl = (async () => new Response('{}', { status: 402 })) as typeof fetch;
    const err = await runRouterDoctor(ctx(), {
      homeDir: home,
      env: {},
      which: () => false,
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).fix).toContain('tenjin install');
  });

  it('reports the router endpoint answering anything but a 402 as a failure', async () => {
    const { runRouterDoctor } = await import('./doctor');
    await runRouterInstall({}, ctx(), deps());
    await writeFile(join(data, 'wallet.json'), '{"not":"a wallet"}');
    const fetchImpl = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    const err = await runRouterDoctor(ctx(), {
      homeDir: home,
      env: {},
      which: () => true,
      readMcp: async () => true,
      fetchImpl,
    }).catch((e: unknown) => e);
    // The throw names the FIRST required failure, so the router's own verdict is
    // read off the check list every doctor envelope carries.
    const checks = (err as CliError).details as { checks: { name: string; detail: string }[] };
    const router = checks.checks.find((c) => c.name === 'router');
    expect(router?.detail).toContain('paid routing looks turned off');
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
    expect(text).toContain('at most 1 USD per call');
    expect(text).toContain('10 USD a day');
    expect(text).not.toContain('0.1 USD per call');
    expect(result.data).toMatchObject({
      spend: { effective: { maxAutoSpend: '1', sessionBudget: '10' } },
    });
  });

  it('says so when an existing config has no daily ceiling at all', async () => {
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ maxAutoSpend: '500000', sessionBudget: '0' }),
    );
    const result = await runRouterInstall({}, ctx(), deps());
    expect(result.humanLines!.join('\n')).toContain('no daily ceiling');
  });

  it('status applies the same expiry an authorization would', async () => {
    const { runRouterStatus } = await import('./status');
    const { createLocalSpendAuthorizer } = await import('../lib/wallet/spend');
    const auth = createLocalSpendAuthorizer({
      dir: data,
      policy: {
        maxAutoSpendAtomic: 1_000_000n,
        sessionBudgetAtomic: 1_000_000n,
        confirm: { mode: 'above', thresholdAtomic: 1_000_000n },
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
        status: 402,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    // The home file has nothing in it: a doctor that looked there would report
    // a correctly wired machine as unwired and exit 3.
    const blind = await runRouterDoctor(ctx(), {
      homeDir: home,
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
    const fetchImpl = (async () => new Response('{}', { status: 402 })) as typeof fetch;
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
    const { classifyMcpEntry } = await import('./doctor');
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
