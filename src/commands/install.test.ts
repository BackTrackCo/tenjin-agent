import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Arms failures the filesystem will not produce on demand. Inert unless a test
 * sets one, so production carries no test-only branch.
 */
const fsHooks = vi.hoisted(() => ({
  settingsInterleave: '',
  /** Which settings.json read to land the interleave after (1-based). */
  settingsInterleaveOnRead: 1,
  settingsReads: 0,
  /** Swap this path for a FIFO the moment it is renamed into place. */
  fifoAfterRename: '',
  /** Deliver a SIGINT the moment this path is renamed into place. */
  signalAfterRename: '',
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const out = await actual.rename(...args);
      // An external writer swapping the just-landed file for a pipe, which is the
      // window between the guarded write and the invocability readback.
      if (fsHooks.fifoAfterRename !== '' && String(args[1]) === fsHooks.fifoAfterRename) {
        const target = fsHooks.fifoAfterRename;
        fsHooks.fifoAfterRename = '';
        await actual.rm(target, { force: true });
        const { execFileSync } = await import('node:child_process');
        execFileSync('mkfifo', [target]);
      }
      // Ctrl-C landing inside the skills write, which is the one interruptible
      // stretch of this command that holds no lock at all.
      if (fsHooks.signalAfterRename !== '' && String(args[1]) === fsHooks.signalAfterRename) {
        fsHooks.signalAfterRename = '';
        process.emit('SIGINT', 'SIGINT');
      }
      return out;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const out = await actual.readFile(...args);
      // A competing writer lands the instant the permissions read returns, which
      // is the top of that writer's read-to-rename window.
      if (fsHooks.settingsInterleave !== '' && String(args[0]).endsWith('settings.json')) {
        fsHooks.settingsReads += 1;
        if (fsHooks.settingsReads === fsHooks.settingsInterleaveOnRead) {
          const bytes = fsHooks.settingsInterleave;
          fsHooks.settingsInterleave = '';
          await actual.writeFile(String(args[0]), bytes);
        }
      }
      return out;
    },
  };
});
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rm,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall, PUBLISH_MODE_CHOICES, WALLET_QUESTION } from './install';
import type { InstallDeps, PromptHarnessesFn, PromptPublishModeFn } from './install';
import type { PublishMode } from '../lib/config';
import type { ExecFn } from '../lib/wallet/passphrase';
import {
  PACKAGED_SKILL_NAMES,
  resolveSkillsSource,
  SHIPPED_SKILL_FILES,
  SKILL_NAMES,
} from '../lib/skills-source';
import { ALWAYS_SAFE_ALLOWLIST, NEVER_ALLOWLISTED } from '../lib/permissions';
import {
  claudeSettingsPath,
  EDIT_MODE_RULE,
  FREE_VERB_RULES,
  inspectFreeVerbRules,
  LEGACY_ALLOWLIST_RULES,
  MODE_GATED_RULES,
  PUBLISH_MODE_RULE,
} from '../lib/harness-permissions';
import { CLI_SKILL_NAMES } from '../lib/skill-wiring';
import { CliError } from '../lib/errors';
import type { DaemonStart } from '../daemon/control';
import { configPath, daemonPidPath, daemonTokenPath, hooksDir, shimBundlePath } from '../lib/paths';
import { renderSkillMarkdown } from '../lib/skill-materialize';
import type { DoctorChecks } from './doctor';
import type { CommandContext, GlobalFlags } from '../context';

// Real packaged skills, resolved once from this test's location. Using the real
// source (not a fixture) also proves the copy lands byte-identical content.
const SKILLS_SRC = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));

/**
 * A packaged skill file as install would WRITE it on this machine. install shapes
 * every source file before it compares and writes (lib/skill-materialize), so a
 * raw read is not what lands: these cases run with no shelf configured, which is
 * public mode. Comparing raw bytes here would pass until the first shipped marker
 * and then fail on an install that did exactly the right thing.
 */
async function packagedText(name: string, rel = 'SKILL.md', teamMode = false): Promise<string> {
  return renderSkillMarkdown(await readFile(join(SKILLS_SRC, name, rel), 'utf8'), { teamMode });
}

const MARKER = 'tenjin-cli:skills';
/** The full marker as it appears in the undo line the walkthrough prints. */
const MARKER_COMMENT = `<!-- ${MARKER} -->`;

let home: string;
let data: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-install-home-'));
  data = await mkdtemp(join(tmpdir(), 'tenjin-install-data-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

function makeCtx(flags: Partial<GlobalFlags> = {}): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 10000, ...flags },
    dataDir: data,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/** The port the fake daemon reports, which is the one every entry must carry. */
const DAEMON_PORT = 34_567;
const DAEMON_TOKEN = 'a'.repeat(64);

/** Steps 1-3 of the hook cutover, without a process behind them. */
const startAt =
  (port: number) =>
  async (dataDir: string): Promise<DaemonStart> => {
    await mkdir(hooksDir(dataDir), { recursive: true });
    await writeFile(shimBundlePath(dataDir), '// shim');
    await writeFile(join(hooksDir(dataDir), 'tenjin-daemon.mjs'), '// daemon');
    await writeFile(daemonTokenPath(dataDir), DAEMON_TOKEN, { mode: 0o600 });
    await writeFile(
      daemonPidPath(dataDir),
      JSON.stringify({ pid: 4242, port, started_at: 1, data_dir: dataDir }),
    );
    return {
      health: {
        version: '9.9.9',
        pid: 4242,
        port,
        uptime_ms: 1,
        idle_ms: 0,
        data_dir: dataDir,
        rss: 1,
      },
      spawned: true,
      replaced: null,
      unconfirmed: null,
      written: [],
    };
  };

const fakeStart = startAt(DAEMON_PORT);

/** Every hook entry in a settings file, flattened to (event, entry) pairs. */
function hookEntries(settings: Record<string, unknown>): [string, HookEntry][] {
  const out: [string, HookEntry][] = [];
  for (const [event, list] of Object.entries(
    (settings.hooks ?? {}) as Record<string, HookEntry[]>,
  )) {
    for (const entry of list) out.push([event, entry]);
  }
  return out;
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; url?: string; command?: string; timeout?: number }[];
}

/** The address the stubbed creator reports; never a real key. */
const STUB_ADDRESS = '0x00000000000000000000000000000000deadbeef';

/** Opt a test into the REAL `wallet create` path (still on the fake keychain). */
function realWalletCreate(exec?: ExecFn): Partial<InstallDeps> {
  return {
    createWallet: undefined,
    walletPassphrase: { platform: 'darwin', isTTY: false, exec: exec ?? fakeKeychain().exec },
  };
}

// Default doctor stub: one passing check, no network. Overridden per-test.
const okChecks: DoctorChecks = {
  publishMode: 'review',
  missingModeGated: [],
  grantable: true,
  checks: [{ name: 'stub', status: 'ok', required: true, detail: 'ok' }],
};

/**
 * An in-memory stand-in for the macOS login keychain.
 *
 * EVERY install test goes through this, and that is a hard safety rule rather
 * than a convenience: a headless install now CREATES a wallet by default, and
 * without an injected exec the real `security` binary would write entries into
 * the developer's own login keychain under the `tenjin-cli` service on every
 * test run. `platform: 'darwin'` is pinned so the same store is exercised on
 * Linux CI, and `isTTY: false` keeps the passphrase prompt unreachable.
 */
function fakeKeychain(): { exec: ExecFn; entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const exec: ExecFn = async (file, args, stdin) => {
    if (file !== 'security') throw new Error(`install tests must not exec ${file}`);
    if (args[0] === '-i') {
      const m = /^add-generic-password -s tenjin-cli -a (\S+) -w '([^']*)'\n$/.exec(String(stdin));
      if (m === null) throw new Error(`unexpected security -i payload: ${String(stdin)}`);
      entries.set(m[1] as string, m[2] as string);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password') {
      const value = entries.get(args[args.indexOf('-a') + 1] as string);
      if (value === undefined) throw new Error('could not be found');
      return { stdout: `${value}\n`, stderr: '' };
    }
    throw new Error(`unexpected security call: ${args.join(' ')}`);
  };
  return { exec, entries };
}

/** A machine with NO usable credential store: every store call fails. */
const noKeychain: ExecFn = async () => {
  throw new Error('no credential store here');
};

function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    homeDir: home,
    skillsSourceDir: SKILLS_SRC,
    which: () => false,
    collectChecks: async () => okChecks,
    // Never the real keychain. See fakeKeychain.
    walletPassphrase: { platform: 'darwin', isTTY: false, exec: fakeKeychain().exec },
    // HERMETIC ENVIRONMENT, and it is load-bearing twice over. It keeps an
    // ambient TENJIN_WALLET_PASSPHRASE in the developer's shell (or leaked by
    // another test file, since vitest does not restore env stubs between files)
    // from silently rerouting the passphrase away from the store these tests
    // assert on. And it means no install test ever has to MUTATE process.env to
    // control that, which is what made the env case flake under the parallel
    // runner. Empty PATH is harmless here: `which` is stubbed above.
    env: {},
    // Every prompt seam is answered in-process, so no test renders a prompt or
    // loads the clack chunk. The defaults are the "changed nothing" answers;
    // decision-specific tests override them.
    walletExists: async () => false,
    confirmWallet: async () => false,
    // Stubbed by default so the ~140 tests that are not about the wallet do not
    // each pay for a real scrypt key derivation. The wallet tests below opt into
    // the real creator with `realWalletCreate()`, which still goes through the
    // fake keychain above.
    createWallet: async () => STUB_ADDRESS,
    // Codex's trust step, answered in-process: the real one spawns `codex
    // app-server`, and no unit test may depend on a Codex being installed.
    // The cases that are ABOUT trust override this with a refusal.
    trustHooks: async (_home, keys) => ({ ok: true, trusted: [...keys] }),
    promptPublishMode: async () => null,
    // NEVER the real one. Steps 1-3 of the hook cutover spawn a detached daemon;
    // this writes exactly what one leaves behind (the bundles, the token, the pid
    // file) so the settings write has a real port and token to read back.
    startDaemon: fakeStart,
    intro: async () => {},
    ...over,
  };
}

async function caught<T>(fn: () => Promise<T>): Promise<CliError> {
  try {
    await fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error('expected the call to throw');
}

type Harnesses = Array<{
  harness: string;
  detected: boolean;
  detectedBy: string[];
  skillsDir: string;
  skills: Array<{
    name: string;
    status: string;
    preexisting: boolean;
    cli: boolean;
    modelInvocable: boolean;
  }>;
  hostedPreexisting: boolean;
  hostedArrivedFirst: boolean;
  claudeMd?: { path: string; status: string };
  codexNetworkRule?: string;
  warnings: string[];
  notes: string[];
}>;
type Data = {
  dryRun: boolean;
  skillsSource: string;
  harnesses: Harnesses;
  hooks: unknown[];
  doctor: unknown;
  bazaarPay: { enabled: boolean; status: string };
};

const asData = (d: unknown) => d as Data;

describe('runInstall: harness override', () => {
  it('installs only Claude when --harness claude, no AGENTS.md wiring', async () => {
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const out = asData(d);
    expect(out.harnesses).toHaveLength(1);
    const h = out.harnesses[0]!;
    expect(h.harness).toBe('claude');
    expect(h.detected).toBe(false);
    expect(h.detectedBy).toEqual([]);
    expect(h.skillsDir).toBe(join(home, '.claude', 'skills'));
    expect(h.codexNetworkRule).toBeUndefined();
    expect(h.skills.map((s) => s.status)).toEqual(SKILL_NAMES.map(() => 'installed'));
    // Every shipped file, not just SKILL.md: this is the only fresh-`create` path
    // under test, and a nested reference file that ships but never lands here
    // would go unnoticed until an agent hits a denial and finds nothing to read.
    for (const name of SKILL_NAMES) {
      for (const rel of SHIPPED_SKILL_FILES[name]) {
        expect(existsSync(join(home, '.claude', 'skills', name, rel))).toBe(true);
      }
    }
  });

  it('installs Codex to ~/.agents/skills and carries the config.toml rule', async () => {
    const { data: d } = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.harness).toBe('codex');
    expect(h.skillsDir).toBe(join(home, '.agents', 'skills'));
    expect(h.codexNetworkRule).toBe('[sandbox_workspace_write]\nnetwork_access = true');
    expect(existsSync(join(home, '.agents', 'skills', 'tenjin', 'SKILL.md'))).toBe(true);
  });

  it('dedupes a repeated harness', async () => {
    const { data: d } = await runInstall({ harness: ['codex', 'codex'] }, makeCtx(), deps());
    expect(asData(d).harnesses).toHaveLength(1);
    expect(asData(d).hooks).toHaveLength(1);
  });

  it.each(['shared', 'cursor'])('rejects non-harness target %s as USAGE / exit 2', async (name) => {
    const err = await caught(() => runInstall({ harness: [name] }, makeCtx(), deps()));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});

describe('runInstall: detection', () => {
  it('detects Claude from ~/.claude and Codex from ~/.codex directories', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(home, '.codex'), { recursive: true });
    const { data: d } = await runInstall(
      {},
      makeCtx(),
      deps({
        isInteractive: true,
        promptHarnesses: async (choices) => choices.map((choice) => choice.harness),
      }),
    );
    const byName = Object.fromEntries(asData(d).harnesses.map((h) => [h.harness, h]));
    expect(byName.claude!.detectedBy).toEqual(['home-dir']);
    expect(byName.codex!.detectedBy).toEqual(['home-dir']);
  });

  it('detects a harness from a binary on PATH', async () => {
    const { data: d } = await runInstall(
      {},
      makeCtx(),
      deps({
        isInteractive: true,
        which: (bin) => bin === 'claude',
        promptHarnesses: async (choices) =>
          choices.filter((choice) => choice.detectedBy.length > 0).map((choice) => choice.harness),
      }),
    );
    const out = asData(d);
    expect(out.harnesses).toHaveLength(1);
    expect(out.harnesses[0]!.harness).toBe('claude');
    expect(out.harnesses[0]!.detectedBy).toEqual(['binary']);
  });

  it('shows both real harnesses when nothing is detected and wires the selected one', async () => {
    let offered: Parameters<PromptHarnessesFn>[0] = [];
    const { data: d } = await runInstall(
      {},
      makeCtx(),
      deps({
        isInteractive: true,
        promptHarnesses: async (choices) => {
          offered = choices;
          return ['codex'];
        },
      }),
    );
    const out = asData(d);
    expect(offered.map((choice) => [choice.harness, choice.detectedBy])).toEqual([
      ['claude', []],
      ['codex', []],
    ]);
    expect(out.harnesses).toHaveLength(1);
    const h = out.harnesses[0]!;
    expect(h.harness).toBe('codex');
    expect(h.detected).toBe(false);
    expect(h.detectedBy).toEqual([]);
    expect(h.skillsDir).toBe(join(home, '.agents', 'skills'));
    expect(existsSync(join(home, '.agents', 'skills', 'tenjin', 'SKILL.md'))).toBe(true);
  });

  it('requires --harness when no interactive prompt is available', async () => {
    const err = await caught(() => runInstall({}, makeCtx(), deps()));
    expect(err.code).toBe('USAGE');
    expect(err.message).toContain('non-interactive');
    expect(err.fix).toContain('--harness claude');
    expect(existsSync(join(home, '.claude'))).toBe(false);
    expect(existsSync(join(home, '.agents'))).toBe(false);
  });

  it('cancels before any write when the harness prompt is dismissed', async () => {
    const err = await caught(() =>
      runInstall({}, makeCtx(), deps({ isInteractive: true, promptHarnesses: async () => null })),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('before anything was written');
    expect(existsSync(join(home, '.claude'))).toBe(false);
    expect(existsSync(join(home, '.agents'))).toBe(false);
  });

  it('resolves the packaged skills itself when no source is injected', async () => {
    // Omit skillsSourceDir so runInstall resolves it from import.meta.url. Proves
    // the global-install / repo-run resolution path, not just the injected one.
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ skillsSourceDir: undefined }),
    );
    expect(asData(d).skillsSource.endsWith('skills')).toBe(true);
    expect(existsSync(join(home, '.claude', 'skills', 'tenjin', 'SKILL.md'))).toBe(true);
  });
});

describe('runInstall: dry run', () => {
  it('writes nothing and reports would-* statuses', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude', 'codex'], dryRun: true },
      makeCtx(),
      deps(),
    );
    const out = asData(d);
    expect(out.dryRun).toBe(true);
    for (const h of out.harnesses) {
      expect(h.skills.every((s) => s.status === 'would-install')).toBe(true);
    }
    // Nothing on disk.
    expect(existsSync(join(home, '.claude', 'skills'))).toBe(false);
    expect(existsSync(join(home, '.agents', 'skills'))).toBe(false);
    expect(existsSync(join(home, '.agents', 'AGENTS.md'))).toBe(false);
  });
});

describe('runInstall: the bazaarPay flag', () => {
  const payPath = () => join(home, '.claude', 'skills', 'tenjin-pay', 'SKILL.md');

  it('a run without the flag leaves it off and persists nothing', async () => {
    const { data: out } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect(asData(out).bazaarPay).toEqual({ enabled: false, status: 'unset' });
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => '{}');
    expect((JSON.parse(raw) as { bazaarPay?: boolean }).bazaarPay).toBeUndefined();
    // The lane's teaching is presence-gated: off means the skill is not there.
    expect(existsSync(payPath())).toBe(false);
  });

  it('the tenjin-pay skill is present exactly while the toggle is on', async () => {
    const first = await runInstall({ harness: ['claude'], bazaarPay: true }, makeCtx(), deps());
    expect(asData(first.data).bazaarPay).toEqual({ enabled: true, status: 'enabled' });
    expect(await readFile(payPath(), 'utf8')).toContain('name: tenjin-pay');

    // The next install honors the persisted decision without the flag...
    const second = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect(asData(second.data).bazaarPay).toEqual({ enabled: true, status: 'kept' });
    expect(existsSync(payPath())).toBe(true);

    // ...and an install after the operator turned it off removes our copy.
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({
        ...JSON.parse(await readFile(join(data, 'config.json'), 'utf8')),
        bazaarPay: false,
      }),
    );
    const third = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect(asData(third.data).bazaarPay).toEqual({ enabled: false, status: 'kept' });
    expect(existsSync(payPath())).toBe(false);
    expect(existsSync(join(home, '.claude', 'skills', 'tenjin-search', 'SKILL.md'))).toBe(true);
  });

  it('--dry-run reports the lane it would turn on and writes nothing', async () => {
    const res = await runInstall(
      { harness: ['claude'], bazaarPay: true, dryRun: true },
      makeCtx(),
      deps(),
    );
    expect(asData(res.data).bazaarPay).toEqual({ enabled: true, status: 'enabled' });
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => '{}');
    expect((JSON.parse(raw) as { bazaarPay?: boolean }).bazaarPay).toBeUndefined();
    expect(existsSync(payPath())).toBe(false);
  });
});

describe('runInstall: idempotency', () => {
  it('re-run reports up-to-date and already-present, with identical files', async () => {
    await runInstall({ harness: ['claude', 'codex'] }, makeCtx(), deps());

    const before = await readFile(join(home, '.claude', 'skills', 'tenjin', 'SKILL.md'), 'utf8');

    const second = await runInstall({ harness: ['claude', 'codex'] }, makeCtx(), deps());
    const out = asData(second.data);
    for (const h of out.harnesses) {
      expect(h.skills.every((s) => s.status === 'up-to-date')).toBe(true);
    }
    const after = await readFile(join(home, '.claude', 'skills', 'tenjin', 'SKILL.md'), 'utf8');
    expect(after).toBe(before);
  });
});

describe('runInstall: canonical overwrite', () => {
  it('overwrites a locally modified skill copy and warns', async () => {
    const dest = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'SKILL.md'), 'stale local edit\n');

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    const tenjin = h.skills.find((s) => s.name === 'tenjin');
    expect(tenjin?.status).toBe('updated');
    expect(h.warnings.length).toBeGreaterThan(0);

    const source = await readFile(join(SKILLS_SRC, 'tenjin', 'SKILL.md'), 'utf8');
    const written = await readFile(join(dest, 'SKILL.md'), 'utf8');
    expect(written).toBe(source);
  });

  // install owns the files it ships, not the directory they live in. Anything else
  // there is the operator's and is never read, listed, or removed.
  it('writes the packaged files and leaves everything else in the directory alone', async () => {
    const dest = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'SKILL.md'), 'stale\n');
    await writeFile(join(dest, 'stray.txt'), 'orphan\n');

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect(await readFile(join(dest, 'stray.txt'), 'utf8')).toBe('orphan\n');
    expect(await readFile(join(dest, 'SKILL.md'), 'utf8')).not.toBe('stale\n');
  });

  it('dry-run over a drifted copy reports would-update and warns, writing nothing', async () => {
    const dest = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'SKILL.md'), 'stale\n');

    const { data: d } = await runInstall({ harness: ['claude'], dryRun: true }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.find((s) => s.name === 'tenjin')?.status).toBe('would-update');
    expect(h.warnings.length).toBeGreaterThan(0);
    expect(await readFile(join(dest, 'SKILL.md'), 'utf8')).toBe('stale\n');
  });
});

describe('runInstall: binary skill assets', () => {
  it('round-trips a non-UTF-8 file byte-for-byte and reports it up-to-date on re-run', async () => {
    // A future skill could ship a non-text asset. Bytes below are not valid UTF-8
    // (a lone continuation byte, a lone leading byte with no continuation): decoding
    // then re-encoding via 'utf8' replaces them with U+FFFD, corrupting the file and
    // making two different corrupted binaries falsely compare equal.
    const src = await mkdtemp(join(tmpdir(), 'tenjin-install-src-'));
    for (const name of SKILL_NAMES) {
      await mkdir(join(src, name), { recursive: true });
      await writeFile(join(src, name, 'SKILL.md'), `# ${name}\n`);
    }
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x80, 0x00, 0x01]);
    await writeFile(join(src, 'tenjin', 'asset.bin'), binary);

    try {
      const { data: d } = await runInstall(
        { harness: ['claude'] },
        makeCtx(),
        deps({ skillsSourceDir: src }),
      );
      const h = asData(d).harnesses[0]!;
      expect(h.skills.find((s) => s.name === 'tenjin')?.status).toBe('installed');

      const written = await readFile(join(home, '.claude', 'skills', 'tenjin', 'asset.bin'));
      expect(written.equals(binary)).toBe(true);

      const second = await runInstall(
        { harness: ['claude'] },
        makeCtx(),
        deps({ skillsSourceDir: src }),
      );
      const h2 = asData(second.data).harnesses[0]!;
      expect(h2.skills.find((s) => s.name === 'tenjin')?.status).toBe('up-to-date');
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });
});

describe('runInstall: default PATH binary probe', () => {
  it('detects a real file on PATH but ignores a same-named directory', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'tenjin-bin-'));
    try {
      // A DIRECTORY named claude on PATH must not count as the binary.
      await mkdir(join(bin, 'claude'), { recursive: true });
      // A real FILE named codex does count.
      await writeFile(join(bin, 'codex'), '#!/bin/sh\n');
      const detected = await runInstall(
        {},
        makeCtx(),
        deps({
          isInteractive: true,
          which: undefined,
          env: { PATH: bin },
          promptHarnesses: async (choices) =>
            choices
              .filter((choice) => choice.detectedBy.length > 0)
              .map((choice) => choice.harness),
        }),
      );
      const harnesses = asData(detected.data).harnesses;
      expect(harnesses.map((h) => h.harness)).toEqual(['codex']);
      expect(harnesses[0]?.detectedBy).toEqual(['binary']);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });
});

describe('runInstall: doctor as the final step', () => {
  it('embeds the doctor summary and never throws on a doctor failure', async () => {
    const failing: DoctorChecks = {
      publishMode: 'review',
      missingModeGated: [],
      grantable: true,
      checks: [{ name: 'api', status: 'fail', required: true, detail: 'down' }],
      failure: {
        code: 'API_UNREACHABLE',
        result: { name: 'api', status: 'fail', required: true, detail: 'down' },
      },
    };
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ collectChecks: async () => failing }),
    );
    const out = asData(d) as Data & { doctor: { status: string; checks: unknown[] } };
    // Wiring still succeeded (skills on disk); doctor problem is reported, not thrown.
    expect(existsSync(join(home, '.claude', 'skills', 'tenjin', 'SKILL.md'))).toBe(true);
    expect(out.doctor.status).toBe('fail');
    expect(out.doctor.checks).toHaveLength(1);
  });

  it('passes the doctor summary through on success', async () => {
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const out = asData(d) as Data & { doctor: { status: string } };
    expect(out.doctor.status).toBe('pass');
  });

  // #101: the snapshot used to be taken right after the skills were written, so a
  // run that created a wallet still reported "No wallet". Pinned on the ORDER
  // rather than on the rendered line, because the same staleness reached
  // `data.doctor` in --json, where no amount of render-side filtering finds it.
  it('collects the checks after the wallet decision, not before', async () => {
    const order: string[] = [];
    await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => false,
        confirmWallet: async () => {
          order.push('wallet');
          return true;
        },
        createWallet: async () => {
          order.push('create');
          return '0xe4C1000000000000000000000000000000000000';
        },
        collectChecks: async () => {
          order.push('doctor');
          return okChecks;
        },
      }),
    );
    expect(order).toEqual(['wallet', 'create', 'doctor']);
  });
});

// #80: the run reads "here is what happened", then "here is what still needs
// you". The rows are the first half; the second half is one line for the doctor
// run and, only when a writer refused, the reason.
describe('runInstall: output ordering', () => {
  const human = (res: { humanLines?: string[] }): string =>
    (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

  const warning: DoctorChecks = {
    publishMode: 'review',
    missingModeGated: [],
    grantable: true,
    checks: [
      {
        name: 'search',
        status: 'warn',
        required: false,
        detail: 'A2 not deployed',
        fix: 'point baseUrl at a deploy that has it',
      },
    ],
  };

  it('puts the rows above the doctor verdict', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, collectChecks: async () => warning }),
    );
    const lines = human(res).split('\n');
    const firstRow = lines.findIndex((l) => l.startsWith('  skills'));
    const verdict = lines.findIndex((l) => l.includes('run tenjin doctor'));
    expect(firstRow).toBeGreaterThanOrEqual(0);
    expect(verdict).toBeGreaterThan(firstRow);
  });

  // The verdict is a tally, never a second copy of doctor's own render: the
  // check's detail and fix belong to `tenjin doctor`.
  it('never expands the doctor verdict into a check list', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, collectChecks: async () => warning }),
    );
    const text = human(res);
    expect(text).toContain('1 checks: 0 ok, 1 warn; run tenjin doctor');
    expect(text).not.toContain('A2 not deployed');
    expect(text).not.toContain('point baseUrl');
  });

  // The dry-run banner is not an attention item: it says what the rest of the
  // output means, so it stays on top of the thing it qualifies.
  it('keeps the dry-run banner above the headline', async () => {
    const res = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const lines = human(res).split('\n');
    expect(lines[0]).toContain('Dry run');
    expect(lines.findIndex((l) => l.includes('tenjin is wired for'))).toBeGreaterThan(0);
  });

  // A writer that refused is the one thing the rows cannot say in their own
  // words, so it prints under them. The string quotes bytes out of the
  // operator's settings file, so it is sanitized on the way through.
  it('prints a refusing writer under the rows', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeSettingsPath(home), '\x1b[2K\x1b[1G not json');
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const lines = human(res).split('\n');
    const warn = lines.findIndex((l) => l.startsWith('! '));
    expect(warn).toBeGreaterThan(lines.findIndex((l) => l.startsWith('  wallet')));
    expect(lines[warn]).not.toContain('\x1b');
  });
});

// Every settled selection is the user's answer about which real harnesses this
// machine wires. Doctor keeps judging those directories on later runs.
describe('runInstall: recording the harness selection', () => {
  async function recorded(): Promise<string[] | undefined> {
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { install?: { harness?: string[] } }).install?.harness;
  }

  it('records the requested targets', async () => {
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    expect(await recorded()).toEqual(['codex']);
  });

  it('records the de-duplicated harness set, matching what was wired', async () => {
    await runInstall({ harness: ['codex', 'codex'] }, makeCtx(), deps());
    expect(await recorded()).toEqual(['codex']);
  });

  it('a later explicit run REPLACES the record rather than unioning', async () => {
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    // The way out of a mistaken --harness is re-running install with the right one.
    expect(await recorded()).toEqual(['claude']);
  });

  it('an explicit run replaces a migrated legacy shared record', async () => {
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ install: { harness: ['shared', 'codex'] } }),
    );
    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect(await recorded()).toEqual(['claude']);
  });

  it('records a selection made through detection and the prompt', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await runInstall(
      {},
      makeCtx(),
      deps({ isInteractive: true, promptHarnesses: async () => ['claude'] }),
    );
    expect(await recorded()).toEqual(['claude']);
  });

  it('a later prompted selection replaces an earlier explicit record', async () => {
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    await mkdir(join(home, '.claude'), { recursive: true });
    await runInstall(
      {},
      makeCtx(),
      deps({ isInteractive: true, promptHarnesses: async () => ['claude'] }),
    );
    expect(await recorded()).toEqual(['claude']);
  });

  it('--dry-run records nothing, like the publish-mode write', async () => {
    await runInstall({ harness: ['codex'], dryRun: true }, makeCtx(), deps());
    expect(await recorded()).toBeUndefined();
  });

  it('the record is merged, never an overwrite of a sibling block', async () => {
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ publish: { mode: 'auto' }, evalCohort: true }),
    );
    await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const json = JSON.parse(await readFile(join(data, 'config.json'), 'utf8')) as {
      install?: { harness?: string[] };
      publish?: { mode?: string };
      evalCohort?: boolean;
    };
    expect(json.install?.harness).toEqual(['codex']);
    expect(json.publish?.mode).toBe('auto');
    expect(json.evalCohort).toBe(true);
  });
});

describe('runInstall: publish-mode selection', () => {
  type ModeData = { publishMode: { value: string; source: string } };
  const modeOf = (d: unknown) => (d as ModeData).publishMode;

  async function persistedMode(): Promise<string | undefined> {
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { publish?: { mode?: string } }).publish?.mode;
  }

  function promptSpy(answers: (string | null)[]): {
    fn: PromptPublishModeFn;
    calls: () => number;
  } {
    let i = 0;
    let n = 0;
    return {
      calls: () => n,
      fn: async () => {
        n++;
        return (answers[i++] ?? null) as Awaited<ReturnType<PromptPublishModeFn>>;
      },
    };
  }

  // This select is the whole consent moment, so the `auto` hint carries both
  // consequences: the agent publishes as you, and the harness allowlist gains the
  // two verbs that lets it.
  it('offers auto first, with both consequences on one line', () => {
    expect(PUBLISH_MODE_CHOICES.map((c) => c.value)).toEqual(['auto', 'review', 'full-auto']);
    expect(PUBLISH_MODE_CHOICES[0]!.label).toBe('Auto (recommended)');
    expect(PUBLISH_MODE_CHOICES[0]!.hint).toBe(
      'your agent publishes and updates pieces on its own, under your identity; it also allows `tenjin publish` and `tenjin edit` in the harness',
    );
    // The clause that used to end this hint promised a harness prompt in front of
    // every publish, which this same mode writes a rule to remove.
    for (const c of PUBLISH_MODE_CHOICES) {
      const hint: string = 'hint' in c ? c.hint : '';
      expect(hint).not.toMatch(/approval/i);
    }
    expect(PUBLISH_MODE_CHOICES[1]!.label).toBe('Ask me in chat first');
    expect(PUBLISH_MODE_CHOICES[2]!.label).toBe('Fully unattended');
  });

  it('persists the recommended auto when it is chosen (source prompt)', async () => {
    const spy = promptSpy(['auto']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(1);
    expect(modeOf(d)).toEqual({ value: 'auto', source: 'prompt' });
    expect(await persistedMode()).toBe('auto');
  });

  it('persists review when it is chosen', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: async () => 'review' }),
    );
    expect(modeOf(d)).toEqual({ value: 'review', source: 'prompt' });
    expect(await persistedMode()).toBe('review');
  });

  it('persists full-auto when it is chosen', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: async () => 'full-auto' }),
    );
    expect(modeOf(d)).toEqual({ value: 'full-auto', source: 'prompt' });
    expect(await persistedMode()).toBe('full-auto');
  });

  it('a cancelled select keeps review WITHOUT writing (provenance stays default)', async () => {
    const spy = promptSpy([null]); // ctrl-C / escape
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(1);
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined(); // no config write
  });

  it('never writes an answer it cannot parse', async () => {
    const spy = promptSpy(['someday']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined();
  });

  // Headless SETTLES the recommended mode rather than leaving the key unset, so
  // "non-interactive is an interactive all-yes" is true of publishing too.
  it('settles and persists the recommended auto on a non-interactive run, with no prompt', async () => {
    const spy = promptSpy(['review']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: false, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(0);
    expect(modeOf(d)).toEqual({ value: 'auto', source: 'headless-default' });
    expect(await persistedMode()).toBe('auto');
  });

  // The headless settle is the SAME answer the interactive select recommends; if
  // one moves without the other, the parity claim quietly stops being true.
  it('settles the mode the interactive select recommends', async () => {
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect(modeOf(d).value).toBe(PUBLISH_MODE_CHOICES[0].value);
  });

  it('respects an already-configured mode headlessly, writing nothing new', async () => {
    await runInstall({ harness: ['claude'], publishMode: 'review' }, makeCtx(), deps());
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect(modeOf(d)).toEqual({ value: 'review', source: 'existing' });
    expect(await persistedMode()).toBe('review');
  });

  it('lets --publish-mode win over the headless settle', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'], publishMode: 'full-auto' },
      makeCtx(),
      deps(),
    );
    expect(modeOf(d)).toEqual({ value: 'full-auto', source: 'flag' });
    expect(await persistedMode()).toBe('full-auto');
  });

  it('a dry run settles nothing and reports the untouched default', async () => {
    const { data: d } = await runInstall({ harness: ['claude'], dryRun: true }, makeCtx(), deps());
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined();
  });

  it('does not prompt when a global mode is already configured (source existing)', async () => {
    await writeFile(join(data, 'config.json'), JSON.stringify({ publish: { mode: 'review' } }));
    const spy = promptSpy(['full-auto']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(0);
    expect(modeOf(d)).toEqual({ value: 'review', source: 'existing' });
    expect(await persistedMode()).toBe('review'); // untouched
  });

  it('--publish-mode sets it non-interactively and suppresses the prompt', async () => {
    const spy = promptSpy(['review']);
    const { data: d } = await runInstall(
      { harness: ['claude'], publishMode: 'full-auto' },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(0);
    expect(modeOf(d)).toEqual({ value: 'full-auto', source: 'flag' });
    expect(await persistedMode()).toBe('full-auto');
  });

  it('--publish-mode rejects a bad value as USAGE', async () => {
    const err = await caught(() =>
      runInstall({ harness: ['claude'], publishMode: 'someday' }, makeCtx(), deps()),
    );
    expect(err.code).toBe('USAGE');
  });

  it('--dry-run with --publish-mode is would-set (no write)', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'], dryRun: true, publishMode: 'review' },
      makeCtx(),
      deps(),
    );
    expect(modeOf(d)).toEqual({ value: 'review', source: 'flag' });
    expect(await persistedMode()).toBeUndefined(); // dry run wrote nothing
  });

  it('--dry-run does not prompt, and opens no frame for the questions it skips', async () => {
    const spy = promptSpy(['review']);
    let frames = 0;
    const { data: d } = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx(),
      deps({
        isInteractive: true,
        promptPublishMode: spy.fn,
        intro: async () => {
          frames += 1;
        },
      }),
    );
    expect(spy.calls()).toBe(0);
    expect(frames).toBe(0);
    expect(modeOf(d)).toEqual({ value: 'review', source: 'default-skipped' });
    expect(await persistedMode()).toBeUndefined();
  });

  it('--json implies non-interactive: no prompt even on a TTY', async () => {
    const spy = promptSpy(['review']);
    const { data: d } = await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps({ isInteractive: true, promptPublishMode: spy.fn }), // json overrides isInteractive
    );
    expect(spy.calls()).toBe(0);
    expect(modeOf(d)).toEqual({ value: 'auto', source: 'headless-default' });
    expect(await persistedMode()).toBe('auto');
  });

  it('--json still honors --publish-mode', async () => {
    const { data: d } = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx({ json: true }),
      deps(),
    );
    expect(modeOf(d)).toEqual({ value: 'review', source: 'flag' });
    expect(await persistedMode()).toBe('review');
  });
});

describe('runInstall: the ten rows', () => {
  const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

  // install is human-first: it returns the walkthrough as humanLines (the
  // dispatcher prints them at a TTY). Read them here, ANSI-stripped.
  const human = (res: { humanLines?: string[] }): string =>
    (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
  const walletOf = (d: unknown) =>
    (d as { wallet: { status: string; address?: string; reason?: string; fix?: string } }).wallet;

  /**
   * The whole human output of a clean install, pinned as a shape rather than as
   * substrings: a headline, five aligned facts, the way back out, and the
   * doctor's verdict. Anything that wants a sixth paragraph fails here.
   */
  it('is a headline, five rows, an undo and a doctor line', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        promptPublishMode: async () => 'auto',
        confirmWallet: async () => true,
      }),
    );
    const lines = human(res).split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('tenjin is wired for Claude Code.');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe(`  skills       3 in ${join(home, '.claude', 'skills')}`);
    expect(lines[3]).toBe(
      `  permissions  ${FREE_VERB_RULES.length + MODE_GATED_RULES.length} tenjin commands in ${claudeSettingsPath(home)}`,
    );
    // The arms and the one command that changes them. The entry count and the
    // port live in `tenjin doctor`, under Hooks.
    expect(lines[4]).toBe('  hooks        7 enabled; change: tenjin hooks disable <arm>');
    expect(lines[5]).toBe('  publishing   auto - your agent publishes under your identity');
    expect(lines[6]).toBe(`  wallet       ${STUB_ADDRESS}, $0 - fund with: tenjin wallet fund`);
    expect(lines[7]).toBe('');
    expect(lines[8]).toBe(
      'Restart Claude Code to load the hooks. Undo everything: tenjin uninstall',
    );
    expect(lines[9]).toBe('tenjin doctor: 1 checks, all pass.');
  });

  // The labels are a column, so the facts beside them line up. A row that
  // formats its own label would drift the moment a label changes length.
  it('aligns every row on one column', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const columns = human(res)
      .split('\n')
      .filter((l) => l.startsWith('  '))
      .map((l) => l.length - l.replace(/^ {2}\S+\s+/, '').length);
    expect(new Set(columns).size).toBe(1);
  });

  // The restart is what makes the entries live, and it is only true of a run
  // that wired some: hooks are read once at session start.
  it('names the restart only when entries were registered', async () => {
    const wired = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(human(wired)).toContain('Restart Claude Code to load the hooks.');

    const none = await runInstall(
      { harness: ['claude'], noHooks: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(human(none)).not.toContain('Restart Claude Code');
    expect(human(none)).toContain('Undo everything: tenjin uninstall');
    expect(human(none)).toContain('hooks        none registered (--no-hooks)');
  });

  /**
   * The prose the rows replaced: what the entries POST, what leaves the machine,
   * where the keystore lives, an undo per item. It is reference material an
   * operator meets once and cannot act on mid-install, so it lives in
   * docs/agent-permissions.md and in the `--json` envelope. Pinned negatively
   * because a paragraph is exactly the thing that creeps back one sentence at a
   * time.
   */
  it('prints no disclosure paragraph, no per-item undo, and no doctor check list', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const text = human(res);
    expect(text).not.toContain('Wired 11 hook entries');
    expect(text).not.toContain('the query text leaves the machine');
    expect(text).not.toContain('keystore v3');
    expect(text).not.toContain('Undo anytime');
    expect(text).not.toContain('Next: tenjin search');
    expect(text).not.toContain('Some checks need attention');
    // No rule string, in any form: an operator meeting one mid-install cannot
    // act on it.
    expect(text).not.toMatch(/Bash\(/);
    for (const e of ALWAYS_SAFE_ALLOWLIST) expect(text).not.toContain(e.rule);
    for (const e of NEVER_ALLOWLISTED) {
      const verb = (e.command.split(' / ')[0] ?? e.command).replace(/^tenjin /, '');
      expect(text).not.toMatch(new RegExp(`Bash\\(tenjin ${verb}[^)]*\\)`));
    }
  });

  // The wording pin the old allowlist block carried, kept alive now that the
  // block itself is gone. lib/permissions.ts refuses to call this tier
  // read-only, and the consent surface must not claim what the module it draws
  // from will not: `search` and `outcome` POST off-machine, `read` writes to the
  // library and can present a wallet-derived delegation, and two of the nine
  // rules are `wallet show` / `wallet balance`.
  it('never calls the free tier read-only, and never claims it cannot touch your wallet', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const auto = PUBLISH_MODE_CHOICES.find((c) => c.value === 'auto');
    for (const text of [human(res), auto?.hint ?? '']) {
      expect(text).not.toMatch(/read-only/i);
      expect(text).not.toMatch(/touch your wallet/i);
      expect(text).not.toMatch(/free, read-only verbs/i);
    }
  });

  // The count is every rule of ours in the file, and the word "free" is gone with
  // the line that needed it: a count that excluded the pair under-reported what
  // just landed.
  it('counts every rule of ours on the permissions row', async () => {
    const rowFor = async (mode: PublishMode): Promise<string> => {
      const res = await runInstall(
        { harness: ['claude'], publishMode: mode },
        makeCtx(),
        deps({ isInteractive: true }),
      );
      return (
        human(res)
          .split('\n')
          .find((l) => l.includes('permissions')) ?? ''
      );
    };

    const review = await rowFor('review');
    expect(review).toContain(`${FREE_VERB_RULES.length} tenjin commands in`);
    expect(review).not.toMatch(/free/i);

    await rm(claudeSettingsPath(home), { force: true });
    const auto = await rowFor('auto');
    expect(auto).toContain(
      `${FREE_VERB_RULES.length + MODE_GATED_RULES.length} tenjin commands in`,
    );
  });

  // The footprint is gone: a harness already loads every skill's frontmatter
  // description at session start, so a pointer line only duplicated it.
  it('writes no CLAUDE.md at all, and says nothing about a nudge', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    expect(existsSync(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
    const text = human(res);
    expect(text).not.toContain('nudge');
    expect(text).not.toContain(MARKER_COMMENT);
  });

  /** `install` never wrote this file, so it never edits one the operator owns:
   *  a CLAUDE.md carrying a pointer line from an older version is left exactly
   *  as it is. */
  it('leaves an operator CLAUDE.md byte for byte', async () => {
    const claudeMd = join(home, '.claude', 'CLAUDE.md');
    await mkdir(dirname(claudeMd), { recursive: true });
    const before = `# My notes\n${MARKER_COMMENT} Tenjin: old text\n## More notes\n`;
    await writeFile(claudeMd, before);

    await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    expect(await readFile(claudeMd, 'utf8')).toBe(before);
  });

  /** A re-run registers the same eleven and says so rather than reporting zero. */
  it('reports the arms that answer, not the entries, on a run that changed nothing', async () => {
    await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const text = human(
      await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true })),
    );
    expect(text).not.toContain('entries');
    expect(text).toContain('hooks        7 enabled; change: tenjin hooks disable <arm>');
  });

  // The row counts what config says, so a machine that turned two arms off says
  // so rather than repeating the default at every operator who reads it.
  it('counts only the arms config leaves on', async () => {
    await writeFile(
      configPath(data),
      JSON.stringify({ hooks: { 'web-search': false, primer: false } }),
    );
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    expect(human(res)).toContain('hooks        5 enabled; change: tenjin hooks disable <arm>');
  });

  it('--json carries the same three tiers in the machine payload', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps({ isInteractive: true }),
    );
    const d = asData(res.data) as Data & {
      permissions: { alwaysSafe: { rule: string }[]; optIn: { rule: string }[] };
    };
    expect(d.permissions.alwaysSafe.map((e) => e.rule)).toEqual(
      ALWAYS_SAFE_ALLOWLIST.map((e) => e.rule),
    );
    expect(d.permissions.optIn.map((e) => e.rule)).toEqual([
      'Bash(tenjin buy:*)',
      'Bash(tenjin pay:*)',
    ]);
  });

  it('--json returns the envelope data and never prompts the wallet', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps({ isInteractive: true, confirmWallet: confirm, walletExists: async () => false }),
    );
    expect(res.humanLines ?? []).toHaveLength(0); // machine path: no walkthrough
    const d = asData(res.data) as Data & { publishMode: unknown };
    expect(d.harnesses[0]!.harness).toBe('claude');
    expect(d.publishMode).toBeDefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('creates a wallet on yes and shows the address and the funding command', async () => {
    const create = vi.fn(async () => ADDR);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => false,
        confirmWallet: async () => true,
        createWallet: create,
      }),
    );
    expect(create).toHaveBeenCalledOnce();
    expect(human(res)).toContain(`wallet       ${ADDR}, $0 - fund with: tenjin wallet fund`);
  });

  it('declining the wallet prompt shows the create-later row, no create', async () => {
    const create = vi.fn(async () => ADDR);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => false,
        confirmWallet: async () => false,
        createWallet: create,
      }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(human(res)).toContain('wallet       none - create with: tenjin wallet create');
  });

  it('--no-wallet skips the wallet prompt entirely', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'], noWallet: true },
      makeCtx(),
      deps({ isInteractive: true, confirmWallet: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    // An opt-out is a `skipped` state with its reason and a remedy, not a
    // `declined` answer: nobody said no, the flag said never ask.
    expect(human(res)).toContain('wallet       none (flag)');
    expect(walletOf(res.data)).toMatchObject({ status: 'skipped', reason: 'flag' });
    expect(walletOf(res.data).fix).toContain('tenjin wallet create');
  });

  it('shows an existing wallet address without prompting', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => true,
        walletAddress: async () => ADDR,
        confirmWallet: confirm,
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(human(res)).toContain(`wallet       ${ADDR} (existing)`);
  });

  it('a TTY with no stdin renders the rows with defaults, no prompt', async () => {
    // humanOutput true (io.isTTY, no --json), but canPrompt false (stdin is not a
    // TTY in the test runner and no isInteractive override): default mode, no
    // wallet prompt, still the full ten rows.
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    const ttyCtx: CommandContext = {
      flags: { json: false, timeout: 10000 },
      dataDir: data,
      io: { stdout: sink(), stderr: sink(), isTTY: true },
    };
    const prompt = vi.fn(async () => 'review' as const);
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      ttyCtx,
      deps({ promptPublishMode: prompt, confirmWallet: confirm, walletExists: async () => false }),
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    // No prompt possible, so publishing settles the recommended mode too.
    expect(human(res)).toContain('publishing   auto');
    // No prompt, but a wallet all the same: a run nobody can answer takes the
    // default rather than treating silence as a no.
    expect(human(res)).toContain(`wallet       ${STUB_ADDRESS}, $0`);
  });

  /**
   * One line for the embedded doctor run, whatever it found. A clean machine
   * says so; a machine with a warn or a fail gets the tally and the command that
   * explains it, and never a second copy of every check.
   */
  it('reports the doctor run as one line, pass or not', async () => {
    const okRes = await runInstall(
      { harness: ['claude'], noHooks: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(human(okRes)).toContain('tenjin doctor: 1 checks, all pass.');

    const mixed: DoctorChecks = {
      publishMode: 'review',
      missingModeGated: [],
      grantable: true,
      checks: [
        { name: 'node', status: 'ok', required: true, detail: '24.4.0' },
        { name: 'balance', status: 'warn', required: false, detail: '$0.00 USDC' },
        {
          name: 'api',
          status: 'fail',
          required: true,
          detail: 'unreachable',
          fix: 'check the base URL',
        },
      ],
      failure: {
        code: 'API_UNREACHABLE',
        result: { name: 'api', status: 'fail', required: true, detail: 'unreachable' },
      },
    };
    const failRes = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, collectChecks: async () => mixed }),
    );
    const text = human(failRes);
    expect(text).toContain('3 checks: 1 ok, 1 warn, 1 fail; run tenjin doctor');
    // The checks themselves are doctor's to print, not install's.
    expect(text).not.toContain('unreachable');
    expect(text).not.toContain('check the base URL');
  });

  it('emits no internal jargon (no "roadmap") in the data or walkthrough', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    expect(JSON.stringify(res.data).toLowerCase()).not.toContain('roadmap');
  });
});

// --- Decision 2: the harness permission allowlist ---------------------------------

describe('runInstall: permissions decision', () => {
  type WiredData = {
    permissions: {
      alwaysSafe: { rule: string }[];
      modeGated: { rule: string }[];
      wired: {
        harness: string;
        path?: string;
        added: string[];
        alreadyPresent: string[];
        addedFree: string[];
        alreadyPresentFree: string[];
        planned?: boolean;
        modeGrant?: { rules: string[]; state: string; disclosure: string; undo: string[] };
        removed: string[];
        skipped?: string;
        warning?: string;
        fix?: string;
      };
    };
  };
  const wiredOf = (d: unknown) => (d as WiredData).permissions.wired;
  const human = (res: { humanLines?: string[] }): string =>
    (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

  async function allowList(): Promise<unknown[] | undefined> {
    const raw = await readFile(claudeSettingsPath(home), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { permissions?: { allow?: unknown[] } }).permissions?.allow;
  }

  /** Seed ~/.claude/settings.json; a string is written verbatim (malformed cases). */
  async function writeSettings(contents: unknown): Promise<void> {
    const path = claudeSettingsPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
    );
  }

  // No question of its own any more: the publish-mode select carries the consent,
  // so an interactive run writes the rules and names them on one row.
  it('writes the allowlist at a TTY and says so in one row', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    expect(wiredOf(res.data).added).toEqual([...FREE_VERB_RULES]);
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
    expect(human(res)).toContain(
      `permissions  ${FREE_VERB_RULES.length} tenjin commands in ${claudeSettingsPath(home)}`,
    );
  });

  it('works under --json and reports the write in the envelope', async () => {
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx({ json: true }),
      deps({ isInteractive: true }),
    );
    expect(res.humanLines ?? []).toHaveLength(0);
    const wired = wiredOf(res.data);
    expect(wired.harness).toBe('claude');
    expect(wired.path).toBe(claudeSettingsPath(home));
    expect(wired.added).toEqual([...FREE_VERB_RULES]);
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
  });

  // The inversion #33 was really asking for: the machine most likely to be denied
  // mid-task is the headless one, and there is nobody there to say yes.
  it('a non-interactive run wires the allowlist by default, with no flag', async () => {
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx({ json: true }),
      deps(),
    );
    expect(wiredOf(res.data).added).toEqual([...FREE_VERB_RULES]);
    expect(wiredOf(res.data).skipped).toBeUndefined();
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
  });

  it('--no-allow-free-verbs is the opt-out and writes nothing', async () => {
    const res = await runInstall(
      { harness: ['claude'], noAllowFreeVerbs: true },
      makeCtx({ json: true }),
      deps(),
    );
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'declined', added: [] });
    expect(await allowList()).toBeUndefined();
  });

  async function declinedList(): Promise<string[] | undefined> {
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { install?: { freeVerbsDeclined?: string[] } }).install
      ?.freeVerbsDeclined;
  }

  // tenjin-agent#234, per-rule fix: a decline records the EXACT rules that were
  // pending, not a flag that suppresses everything forever.
  it('--no-allow-free-verbs persists the exact rules that were pending', async () => {
    await runInstall(
      { harness: ['claude'], noAllowFreeVerbs: true, publishMode: 'review' },
      makeCtx({ json: true }),
      deps(),
    );
    expect(await declinedList()).toEqual([...FREE_VERB_RULES]);
  });

  /**
   * Greptile P1 #1: the satisfied-early-return in `resolvePermissions` used to
   * return before ever touching `install.freeVerbsDeclined`, so a decline
   * recorded on one run survived a grant made an entirely different way (a
   * hand-edit, another tool, or `tenjin uninstall` and reinstall of just the
   * settings file) — the next refresh kept nagging about rules the settings
   * file plainly already had. A satisfied state must clear the record.
   */
  it('a satisfied file clears a stale decline, even when satisfied by hand', async () => {
    await runInstall(
      { harness: ['claude'], noAllowFreeVerbs: true, publishMode: 'review' },
      makeCtx(),
      deps(),
    );
    expect(await declinedList()).toEqual([...FREE_VERB_RULES]);

    // Granted by some means entirely outside `install` — nothing this CLI wrote.
    await writeSettings({ permissions: { allow: [...FREE_VERB_RULES] } });

    // A bare re-run finds it already satisfied.
    const res = await runInstall({ harness: ['claude'], publishMode: 'review' }, makeCtx(), deps());
    expect(wiredOf(res.data).added).toEqual([]);
    expect(await declinedList()).toEqual([]);
  });

  /**
   * Greptile P1 #2: a boolean decline suppressed every future pending rule
   * forever, so a later version's genuinely NEW suggestion was silently never
   * reported. The per-rule list must let a new rule through while an old
   * decline stays quiet — proven end to end via `--refresh` in the
   * `runInstall --refresh` suite below.
   */
  it('a later grant clears the declined list entirely', async () => {
    await runInstall(
      { harness: ['claude'], noAllowFreeVerbs: true, publishMode: 'review' },
      makeCtx(),
      deps(),
    );
    expect((await declinedList())?.length).toBeGreaterThan(0);

    await runInstall({ harness: ['claude'], publishMode: 'review' }, makeCtx(), deps());
    expect(await declinedList()).toEqual([]);
  });

  /**
   * Greptile P1 (tenjin-agent#272): the grant branch used to clear
   * `freeVerbsDeclined` BEFORE `wireFreeVerbAllowlist` returned, so a refused
   * settings write left the rules absent but the record erased — reopening
   * exactly the #234 bug this changeset fixes (a settled decline recomputed as
   * pending on every later refresh) for the one machine that can least repair
   * it: one where the write itself keeps failing. Race the grant's own write
   * out from under it with the same settings-interleave hook `changed-since-read`
   * uses elsewhere in this file, and check the decline survives the refusal
   * and a follow-up refresh still honors it rather than re-nagging.
   */
  it('a failed grant leaves the decline on record, so refresh keeps honoring it', async () => {
    await writeSettings({ permissions: { allow: [] } });
    await runInstall(
      { harness: ['claude'], noAllowFreeVerbs: true, publishMode: 'auto' },
      makeCtx(),
      deps({ which: (bin) => bin === 'claude' }),
    );
    const declinedBefore = await declinedList();
    expect(declinedBefore?.length).toBeGreaterThan(0);

    // The file changes the instant the grant's own snapshot read returns, so
    // its later current-vs-raw compare sees a moved file and refuses to write.
    fsHooks.settingsInterleave = `${JSON.stringify({ permissions: { allow: [] }, theirs: 1 }, null, 2)}\n`;
    fsHooks.settingsInterleaveOnRead = 2;
    fsHooks.settingsReads = 0;
    let res;
    try {
      res = await runInstall(
        { harness: ['claude'], publishMode: 'auto' },
        makeCtx(),
        deps({ which: (bin) => bin === 'claude' }),
      );
    } finally {
      fsHooks.settingsInterleave = '';
      fsHooks.settingsReads = 0;
      fsHooks.settingsInterleaveOnRead = 1;
    }
    expect(wiredOf(res.data).skipped).toBe('changed-since-read');
    // The rules never landed...
    expect(await allowList()).toEqual([]);
    // ...and the refusal must not have erased the record that told the
    // operator so: it survives exactly as it was.
    expect(await declinedList()).toEqual(declinedBefore);

    // A follow-up refresh must still honor that surviving record rather than
    // re-nagging: with the decline erased (the bug), these rules would be
    // recomputed as freshly pending on every refresh, which is the #234
    // regression this whole changeset exists to close.
    const refreshRes = await runInstall(
      { refresh: true },
      makeCtx(),
      deps({ which: (bin) => bin === 'claude' }),
    );
    const pending = (refreshRes.data as { permissions: { pending: string[] } }).permissions.pending;
    for (const rule of declinedBefore ?? []) expect(pending).not.toContain(rule);
  });

  // Every skipped state names the command that changes it, the same contract a
  // CliError's `fix` carries, so a machine consumer never has to parse prose.
  it('carries a fix string on every skipped permissions state', async () => {
    const declined = await runInstall(
      { harness: ['claude'], noAllowFreeVerbs: true },
      makeCtx({ json: true }),
      deps(),
    );
    expect(wiredOf(declined.data).fix).toContain('tenjin install');

    const dry = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx({ json: true }),
      deps(),
    );
    expect(wiredOf(dry.data).fix).toContain('tenjin install');

    // Codex's is the exception that proves the contract: no `tenjin` command
    // turns this skip into a Claude write, because Codex's grant landed in its
    // own file. Naming `tenjin doctor` here sent operators to a page of Claude
    // rules and let them read those as their own (tenjin-agent#342).
    const codex = await runInstall({ harness: ['codex'] }, makeCtx({ json: true }), deps());
    expect(wiredOf(codex.data).fix).toMatch(/codex/i);
    expect(wiredOf(codex.data).fix).not.toContain('tenjin doctor');
  });

  // The old headless arm returned an empty pair whatever the file held, so a
  // re-run against an already-permissioned home reported nothing at all.
  it('reports alreadyPresent accurately on a headless re-run', async () => {
    const args = { harness: ['claude'], publishMode: 'review' };
    await runInstall(args, makeCtx({ json: true }), deps());
    const res = await runInstall(args, makeCtx({ json: true }), deps());
    expect(wiredOf(res.data).added).toEqual([]);
    expect(wiredOf(res.data).alreadyPresent).toEqual([...FREE_VERB_RULES]);
  });

  it('is idempotent: a second run adds nothing and reports already-present', async () => {
    const args = { harness: ['claude'], publishMode: 'review' };
    await runInstall(args, makeCtx(), deps());
    const res = await runInstall(args, makeCtx(), deps({ isInteractive: true }));
    expect(wiredOf(res.data).added).toEqual([]);
    expect(wiredOf(res.data).alreadyPresent).toEqual([...FREE_VERB_RULES]);
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
    expect(human(res)).toContain(`${FREE_VERB_RULES.length} tenjin commands in`);
  });

  // Re-running install is the advice for refreshing a stale setup, so this is the
  // ordinary second-run path, not an edge case.
  it('adds nothing once every rule is already allowed', async () => {
    await runInstall({ harness: ['claude'], publishMode: 'review' }, makeCtx(), deps());
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(wiredOf(res.data)).toMatchObject({ added: [], alreadyPresent: [...FREE_VERB_RULES] });
    expect(human(res)).toContain(`${FREE_VERB_RULES.length} tenjin commands in`);
  });

  // The satisfied path must not perform a SECOND read: re-reading meant a rule
  // revoked between probe and write was silently re-added.
  it('reports the probe snapshot and writes nothing if a rule is revoked mid-run', async () => {
    await runInstall({ harness: ['claude'], publishMode: 'review' }, makeCtx(), deps());
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx(),
      deps({
        isInteractive: true,
        // Probe says satisfied; the file loses a rule immediately afterwards.
        inspectPermissions: async (h) => {
          const out = await inspectFreeVerbRules(h);
          await writeSettings({ permissions: { allow: [...FREE_VERB_RULES.slice(1)] } });
          return out;
        },
      }),
    );
    expect(wiredOf(res.data).added).toEqual([]);
    // The revoked rule stays revoked: no second read, no silent re-grant.
    expect(await allowList()).toEqual([...FREE_VERB_RULES.slice(1)]);
  });

  // The summary must not tell the operator to fix a healthy file, or to re-run with
  // a flag that is not the remedy. The warning beside it already says the right
  // thing, so the two lines used to disagree.
  it('says what to do when the settings file moved under the write', async () => {
    await writeSettings({ model: 'opus', permissions: { allow: [] } });
    // Read 1 is the review retraction's own look at the file, read 2 the consent
    // probe, read 3 the writer's snapshot — and only a change after THAT one is
    // the window the guard exists for.
    fsHooks.settingsInterleave = `${JSON.stringify({ model: 'opus', theirs: 1 }, null, 2)}\n`;
    fsHooks.settingsInterleaveOnRead = 3;
    fsHooks.settingsReads = 0;
    let res;
    try {
      res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    } finally {
      fsHooks.settingsInterleave = '';
      fsHooks.settingsReads = 0;
      fsHooks.settingsInterleaveOnRead = 1;
    }
    expect(wiredOf(res.data).skipped).toBe('changed-since-read');
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain('changed mid-write, nothing written');
    expect(text).toContain('re-run: tenjin install');
    expect(text).not.toContain('was left untouched');
  });

  it('adds only the rules that are missing', async () => {
    await writeSettings({ permissions: { allow: [FREE_VERB_RULES[0]] } });
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    expect(wiredOf(res.data).added).toEqual(FREE_VERB_RULES.slice(1));
  });

  // A file we cannot read is not "already allowed": the probe returns null and the
  // writer is still called, so it gets to report why nothing was written.
  it('reaches the writer when the settings file cannot be parsed', async () => {
    await writeSettings('not json at all');
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'auto' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'unparsable' });
  });

  // Under `review` the retraction runs first and reads the same file, so an
  // unreadable one is settled there: nothing can be written either way, and what
  // the operator gets instead is the pair named, with the command that always
  // works.
  it('settles an unreadable file under review, and names the pair', async () => {
    await writeSettings('not json at all');
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'unparsable' });
    const fix = wiredOf(res.data).fix ?? '';
    for (const rule of MODE_GATED_RULES) expect(fix).toContain(rule);
    expect(fix).toContain('tenjin uninstall');
  });

  it('--dry-run writes nothing', async () => {
    const res = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'dry-run' });
    expect(await allowList()).toBeUndefined();
  });

  /**
   * A dry run reported the allowlist as a bare `dry-run` skip: empty `added`, no
   * `modeGrant`. An operator dry-running for exactly one reason, to find out
   * whether `publish` and `edit` would be granted, learned nothing. It now fills
   * the same fields with the plan and flags them `planned`.
   */
  it('--dry-run reports the rules it WOULD write, grant included', async () => {
    const res = await runInstall(
      { harness: ['claude'], dryRun: true, publishMode: 'auto' },
      makeCtx({ json: true }),
      deps(),
    );
    const wired = wiredOf(res.data);
    expect(wired.planned).toBe(true);
    expect(wired.skipped).toBe('dry-run');
    expect(wired.added).toEqual([...FREE_VERB_RULES, ...MODE_GATED_RULES]);
    expect(wired.addedFree).toEqual([...FREE_VERB_RULES]);
    // The grant an operator dry-runs to find out about, with the same disclosure
    // and undos a real run would carry.
    expect(wired.modeGrant?.rules).toEqual([...MODE_GATED_RULES]);
    expect(wired.modeGrant?.disclosure).toContain('publish.mode auto');
    expect(wired.modeGrant?.undo).toHaveLength(3);
    // In the future tense: the `planned` flag alone left the one string a reader
    // quotes back claiming the rules had landed.
    expect(wired.modeGrant?.disclosure).toContain('would be added');
    expect(wired.modeGrant?.disclosure).not.toMatch(/\)\sadded:/);
    // And still nothing on disk.
    expect(await allowList()).toBeUndefined();
  });

  /**
   * A dry run fills `removed` with what a real run WOULD take back, so the
   * retraction sentence has to be future tense here and "otherwise unchanged" has
   * to not fire: on a fully-wired machine the line said "otherwise unchanged (dry
   * run)" on a run that changed nothing, qualifying against a retraction it never
   * named. The three existing dry-run tests all miss it — two run real installs,
   * and the third starts from a file with no mode-gated rules, so `wouldRemove` is
   * empty there.
   */
  it('--dry-run on review reports the planned retraction in the future tense', async () => {
    await writeSettings({
      permissions: { allow: [...FREE_VERB_RULES, PUBLISH_MODE_RULE, EDIT_MODE_RULE] },
    });
    const res = await runInstall(
      { harness: ['claude'], dryRun: true, publishMode: 'review' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const line =
      human(res)
        .split('\n')
        .find((l) => l.includes('permissions')) ?? '';
    // Future tense: past tense belongs to a run that actually wrote.
    expect(line).toContain('2 to remove');
    expect(line).not.toContain('2 removed');
    expect(await allowList()).toEqual([...FREE_VERB_RULES, PUBLISH_MODE_RULE, EDIT_MODE_RULE]);
  });

  it('--dry-run on review plans the free tier only, and no grant', async () => {
    const res = await runInstall(
      { harness: ['claude'], dryRun: true, publishMode: 'review' },
      makeCtx({ json: true }),
      deps(),
    );
    const wired = wiredOf(res.data);
    expect(wired.added).toEqual([...FREE_VERB_RULES]);
    expect(wired.modeGrant).toBeUndefined();
    expect(await allowList()).toBeUndefined();
  });

  it('--dry-run says "would allow" on the permissions row', async () => {
    const res = await runInstall(
      { harness: ['claude'], dryRun: true, publishMode: 'auto' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const text = human(res);
    expect(text).toContain(
      `would allow ${FREE_VERB_RULES.length + MODE_GATED_RULES.length} tenjin commands in`,
    );
    expect(text).toContain('Dry run: nothing was written.');
  });

  it('--dry-run on an already-wired machine says so rather than planning a write', async () => {
    await runInstall({ harness: ['claude'], publishMode: 'auto' }, makeCtx({ json: true }), deps());
    const res = await runInstall(
      { harness: ['claude'], dryRun: true, publishMode: 'auto' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(wiredOf(res.data).added).toEqual([]);
    expect(wiredOf(res.data).alreadyPresent).toEqual([...FREE_VERB_RULES, ...MODE_GATED_RULES]);
    expect(human(res)).toContain('unchanged (dry run)');
  });

  /**
   * `effective` is about the `Bash(...)` payload beside it, which is Claude
   * Code's grammar. Codex has a grant surface of its own and cannot carry one
   * line of it, so a Codex-only envelope claiming these rules are in force is
   * #342's defect one level up (tenjin-agent#343).
   */
  it('never marks Claude rules effective on a codex-only install', async () => {
    const res = await runInstall({ harness: ['codex'] }, makeCtx({ json: true }), deps());
    const perms = (res.data as { permissions: { effective: boolean } }).permissions;
    expect(perms.effective).toBe(false);

    const both = await runInstall(
      { harness: ['claude', 'codex'] },
      makeCtx({ json: true }),
      deps(),
    );
    expect((both.data as { permissions: { effective: boolean } }).permissions.effective).toBe(true);
  });

  it('writes no Claude rules on a codex-only install, and grants Codex its own', async () => {
    // The Claude writer must not create a settings.json on a machine with no
    // Claude on it, and the envelope must not read as though it did. Codex is
    // not ungranted here: its grant is a file of its own (tenjin-agent#342).
    const res = await runInstall({ harness: ['codex'] }, makeCtx(), deps({ isInteractive: true }));
    expect(wiredOf(res.data)).toMatchObject({ harness: 'codex', skipped: 'harness-elsewhere' });
    expect(await allowList()).toBeUndefined();
    const grant = (res.data as { codexGrant?: { granted: string[]; path: string } }).codexGrant;
    expect(grant?.granted.length).toBeGreaterThan(0);
    expect(await readFile(grant?.path ?? '', 'utf8')).toContain('prefix_rule(pattern=["tenjin"');
  });

  it('sanitizes the warning, which quotes bytes out of the file', async () => {
    // V8's JSON parse errors quote the offending input, so ~20 attacker-chosen
    // bytes of settings.json reach the terminal at the moment we tell the
    // operator we left their file alone. Escapes there could overwrite the very
    // line reporting the skip.
    await mkdir(join(home, '.claude'), { recursive: true });
    // The escapes lead, so V8 fails on the FIRST token and takes the
    // "Unexpected token X, "<excerpt>" is not valid JSON" branch, which is the
    // one that echoes the file. A payload that fails later gets a positional
    // message with no excerpt and would test nothing.
    await writeFile(claudeSettingsPath(home), '\x1b[2K\x1b[1G\x1b[32m OK: safe\x1b[0m{"a":1}');
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const wired = wiredOf(res.data);
    expect(wired.skipped).toBe('unparsable');
    // The escapes really do reach the warning: V8 quotes the input it choked on.
    // eslint-disable-next-line no-control-regex
    expect(wired.warning).toMatch(/\x1b/);
    // They survive into the machine envelope, where bytes are data, and are
    // stripped from the line a human reads.
    const line = (res.humanLines ?? []).find((l) => l.includes('not valid JSON'));
    expect(line).toBeDefined();
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/\x1b/);
  });

  it('warns and writes nothing when settings.json is unparsable', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(claudeSettingsPath(home), '{ not json');
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    expect(wiredOf(res.data).skipped).toBe('unparsable');
    expect(await readFile(claudeSettingsPath(home), 'utf8')).toBe('{ not json');
    const text = human(res);
    expect(text).toContain('not valid JSON');
    expect(text).toContain('was left untouched');
  });

  it('preserves an existing settings file while adding the rules', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      claudeSettingsPath(home),
      JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(git status:*)'] } }, null, 2),
    );
    await runInstall({ harness: ['claude'], publishMode: 'review' }, makeCtx(), deps());
    const settings = JSON.parse(await readFile(claudeSettingsPath(home), 'utf8')) as {
      model: string;
      permissions: { allow: string[] };
    };
    expect(settings.model).toBe('opus');
    expect(settings.permissions.allow).toEqual(['Bash(git status:*)', ...FREE_VERB_RULES]);
  });

  it('keeps the three recommendation tiers beside the write outcome', async () => {
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx({ json: true }),
      deps(),
    );
    const d = res.data as WiredData;
    expect(d.permissions.alwaysSafe.map((e) => e.rule)).toEqual(
      ALWAYS_SAFE_ALLOWLIST.map((e) => e.rule),
    );
    expect(d.permissions.wired.added).toEqual([...FREE_VERB_RULES]);
  });

  /**
   * The publish rule follows decision 1 on EVERY path, first run included:
   * installing Tenjin is the consent for it (owner call, PR #164). An agent
   * cannot reach either half on its own — `tenjin install` and `tenjin config
   * set` are both never-allowlisted — and every install that writes the rule
   * says so, names it, and prints the three ways out.
   */
  describe('the publish rule follows publish.mode', () => {
    it('writes it when --publish-mode names auto on this run', async () => {
      const res = await runInstall(
        { harness: ['claude'], publishMode: 'auto' },
        makeCtx({ json: true }),
        deps(),
      );
      expect(wiredOf(res.data).added).toEqual([...FREE_VERB_RULES, ...MODE_GATED_RULES]);
      expect(await allowList()).toEqual([...FREE_VERB_RULES, ...MODE_GATED_RULES]);
    });

    it('writes it when auto is already the configured mode', async () => {
      await runInstall(
        { harness: ['claude'], publishMode: 'auto' },
        makeCtx({ json: true }),
        deps(),
      );
      // Second run names no mode: it reads `auto` back out of config.
      const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
      expect(wiredOf(res.data).alreadyPresent).toContain(PUBLISH_MODE_RULE);
    });

    it('does not write it on review', async () => {
      const res = await runInstall(
        { harness: ['claude'], publishMode: 'review' },
        makeCtx({ json: true }),
        deps(),
      );
      expect(wiredOf(res.data).added).toEqual([...FREE_VERB_RULES]);
      expect(await allowList()).not.toContain(PUBLISH_MODE_RULE);
    });

    // The headless default IS auto, and the FIRST install writes the rule for it.
    // The earlier shape withheld it on run 1 and then wrote it on run 2, which
    // read its own default back as a choice — later and quieter, never absent.
    it('writes it on the FIRST headless install, off the default mode', async () => {
      const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
      expect(
        (res.data as { publishMode: { value: string; source: string } }).publishMode,
      ).toMatchObject({ value: 'auto', source: 'headless-default' });
      expect(wiredOf(res.data).added).toEqual([...FREE_VERB_RULES, ...MODE_GATED_RULES]);
      expect(await allowList()).toContain(PUBLISH_MODE_RULE);
    });

    // No second-run asymmetry: the same box, installed twice, is unchanged.
    it('is idempotent across two headless installs', async () => {
      await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
      const before = await allowList();
      const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
      expect(wiredOf(res.data).added).toEqual([]);
      expect(wiredOf(res.data).alreadyPresent).toContain(PUBLISH_MODE_RULE);
      expect(await allowList()).toEqual(before);
    });

    /**
     * THE HEADLESS PATH, which is the one that grants without anybody present and
     * therefore the one the whole default rests on. It returns before
     * buildWalkthrough, so the envelope is the only disclosure there is: it has to
     * carry the grant sentence and all three undos as data.
     */
    it('carries the grant and all three undos in the headless envelope', async () => {
      const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
      expect(res.humanLines ?? []).toHaveLength(0);
      const grant = wiredOf(res.data).modeGrant!;
      expect(grant.rules).toEqual([...MODE_GATED_RULES]);
      expect(grant.state).toBe('added');
      expect(grant.disclosure).toContain('publish.mode auto');
      expect(grant.disclosure).toContain('without a harness prompt');
      // The keystore is the part the free-tier wording does not cover at this
      // scope: `read` opens it for a read-scoped key, and this pair mints a
      // strictly broader read+write one. The rest of what the pair clears is in
      // docs/agent-permissions.md; this line stays one sentence.
      expect(grant.disclosure).toContain('open your wallet keystore');
      expect(grant.undo).toEqual([
        'tenjin install --publish-mode review',
        'tenjin config set publish.mode review',
        'tenjin uninstall',
      ]);
    });

    it('carries no grant on review, where nothing was granted', async () => {
      const res = await runInstall(
        { harness: ['claude'], publishMode: 'review' },
        makeCtx({ json: true }),
        deps(),
      );
      expect(wiredOf(res.data).modeGrant).toBeUndefined();
    });

    // `publish` and `edit` are not free verbs, and the count line that called
    // eleven rules "free tenjin commands" contradicted both this module and the
    // doctor pointer printed on the next screen.
    it('counts only the free tier as free, with the pair reported separately', async () => {
      const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
      const wired = wiredOf(res.data);
      expect(wired.added).toHaveLength(FREE_VERB_RULES.length + MODE_GATED_RULES.length);
      expect(wired.addedFree).toEqual([...FREE_VERB_RULES]);
      expect(wired.addedFree).toHaveLength(FREE_VERB_RULES.length);
    });

    // The human count is every rule of ours in the file. It said nine while the
    // pair got a block of its own reciting both rule strings; that block is gone,
    // so a count that still excluded them would under-report what just landed.
    it('counts all eleven in the human line, and calls none of them free', async () => {
      const res = await runInstall(
        { harness: ['claude'], publishMode: 'auto' },
        makeCtx(),
        deps({ isInteractive: true }),
      );
      const text = human(res);
      expect(text).toContain(
        `${FREE_VERB_RULES.length + MODE_GATED_RULES.length} tenjin commands in`,
      );
      expect(text).not.toMatch(/free tenjin commands/);
    });

    // One of the pair present, the other written: neither "added" nor "already
    // present" is true of both, so the sentence says neither.
    it('reports a mixed run as in place rather than claiming it added both', async () => {
      await writeSettings({ permissions: { allow: [PUBLISH_MODE_RULE] } });
      const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
      const grant = wiredOf(res.data).modeGrant!;
      expect(grant.state).toBe('mixed');
      expect(grant.disclosure).toContain('in place');
      expect(grant.disclosure).not.toMatch(/\badded\b/);
    });

    /**
     * The grant is a DEFAULT, so the output carries its own receipt: what the
     * agent will now do, and the command that stops it. In PLAIN WORDS. The rule
     * strings and all three undos used to be recited here, which is what the
     * owner read as slop at an install where `Bash(tenjin publish:*)` means
     * nothing yet; they live on in the docs, `doctor --json`, and the envelope
     * asserted above.
     */
    it('says what the mode does and how to turn it off, in plain words', async () => {
      const res = await runInstall(
        { harness: ['claude'], publishMode: 'auto' },
        makeCtx(),
        deps({ isInteractive: true }),
      );
      /**
       * PRESENCE, not absence. Pinning the lean terminal with `not.toMatch(/Bash\(/)`
       * alone encodes the deletion rather than the disclosure: it passes just as
       * well when the whole row goes missing. These assert the two rows an operator
       * has to leave the install with.
       */
      const lines = human(res).split('\n');
      const publishing = lines.find((l) => l.includes('publishing')) ?? '';
      expect(publishing).toContain('publishing   auto');
      expect(publishing).toContain('your agent publishes under your identity');

      const permissions = lines.find((l) => l.includes('permissions')) ?? '';
      expect(permissions).toContain(
        `${FREE_VERB_RULES.length + MODE_GATED_RULES.length} tenjin commands in`,
      );

      // Lean stays lean: the depth lives in the envelope and the doc, both pinned
      // above and in `docs/agent-permissions.md`.
      expect(human(res)).not.toMatch(/Bash\(/);
    });

    it('says none of that on review, which grants nothing', async () => {
      const res = await runInstall(
        { harness: ['claude'], publishMode: 'review' },
        makeCtx(),
        deps({ isInteractive: true }),
      );
      expect(human(res)).not.toContain(PUBLISH_MODE_RULE);
      expect(human(res)).toContain('publishing   review');
    });

    // `--no-allow-free-verbs` still refuses the whole write, publish rule included.
    it('writes nothing at all when the allowlist itself is refused', async () => {
      const res = await runInstall(
        { harness: ['claude'], noAllowFreeVerbs: true },
        makeCtx({ json: true }),
        deps(),
      );
      expect(wiredOf(res.data).skipped).toBe('declined');
      expect(await allowList()).toBeUndefined();
    });

    /**
     * `--no-allow-free-verbs` declines a WRITE OF OURS. It is not a request to
     * keep a grant the operator just revoked, and while the retraction sat below
     * this guard the run wrote `mode: review` to config.json, left both rules
     * allowed, exited 0, and reported `skipped: declined` with a fix telling the
     * operator to ADD rules on the run where they asked to revoke.
     */
    it('retracts on review even when the free-verb write is refused', async () => {
      await writeSettings({
        permissions: { allow: [FREE_VERB_RULES[0], PUBLISH_MODE_RULE, EDIT_MODE_RULE] },
      });
      const res = await runInstall(
        { harness: ['claude'], noAllowFreeVerbs: true, publishMode: 'review' },
        makeCtx({ json: true }),
        deps(),
      );
      expect(wiredOf(res.data).skipped).toBe('declined');
      expect(wiredOf(res.data).removed).toEqual([...MODE_GATED_RULES]);
      expect(await allowList()).toEqual([FREE_VERB_RULES[0]]);
    });

    /**
     * The retraction runs above the guards that decline a write, so a run can
     * retract and then skip. Both skip lines described the file as untouched:
     * "unchanged" on the declined path, and "not wired (Claude Code only)" on the
     * other-harness path, which is worse because it names the very file the run
     * had just deleted two rules from.
     */
    it('says what it took back on the skip lines too, not just the write lines', async () => {
      const lineFor = async (args: Parameters<typeof runInstall>[0]): Promise<string> => {
        await writeSettings({
          permissions: { allow: [FREE_VERB_RULES[0], PUBLISH_MODE_RULE, EDIT_MODE_RULE] },
        });
        const res = await runInstall(args, makeCtx(), deps({ isInteractive: true }));
        return (
          human(res)
            .split('\n')
            .find((l) => l.includes('permissions')) ?? ''
        );
      };

      const declined = await lineFor({
        harness: ['claude'],
        noAllowFreeVerbs: true,
        publishMode: 'review',
      });
      expect(declined).toContain('2 removed');

      const otherHarness = await lineFor({ harness: ['codex'], publishMode: 'review' });
      expect(otherHarness).toContain('2 removed');
      // And it NAMES the file. A non-Claude skip carries no path on purpose, but
      // once this run has deleted from that file, withholding its name is the
      // thing that leaves the operator unable to check.
      expect(otherHarness).toContain(claudeSettingsPath(home));
    });

    // And the row stays honest the other way: a run that retracted nothing says
    // nothing about a retraction.
    it('says nothing about a retraction when there was nothing to take back', async () => {
      await writeSettings({ permissions: { allow: ['Bash(git status:*)'] } });
      const res = await runInstall(
        { harness: ['claude'], noAllowFreeVerbs: true, publishMode: 'review' },
        makeCtx(),
        deps({ isInteractive: true }),
      );
      const line = human(res)
        .split('\n')
        .find((l) => l.includes('permissions'));
      expect(line).toContain('none written (--no-allow-free-verbs)');
      expect(line).not.toContain('removed');
    });

    // Same ordering bug, the other guard: scoping a WRITE to the harnesses a run
    // targets is defensible, but a Claude rule this CLI wrote is ours to reclaim
    // whichever harness is being installed today.
    it('retracts on review even when this run targets another harness', async () => {
      await writeSettings({ permissions: { allow: [PUBLISH_MODE_RULE, EDIT_MODE_RULE] } });
      const res = await runInstall(
        { harness: ['codex'], publishMode: 'review' },
        makeCtx({ json: true }),
        deps(),
      );
      expect(wiredOf(res.data).skipped).toBe('harness-elsewhere');
      expect(wiredOf(res.data).removed).toEqual([...MODE_GATED_RULES]);
      expect(await allowList()).toEqual([]);
      // And the retraction reaches the harness this run actually targeted:
      // `review` regenerates Codex's grant without the mode-gated pair.
      const grant = (res.data as { codexGrant?: { granted: string[] } }).codexGrant;
      expect(grant?.granted).not.toContain('tenjin publish');
      expect(grant?.granted).not.toContain('tenjin edit');
    });

    /**
     * The retraction used to RETURN, jumping the additive pass and the legacy
     * sweep both. One review-install on a machine holding only the pair retracted
     * them, printed "the 9 free tenjin commands were already allowed" over a file
     * holding none of them, stranded a legacy rule, and made the operator run
     * install twice to get the tier.
     */
    it('retracts AND wires the free tier AND sweeps legacy, in one run', async () => {
      await writeSettings({
        permissions: {
          allow: [
            PUBLISH_MODE_RULE,
            EDIT_MODE_RULE,
            'Bash(git status:*)',
            ...LEGACY_ALLOWLIST_RULES,
          ],
        },
      });
      const res = await runInstall(
        { harness: ['claude'], publishMode: 'review' },
        makeCtx(),
        deps({ isInteractive: true }),
      );
      const wired = wiredOf(res.data);
      expect(wired.added).toEqual([...FREE_VERB_RULES]);
      for (const rule of [...MODE_GATED_RULES, ...LEGACY_ALLOWLIST_RULES]) {
        expect(wired.removed, rule).toContain(rule);
      }
      expect(await allowList()).toEqual(['Bash(git status:*)', ...FREE_VERB_RULES]);

      // And the row says what happened rather than claiming a tier it never wrote:
      // what is allowed now, and how many rules this run took away.
      const text = human(res);
      expect(text).toContain(`${FREE_VERB_RULES.length} tenjin commands in`);
      expect(text).toContain(
        `, ${MODE_GATED_RULES.length + LEGACY_ALLOWLIST_RULES.length} removed`,
      );
    });

    // The mode moved back to "ask me first", so the rule that skipped the asking
    // must not outlive it.
    it('takes it back when the mode returns to review', async () => {
      await runInstall(
        { harness: ['claude'], publishMode: 'auto' },
        makeCtx({ json: true }),
        deps(),
      );
      const res = await runInstall(
        { harness: ['claude'], publishMode: 'review' },
        makeCtx({ json: true }),
        deps(),
      );
      expect(wiredOf(res.data).removed).toEqual([...MODE_GATED_RULES]);
      expect(await allowList()).toEqual([...FREE_VERB_RULES]);
    });

    // The consent for the pair is the `auto` hint on the publish-mode select, and
    // it names the two verbs rather than the rule strings, which an operator has
    // not met yet and cannot act on mid-install.
    it('names the two verbs in the auto hint, and no rule string', () => {
      const auto = PUBLISH_MODE_CHOICES.find((c) => c.value === 'auto');
      expect(auto?.hint).toContain('`tenjin publish` and `tenjin edit`');
      expect(auto?.hint).not.toContain(PUBLISH_MODE_RULE);
    });

    it('carries the mode-gated tier in the envelope', async () => {
      const res = await runInstall(
        { harness: ['claude'], publishMode: 'auto' },
        makeCtx({ json: true }),
        deps(),
      );
      const d = res.data as WiredData;
      expect(d.permissions.modeGated.map((e) => e.rule)).toEqual([...MODE_GATED_RULES]);
    });
  });
});

// --- Two questions, in order, and nothing else ------------------------------------

describe('runInstall: two questions', () => {
  it('asks publishing and the wallet, and stops there', async () => {
    const asked: string[] = [];
    await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        promptPublishMode: async () => {
          asked.push('publishing');
          return 'auto';
        },
        walletExists: async () => false,
        confirmWallet: async () => {
          asked.push('wallet');
          return false;
        },
      }),
    );
    expect(asked).toEqual(['publishing', 'wallet']);
  });

  it('asks nothing at all on a machine run', async () => {
    const asked: string[] = [];
    await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps({
        isInteractive: true, // --json wins
        promptPublishMode: async () => {
          asked.push('publishing');
          return 'auto';
        },
        confirmWallet: async () => {
          asked.push('wallet');
          return true;
        },
      }),
    );
    expect(asked).toEqual([]);
  });
});

// --- #35: install on a machine that already has the hosted Tenjin skill ------------
//
// The reported shape: `tenjin install` on a machine carrying the hosted zero-install
// `tenjin` skill (from tenjin.blog/skills.md) left publish unavailable — search
// worked, publish was simply absent. Install on such a machine is the UPGRADE path,
// never a no-op: both CLI adapter skills get wired, the hosted mirror is kept, and
// nothing about a pre-existing skill may make the wiring conditional.

/** Simulate a machine that already carries the hand-installed hosted `tenjin` skill. */
async function seedHostedSkill(dir: string): Promise<void> {
  const hosted = join(dir, 'tenjin');
  await mkdir(hosted, { recursive: true });
  await writeFile(
    join(hosted, 'SKILL.md'),
    '---\nname: tenjin\ndescription: hosted zero-install curriculum\n---\n\n# Tenjin (hosted copy)\n',
  );
}

const isDisabled = (text: string): boolean =>
  /^disable-model-invocation:\s*true\s*$/m.test(text.split('\n---')[0] ?? '');

describe('runInstall: hosted skill already present (#35)', () => {
  it('wires BOTH CLI skills next to a pre-existing hosted skill, model-invocable', async () => {
    const claudeSkills = join(home, '.claude', 'skills');
    await seedHostedSkill(claudeSkills);

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;

    // The regression itself: publish is installed, not skipped.
    const publish = h.skills.find((s) => s.name === 'tenjin-publish');
    expect(publish?.status).toBe('installed');
    expect(publish?.preexisting).toBe(false);
    expect(h.skills.find((s) => s.name === 'tenjin-search')?.status).toBe('installed');

    for (const name of SKILL_NAMES) {
      expect(existsSync(join(claudeSkills, name, 'SKILL.md'))).toBe(true);
    }
    // On disk is not enough: a disable-model-invocation skill is installed but
    // never surfaced to the model, which is how publish went missing.
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      const text = await readFile(join(claudeSkills, name, 'SKILL.md'), 'utf8');
      expect(isDisabled(text)).toBe(false);
    }
  });

  it('keeps the hosted skill (never removes it) and reports it as pre-existing', async () => {
    const claudeSkills = join(home, '.claude', 'skills');
    await seedHostedSkill(claudeSkills);

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;

    expect(h.hostedPreexisting).toBe(true);
    const hosted = h.skills.find((s) => s.name === 'tenjin');
    expect(hosted?.preexisting).toBe(true);
    expect(hosted?.status).toBe('updated'); // refreshed from the packaged mirror
    expect(existsSync(join(claudeSkills, 'tenjin', 'SKILL.md'))).toBe(true);
    // The mirror is permanent, so its refresh reads as a refresh, not skill drift.
    expect(h.warnings.join('\n')).toContain('stays as the zero-install fallback');
    expect(h.notes.join('\n')).toContain('take precedence');
  });

  // The terminal counts the skills; which ones landed, and what became of a
  // hosted mirror that was already there, is the envelope's to carry.
  it('reports the superseded hosted skill in the envelope, not on a row', async () => {
    await seedHostedSkill(join(home, '.claude', 'skills'));
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const h = asData(res.data).harnesses[0]!;
    expect(h.skills.filter((sk) => sk.cli).map((sk) => sk.name)).toEqual([...CLI_SKILL_NAMES]);
    expect(h.notes.join('\n')).toContain('zero-install fallback');
    expect(h.notes.join('\n')).toContain('take precedence');
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain(`  skills       3 in ${join(home, '.claude', 'skills')}`);
    // The writer's own warning still prints: it names a file this run replaced.
    // The notice that the CLI skills now take precedence does not.
    expect(text).toContain('was replaced by');
    expect(text).not.toContain('take precedence');
  });

  // The notice is about arriving through the hosted skill. After run 1 the mirror on
  // disk is one the CLI wrote, so claiming it "was already here" reports our own
  // footprint back to the user as something they did.
  it('does not claim a pre-existing hosted skill on a re-run of its own install', async () => {
    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const h = asData(res.data).harnesses[0]!;
    // The raw fact stays true (a SKILL.md was on disk); only the notice gate narrows.
    expect(h.hostedPreexisting).toBe(true);
    expect(h.hostedArrivedFirst).toBe(false);
    expect(h.notes.join('\n')).not.toContain('was already here');
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).not.toContain('kept as the zero-install fallback');
  });

  it('still notices the genuine hosted-first funnel', async () => {
    await seedHostedSkill(join(home, '.claude', 'skills'));
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const h = asData(res.data).harnesses[0]!;
    expect(h.hostedArrivedFirst).toBe(true);
    expect(h.notes.join('\n')).toContain('was already here');
  });

  // The hosted-skill-first funnel puts the mirror in BOTH targets, so the skills
  // row names each directory: a count with no directory cannot tell a
  // two-harness machine which tree it is talking about.
  it('names every directory it wrote, on one row', async () => {
    const claudeSkills = join(home, '.claude', 'skills');
    const sharedSkills = join(home, '.agents', 'skills');
    await seedHostedSkill(claudeSkills);
    await seedHostedSkill(sharedSkills);

    const res = await runInstall(
      { harness: ['codex', 'claude'] },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain(`  skills       3 in ${claudeSkills}; 3 in ${sharedSkills}`);
    expect(text).toContain('tenjin is wired for Claude Code and Codex.');
    for (const h of asData(res.data).harnesses) expect(h.hostedArrivedFirst).toBe(true);
  });

  it('re-running on top of a hosted-skill machine is idempotent', async () => {
    const claudeSkills = join(home, '.claude', 'skills');
    await seedHostedSkill(claudeSkills);

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const before = await Promise.all(
      SKILL_NAMES.map((n) => readFile(join(claudeSkills, n, 'SKILL.md'), 'utf8')),
    );

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.every((s) => s.status === 'up-to-date')).toBe(true);
    expect(h.skills.every((s) => s.preexisting)).toBe(true);
    expect(h.hostedPreexisting).toBe(true);
    expect(h.warnings).toEqual([]); // nothing changed, so nothing to warn about

    const after = await Promise.all(
      SKILL_NAMES.map((n) => readFile(join(claudeSkills, n, 'SKILL.md'), 'utf8')),
    );
    expect(after).toEqual(before);
  });

  // A user's own files beside the SKILL.md are not ours. The old wipe took them and
  // called it "overwritten"; nothing removes them now.
  it("leaves a user's files beside the skill untouched", async () => {
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(join(dir, 'references'), { recursive: true });
    // Every file the skill ships, already identical — including the one that
    // lives in the same subdirectory as the operator's own notes.
    for (const rel of SHIPPED_SKILL_FILES['tenjin-search']) {
      await writeFile(join(dir, rel), await packagedText('tenjin-search', rel));
    }
    await writeFile(join(dir, 'references', 'notes.md'), 'my private notes');

    const { data } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const skill = asData(data).harnesses[0]!.skills.find((x) => x.name === 'tenjin-search')!;
    // The packaged files were already identical, so nothing changed at all.
    expect(skill.status).toBe('up-to-date');
    expect(asData(data).harnesses[0]!.warnings.filter((w) => w.includes('tenjin-search'))).toEqual(
      [],
    );
    expect(await readFile(join(dir, 'references', 'notes.md'), 'utf8')).toBe('my private notes');
  });

  // The multi-file half of the same promise: a skill that ships a subdirectory
  // gets it created and written, beside whatever the operator already had there.
  it('writes a shipped reference file into an existing skill directory', async () => {
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), await packagedText('tenjin-search'));
    await writeFile(join(dir, 'references', 'notes.md'), 'my private notes');

    const { data } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const skill = asData(data).harnesses[0]!.skills.find((x) => x.name === 'tenjin-search')!;
    expect(skill.status).toBe('updated');
    expect(await readFile(join(dir, 'references', 'permissions.md'), 'utf8')).toBe(
      await packagedText('tenjin-search', 'references/permissions.md'),
    );
    expect(await readFile(join(dir, 'references', 'notes.md'), 'utf8')).toBe('my private notes');
  });

  it('still warns when it overwrites local edits to a SKILL.md it owns', async () => {
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: tenjin-search\n---\n\nmy edits\n');

    const { data } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const warning = asData(data).harnesses[0]!.warnings.find((w) => w.includes('tenjin-search'));
    expect(warning).toContain('overwritten');
  });

  // An unwritable HOME is an environment problem. It reached the envelope as a raw
  // `EACCES: permission denied, mkdir ...` under INTERNAL with no fix, which reads
  // as a CLI bug and leaves the operator nothing to do.
  it('turns an unwritable skills directory into a typed error with a fix', async () => {
    // root ignores mode bits, so the chmod would not deny anything.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const skills = join(home, '.claude', 'skills');
    await mkdir(skills, { recursive: true });
    await chmod(skills, 0o500);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      // The child could not be created, so the culprit is the ancestor that
      // refused: the skills root, the deepest directory that exists (resolved,
      // hence realpath: the macOS tmpdir lives behind /var -> /private/var).
      expect(err.fix).toContain(`ls -ld ${await realpath(skills)}`);
      expect(err.fix).toContain('tenjin install');
      expect(err.message).not.toContain('EACCES'); // the raw errno is the cause, not the message
    } finally {
      await chmod(skills, 0o700);
    }
  });

  // An empty HOME (sudo/docker env_reset) makes every target relative, so the old
  // behavior installed into the CURRENT DIRECTORY and reported success while no
  // harness read a thing.
  it('refuses an empty or relative home directory instead of installing into the cwd', async () => {
    for (const homeDir of ['', 'relative/home']) {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps({ homeDir })).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.message).toContain('did not resolve to an absolute path');
      expect(err.fix).toContain('HOME');
    }
    expect(existsSync(join(process.cwd(), '.claude'))).toBe(false);
  });

  // On a case-insensitive filesystem the user's own TENJIN directory IS the tenjin
  // skill's path, and the old behavior replaced their SKILL.md under a warning
  // naming a lowercase path that is not on disk.
  it('refuses a case-variant skill directory instead of overwriting it', async () => {
    const skills = join(home, '.claude', 'skills');
    await mkdir(skills, { recursive: true });
    // Only meaningful where the filesystem aliases case; probe it.
    await writeFile(join(skills, 'Aa'), '');
    const caseInsensitive = existsSync(join(skills, 'aa'));
    await rm(join(skills, 'Aa'));
    if (!caseInsensitive) return;
    const dir = join(skills, 'TENJIN');
    await mkdir(dir);
    await writeFile(join(dir, 'SKILL.md'), 'my own unrelated skill');
    const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain('TENJIN');
    expect(err.message).toContain('case variant');
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe('my own unrelated skill');
  });

  // The inverse of the missing-child case: the skill directory EXISTS and is
  // itself what refuses the temp-file write. Its parent is writable and innocent,
  // so a fix pointing one directory up sends the operator to chmod the wrong thing.
  it('names the skill directory itself when it exists and refuses the write', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: tenjin-search\n---\n\nstale\n');
    await chmod(dir, 0o500);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      expect(err.fix).toContain(`ls -ld ${await realpath(dir)}`);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  // The typed command follows a link the operator placed, one directory up as
  // well as at the file. This is the half of the contract the unattended self-heal
  // deliberately does NOT share (it skips both and leaves them here), so it is
  // worth its own case: `install` has to remain the way a dotfiles-managed skill
  // directory gets updated.
  it('writes through a symlinked skill directory, keeping the link', async () => {
    if (process.platform === 'win32') return;
    const managed = join(home, 'dotfiles', 'tenjin-search');
    await mkdir(managed, { recursive: true });
    await writeFile(join(managed, 'SKILL.md'), 'what an older CLI shipped\n');
    const link = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dirname(link), { recursive: true });
    await symlink(managed, link);

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(managed, 'SKILL.md'), 'utf8')).toBe(
      await packagedText('tenjin-search'),
    );
  });

  // A symlinked SKILL.md is written through to its target, so a denied write
  // happens in the link's TARGET directory, which no path under the skills tree
  // names. The fix must name that directory or the operator has nothing to check.
  it('names the link target directory when a symlinked SKILL.md cannot be written', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dotfiles = join(home, 'dotfiles');
    const managed = join(dotfiles, 'search.md');
    await mkdir(dotfiles, { recursive: true });
    await writeFile(managed, 'my managed copy\n');
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await symlink(managed, join(dir, 'SKILL.md'));
    await chmod(dotfiles, 0o500);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      // realpath, because the write goes through the link: on macOS the tmpdir is
      // itself behind a symlink (/var -> /private/var), and the resolved directory
      // is the one whose mode actually decides.
      expect(err.fix).toContain(`ls -ld ${await realpath(dotfiles)}`);
      expect((await lstat(join(dir, 'SKILL.md'))).isSymbolicLink()).toBe(true);
      expect(await readFile(managed, 'utf8')).toBe('my managed copy\n');
    } finally {
      await chmod(dotfiles, 0o700);
    }
  });

  // The directory variant of the case above: the skill directory is itself a
  // symlink, and the mode that denied the write lives on its TARGET. Naming the
  // link's path tells the operator to chmod a healthy link.
  it('names the resolved directory when a symlinked skill directory refuses the write', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const real = join(home, 'dotfiles', 'tenjin-search');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'SKILL.md'), '---\nname: tenjin-search\n---\n\nstale\n');
    const link = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dirname(link), { recursive: true });
    await symlink(real, link);
    await chmod(real, 0o500);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      expect(err.fix).toContain(`ls -ld ${await realpath(real)}`);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    } finally {
      await chmod(real, 0o700);
    }
  });

  // Writing through the link is what the operator asked for by making it. Nothing
  // is removed, so the dotfiles tree keeps both its link and its own files.
  it('writes through a symlinked skill directory, keeping the link and their files', async () => {
    if (process.platform === 'win32') return;
    const real = join(home, 'dotfiles', 'tenjin-search');
    await mkdir(join(real, 'references'), { recursive: true });
    await writeFile(join(real, 'SKILL.md'), '---\nname: tenjin-search\n---\n\nstale\n');
    await writeFile(join(real, 'references', 'notes.md'), 'my private notes');
    const link = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dirname(link), { recursive: true });
    await symlink(real, link);

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(real, 'SKILL.md'), 'utf8')).toBe(
      await packagedText('tenjin-search'),
    );
    expect(await readFile(join(real, 'references', 'notes.md'), 'utf8')).toBe('my private notes');
  });

  // A broken link cannot be written through. It must fail saying so, and must not
  // quietly become a real directory.
  it('fails a dangling symlink with a fix naming it, and leaves it a link', async () => {
    if (process.platform === 'win32') return;
    const link = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(home, 'nowhere', 'tenjin-search'), link);

    const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain('broken symlink');
    expect(err.message).not.toContain('ENOENT');
    expect(err.fix).toContain('ls -ld');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  // The write commits with `rename`, which replaces a symlink at the destination
  // PATH with a regular file. A file the operator manages through a link has to be
  // written through it, like the directory case and like settings.json.
  it('writes through a symlinked SKILL.md, keeping the link and updating its target', async () => {
    if (process.platform === 'win32') return;
    const managed = join(home, 'dotfiles', 'search.md');
    await mkdir(dirname(managed), { recursive: true });
    await writeFile(managed, 'my managed copy\n');
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await symlink(managed, join(dir, 'SKILL.md'));

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect((await lstat(join(dir, 'SKILL.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(managed, 'utf8')).toBe(await packagedText('tenjin-search'));
  });

  // Treating every read failure as "absent" classified an unreadable skill as a
  // fresh install and then replaced it, because the atomic rename needs DIRECTORY
  // permission, not file permission.
  it('refuses an unreadable SKILL.md instead of replacing it', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    await writeFile(file, 'secret');
    await chmod(file, 0o000);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      await chmod(file, 0o644);
      expect(await readFile(file, 'utf8')).toBe('secret');
    } finally {
      await chmod(file, 0o644).catch(() => undefined);
    }
  });

  // A dry run must reach the same verdict as the real run.
  it('fails a broken destination link on --dry-run too, matching the real run', async () => {
    if (process.platform === 'win32') return;
    const link = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(home, 'nowhere', 'tenjin-search'), link);

    const dry = (await runInstall({ harness: ['claude'], dryRun: true }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    const real = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    expect(dry).toBeInstanceOf(CliError);
    expect(real).toBeInstanceOf(CliError);
    expect(dry.fix).toBe(real.fix);
  });

  // `readFile` on a FIFO blocks until a writer appears, so a pipe left at a
  // SKILL.md path hung install past SIGTERM until it was SIGKILLed. An errno
  // mapping cannot help: the call does not fail, it never returns.
  it('refuses a non-regular file at a shipped path instead of reading it', async () => {
    if (process.platform === 'win32') return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    const { execFileSync } = await import('node:child_process');
    execFileSync('mkfifo', [join(dir, 'SKILL.md')]);

    const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain('not a regular file');
    expect(err.fix).toContain('ls -l');
  }, 10000);

  // A SKILL.md that is itself a dangling link: resolveThroughLink's throw, which
  // is a different path from a dangling skill DIRECTORY (that one is assertReachable).
  it('fails a SKILL.md that is itself a broken symlink', async () => {
    if (process.platform === 'win32') return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await symlink(join(home, 'nowhere.md'), join(dir, 'SKILL.md'));

    const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
      (e) => e,
    )) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain('broken symlink');
    expect(err.fix).toContain('ls -ld');
  });

  // The permission error must name the FILE. Naming its parent sent operators to
  // chmod a directory that was fine, which is the same defect this PR removed from
  // the skills-not-written error.
  it('names the unreadable file, not its writable parent directory', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'SKILL.md');
    await writeFile(file, 'secret');
    await chmod(file, 0o000);
    try {
      const err = (await runInstall({ harness: ['claude'] }, makeCtx(), deps()).catch(
        (e) => e,
      )) as CliError;
      expect(err.fix).toContain(file);
      expect(err.fix).not.toContain(`ls -ld ${dirname(dir)}\``);
    } finally {
      await chmod(file, 0o644).catch(() => undefined);
    }
  });

  // The skills land first and are unaffected; what fails is recording the harness
  // in the data dir, and a raw EACCES there reads as a CLI bug and carries no fix.
  it('gives an unwritable data directory a typed error with a fix', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    await mkdir(data, { recursive: true });
    await chmod(data, 0o500);
    try {
      const err = await caught(() => runInstall({ harness: ['claude'] }, makeCtx(), deps()));
      expect(err).toBeInstanceOf(CliError);
      expect(err.fix).toContain('Permission denied');
      expect(err.message).not.toContain('EACCES');
      expect(existsSync(join(home, '.claude', 'skills', 'tenjin-search', 'SKILL.md'))).toBe(true);
    } finally {
      await chmod(data, 0o700).catch(() => undefined);
    }
  });

  // The invocability readback happens AFTER the write, so the path can have been
  // swapped for a pipe in between. A raw read there hangs the command that has
  // already done its work.
  it('does not hang when a landed SKILL.md is swapped for a pipe before the readback', async () => {
    if (process.platform === 'win32') return;
    fsHooks.fifoAfterRename = join(home, '.claude', 'skills', 'tenjin-search', 'SKILL.md');
    try {
      const { data } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
      const skill = asData(data).harnesses[0]!.skills.find((x) => x.name === 'tenjin-search')!;
      // Reaching here at all is the assertion; a pipe is not model-invocable.
      expect(skill.modelInvocable).toBe(false);
    } finally {
      fsHooks.fifoAfterRename = '';
    }
  }, 15000);

  it('leaves a nested symlink in the skill directory alone', async () => {
    if (process.platform === 'win32') return;
    const dir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(dir, { recursive: true });
    await writeFile(join(home, 'real-notes.md'), 'my private notes');
    await symlink(join(home, 'real-notes.md'), join(dir, 'notes.md'));

    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect((await lstat(join(dir, 'notes.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe('my private notes');
  });

  it('a stale disable-model-invocation publish skill is overwritten and re-wired', async () => {
    // What an older CLI left behind: the file is there, the harness ignores it.
    const claudeSkills = join(home, '.claude', 'skills');
    const stale = join(claudeSkills, 'tenjin-publish');
    await mkdir(stale, { recursive: true });
    await writeFile(
      join(stale, 'SKILL.md'),
      '---\nname: tenjin-publish\ndescription: old\ndisable-model-invocation: true\n---\n\n# old\n',
    );

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.find((s) => s.name === 'tenjin-publish')?.status).toBe('updated');
    const text = await readFile(join(stale, 'SKILL.md'), 'utf8');
    expect(isDisabled(text)).toBe(false);
  });

  /**
   * install SHAPES what it writes by the machine's configured mode, through the same
   * resolver the self-heal and doctor use (lib/skill-materialize). These cases sit
   * here rather than in skill-writer.test.ts because what they pin is the WIRING —
   * that install reads the raw config, that a `--base-url` cannot reach it, and that
   * a mode change is reported as an update rather than as up-to-date.
   */
  describe('shapes the installed skills by the configured mode', () => {
    const TEAM = {
      baseUrl: 'https://backtrack.tenjin.sh',
      shelfBypassSecret: 'shelf-secret-abc123',
    };
    const searchAt = () => join(home, '.claude', 'skills', 'tenjin-search', 'SKILL.md');

    async function configure(config: Record<string, unknown>): Promise<void> {
      await writeFile(join(data, 'config.json'), JSON.stringify(config));
    }

    it('writes the team arm on a team-mode machine, and no marker', async () => {
      await configure(TEAM);
      await runInstall({ harness: ['claude'] }, makeCtx(), deps());
      const written = await readFile(searchAt(), 'utf8');
      expect(written).toBe(await packagedText('tenjin-search', 'SKILL.md', true));
      expect(written).not.toContain('tenjin:when');
      expect(written).toContain('teammate-useful');
      expect(written).not.toContain('Public + durable + costly to reproduce');
    });

    it('writes the public arm with no config, and with the key alone', async () => {
      await runInstall({ harness: ['claude'] }, makeCtx(), deps());
      expect(await readFile(searchAt(), 'utf8')).toBe(await packagedText('tenjin-search'));

      // The half-set state: the key landed before the shelf did. Team mode there
      // would render team guidance on a machine still publishing to the marketplace.
      await configure({ shelfBypassSecret: TEAM.shelfBypassSecret });
      await runInstall({ harness: ['claude'] }, makeCtx(), deps());
      expect(await readFile(searchAt(), 'utf8')).toBe(await packagedText('tenjin-search'));
    });

    /**
     * A `--base-url` re-points THIS run; it does not change what mode the machine is
     * configured in. The file being written outlives the command, so shaping it by a
     * one-off flag would leave a team machine reading public guidance until the next
     * install — and would let any single command silently rewrite every wired skill.
     */
    it('ignores --base-url when deciding which arm to write', async () => {
      await configure(TEAM);
      await runInstall(
        { harness: ['claude'] },
        makeCtx({ baseUrl: 'https://tenjin.blog' }),
        deps(),
      );
      expect(await readFile(searchAt(), 'utf8')).toBe(
        await packagedText('tenjin-search', 'SKILL.md', true),
      );
    });

    /**
     * The compare happens on the SHAPED source, so a mode flip is a real update. If
     * install compared raw packaged bytes it would report `up-to-date` and leave the
     * previous mode's guidance in place, which is the whole failure the seam exists
     * to prevent.
     */
    it('reports a mode flip as an update, not up-to-date', async () => {
      const first = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
      expect(
        asData(first.data).harnesses[0]!.skills.find((s) => s.name === 'tenjin-search')!.status,
      ).toBe('installed');

      const same = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
      expect(
        asData(same.data).harnesses[0]!.skills.find((s) => s.name === 'tenjin-search')!.status,
      ).toBe('up-to-date');

      await configure(TEAM);
      const flipped = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
      expect(
        asData(flipped.data).harnesses[0]!.skills.find((s) => s.name === 'tenjin-search')!.status,
      ).toBe('updated');
      expect(await readFile(searchAt(), 'utf8')).toContain('teammate-useful');
    });

    // A dry run must resolve the same bytes the real run would, or `would-update`
    // means nothing on a machine whose mode decides the content.
    it('a dry run judges against the shaped content too', async () => {
      await configure(TEAM);
      await runInstall({ harness: ['claude'] }, makeCtx(), deps());
      const dry = await runInstall({ harness: ['claude'], dryRun: true }, makeCtx(), deps());
      expect(
        asData(dry.data).harnesses[0]!.skills.find((s) => s.name === 'tenjin-search')!.status,
      ).toBe('up-to-date');
    });
  });

  it('the packaged CLI skills are model-invocable (guards the frontmatter)', async () => {
    for (const name of ['tenjin-search', 'tenjin-publish']) {
      const text = await readFile(join(SKILLS_SRC, name, 'SKILL.md'), 'utf8');
      expect(isDisabled(text)).toBe(false);
    }
  });

  it('wires the shared ~/.agents/skills target the same way', async () => {
    const shared = join(home, '.agents', 'skills');
    await seedHostedSkill(shared);
    const { data: d } = await runInstall({ harness: ['codex'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.hostedPreexisting).toBe(true);
    expect(h.skills.find((s) => s.name === 'tenjin-publish')?.status).toBe('installed');
    expect(existsSync(join(shared, 'tenjin-publish', 'SKILL.md'))).toBe(true);
  });
});

describe('runInstall: packaged-source wiring guard (#35)', () => {
  /** A throwaway skills source with all three skills, so a test can corrupt exactly one. */
  async function fixtureSource(): Promise<string> {
    const src = await mkdtemp(join(tmpdir(), 'tenjin-install-src-'));
    for (const name of SKILL_NAMES) {
      await mkdir(join(src, name), { recursive: true });
      await writeFile(join(src, name, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n`);
    }
    return src;
  }

  it('a packaged CLI skill carrying the flag fails INTERNAL before anything is written', async () => {
    const src = await fixtureSource();
    await writeFile(
      join(src, 'tenjin-publish', 'SKILL.md'),
      '---\nname: tenjin-publish\ndisable-model-invocation: true\n---\n',
    );
    try {
      const err = await caught(() =>
        runInstall({ harness: ['claude'] }, makeCtx(), deps({ skillsSourceDir: src })),
      );
      expect(err.code).toBe('INTERNAL');
      expect(err.message).toContain('tenjin-publish');
      expect(err.message).toContain('disable-model-invocation');
      // Nothing is written: the guard runs before the plan loop, so a bad package
      // can never leave one target rewritten and the next untouched.
      expect(existsSync(join(home, '.claude', 'skills'))).toBe(false);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('the hosted mirror carrying the flag is NOT fatal; install still wires the CLI skills', async () => {
    // The mirror's frontmatter comes verbatim from tenjin.blog/skills.md, so
    // upstream adding the flag must not hard-fail every install.
    const src = await fixtureSource();
    await writeFile(
      join(src, 'tenjin', 'SKILL.md'),
      '---\nname: tenjin\ndisable-model-invocation: true\n---\n',
    );
    try {
      const { data: d } = await runInstall(
        { harness: ['claude'] },
        makeCtx(),
        deps({ skillsSourceDir: src }),
      );
      const h = asData(d).harnesses[0]!;
      expect(h.skills.find((s) => s.name === 'tenjin-publish')?.modelInvocable).toBe(true);
      expect(h.skills.find((s) => s.name === 'tenjin')?.modelInvocable).toBe(false);
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });

  it('reports modelInvocable per skill, read back from what actually landed', async () => {
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.filter((s) => s.cli).every((s) => s.modelInvocable)).toBe(true);
  });

  it('--dry-run answers for the PACKAGED source, not a hardcoded true', async () => {
    // The mirror is the one skill whose value can legitimately be false (the guard
    // exempts it), and the dry run used to be the one place that always said true.
    const src = await fixtureSource();
    await writeFile(
      join(src, 'tenjin', 'SKILL.md'),
      '---\nname: tenjin\ndisable-model-invocation: true\n---\n',
    );
    try {
      const { data: d } = await runInstall(
        { harness: ['claude'], dryRun: true },
        makeCtx(),
        deps({ skillsSourceDir: src }),
      );
      const h = asData(d).harnesses[0]!;
      expect(h.skills.find((s) => s.name === 'tenjin')?.modelInvocable).toBe(false);
      expect(h.skills.find((s) => s.name === 'tenjin-publish')?.modelInvocable).toBe(true);
      expect(existsSync(join(home, '.claude', 'skills'))).toBe(false); // still wrote nothing
    } finally {
      await rm(src, { recursive: true, force: true });
    }
  });
});

describe('runInstall: preexisting means a real prior copy', () => {
  it('a bare empty skill directory is not "already here"', async () => {
    // `mkdir ~/.claude/skills/tenjin` with no SKILL.md used to report
    // preexisting/hostedPreexisting true and claim the mirror was refreshed.
    await mkdir(join(home, '.claude', 'skills', 'tenjin'), { recursive: true });
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.find((s) => s.name === 'tenjin')?.preexisting).toBe(false);
    expect(h.skills.find((s) => s.name === 'tenjin')?.status).toBe('installed');
    expect(h.hostedPreexisting).toBe(false);
    expect(h.warnings).toEqual([]);
  });

  it('an interrupted write (stray file, no SKILL.md) is not "already here" either', async () => {
    const dir = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'asset.bin'), 'partial');
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(h.skills.find((s) => s.name === 'tenjin')?.preexisting).toBe(false);
    expect(h.hostedPreexisting).toBe(false);
    // The stray file is the operator's; nothing removes it, so this is a plain
    // install of a skill that was not here, with nothing to warn about.
    expect(await readFile(join(dir, 'asset.bin'), 'utf8')).toBe('partial');
    expect(h.skills.find((s) => s.name === 'tenjin')?.status).toBe('installed');
    expect(h.warnings.filter((w) => w.includes(dir))).toEqual([]);
  });

  it('installs alongside the user OWN files without touching any of them', async () => {
    // ~/.claude/skills/tenjin/skills.md is what `curl tenjin.blog/skills.md -o`
    // leaves behind, and NOTES.md is the user's. The old rm(recursive) deleted
    // both; the skill is now written beside them.
    const searchDir = join(home, '.claude', 'skills', 'tenjin-search');
    await mkdir(join(searchDir, 'references'), { recursive: true });
    await writeFile(join(searchDir, 'NOTES.md'), 'mine');
    await writeFile(join(searchDir, 'references', 'mine.md'), 'also mine');
    const hostedDir = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(hostedDir, { recursive: true });
    await writeFile(join(hostedDir, 'skills.md'), '# a hand-saved hosted skill');

    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const h = asData(d).harnesses[0]!;
    expect(await readFile(join(searchDir, 'NOTES.md'), 'utf8')).toBe('mine');
    expect(await readFile(join(searchDir, 'references', 'mine.md'), 'utf8')).toBe('also mine');
    expect(await readFile(join(hostedDir, 'skills.md'), 'utf8')).toBe(
      '# a hand-saved hosted skill',
    );
    // Neither directory held a SKILL.md, so both are installs and neither is a
    // copy that "was already here".
    expect(h.skills.find((s) => s.name === 'tenjin-search')?.status).toBe('installed');
    expect(h.skills.find((s) => s.name === 'tenjin')?.preexisting).toBe(false);
    expect(h.hostedPreexisting).toBe(false);
    expect(h.warnings).toEqual([]);
  });

  it('the mirror-replacement warning claims no direction about which copy is newer', async () => {
    const dir = join(home, '.claude', 'skills', 'tenjin');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: tenjin\n---\n\n# a newer fetch\n');
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const warnings = asData(d).harnesses[0]!.warnings.join('\n');
    expect(warnings).toContain('may be older');
    expect(warnings).not.toContain('was would be');
  });
});

/** Writing the skill tree: locking, interrupts and destructive-write reporting. */
/**
 * The safety net under write-in-place. `installSkill` writes the files it ships and
 * removes nothing, which cannot orphan anything while each skill is a single file.
 * The day a skill ships a second file and a later release drops it, that file would
 * linger in every install forever, and the fix is a manifest of what the previous
 * version wrote. This fails first and says so.
 */
describe('the packaged skills ship a DECLARED file set, which is what uninstall reclaims', () => {
  // `uninstall` removes what this list names, on a machine where the packaged
  // source may be long gone. A reference file nobody declares is litter no
  // uninstall can reclaim, so the declaration is pinned against the real tree.
  // PACKAGED, not required-only: the gated tenjin-pay directory is written to
  // the operator's disk like any other, so it is reclaimed like any other.
  it('declares exactly the files each skill actually ships', async () => {
    for (const name of PACKAGED_SKILL_NAMES) {
      const entries = await readdir(join(SKILLS_SRC, name), {
        recursive: true,
        withFileTypes: true,
      });
      const files = entries
        .filter((e) => e.isFile())
        .map((e) =>
          relative(join(SKILLS_SRC, name), join(e.parentPath, e.name)).split(sep).join('/'),
        )
        .sort();
      expect(files).toEqual([...SHIPPED_SKILL_FILES[name]].sort());
    }
  });

  it('always ships SKILL.md first, the file that proves the directory is ours', () => {
    for (const name of PACKAGED_SKILL_NAMES) expect(SHIPPED_SKILL_FILES[name][0]).toBe('SKILL.md');
  });

  // Everything else in the tree is written in place beside the operator's own
  // files, so a shipped path may never climb out of its skill directory.
  it('declares no path that escapes its own skill directory', () => {
    for (const name of PACKAGED_SKILL_NAMES) {
      for (const rel of SHIPPED_SKILL_FILES[name]) {
        expect(rel.startsWith('/')).toBe(false);
        expect(rel.split('/')).not.toContain('..');
      }
    }
  });
});

describe('runInstall: the skill-directory write', () => {
  // 5 concurrent runs used to fail 7 of 15 times on raw ENOENT/ENOTEMPTY renames,
  // when each skill was replaced by rm-then-write. Named for what these assertions
  // can actually see: the lock is NOT what this proves, and the tree surviving is
  // delivered by the per-file atomic renames (install.ts says the same).
  it('leaves concurrent installs neither failing nor corrupting the tree', async () => {
    const runs = await Promise.allSettled(
      Array.from({ length: 5 }, () => runInstall({ harness: ['claude'] }, makeCtx(), deps())),
    );
    expect(runs.filter((r) => r.status === 'rejected')).toEqual([]);
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(home, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
    }
  });

  // No lock at all, so nothing serializes these: what keeps a run that arrives
  // mid-write from reading a half-built tree is the per-file atomic rename.
  it('writes the skills without leaving any lock in the data dir', async () => {
    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    expect((await readdir(data)).filter((e) => e.endsWith('.lock'))).toEqual([]);
  });

  // The skills write holds no lock, so `ownsAnyLock` cannot see it and the phase
  // marker is the ONLY thing standing between an interrupt mid-copy and a report
  // that nothing changed, on a machine where files have already landed.
  it('an interrupt during the skills write reports a possibly half-written machine', async () => {
    const written: string[] = [];
    const exits: unknown[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      exits.push(code);
    }) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    fsHooks.signalAfterRename = join(home, '.claude', 'skills', 'tenjin-search', 'SKILL.md');
    try {
      await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    } finally {
      fsHooks.signalAfterRename = '';
      exit.mockRestore();
      stderr.mockRestore();
    }
    expect(written.join('')).toContain('half-written');
    expect(exits).toEqual([130]);
  });
});

// --- The harness hook entries -------------------------------------------------------

describe('runInstall: harness hooks', () => {
  type HooksData = {
    hooks: {
      harness: string;
      path?: string;
      hooksDir: string;
      entries: number;
      wrote: boolean;
      url?: string;
      daemon?: { pid: number; port: number; version: string };
      activation?: string[];
      trusted?: number;
      removed: string[];
      skipped?: string;
      fix?: string;
    }[];
  };
  /** The one outcome a single-harness run reports. */
  const hooksOf = (d: unknown) => (d as HooksData).hooks[0]!;

  async function settings(): Promise<Record<string, unknown>> {
    const raw = await readFile(claudeSettingsPath(home), 'utf8').catch(() => null);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
  }
  async function persistedHooks(): Promise<Record<string, boolean> | undefined> {
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { hooks?: Record<string, boolean> }).hooks;
  }

  // A bare headless install is the one that most needs the hooks, and it is the
  // one that used to get the least.
  it('a non-interactive run registers the eleven entries and installs the daemon', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    const h = hooksOf(res.data);

    expect(h.skipped).toBeUndefined();
    expect(h.entries).toBe(11);
    expect(h.wrote).toBe(true);
    expect(h.hooksDir).toBe(join(data, 'hooks'));
    // The port comes out of daemon.pid after `/health` answered, never derived.
    expect(h.url).toBe(`http://127.0.0.1:${DAEMON_PORT}/hook/claude`);
    expect(existsSync(shimBundlePath(data))).toBe(true);
    expect(existsSync(daemonTokenPath(data))).toBe(true);

    const entries = hookEntries(await settings());
    expect(entries).toHaveLength(11);
    expect(entries.filter(([, e]) => e.hooks[0]?.type === 'http')).toHaveLength(9);
    expect(entries.filter(([, e]) => e.hooks[0]?.type === 'command')).toHaveLength(2);
    // Install writes no hook key: the seven arms are on by default and each is
    // one `tenjin config set hooks.<arm> false` away.
    expect(await persistedHooks()).toBeUndefined();
  });

  // settings.json hooks load at session start, so an operator who does not
  // restart gets zero hook activity and nothing telling them why.
  it('tells the operator to restart, but only when hooks were actually wired', async () => {
    const human = (res: { humanLines?: string[] }): string =>
      (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

    // isInteractive is only what makes install return the walkthrough as
    // humanLines at all; nothing about the hooks is asked.
    const wired = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(human(wired)).toContain('Restart Claude Code to load the hooks.');

    // `--no-hooks` is the only run that wires nothing: the entry set is permanent
    // now and every other switch is a per-fire gate the arms read.
    const declined = await runInstall(
      { harness: ['claude'], noHooks: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(human(declined)).not.toContain('Restart Claude Code');
  });

  it('is idempotent: a second run writes a byte-identical file', async () => {
    await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    const first = await readFile(claudeSettingsPath(home), 'utf8');
    const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    const h = hooksOf(res.data);
    expect(h.entries).toBe(11);
    expect(h.wrote).toBe(false);
    expect(await readFile(claudeSettingsPath(home), 'utf8')).toBe(first);
  });

  // No prompt and no key: an interactive run wires the same entries a machine
  // run does, and says nothing about the arms.
  it('wires the entries at a TTY, with nothing asked and no hook key written', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    expect(hooksOf(res.data).entries).toBe(11);
    expect(await persistedHooks()).toBeUndefined();
  });

  it('writes nothing under --dry-run and says why', async () => {
    const res = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx({ json: true }),
      deps(),
    );
    expect(hooksOf(res.data).skipped).toBe('dry-run');
    expect(existsSync(join(data, 'hooks'))).toBe(false);
    expect((await settings()).hooks).toBeUndefined();
    expect(await persistedHooks()).toBeUndefined();
  });

  it('a Codex-only install writes hooks.json under ~/.codex and no Claude settings file', async () => {
    const res = await runInstall({ harness: ['codex'] }, makeCtx({ json: true }), deps());
    expect((res.data as HooksData).hooks).toHaveLength(1);
    const h = hooksOf(res.data);
    expect(h).toMatchObject({ harness: 'codex', entries: 7, wrote: true });
    expect(h.skipped).toBeUndefined();
    expect(h.path).toBe(join(home, '.codex', 'hooks.json'));
    expect(h.url).toBeUndefined();
    // Install trusts what it wrote, so the only step left is the new session
    // the operator has to start; no `/hooks` walkthrough (tenjin-agent#343).
    expect(h.trusted).toBe(7);
    expect(h.activation).toEqual(['Start a new Codex session: hooks are read at session start.']);
    expect(existsSync(join(data, 'hooks'))).toBe(true);
    expect(existsSync(claudeSettingsPath(home))).toBe(false);
    const file = JSON.parse(await readFile(h.path ?? '', 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(file.hooks)).toHaveLength(7);
    expect(JSON.stringify(file)).not.toContain(DAEMON_PORT.toString());
  });

  it('both harnesses: one outcome each, one daemon, and Codex reported as trusted', async () => {
    const res = await runInstall(
      { harness: ['claude', 'codex'] },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const hooks = (res.data as HooksData).hooks;
    expect(hooks.map((h) => [h.harness, h.entries])).toEqual([
      ['claude', 11],
      ['codex', 7],
    ]);
    expect(hooks[0]?.daemon?.port).toBe(hooks[1]?.daemon?.port);
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain('hooks        Claude Code: 7 enabled');
    // Codex's row names the trust it obtained; "7 enabled" over entries the
    // harness will not run is the claim #342 was filed about.
    expect(text).toContain('hooks        Codex: 7 trusted, 7 enabled');
    expect(text).toContain('Restart Claude Code to load the hooks.');
    expect(text).not.toContain('/hooks');
  });
});

// --- The wallet step's skipped decision --------------------------------------------

describe('runInstall: the wallet decision is visible even when it is skipped', () => {
  const walletOf = (d: unknown) =>
    (d as { wallet: { status: string; address?: string; reason?: string } }).wallet;

  // The loop this command sets up needs a key, so the headless path creates one.
  it('a machine run creates a wallet and reports its address', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    expect(walletOf(res.data)).toEqual({ status: 'created', address: STUB_ADDRESS });
  });

  it('a dry run creates nothing and says why', async () => {
    const res = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(walletOf(res.data)).toMatchObject({ status: 'skipped', reason: 'dry-run' });
  });

  // Answering no is a decision; it must not read the same as never being asked.
  it('declining is distinguishable from never being asked', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmWallet: async () => false }),
    );
    expect(walletOf(res.data)).toEqual({ status: 'declined' });
  });

  it('an existing wallet is reported on the machine path as it is on the human one', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => true,
        walletAddress: async () => '0x1234567890abcdef1234567890abcdef12345678',
      }),
    );
    expect(walletOf(res.data).status).toBe('existing');
  });
});

// --- The wallet is created by default -----------------------------------------------

describe('runInstall: wallet creation is the default', () => {
  const walletOf = (d: unknown) =>
    (d as { wallet: { status: string; address?: string; reason?: string; fix?: string } }).wallet;
  const human = (res: { humanLines?: string[] }): string =>
    (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

  const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

  /**
   * Real ox scrypt at N=262144, so these three run past the 5s default whenever
   * the machine is busy — the flake tenjin-agent#47 named, whose remedy the wallet
   * suites already apply file-wide (`vi.setConfig` in commands/wallet.test.ts and
   * lib/wallet/local.test.ts). Applied PER TEST here instead: this file is 170
   * other cases of ordinary filesystem work, and raising the whole file would
   * take the 5s hang detector away from all of them.
   */
  const SCRYPT_TIMEOUT_MS = 120_000;

  // The real creator on a fake keychain: this is the path a headless install
  // actually takes, generated passphrase and scrypt keystore included.
  it(
    'a non-interactive run really creates one, passphrase in the OS store',
    async () => {
      const { exec, entries } = fakeKeychain();
      const res = await runInstall(
        { harness: ['claude'] },
        makeCtx({ json: true }),
        deps(realWalletCreate(exec)),
      );
      const wallet = walletOf(res.data);
      expect(wallet.status).toBe('created');
      expect(wallet.address).toMatch(ADDRESS_RE);
      expect(existsSync(join(data, 'wallet.json'))).toBe(true);
      // Exactly one entry, keyed by the new wallet's own lowercase address.
      expect([...entries.keys()]).toEqual([wallet.address!.toLowerCase()]);
    },
    SCRYPT_TIMEOUT_MS,
  );

  // Through the deps seam, NOT vi.stubEnv: mutating the real process environment
  // to steer this is what made it flake under the parallel runner, and the
  // passphrase layer already takes its env as an argument.
  it(
    'uses TENJIN_WALLET_PASSPHRASE when it is set, touching no store at all',
    async () => {
      const touched: string[] = [];
      const spyExec: ExecFn = async (file, args) => {
        touched.push(`${file} ${args[0] ?? ''}`);
        throw new Error('no store');
      };
      const res = await runInstall(
        { harness: ['claude'] },
        makeCtx({ json: true }),
        deps({
          ...realWalletCreate(spyExec),
          env: { TENJIN_WALLET_PASSPHRASE: 'a-passphrase-the-operator-supplied' },
        }),
      );
      expect(walletOf(res.data).status).toBe('created');
      // The env value settles it, so no credential store is consulted at all.
      expect(touched).toEqual([]);
    },
    SCRYPT_TIMEOUT_MS,
  );

  // The mirror of the case above, and the reason the fixture pins an empty env:
  // with no passphrase in the environment the store is the only source left, so
  // an ambient one leaking in from a shell or another file would silently make
  // the keychain assertions vacuous.
  // Real scrypt again; see SCRYPT_TIMEOUT_MS above.
  it(
    'falls to the OS store when the environment carries no passphrase',
    async () => {
      const { exec, entries } = fakeKeychain();
      const res = await runInstall(
        { harness: ['claude'] },
        makeCtx({ json: true }),
        deps(realWalletCreate(exec)),
      );
      expect(walletOf(res.data).status).toBe('created');
      expect(entries.size).toBe(1);
    },
    SCRYPT_TIMEOUT_MS,
  );

  // The one case with no safe answer. No plaintext fallback exists, by design.
  it('creates nothing and skips LOUDLY with no store and no env passphrase', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps(realWalletCreate(noKeychain)),
    );
    const wallet = walletOf(res.data);
    expect(wallet).toMatchObject({ status: 'skipped', reason: 'no-passphrase-store' });
    expect(wallet.address).toBeUndefined();
    // Both remedies are named, and neither is "we wrote it to a file".
    expect(wallet.fix).toContain('TENJIN_WALLET_PASSPHRASE');
    expect(wallet.fix).toContain('tenjin wallet create');
    expect(existsSync(join(data, 'wallet.json'))).toBe(false);
  });

  it('still succeeds, and still wires everything else, when the wallet is skipped', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps(realWalletCreate(noKeychain)),
    );
    const d = res.data as {
      permissions: { wired: { added: string[] } };
      hooks: { entries: number }[];
    };
    // The default mode is auto, so the publish rule rides along with the tier.
    expect(d.permissions.wired.added).toEqual([...FREE_VERB_RULES, ...MODE_GATED_RULES]);
    expect(d.hooks[0]?.entries).toBe(11);
  });

  it('never writes a passphrase to a plain file', async () => {
    await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps(realWalletCreate(noKeychain)),
    );
    for (const name of await readdir(data)) {
      expect(name).not.toMatch(/passphrase/i);
    }
  });

  it('--no-wallet suppresses it entirely', async () => {
    const res = await runInstall(
      { harness: ['claude'], noWallet: true },
      makeCtx({ json: true }),
      deps(realWalletCreate()),
    );
    expect(walletOf(res.data)).toMatchObject({ status: 'skipped', reason: 'flag' });
    expect(existsSync(join(data, 'wallet.json'))).toBe(false);
  });

  it('an interactive run still asks, and still defaults to yes', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmWallet: confirm }),
    );
    expect(confirm).toHaveBeenCalledWith(WALLET_QUESTION);
    expect(walletOf(res.data).status).toBe('created');
  });

  it('an interactive no is recorded as declined, not as a skip', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmWallet: async () => false }),
    );
    expect(walletOf(res.data)).toEqual({ status: 'declined' });
  });

  // The row says the two things an operator has to act on: it is empty, and
  // funding it is theirs to do. Where the key lives and how it is encrypted is
  // reference material, in docs/agent-permissions.md.
  it('names the empty balance and the human funding step, in one row', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmWallet: async () => true }),
    );
    const text = human(res);
    expect(text).toContain(`wallet       ${STUB_ADDRESS}, $0 - fund with: tenjin wallet fund`);
    expect(text).not.toContain('encrypted at rest');
    expect(text).not.toContain(join(data, 'wallet.json'));
  });

  it('leaves an existing wallet alone and never creates a second', async () => {
    const create = vi.fn(async () => STUB_ADDRESS);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps({
        walletExists: async () => true,
        walletAddress: async () => '0x1234567890abcdef1234567890abcdef12345678',
        createWallet: create,
      }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(walletOf(res.data).status).toBe('existing');
  });

  // An install is useful without a wallet; a create failure must not undo it.
  it('reports an unexpected create failure without failing the install', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx({ json: true }),
      deps({
        createWallet: async () => {
          throw new Error('disk is full');
        },
      }),
    );
    expect(walletOf(res.data)).toMatchObject({ status: 'skipped', reason: 'create-failed' });
    expect((res.data as { wallet: { warning?: string } }).wallet.warning).toContain('disk is full');
  });
});

describe('runInstall: --no-hooks', () => {
  const hooksOf = (d: unknown) => (d as { hooks: { skipped?: string; mode: string }[] }).hooks[0]!;

  it('registers nothing and writes no config', async () => {
    const res = await runInstall(
      { harness: ['claude'], noHooks: true },
      makeCtx({ json: true }),
      deps(),
    );
    expect(hooksOf(res.data).skipped).toBe('declined');
    expect(existsSync(join(data, 'hooks'))).toBe(false);
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => '{}');
    expect((JSON.parse(raw) as { hooks?: unknown }).hooks).toBeUndefined();
  });

  // The difference from `tenjin config set hooks.<arm> false`, which IS a
  // durable statement.
  it('leaves a later bare re-run free to wire them', async () => {
    await runInstall({ harness: ['claude'], noHooks: true }, makeCtx({ json: true }), deps());
    const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    expect(hooksOf(res.data).skipped).toBeUndefined();
    expect(existsSync(join(data, 'hooks'))).toBe(true);
  });
});

/**
 * `--refresh`: the non-interactive re-materialize `tenjin update` spawns on the
 * newly installed binary (tenjin-agent#171).
 *
 * Every test here is about a NEGATIVE. The mode's whole value is what it cannot
 * do, because an unattended upgrade runs it: it must not ask, must not create a
 * key, must not write config, and must not turn an upgrade into an install by
 * materializing a surface the machine did not have.
 */
describe('runInstall --refresh', () => {
  const settingsPath = (): string => join(home, '.claude', 'settings.json');
  const readSettings = async (): Promise<{
    hooks?: Record<string, unknown[]>;
    permissions?: { allow?: string[] };
  }> => JSON.parse(await readFile(settingsPath(), 'utf8'));

  /** A machine that ran a real install: skills, hooks, rules and config. */
  async function installed(): Promise<void> {
    await runInstall(
      { harness: ['claude'], publishMode: 'auto' },
      makeCtx(),
      deps({ which: (bin) => bin === 'claude' }),
    );
  }

  /** Deps whose every prompt, wallet and config seam is a tripwire. */
  function refreshDeps(over: Partial<InstallDeps> = {}): InstallDeps {
    const boom = (what: string) => () => {
      throw new Error(`--refresh must not ${what}`);
    };
    return deps({
      which: (bin) => bin === 'claude',
      // A TTY with stdin: the state in which every other install path prompts.
      isInteractive: true,
      promptPublishMode: boom('ask for a publish mode') as never,
      confirmWallet: boom('ask about a wallet') as never,
      createWallet: boom('create a wallet') as never,
      intro: boom('open a prompt sequence') as never,
      collectChecks: boom('run the doctor probes') as never,
      ...over,
    });
  }

  it('asks nothing and creates nothing, even at an interactive TTY', async () => {
    await installed();
    const configBefore = await readFile(join(data, 'config.json'), 'utf8');
    // Every seam above throws; reaching the end is the assertion.
    const result = await runInstall({ refresh: true }, makeCtx(), refreshDeps());
    expect((result.data as { refresh: boolean }).refresh).toBe(true);
    expect(existsSync(join(data, 'wallet.json'))).toBe(false);
    // Config is READ (for publish.mode) and never written.
    expect(await readFile(join(data, 'config.json'), 'utf8')).toBe(configBefore);
  });

  it('re-registers the entries against the port the daemon came back on', async () => {
    await installed();
    // The daemon lost its port and came back on another one — the case the
    // whole ordering exists for, since the old URL is a silent HTTP error.
    const result = await runInstall(
      { refresh: true },
      makeCtx(),
      refreshDeps({ startDaemon: startAt(40_002) }),
    );
    const hooks = (result.data as { hooks: { entries: number; url: string }[] }).hooks[0]!;
    expect(hooks.entries).toBe(11);
    expect(hooks.url).toBe('http://127.0.0.1:40002/hook/claude');
    const urls = hookEntries(await readSettings())
      .map(([, e]) => e.hooks[0]?.url)
      .filter((u): u is string => u !== undefined);
    expect(new Set(urls)).toEqual(new Set(['http://127.0.0.1:40002/hook/claude']));
    expect((result.data as { hooks: { harness: string }[] }).hooks.map((h) => h.harness)).toEqual([
      'claude',
    ]);
    expect(result.humanLines?.join('\n')).not.toContain('hooks (codex)');
  });

  /**
   * The parent reads the EXIT CODE and nothing else, so a no-op that returned
   * success would reach the operator as "Refreshed the skills and hook scripts
   * for <dir>" on a machine where nothing was refreshed.
   */
  it('exits non-zero on a machine where nothing was ever materialized', async () => {
    const err = await caught(() => runInstall({ refresh: true }, makeCtx(), refreshDeps()));
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).not.toBe(0);
    expect(err.message).toContain('Nothing to refresh');
    expect(err.fix).toContain('tenjin install');
    expect((err.details as { touched: boolean }).touched).toBe(false);
    // And it materialized none of the things it just declined to refresh.
    expect(existsSync(join(data, 'hooks'))).toBe(false);
    expect(existsSync(settingsPath())).toBe(false);
  });

  /** The other half of the same rule: a refusal to write is not a refresh either. */
  it('exits non-zero when the hook writer refused, and carries the reason', async () => {
    await installed();
    const err = await caught(() =>
      runInstall(
        { refresh: true },
        makeCtx(),
        refreshDeps({
          startDaemon: () => Promise.reject(new Error('Daemon did not start: spawn backoff')),
        }),
      ),
    );
    expect(err).toBeInstanceOf(CliError);
    expect(err.exitCode).not.toBe(0);
    expect(err.message).toContain('spawn backoff');
    expect(err.fix).toContain('tenjin install');
  });

  /**
   * `--refresh` dispatches ABOVE the only place `dryRun` is read, so honouring
   * the pair would write every script and commit settings.json against the
   * flag's own help text.
   */
  it('refuses --dry-run instead of writing through it', async () => {
    await installed();
    const settingsBefore = await readFile(settingsPath(), 'utf8');

    const err = await caught(() =>
      runInstall({ refresh: true, dryRun: true }, makeCtx(), refreshDeps()),
    );
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('USAGE');
    expect(await readFile(settingsPath(), 'utf8')).toBe(settingsBefore);
  });

  /**
   * THE PINNED ADVERSARIAL CASE. An update-triggered refresh runs unattended, so
   * a version that would grant MORE rules must not take them: converging a
   * surface is unattended-safe, widening the agent's allowlist is not. The new
   * rules arrive when an operator runs `tenjin install` on purpose.
   */
  it('never widens the allowlist, and names the rules it declined to write', async () => {
    await installed();
    const before = (await readSettings()).permissions?.allow ?? [];
    expect(before.length).toBeGreaterThan(0);

    // A newer version's install would want a rule this machine has never had.
    const NEW_RULE = 'Bash(tenjin brandnewverb:*)';
    const result = await runInstall(
      { refresh: true },
      makeCtx(),
      refreshDeps({ inspectPermissions: async () => ({ pending: [NEW_RULE] }) }),
    );

    const after = (await readSettings()).permissions?.allow ?? [];
    expect(after).toEqual(before);
    expect(after).not.toContain(NEW_RULE);
    // Reported rather than silently skipped: the operator can see what an
    // explicit install is holding for them.
    const data_ = result.data as { permissions: { pending: string[] } };
    expect(data_.permissions.pending).toEqual([NEW_RULE]);
    expect(result.humanLines?.join(' ')).toContain('tenjin install');
  });

  /**
   * tenjin-agent#234: a settled `--no-allow-free-verbs` must stay settled, not
   * get recomputed from the settings file (which has none of the rules) and
   * reported as pending on every later refresh.
   */
  it('does not re-report a declined allowlist as pending', async () => {
    await runInstall(
      { harness: ['claude'], noAllowFreeVerbs: true, publishMode: 'auto' },
      makeCtx(),
      deps({ which: (bin) => bin === 'claude' }),
    );
    expect((await readSettings()).permissions?.allow ?? []).toEqual([]);

    const result = await runInstall({ refresh: true }, makeCtx(), refreshDeps());

    const data_ = result.data as { permissions: { pending: string[] } };
    expect(data_.permissions.pending).toEqual([]);
    expect(result.humanLines?.join(' ')).not.toContain('were NOT written');
  });

  /**
   * Greptile P1 #2: a boolean `freeVerbsDeclined` suppressed EVERY future
   * pending rule forever, so a later version's genuinely new suggestion would
   * never be reported once any decline was on record. The per-rule list must
   * silence only the rules that were actually declined and let a new one
   * through.
   */
  it('still reports a genuinely new rule after an earlier decline', async () => {
    await runInstall(
      { harness: ['claude'], noAllowFreeVerbs: true, publishMode: 'auto' },
      makeCtx(),
      deps({ which: (bin) => bin === 'claude' }),
    );
    expect((await readSettings()).permissions?.allow ?? []).toEqual([]);

    const NEW_RULE = 'Bash(tenjin brandnewverb:*)';
    const declinedRules = [...FREE_VERB_RULES, ...MODE_GATED_RULES];
    const result = await runInstall(
      { refresh: true },
      makeCtx(),
      refreshDeps({
        inspectPermissions: async () => ({ pending: [...declinedRules, NEW_RULE] }),
      }),
    );

    const data_ = result.data as { permissions: { pending: string[] } };
    // Every rule this decline actually covered stays quiet...
    for (const rule of declinedRules) expect(data_.permissions.pending).not.toContain(rule);
    // ...but a rule the decline never saw still surfaces.
    expect(data_.permissions.pending).toEqual([NEW_RULE]);
    expect(result.humanLines?.join(' ')).toContain('tenjin install');
  });

  // A later grant clears the declined list (see the runInstall: permissions
  // decision suite), so a subsequent refresh reports fresh pending rules
  // rather than silencing them off a stale decline.
  //
  // A1igator's nit (PR #272): the version of this test that only checked the
  // refresh output passed unchanged with all three production hunks reverted,
  // because a single-rule `pending` mock reads back identically whether or not
  // the declined set was actually cleared — nothing here distinguished "the
  // grant cleared the record" from "the record was never consulted at all".
  // Read `install.freeVerbsDeclined` off disk directly so the test fails if
  // the grant stops clearing it.
  it('reports freshly-pending rules again once a decline has been cleared by a grant', async () => {
    await runInstall(
      { harness: ['claude'], noAllowFreeVerbs: true, publishMode: 'auto' },
      makeCtx(),
      deps({ which: (bin) => bin === 'claude' }),
    );
    const declinedBefore = JSON.parse(await readFile(join(data, 'config.json'), 'utf8')) as {
      install?: { freeVerbsDeclined?: string[] };
    };
    expect(declinedBefore.install?.freeVerbsDeclined?.length).toBeGreaterThan(0);

    // A later, explicit run grants the allowlist and clears the record.
    await runInstall(
      { harness: ['claude'], publishMode: 'auto' },
      makeCtx(),
      deps({ which: (bin) => bin === 'claude' }),
    );
    const declinedAfter = JSON.parse(await readFile(join(data, 'config.json'), 'utf8')) as {
      install?: { freeVerbsDeclined?: string[] };
    };
    expect(declinedAfter.install?.freeVerbsDeclined).toEqual([]);

    const REVOKED_RULE = FREE_VERB_RULES[0]!;
    const result = await runInstall(
      { refresh: true },
      makeCtx(),
      refreshDeps({ inspectPermissions: async () => ({ pending: [REVOKED_RULE] }) }),
    );
    const data_ = result.data as { permissions: { pending: string[] } };
    expect(data_.permissions.pending).toEqual([REVOKED_RULE]);
  });

  /**
   * ONE CONVERGING WRITER, gated on what is already there: it always writes the
   * WHOLE entry set, so the only thing that keeps a refresh from becoming an
   * install is this question. An unattended upgrade may not materialize a
   * surface nobody asked for.
   */
  it('registers nothing on a machine with no entry of ours', async () => {
    // Skills installed, hooks never wired: the refresh has skills to converge
    // and must still leave settings.json without a hook entry.
    await runInstall(
      { harness: ['claude'], noHooks: true, publishMode: 'auto' },
      makeCtx(),
      deps({ which: (bin) => bin === 'claude' }),
    );
    const before = existsSync(settingsPath()) ? await readFile(settingsPath(), 'utf8') : null;

    const result = await runInstall({ refresh: true }, makeCtx(), refreshDeps());
    expect((result.data as { hooks: unknown[] }).hooks).toEqual([]);
    const after = existsSync(settingsPath()) ? await readFile(settingsPath(), 'utf8') : null;
    expect(after).toBe(before);
    // And no daemon was materialized for it either.
    expect(existsSync(join(data, 'hooks', 'tenjin-shim.mjs'))).toBe(false);
  });

  /**
   * The skills pass is the existing heal writer, which stands down when this
   * invocation's data dir is not the machine default: the skills directories are
   * machine-wide, so a per-profile refresh must not decide their contents.
   */
  it('leaves the machine-wide skills alone when the data dir is redirected', async () => {
    await installed();
    const skill = join(home, '.claude', 'skills', 'tenjin-search', 'SKILL.md');
    await writeFile(skill, '# stale\n');
    const result = await runInstall(
      { refresh: true },
      makeCtx(),
      refreshDeps({ env: { TENJIN_DATA_DIR: data } }),
    );
    expect(await readFile(skill, 'utf8')).toBe('# stale\n');
    const skills = (result.data as { skills: { ran: boolean; reason?: string } }).skills;
    expect(skills.ran).toBe(false);
    expect(skills.reason).toContain('TENJIN_DATA_DIR');
  });

  it('re-renders the wired skills from the default profile', async () => {
    await installed();
    const skill = join(home, '.claude', 'skills', 'tenjin-search', 'SKILL.md');
    // Drift the BODY and keep the frontmatter: the heal writer only rewrites a
    // file it can still identify as ours, which is what keeps it off a copy
    // someone replaced with their own.
    const packaged = await packagedText('tenjin-search');
    await writeFile(skill, `${packaged}\n<!-- an older version wrote this -->\n`);
    const result = await runInstall({ refresh: true }, makeCtx(), refreshDeps());
    expect(await readFile(skill, 'utf8')).toBe(packaged);
    expect((result.data as { skills: { ran: boolean } }).skills.ran).toBe(true);
  });
});
