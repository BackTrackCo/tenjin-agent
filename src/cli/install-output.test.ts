import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../cli';
import type { Io } from '../lib/output';
import { CliError } from '../lib/errors';
import type { WalletOutcome } from '../commands/install-wallet';

const stubs = vi.hoisted(() => ({ install: vi.fn(), codex: vi.fn(), doctor: vi.fn() }));
vi.mock('../router/install', () => ({
  runRouterInstall: stubs.install,
  runtimeOncePerRun: () => vi.fn(),
}));
vi.mock('../router/codex-install', () => ({ runCodexInstall: stubs.codex }));
vi.mock('../router/doctor', () => ({ runRouterDoctor: stubs.doctor }));
vi.mock('../router/hosts', async (original) => ({
  ...(await original<typeof import('../router/hosts')>()),
  installHosts: async () => ['claude', ...(process.env.TEST_BOTH_HOSTS ? ['codex'] : [])],
  otherHostNote: async () => 'Codex is also installed.',
  recordInstalledHost: vi.fn(),
  recordedHosts: async () => ['claude'],
}));

const pending = [
  {
    id: 'spend',
    question: 'Use the defaults or set your own limits?',
    options: [
      {
        id: 'default',
        label: 'Use the defaults',
        recommended: true,
        command: "'/private runtime/tenjin' install --yes",
      },
      {
        id: 'custom',
        label: 'Set my own limits',
        recommended: false,
        ask: ['Daily budget in USD', 'Per-call limit in USD'],
        command:
          "'/private runtime/tenjin' install --max-auto-spend <usd> --session-budget <usd|none>",
      },
    ],
    next: 'Ask this question, then run the selected command.',
  },
];
const full = () => ({
  next: 'Ask the pending question, then run /reload-plugins and verify its tools.',
  nextSteps: structuredClone(pending),
  plugin: {
    id: 'tenjin@tenjin',
    state: 'installed',
    scope: 'user',
    steps: [{ stdout: 'registration diagnostics' }],
  },
  claudeCode: { binary: '/usr/local/bin/claude', version: '2.1.311', meetsFloor: true },
  migration: { state: 'absent' },
  spend: { set: [], kept: [], effective: { maxAutoSpend: '0.25', sessionBudget: '5' } },
  wallet: {
    status: 'created',
    address: '0x1111111111111111111111111111111111111111',
    passphrase: {
      store: 'file',
      durable: true,
      location: '/home/dev/.tenjin/passphrase.plain',
      note: 'passphrase is saved in a plaintext file',
    },
    signing: { status: 'ready', source: 'file' },
  },
  router: { status: 'ok', detail: 'https://tenjin.sh/api/x402-router/route is live' },
  mcpServer: {
    status: 'ok',
    required: false,
    detail: 'none running (starts with the next session)',
  },
  runtime: {
    state: 'active',
    root: '/home/dev/.tenjin/runtime',
    cli: 'test',
    nodeVersion: '24.22.1',
  },
  launcher: { state: 'written', onPath: false, pathLine: 'edit your shell profile' },
  disclosure: ['Relevant task context is sent to Tenjin for routing.'],
  fundingWarning: 'Could not check funds; this does not mean another payment is needed.',
});

let sandbox: string;
beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'tenjin-install-output-'));
  vi.stubEnv('CI', '1');
  vi.stubEnv('HOME', sandbox);
  vi.stubEnv('TENJIN_DATA_DIR', join(sandbox, '.tenjin'));
  for (const key of [
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_EXECPATH',
    'CODEX_SESSION_ID',
    'TEST_BOTH_HOSTS',
  ])
    vi.stubEnv(key, '');
  stubs.install.mockResolvedValue({ data: full(), humanLines: ['Installed.'] });
  stubs.codex.mockResolvedValue({ data: { ...full(), plugin: 'tenjin' } });
  stubs.doctor.mockResolvedValue({ data: full() });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await rm(sandbox, { recursive: true, force: true });
});

async function run(args: string[], isTTY = false) {
  const chunks: string[] = [];
  const io: Io = {
    isTTY,
    stdout: {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    } as NodeJS.WritableStream,
    stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  };
  const code = await main(args, io);
  return { code, stdout: chunks.join('') };
}

describe('the default agent install handoff', () => {
  it('keeps every choice and activation instruction through the observed tail -40', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    const out = await run(['install']);
    expect(out.code).toBe(0);
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    const data = JSON.parse(out.stdout.trim().split('\n').slice(-40).join('\n')).data;
    expect(data.nextSteps).toEqual(pending);
    expect(data.next).toBe(full().next);
    expect(data).not.toHaveProperty('mcpServer');
    expect(data.next).toContain('verify its tools');
    expect(out.stdout).not.toContain('starts with the next session');
    expect(data.spend).toEqual(full().spend);
    expect(data.notices).toEqual(['Codex is also installed.']);
    expect(data.fundingWarning).toBe(full().fundingWarning);
    expect(data.wallet).not.toHaveProperty('address');
    expect(data.wallet).not.toHaveProperty('passphrase');
    expect(data).not.toHaveProperty('launcher');
    expect(data).not.toHaveProperty('compactJson');
  });

  it.each([
    ['install', '--json'],
    ['--json', 'install'],
    ['install', '--refresh', '--harness', 'claude'],
    ['doctor'],
  ])('keeps complete diagnostics for %j even under an agent', async (...args) => {
    vi.stubEnv('CLAUDECODE', '1');
    const out = await run(args);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).data).toMatchObject(full());
    expect(out.stdout.split('\n').length).toBeGreaterThan(40);
  });

  it('preserves ordinary piped automation and terminal output', async () => {
    const piped = await run(['install']);
    expect(JSON.parse(piped.stdout).data).toMatchObject(full());
    vi.stubEnv('CLAUDECODE', '1');
    expect((await run(['install'], true)).stdout).toBe('Installed.\nCodex is also installed.\n');
  });

  it('keeps each host pending question and all warnings in the multi-host result', async () => {
    vi.stubEnv('CODEX_SESSION_ID', 'test');
    vi.stubEnv('TEST_BOTH_HOSTS', '1');
    const data = JSON.parse((await run(['install'])).stdout).data;
    expect(data.hosts).toEqual(['claude', 'codex']);
    for (const host of data.hosts) {
      expect(data[host].nextSteps).toEqual(pending);
      expect(data[host].fundingWarning).toBe(full().fundingWarning);
      expect(data[host].wallet).not.toHaveProperty('address');
    }
    expect(data.notices).toEqual(['Codex is also installed.']);
  });

  it('preserves a failed registration and wallet recovery instead of hiding them', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    const data = full();
    Object.assign(data.plugin, {
      state: 'failed',
      reason: 'registration refused',
      fix: 'Run doctor.',
    });
    Object.assign(data.wallet, {
      passphrase: { ...data.wallet.passphrase, durable: false },
      signing: {
        status: 'blocked',
        reason: 'passphrase_missing',
        fix: 'Ask for a local repair, never the passphrase.',
      },
    });
    Object.assign(data.mcpServer, { status: 'warn', fix: 'Reload the stale server.' });
    stubs.install.mockResolvedValueOnce({ data });
    const projected = JSON.parse((await run(['install'])).stdout).data;
    expect(projected.plugin).toEqual(data.plugin);
    expect(projected.wallet).toMatchObject({
      passphrase: { durable: false },
      signing: data.wallet.signing,
    });
    expect(projected.mcpServer).toEqual(data.mcpServer);
  });

  it('never projects thrown failure details', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    stubs.install.mockRejectedValueOnce(
      new CliError('REFUSED', 'Install failed.', { details: full() }),
    );
    const out = await run(['install']);
    expect(out.code).not.toBe(0);
    expect(JSON.parse(out.stdout).error.details).toEqual(full());
  });

  it.each(['key', 'passphrase'] as const)(
    'preserves signing that only works through a shell %s',
    async (shellOnly) => {
      vi.stubEnv('CLAUDECODE', '1');
      const wallet: WalletOutcome = {
        status: 'existing',
        signing: { status: 'ready', source: shellOnly === 'key' ? 'key-env' : 'passphrase-env' },
        shellOnly,
      };
      stubs.install.mockResolvedValueOnce({ data: { ...full(), wallet } });
      expect(JSON.parse((await run(['install'])).stdout).data.wallet).toEqual(wallet);
    },
  );

  it('keeps an unsaved passphrase warning even when this shell can sign', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    const wallet: WalletOutcome = {
      status: 'created',
      signing: { status: 'ready', source: 'passphrase-env' },
      passphrase: {
        store: 'env',
        durable: false,
        location: 'TENJIN_WALLET_PASSPHRASE',
        note: 'Only this shell holds the passphrase.',
      },
    };
    stubs.install.mockResolvedValueOnce({ data: { ...full(), wallet } });
    expect(JSON.parse((await run(['install'])).stdout).data.wallet).toEqual(wallet);
  });
});
