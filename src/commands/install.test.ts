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
import {
  runInstall,
  PERMISSIONS_QUESTION,
  permissionsQuestion,
  PUBLISH_MODE_CHOICES,
  WALLET_QUESTION,
} from './install';
import type { InstallDeps, PromptPublishModeFn } from './install';
import type { PublishMode } from '../lib/config';
import type { ExecFn } from '../lib/wallet/passphrase';
import { resolveSkillsSource, SHIPPED_SKILL_FILES, SKILL_NAMES } from '../lib/skills-source';
import { ALWAYS_SAFE_ALLOWLIST, NEVER_ALLOWLISTED, PERMISSIONS_DOC_URL } from '../lib/permissions';
import {
  claudeSettingsPath,
  EDIT_MODE_RULE,
  FREE_VERB_RULES,
  inspectFreeVerbRules,
  LEGACY_ALLOWLIST_RULES,
  MODE_GATED_RULES,
  PUBLISH_MODE_RULE,
} from '../lib/harness-permissions';
import { CliError } from '../lib/errors';
import type { DoctorChecks } from './doctor';
import type { CommandContext, GlobalFlags } from '../context';

// Real packaged skills, resolved once from this test's location. Using the real
// source (not a fixture) also proves the copy lands byte-identical content.
const SKILLS_SRC = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
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
    promptPublishMode: async () => null,
    promptSearchHooks: async () => null,
    confirmPermissions: async () => false,
    intro: async () => {},
    outro: async () => {},
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
type Data = { dryRun: boolean; skillsSource: string; harnesses: Harnesses; doctor: unknown };

const asData = (d: unknown) => d as Data;

describe('runInstall: harness override', () => {
  it('installs only Claude when --harness claude, no AGENTS.md wiring', async () => {
    const { data: d } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const out = asData(d);
    expect(out.harnesses).toHaveLength(1);
    const h = out.harnesses[0]!;
    expect(h.harness).toBe('claude');
    expect(h.detectedBy).toEqual(['override']);
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

  it('dedupes codex + shared onto the one ~/.agents/skills target', async () => {
    const { data: d } = await runInstall({ harness: ['codex', 'shared'] }, makeCtx(), deps());
    expect(asData(d).harnesses).toHaveLength(1);
  });

  it('rejects an unknown harness as USAGE / exit 2', async () => {
    const err = await caught(() => runInstall({ harness: ['cursor'] }, makeCtx(), deps()));
    expect(err.code).toBe('USAGE');
    expect(err.exitCode).toBe(2);
  });
});

describe('runInstall: detection', () => {
  it('detects Claude from ~/.claude and Codex from ~/.codex directories', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(home, '.codex'), { recursive: true });
    const { data: d } = await runInstall({}, makeCtx(), deps());
    const byName = Object.fromEntries(asData(d).harnesses.map((h) => [h.harness, h]));
    expect(byName.claude!.detectedBy).toEqual(['home-dir']);
    expect(byName.codex!.detectedBy).toEqual(['home-dir']);
  });

  it('detects a harness from a binary on PATH', async () => {
    const { data: d } = await runInstall({}, makeCtx(), deps({ which: (bin) => bin === 'claude' }));
    const out = asData(d);
    expect(out.harnesses).toHaveLength(1);
    expect(out.harnesses[0]!.harness).toBe('claude');
    expect(out.harnesses[0]!.detectedBy).toEqual(['binary']);
  });

  it('falls back to the shared Agent Skills location when nothing is detected', async () => {
    const { data: d } = await runInstall({}, makeCtx(), deps());
    const out = asData(d);
    expect(out.harnesses).toHaveLength(1);
    const h = out.harnesses[0]!;
    expect(h.harness).toBe('shared');
    expect(h.detected).toBe(false);
    expect(h.detectedBy).toEqual(['fallback']);
    expect(h.skillsDir).toBe(join(home, '.agents', 'skills'));
    expect(existsSync(join(home, '.agents', 'skills', 'tenjin', 'SKILL.md'))).toBe(true);
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
      const notDetected = await runInstall(
        {},
        makeCtx(),
        deps({ which: undefined, env: { PATH: bin } }),
      );
      expect(asData(notDetected.data).harnesses[0]!.harness).toBe('shared');

      // A real FILE named codex does count.
      await writeFile(join(bin, 'codex'), '#!/bin/sh\n');
      const detected = await runInstall(
        {},
        makeCtx(),
        deps({ which: undefined, env: { PATH: bin } }),
      );
      const names = asData(detected.data).harnesses.map((h) => h.harness);
      expect(names).toContain('codex');
      expect(names).not.toContain('claude');
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
      checks: [{ name: 'api-contract', status: 'fail', required: true, detail: 'down' }],
      failure: {
        code: 'API_UNREACHABLE',
        result: { name: 'api-contract', status: 'fail', required: true, detail: 'down' },
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
// you". It used to read the other way round, so "Setup complete" was followed by
// a block of warnings before a single ✓.
describe('runInstall: walkthrough ordering', () => {
  const human = (res: { humanLines?: string[] }): string =>
    (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

  const warning: DoctorChecks = {
    publishMode: 'review',
    missingModeGated: [],
    checks: [
      {
        name: 'search-contract',
        status: 'warn',
        required: false,
        detail: 'A2 not deployed',
        fix: 'point baseUrl at a deploy that has it',
      },
    ],
  };

  it('puts the summary above the attention items', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, collectChecks: async () => warning }),
    );
    const lines = human(res).split('\n');
    const firstTick = lines.findIndex((l) => l.includes('Claude Code:'));
    const attention = lines.findIndex((l) => l.includes('need attention'));
    expect(firstTick).toBeGreaterThanOrEqual(0);
    expect(attention).toBeGreaterThan(firstTick);
  });

  it('a clean run is the summary and nothing else', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    expect(human(res)).not.toContain('need attention');
  });

  // The dry-run banner is not an attention item: it says what the rest of the
  // output means, so it stays on top of the thing it qualifies.
  it('keeps the dry-run banner above the summary', async () => {
    const res = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const lines = human(res).split('\n');
    expect(lines[0]).toContain('Dry run');
    expect(lines.findIndex((l) => l.includes('Claude Code:'))).toBeGreaterThan(0);
  });

  // The other half of #80: with no wallet, the summary's own line already says
  // `none` and names `tenjin wallet create`. Repeating it as a yellow warning
  // told someone who only wants `tenjin search` that their setup needs attention
  // when it does not.
  it('does not repeat the no-wallet line as a warning', async () => {
    const noWallet: DoctorChecks = {
      publishMode: 'review',
      missingModeGated: [],
      checks: [
        {
          name: 'wallet',
          status: 'warn',
          required: false,
          detail: 'No wallet; needed only for buy/publish',
          fix: 'tenjin wallet create',
          // The marker doctor's noWalletCheck sets; doctor.test.ts pins that the
          // production check really carries it, so this stub cannot drift into
          // testing a shape nothing emits.
          data: { credential: 'absent' },
        },
      ],
    };
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => false,
        confirmWallet: async () => false,
        collectChecks: async () => noWallet,
      }),
    );
    const text = human(res);
    expect(text).not.toContain('need attention');
    expect(text).toContain('Wallet: none. Create one later with: tenjin wallet create');
  });

  // ...but a wallet that is BROKEN is not something the summary says anywhere,
  // so suppressing the no-wallet case must not suppress the whole check.
  it('still reports a wallet warning the summary does not carry', async () => {
    const broken: DoctorChecks = {
      publishMode: 'review',
      missingModeGated: [],
      checks: [
        {
          name: 'wallet',
          status: 'warn',
          required: false,
          detail: 'Wallet 0xabc (file): the keystore cannot be decrypted',
          fix: 'Set TENJIN_WALLET_PASSPHRASE',
        },
      ],
    };
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => true,
        walletAddress: async () => '0xabc',
        collectChecks: async () => broken,
      }),
    );
    const text = human(res);
    expect(text).toContain('need attention');
    expect(text).toContain('the keystore cannot be decrypted');
  });

  // The suppression keys on the check that says there is NO credential, never on
  // the name `wallet`. `walletExists` is a wallet-FILE probe, so a broken
  // TENJIN_WALLET_KEY with no file on disk records `none` in the summary while
  // doctor is warning about a credential that exists and does not work. Filtering
  // by name hid exactly that, which is the one wallet state install says nothing
  // else about.
  it('reports a broken env key even while the summary says none', async () => {
    const badEnvKey: DoctorChecks = {
      publishMode: 'review',
      missingModeGated: [],
      checks: [
        {
          name: 'wallet',
          status: 'warn',
          required: false,
          detail: 'TENJIN_WALLET_KEY is not a valid private key.',
          fix: 'Set TENJIN_WALLET_KEY to a 0x-prefixed 32-byte hex key, or unset it to use the wallet file.',
        },
      ],
    };
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        walletExists: async () => false,
        confirmWallet: async () => false,
        collectChecks: async () => badEnvKey,
      }),
    );
    const text = human(res);
    expect(text).toContain('need attention');
    expect(text).toContain('not a valid private key');
    // ...and the summary still reports what the walkthrough itself settled.
    expect(text).toContain('Wallet: none');
  });
});

// An explicit --harness is the user telling the CLI which directory they use.
// Detection cannot see a harness Tenjin does not probe for, so the choice is recorded
// and `doctor` keeps judging that directory on later runs (#39 review).
describe('runInstall: recording an explicit --harness', () => {
  async function recorded(): Promise<string[] | undefined> {
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { install?: { harness?: string[] } }).install?.harness;
  }

  it('records the requested targets', async () => {
    await runInstall({ harness: ['shared'] }, makeCtx(), deps());
    expect(await recorded()).toEqual(['shared']);
  });

  it('records the DE-DUPED target set, matching what was written', async () => {
    // codex + shared are one directory, so one recorded entry, like one install target.
    await runInstall({ harness: ['codex', 'shared'] }, makeCtx(), deps());
    expect(await recorded()).toEqual(['codex']);
  });

  it('a later explicit run REPLACES the record rather than unioning', async () => {
    await runInstall({ harness: ['shared'] }, makeCtx(), deps());
    await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    // The way out of a mistaken --harness is re-running install with the right one.
    expect(await recorded()).toEqual(['claude']);
  });

  it('a bare install records nothing: detection is re-probed every time', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await runInstall({}, makeCtx(), deps());
    expect(await recorded()).toBeUndefined();
  });

  it('a bare install leaves an earlier explicit record alone', async () => {
    await runInstall({ harness: ['shared'] }, makeCtx(), deps());
    await mkdir(join(home, '.claude'), { recursive: true });
    await runInstall({}, makeCtx(), deps());
    expect(await recorded()).toEqual(['shared']);
  });

  it('--dry-run records nothing, like the publish-mode write', async () => {
    await runInstall({ harness: ['shared'], dryRun: true }, makeCtx(), deps());
    expect(await recorded()).toBeUndefined();
  });

  it('the record is merged, never an overwrite of a sibling block', async () => {
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({ publish: { mode: 'auto' }, evalCohort: true }),
    );
    await runInstall({ harness: ['shared'] }, makeCtx(), deps());
    const json = JSON.parse(await readFile(join(data, 'config.json'), 'utf8')) as {
      install?: { harness?: string[] };
      publish?: { mode?: string };
      evalCohort?: boolean;
    };
    expect(json.install?.harness).toEqual(['shared']);
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

  it('offers auto first, as the recommended answer, with one line of consequence', () => {
    expect(PUBLISH_MODE_CHOICES.map((c) => c.value)).toEqual(['auto', 'review', 'full-auto']);
    expect(PUBLISH_MODE_CHOICES[0]!.label).toBe('Auto (recommended)');
    expect(PUBLISH_MODE_CHOICES[0]!.hint).toBe(
      'your agent publishes and updates pieces on its own, under your identity',
    );
    // The clause that used to end this hint promised a harness prompt in front of
    // every publish, which this same mode now writes a rule to remove.
    for (const c of PUBLISH_MODE_CHOICES) {
      const hint: string = 'hint' in c ? c.hint : '';
      expect(hint).not.toMatch(/harness/i);
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

  it('--dry-run does not prompt', async () => {
    const spy = promptSpy(['review']);
    const { data: d } = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx(),
      deps({ isInteractive: true, promptPublishMode: spy.fn }),
    );
    expect(spy.calls()).toBe(0);
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

describe('runInstall: interactive walkthrough', () => {
  const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

  // install is human-first: it returns the walkthrough as humanLines (the
  // dispatcher prints them at a TTY). Read them here, ANSI-stripped.
  const human = (res: { humanLines?: string[] }): string =>
    (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
  const walletOf = (d: unknown) =>
    (d as { wallet: { status: string; address?: string; reason?: string; fix?: string } }).wallet;

  // The summary is one line per subject and it closes the output, so it is read
  // off the TAIL: whatever disclosures a given run owed the operator sit above it,
  // and adding one must not be able to quietly drop a summary line.
  it('closes with a six-line summary: skills, publishing, permissions, hooks, wallet, next', async () => {
    // Nothing disclosable: hooks off, permissions declined by the default seam,
    // no nudge. What is left is the summary, which is what this pins.
    const res = await runInstall(
      { harness: ['claude'], searchHooks: 'off', claudeMd: false },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const lines = human(res).split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('Claude Code: 3 skills installed');
    expect(lines[0]).toContain('tenjin-search, tenjin-publish (CLI)');
    expect(lines[1]).toContain('Publishing: review');
    expect(lines[2]).toContain('Permissions:');
    expect(lines[3]).toContain('Search hooks:');
    expect(lines[4]).toContain('Wallet:');
    expect(lines[5]).toContain('Next: tenjin search');
  });

  // Nothing this command writes into the operator's home may land silently, and
  // that has to hold for the two things a bare run now writes by default.
  it('discloses the hooks it wired and how to take them back', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptSearchHooks: async () => 'auto' }),
    );
    const text = human(res);
    expect(text).toContain('Before a web search or a subagent dispatch, the hooks ask tenjin.blog');
    // The subagent prompt is the surprising half of what leaves the machine, so
    // the disclosure names it and its bound rather than only "the query".
    expect(text).toContain(
      'the query text, or at most 400 characters of the subagent prompt, leaves the machine',
    );
    expect(text).toContain('tenjin config set hooks.searchMode off');
    expect(text).toContain(join(data, 'hooks'));
  });

  // The disclosure names the count, the file and the undo. It does NOT recite the
  // nine rules: that block is `doctor`'s, and the machine envelope carries them.
  // The nudge is written by default now, so its existing disclosure block has to
  // fire on a bare run rather than only behind the flag it used to need.
  // The footprint is gone: a harness already loads every skill's frontmatter
  // description at session start, so the pointer line only duplicated it.
  it('writes no CLAUDE.md at all, and says nothing about a nudge', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    expect(existsSync(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
    const text = human(res);
    expect(text).not.toContain('nudge');
    expect(text).not.toContain(MARKER_COMMENT);
  });

  // One-time cleanup for the machines that already carry one. It edits a file the
  // operator writes their own notes in, so it has to be disclosed.
  it('removes a legacy pointer line and reports which file it cleaned', async () => {
    const claudeMd = join(home, '.claude', 'CLAUDE.md');
    await mkdir(dirname(claudeMd), { recursive: true });
    await writeFile(claudeMd, `# My notes\n${MARKER_COMMENT} Tenjin: old text\n## More notes\n`);

    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const after = await readFile(claudeMd, 'utf8');
    expect(after).not.toContain(MARKER_COMMENT);
    // Everything around it survives, byte for byte.
    expect(after).toContain('# My notes');
    expect(after).toContain('## More notes');
    expect(human(res)).toContain(`Removed the old Tenjin pointer line from ${claudeMd}`);
  });

  /**
   * A run that wired permissions has to say so and say how to take it back. It
   * said it twice: a ✓ line with the count, the file and the link, then a dim
   * paragraph repeating all three. The count and the link stay on the ✓ line, the
   * undo stays here, and neither recites a rule. The full grant story lives in the
   * `--json` envelope, asserted in the mode-gated block below.
   */
  it('discloses the permission rules it wired and how to take them back', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: async () => true }),
    );
    const text = human(res);
    expect(text).toContain(
      `${FREE_VERB_RULES.length} tenjin commands allowed in ${claudeSettingsPath(home)}`,
    );
    expect(text).toContain(`Undo anytime: remove those lines from ${claudeSettingsPath(home)}`);
    for (const rule of FREE_VERB_RULES) expect(text).not.toContain(rule);
    // Said once, not twice: the old pairing repeated the count and the file in a
    // dim paragraph directly under the line that already carried them.
    expect(text.match(/tenjin commands allowed in/g)).toHaveLength(1);
  });

  it('no longer prints the allowlist block or the security essays that went with it', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const text = human(res);
    // The rules and their caveats are reference material: `doctor` prints them,
    // the README documents them, and a setup flow does not recite them.
    for (const e of ALWAYS_SAFE_ALLOWLIST) expect(text).not.toContain(e.rule);
    expect(text).not.toContain('Bash(tenjin buy:*)');
    expect(text).not.toContain('Bash(tenjin session start:*)');
    expect(text).not.toContain('mcp__tenjin__tenjin_publish');
    expect(text).not.toContain('maxAutoSpend');
    // And no rule for a money-moving or state-changing verb, in any form.
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
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const surfaces = [human(res), PERMISSIONS_QUESTION];
    for (const text of surfaces) {
      expect(text).not.toMatch(/read-only/i);
      expect(text).not.toMatch(/touch your wallet/i);
      expect(text).not.toMatch(/free, read-only verbs/i);
    }
  });

  /**
   * Two sentences and a link. The question is a yes/no an operator answers in a
   * couple of seconds, so it carries only what they can decide on: it cannot
   * spend their money, and the rules land in a named file. The tier inventory,
   * the caveats and the undos are one hop away, unchanged.
   */
  it('the consent question is short, honest, and points at the details', async () => {
    expect(PERMISSIONS_QUESTION).toContain(
      `Adds ${FREE_VERB_RULES.length} command rules to ~/.claude/settings.json`,
    );
    expect(PERMISSIONS_QUESTION).toMatch(/spend your money/);
    expect(permissionsQuestion('auto')).toMatch(/spend your money/);
    // The one thing auto changes about the answer, said in the question itself.
    expect(permissionsQuestion('auto')).toContain('publish under your identity on its own');
    expect(PERMISSIONS_QUESTION).toContain(`Details: ${PERMISSIONS_DOC_URL}`);
    expect(PERMISSIONS_QUESTION).not.toContain('tenjin doctor');
    // No inventory, no rule syntax, no jargon the operator has not met yet.
    expect(PERMISSIONS_QUESTION).not.toMatch(/Bash\(/);
    expect(PERMISSIONS_QUESTION).not.toMatch(/send or store data/i);
    expect(PERMISSIONS_QUESTION).not.toMatch(/keystore/i);
    // Short enough to read at a prompt. The old one ran past 300 characters of
    // inventory before the link, which is where the owner stopped reading.
    for (const mode of ['review', 'auto', 'full-auto'] as const) {
      const q = permissionsQuestion(mode);
      expect(q.split('Details:')[0]!.length, mode).toBeLessThan(230);
    }
  });

  it('the line reporting a write says how many are allowed, and where the rest is', async () => {
    const permissionsLineOf = async (mode: PublishMode): Promise<string> => {
      const res = await runInstall(
        { harness: ['claude'], allowFreeVerbs: true, publishMode: mode },
        makeCtx(),
        deps({ isInteractive: true }),
      );
      return (
        human(res)
          .split('\n')
          .find((l) => l.includes('Permissions:')) ?? ''
      );
    };

    const review = await permissionsLineOf('review');
    expect(review).toContain(`${FREE_VERB_RULES.length} tenjin commands allowed in`);
    expect(review).toContain(`Details: ${PERMISSIONS_DOC_URL}`);
    // "free" was a qualifier this count needed only while it excluded the pair.
    expect(review).not.toMatch(/free/i);

    // The count is every rule of ours in the file, so an auto machine says eleven
    // rather than reporting nine and leaving the pair to a line that no longer
    // exists.
    await rm(claudeSettingsPath(home), { force: true });
    const auto = await permissionsLineOf('auto');
    expect(auto).toContain(
      `${FREE_VERB_RULES.length + MODE_GATED_RULES.length} tenjin commands allowed in`,
    );
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
      'Bash(tenjin session start:*)',
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

  it('creates a wallet on yes and shows the address + funding lines', async () => {
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
    const text = human(res);
    expect(text).toContain(ADDR);
    expect(text).toContain('Fund it with a few dollars of USDC on Base');
    expect(text).toContain('tenjin wallet balance');
  });

  it('declining the wallet prompt shows the create-later line, no create', async () => {
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
    expect(human(res)).toContain('Create one later with: tenjin wallet create');
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
    expect(human(res)).toContain('Wallet: none (flag)');
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
    expect(human(res)).toContain(`Wallet: ${ADDR} (existing)`);
  });

  it('a TTY with no stdin renders the walkthrough with defaults, no prompt', async () => {
    // humanOutput true (io.isTTY, no --json), but canPrompt false (stdin is not a
    // TTY in the test runner and no isInteractive override): default mode, no
    // wallet prompt, still a full walkthrough.
    const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
    const ttyCtx: CommandContext = {
      flags: { json: false, timeout: 10000 },
      dataDir: data,
      io: { stdout: sink(), stderr: sink(), isTTY: true },
    };
    const prompt = vi.fn(async () => 'review' as const);
    const confirm = vi.fn(async () => true);
    const permissions = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      ttyCtx,
      deps({
        promptPublishMode: prompt,
        confirmWallet: confirm,
        confirmPermissions: permissions,
        walletExists: async () => false,
      }),
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(permissions).not.toHaveBeenCalled();
    // No prompt possible, so publishing settles the recommended mode too.
    expect(human(res)).toContain('Publishing: auto');
    // No prompt, but a wallet all the same: a run nobody can answer takes the
    // default rather than treating silence as a no.
    expect(human(res)).toContain(`Wallet: ${STUB_ADDRESS}, holding $0`);
  });

  it('a green doctor says nothing; a failure surfaces with its fix', async () => {
    const okRes = await runInstall(
      { harness: ['claude'], searchHooks: 'off', claudeMd: false },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(human(okRes)).not.toContain('need attention');
    expect(human(okRes).split('\n')).toHaveLength(6);

    const failing: DoctorChecks = {
      publishMode: 'review',
      missingModeGated: [],
      checks: [
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
      deps({ isInteractive: true, collectChecks: async () => failing }),
    );
    const text = human(failRes);
    expect(text).toContain('need attention');
    expect(text).toContain('api: unreachable');
    expect(text).toContain('fix: check the base URL');
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

  it('writes the allowlist on an interactive yes and says so in one line', async () => {
    const confirm = vi.fn(async (_label: string) => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toContain('without permission popups');
    expect(wiredOf(res.data).added).toEqual([...FREE_VERB_RULES]);
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
    expect(human(res)).toContain(
      `${FREE_VERB_RULES.length} tenjin commands allowed in ${claudeSettingsPath(home)}`,
    );
  });

  it('writes nothing on an interactive no and offers the flag instead', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: async () => false }),
    );
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'declined', added: [] });
    expect(await allowList()).toBeUndefined();
    expect(human(res)).toContain('tenjin install --allow-free-verbs');
  });

  it('--allow-free-verbs wires it headlessly, with no prompt', async () => {
    const confirm = vi.fn(async () => false);
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true, publishMode: 'review' },
      makeCtx(),
      deps({ confirmPermissions: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data).added).toEqual([...FREE_VERB_RULES]);
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
  });

  it('--allow-free-verbs works under --json and reports the write in the envelope', async () => {
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true, publishMode: 'review' },
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
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: false },
      makeCtx({ json: true }),
      deps({ confirmPermissions: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'declined', added: [] });
    expect(await allowList()).toBeUndefined();
  });

  // Every skipped state names the command that changes it, the same contract a
  // CliError's `fix` carries, so a machine consumer never has to parse prose.
  it('carries a fix string on every skipped permissions state', async () => {
    const declined = await runInstall(
      { harness: ['claude'], allowFreeVerbs: false },
      makeCtx({ json: true }),
      deps(),
    );
    expect(wiredOf(declined.data).fix).toContain('tenjin install --allow-free-verbs');

    const dry = await runInstall(
      { harness: ['claude'], dryRun: true },
      makeCtx({ json: true }),
      deps(),
    );
    expect(wiredOf(dry.data).fix).toContain('tenjin install --allow-free-verbs');

    const codex = await runInstall({ harness: ['codex'] }, makeCtx({ json: true }), deps());
    expect(wiredOf(codex.data).fix).toContain('tenjin doctor');
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
    const args = { harness: ['claude'], allowFreeVerbs: true, publishMode: 'review' };
    await runInstall(args, makeCtx(), deps());
    const res = await runInstall(args, makeCtx(), deps({ isInteractive: true }));
    expect(wiredOf(res.data).added).toEqual([]);
    expect(wiredOf(res.data).alreadyPresent).toEqual([...FREE_VERB_RULES]);
    expect(await allowList()).toEqual([...FREE_VERB_RULES]);
    expect(human(res)).toContain('were already allowed');
  });

  // Re-running install is the advice for refreshing a stale setup, so this is the
  // ordinary second-run path, not an edge case.
  it('does not re-ask once every rule is already allowed', async () => {
    await runInstall(
      { harness: ['claude'], allowFreeVerbs: true, publishMode: 'review' },
      makeCtx(),
      deps(),
    );
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data)).toMatchObject({ added: [], alreadyPresent: [...FREE_VERB_RULES] });
    expect(human(res)).toContain('were already allowed');
  });

  // The no-prompt path must not perform a SECOND read. Re-reading meant a rule
  // revoked between probe and write was silently re-added without a prompt, which
  // is the one thing a consent gate cannot do.
  it('reports the probe snapshot and writes nothing if a rule is revoked mid-run', async () => {
    await runInstall(
      { harness: ['claude'], allowFreeVerbs: true, publishMode: 'review' },
      makeCtx(),
      deps(),
    );
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx(),
      deps({
        isInteractive: true,
        confirmPermissions: confirm,
        // Probe says satisfied; the file loses a rule immediately afterwards.
        inspectPermissions: async (h) => {
          const out = await inspectFreeVerbRules(h);
          await writeSettings({ permissions: { allow: [...FREE_VERB_RULES.slice(1)] } });
          return out;
        },
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data).added).toEqual([]);
    // The revoked rule stays revoked: no unprompted re-grant.
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
      res = await runInstall(
        { harness: ['claude'] },
        makeCtx(),
        deps({ isInteractive: true, confirmPermissions: async () => true }),
      );
    } finally {
      fsHooks.settingsInterleave = '';
      fsHooks.settingsReads = 0;
      fsHooks.settingsInterleaveOnRead = 1;
    }
    expect(wiredOf(res.data).skipped).toBe('changed-since-read');
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain('changed while it was being updated');
    expect(text).toContain('Re-run: tenjin install');
    expect(text).not.toContain('Fix it, then');
  });

  it('still asks when only SOME of the rules are allowed', async () => {
    await writeSettings({ permissions: { allow: [FREE_VERB_RULES[0]] } });
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(wiredOf(res.data).added).toEqual(FREE_VERB_RULES.slice(1));
  });

  // A file we cannot read is not "already allowed": the probe returns null and the
  // question is still asked, so the writer gets to report why nothing was written.
  it('still asks when the settings file cannot be parsed', async () => {
    await writeSettings('not json at all');
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'auto' },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'unparsable' });
  });

  // Under `review` the retraction runs first and reads the same file, so an
  // unreadable one is settled before the question: nothing can be written either
  // way, and asking a question whose yes cannot be honored is a prompt for
  // nothing. What the operator gets instead is the pair named, with the command
  // that always works.
  it('asks nothing on an unreadable file under review, and names the pair', async () => {
    await writeSettings('not json at all');
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'], publishMode: 'review' },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data)).toMatchObject({ skipped: 'unparsable' });
    const fix = wiredOf(res.data).fix ?? '';
    for (const rule of MODE_GATED_RULES) expect(fix).toContain(rule);
    expect(fix).toContain('tenjin uninstall');
  });

  it('--dry-run neither prompts nor writes', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['claude'], dryRun: true, allowFreeVerbs: true },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
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
      { harness: ['claude'], dryRun: true, allowFreeVerbs: true, publishMode: 'auto' },
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
      { harness: ['claude'], dryRun: true, allowFreeVerbs: true, publishMode: 'review' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const line =
      human(res)
        .split('\n')
        .find((l) => l.includes('Permissions:')) ?? '';
    expect(line).toContain('would remove 2 rule(s) for publish and edit');
    // Nothing happened, so nothing is "otherwise" unchanged.
    expect(line).not.toContain('otherwise unchanged');
    expect(line).toContain('unchanged (dry run)');
    // Past tense belongs to a run that actually wrote.
    expect(line).not.toContain('were removed');
    expect(await allowList()).toEqual([...FREE_VERB_RULES, PUBLISH_MODE_RULE, EDIT_MODE_RULE]);
  });

  it('--dry-run on review plans the free tier only, and no grant', async () => {
    const res = await runInstall(
      { harness: ['claude'], dryRun: true, allowFreeVerbs: true, publishMode: 'review' },
      makeCtx({ json: true }),
      deps(),
    );
    const wired = wiredOf(res.data);
    expect(wired.added).toEqual([...FREE_VERB_RULES]);
    expect(wired.modeGrant).toBeUndefined();
    expect(await allowList()).toBeUndefined();
  });

  it('--dry-run says "would allow" in the human line, and offers no undo', async () => {
    const res = await runInstall(
      { harness: ['claude'], dryRun: true, allowFreeVerbs: true, publishMode: 'auto' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const text = human(res);
    expect(text).toContain(
      `would allow ${FREE_VERB_RULES.length + MODE_GATED_RULES.length} tenjin commands in`,
    );
    expect(text).toContain('Would turn off: tenjin config set publish.mode review');
    // The tail that tells an operator how to undo a write belongs to a write.
    expect(text).not.toContain('Undo anytime:');
  });

  it('--dry-run on an already-wired machine says so rather than planning a write', async () => {
    await runInstall(
      { harness: ['claude'], allowFreeVerbs: true, publishMode: 'auto' },
      makeCtx({ json: true }),
      deps(),
    );
    const res = await runInstall(
      { harness: ['claude'], dryRun: true, allowFreeVerbs: true, publishMode: 'auto' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(wiredOf(res.data).added).toEqual([]);
    expect(wiredOf(res.data).alreadyPresent).toEqual([...FREE_VERB_RULES, ...MODE_GATED_RULES]);
    expect(human(res)).toContain('unchanged (dry run)');
  });

  it('skips a codex-only install without asking, and says why', async () => {
    const confirm = vi.fn(async () => true);
    const res = await runInstall(
      { harness: ['codex'] },
      makeCtx(),
      deps({ isInteractive: true, confirmPermissions: confirm }),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(wiredOf(res.data)).toMatchObject({ harness: 'codex', skipped: 'harness-not-claude' });
    expect(await allowList()).toBeUndefined();
    expect(human(res)).toContain('Claude Code only');
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
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
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
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true },
      makeCtx(),
      deps({ isInteractive: true }),
    );
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
    await runInstall(
      { harness: ['claude'], allowFreeVerbs: true, publishMode: 'review' },
      makeCtx(),
      deps(),
    );
    const settings = JSON.parse(await readFile(claudeSettingsPath(home), 'utf8')) as {
      model: string;
      permissions: { allow: string[] };
    };
    expect(settings.model).toBe('opus');
    expect(settings.permissions.allow).toEqual(['Bash(git status:*)', ...FREE_VERB_RULES]);
  });

  it('keeps the three recommendation tiers beside the write outcome', async () => {
    const res = await runInstall(
      { harness: ['claude'], allowFreeVerbs: true, publishMode: 'review' },
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
        { harness: ['claude'], allowFreeVerbs: true, publishMode: 'auto' },
        makeCtx({ json: true }),
        deps(),
      );
      expect(wiredOf(res.data).added).toEqual([...FREE_VERB_RULES, ...MODE_GATED_RULES]);
      expect(await allowList()).toEqual([...FREE_VERB_RULES, ...MODE_GATED_RULES]);
    });

    it('writes it when auto is already the configured mode', async () => {
      await runInstall(
        { harness: ['claude'], allowFreeVerbs: true, publishMode: 'auto' },
        makeCtx({ json: true }),
        deps(),
      );
      // Second run names no mode: it reads `auto` back out of config.
      const res = await runInstall(
        { harness: ['claude'], allowFreeVerbs: true },
        makeCtx({ json: true }),
        deps(),
      );
      expect(wiredOf(res.data).alreadyPresent).toContain(PUBLISH_MODE_RULE);
    });

    it('does not write it on review', async () => {
      const res = await runInstall(
        { harness: ['claude'], allowFreeVerbs: true, publishMode: 'review' },
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
      // The keystore is the part the free-tier wording does not cover, and the
      // part `tenjin session start` exists as an explicit opt-in for. The rest of
      // what the pair clears is in docs/agent-permissions.md; this line stays one
      // sentence.
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
        deps({ isInteractive: true, confirmPermissions: async () => true }),
      );
      const text = human(res);
      expect(text).toContain(
        `${FREE_VERB_RULES.length + MODE_GATED_RULES.length} tenjin commands allowed`,
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
        deps({ isInteractive: true, confirmPermissions: async () => true }),
      );
      /**
       * PRESENCE, not absence. The first cut of this test pinned the lean terminal
       * with `not.toMatch(/Bash\(/)` and `not.toContain('tenjin uninstall')`, which
       * encodes the deletion rather than the disclosure: both pass just as well
       * when the whole block goes missing. These assert the two lines an operator
       * has to leave the install with.
       */
      const lines = human(res).split('\n');
      const publishing = lines.find((l) => l.includes('Publishing:')) ?? '';
      expect(publishing).toContain('Publishing: auto');
      expect(publishing).toContain('publishes and updates pieces on its own, under your identity');
      expect(publishing).toContain('Turn off: tenjin config set publish.mode review');

      const permissions = lines.find((l) => l.includes('Permissions:')) ?? '';
      expect(permissions).toContain(
        `${FREE_VERB_RULES.length + MODE_GATED_RULES.length} tenjin commands allowed in`,
      );
      expect(permissions).toContain(`Details: ${PERMISSIONS_DOC_URL}`);

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
      expect(human(res)).not.toContain('Turn off:');
    });

    // `--no-allow-free-verbs` still refuses the whole write, publish rule included.
    it('writes nothing at all when the allowlist itself is refused', async () => {
      const res = await runInstall(
        { harness: ['claude'], allowFreeVerbs: false },
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
        { harness: ['claude'], allowFreeVerbs: false, publishMode: 'review' },
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
            .find((l) => l.includes('Permissions:')) ?? ''
        );
      };

      const declined = await lineFor({
        harness: ['claude'],
        allowFreeVerbs: false,
        publishMode: 'review',
      });
      expect(declined).toContain('2 rule(s) for publish and edit were removed');
      expect(declined).not.toMatch(/Permissions: unchanged\./);

      const otherHarness = await lineFor({ harness: ['codex'], publishMode: 'review' });
      expect(otherHarness).toContain('2 rule(s) for publish and edit were removed');
      // "not wired (Claude Code only)" read as "your Claude settings were left
      // alone", which is the opposite of what just happened to them.
      expect(otherHarness).not.toMatch(/not wired \(Claude Code only\)/);
      // And it NAMES the file. A non-Claude skip carries no path on purpose, but
      // once this run has deleted from that file, withholding its name is the
      // thing that leaves the operator unable to check.
      expect(otherHarness).toContain(claudeSettingsPath(home));
    });

    // And the word stays honest the other way: a run that retracted nothing and
    // wrote nothing is the only one allowed to say "unchanged".
    it('still says unchanged when there was genuinely nothing to take back', async () => {
      await writeSettings({ permissions: { allow: ['Bash(git status:*)'] } });
      const res = await runInstall(
        { harness: ['claude'], allowFreeVerbs: false, publishMode: 'review' },
        makeCtx(),
        deps({ isInteractive: true }),
      );
      const line = human(res)
        .split('\n')
        .find((l) => l.includes('Permissions:'));
      expect(line).toMatch(/Permissions: unchanged\./);
      expect(line).not.toContain('were removed');
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
      expect(wiredOf(res.data).skipped).toBe('harness-not-claude');
      expect(wiredOf(res.data).removed).toEqual([...MODE_GATED_RULES]);
      expect(await allowList()).toEqual([]);
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
        { harness: ['claude'], allowFreeVerbs: true, publishMode: 'review' },
        makeCtx(),
        deps({ isInteractive: true }),
      );
      const wired = wiredOf(res.data);
      expect(wired.added).toEqual([...FREE_VERB_RULES]);
      for (const rule of [...MODE_GATED_RULES, ...LEGACY_ALLOWLIST_RULES]) {
        expect(wired.removed, rule).toContain(rule);
      }
      expect(await allowList()).toEqual(['Bash(git status:*)', ...FREE_VERB_RULES]);

      // And the line says what happened rather than claiming a tier it never wrote.
      const text = human(res);
      expect(text).toContain(`${FREE_VERB_RULES.length} tenjin commands allowed in`);
      expect(text).not.toContain('were already allowed');
      expect(text).toContain('Publishing is back to asking first');
      // The legacy sweep's note is about commands that no longer exist. `publish`
      // and `edit` very much exist, so they must not be counted into it.
      expect(text).toContain(
        `Removed ${LEGACY_ALLOWLIST_RULES.length} permission rule(s) an older tenjin left`,
      );
    });

    // The mode moved back to "ask me first", so the rule that skipped the asking
    // must not outlive it.
    it('takes it back when the mode returns to review', async () => {
      await runInstall(
        { harness: ['claude'], allowFreeVerbs: true, publishMode: 'auto' },
        makeCtx({ json: true }),
        deps(),
      );
      const res = await runInstall(
        { harness: ['claude'], allowFreeVerbs: true, publishMode: 'review' },
        makeCtx({ json: true }),
        deps(),
      );
      expect(wiredOf(res.data).removed).toEqual([...MODE_GATED_RULES]);
      expect(await allowList()).toEqual([...FREE_VERB_RULES]);
    });

    // The consent prompt has to name what the write actually carries.
    // What auto changes about the answer, in the question itself: the count goes
    // up and the agent publishes as them. NOT the rule strings, which the operator
    // has not met yet and cannot act on at a yes/no.
    it('discloses what auto adds in the question it asks', async () => {
      const confirm = vi.fn(async (_label: string) => true);
      await runInstall(
        { harness: ['claude'], publishMode: 'auto' },
        makeCtx(),
        deps({ isInteractive: true, confirmPermissions: confirm }),
      );
      const asked = confirm.mock.calls[0]![0];
      expect(asked).toContain(
        `Adds ${FREE_VERB_RULES.length + MODE_GATED_RULES.length} command rules`,
      );
      expect(asked).toContain('publish.mode auto your agent will publish under your identity');
      expect(asked).not.toContain(PUBLISH_MODE_RULE);
    });

    it('names no extra rule in the question on review', async () => {
      const confirm = vi.fn(async (_label: string) => true);
      await runInstall(
        { harness: ['claude'], publishMode: 'review' },
        makeCtx(),
        deps({ isInteractive: true, confirmPermissions: confirm }),
      );
      expect(confirm.mock.calls[0]![0]).not.toContain(PUBLISH_MODE_RULE);
    });

    it('carries the mode-gated tier in the envelope', async () => {
      const res = await runInstall(
        { harness: ['claude'], allowFreeVerbs: true, publishMode: 'auto' },
        makeCtx({ json: true }),
        deps(),
      );
      const d = res.data as WiredData;
      expect(d.permissions.modeGated.map((e) => e.rule)).toEqual([...MODE_GATED_RULES]);
    });
  });
});

// --- The four decisions, in order, and nothing else -------------------------------

describe('runInstall: at most four questions', () => {
  it('asks publishing, permissions, search hooks, then wallet, and stops there', async () => {
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
        confirmPermissions: async () => {
          asked.push('permissions');
          return true;
        },
        promptSearchHooks: async () => {
          asked.push('search-hooks');
          return 'auto';
        },
        walletExists: async () => false,
        confirmWallet: async () => {
          asked.push('wallet');
          return false;
        },
      }),
    );
    expect(asked).toEqual(['publishing', 'permissions', 'search-hooks', 'wallet']);
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
        confirmPermissions: async () => {
          asked.push('permissions');
          return true;
        },
        promptSearchHooks: async () => {
          asked.push('search-hooks');
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

  it('tells the human that publish is wired and the hosted skill was superseded', async () => {
    await seedHostedSkill(join(home, '.claude', 'skills'));
    const res = await runInstall({ harness: ['claude'] }, makeCtx(), deps({ isInteractive: true }));
    const text = (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
    expect(text).toContain('tenjin-search, tenjin-publish (CLI)');
    expect(text).toContain('zero-install fallback');
    expect(text).toContain('take precedence');
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

  // The hosted-skill-first funnel puts the mirror in BOTH targets, and the notice
  // is emitted once per harness. Without the directory the two lines are byte
  // identical and read as the CLI stuttering.
  it('names the directory, so a two-harness machine gets two distinguishable lines', async () => {
    const claudeSkills = join(home, '.claude', 'skills');
    const sharedSkills = join(home, '.agents', 'skills');
    await seedHostedSkill(claudeSkills);
    await seedHostedSkill(sharedSkills);

    const res = await runInstall(
      { harness: ['claude', 'codex'] },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    const lines = (res.humanLines ?? [])
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')) // eslint-disable-line no-control-regex
      // The notice's own phrase: the per-harness warning says "stays as", and the
      // summary's skill list says "(hosted, zero-install fallback)".
      .filter((l) => l.includes('kept as the zero-install fallback'));
    expect(lines).toHaveLength(2);
    expect(new Set(lines).size).toBe(2);
    expect(lines.some((l) => l.includes(claudeSkills))).toBe(true);
    expect(lines.some((l) => l.includes(sharedSkills))).toBe(true);
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
      await writeFile(join(dir, rel), await readFile(join(SKILLS_SRC, 'tenjin-search', rel)));
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
    await writeFile(
      join(dir, 'SKILL.md'),
      await readFile(join(SKILLS_SRC, 'tenjin-search', 'SKILL.md')),
    );
    await writeFile(join(dir, 'references', 'notes.md'), 'my private notes');

    const { data } = await runInstall({ harness: ['claude'] }, makeCtx(), deps());
    const skill = asData(data).harnesses[0]!.skills.find((x) => x.name === 'tenjin-search')!;
    expect(skill.status).toBe('updated');
    expect(await readFile(join(dir, 'references', 'permissions.md'), 'utf8')).toBe(
      await readFile(join(SKILLS_SRC, 'tenjin-search', 'references', 'permissions.md'), 'utf8'),
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
      await readFile(join(SKILLS_SRC, 'tenjin-search', 'SKILL.md'), 'utf8'),
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
    expect(await readFile(join(real, 'SKILL.md'))).toEqual(
      await readFile(join(SKILLS_SRC, 'tenjin-search', 'SKILL.md')),
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
    expect(await readFile(managed)).toEqual(
      await readFile(join(SKILLS_SRC, 'tenjin-search', 'SKILL.md')),
    );
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
  it('declares exactly the files each skill actually ships', async () => {
    for (const name of SKILL_NAMES) {
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
    for (const name of SKILL_NAMES) expect(SHIPPED_SKILL_FILES[name][0]).toBe('SKILL.md');
  });

  // Everything else in the tree is written in place beside the operator's own
  // files, so a shipped path may never climb out of its skill directory.
  it('declares no path that escapes its own skill directory', () => {
    for (const name of SKILL_NAMES) {
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
      Array.from({ length: 5 }, () =>
        runInstall({ harness: ['claude'], allowFreeVerbs: true }, makeCtx(), deps()),
      ),
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

// --- Decision 3: the harness search hooks ------------------------------------------

describe('runInstall: search hooks', () => {
  type HooksData = {
    hooks: {
      harness: string;
      path?: string;
      scriptsDir: string;
      mode: string;
      added: string[];
      alreadyPresent: string[];
      updated: string[];
      scripts: string[];
      skipped?: string;
      fix?: string;
    };
  };
  const hooksOf = (d: unknown) => (d as HooksData).hooks;

  async function settings(): Promise<Record<string, unknown>> {
    const raw = await readFile(claudeSettingsPath(home), 'utf8').catch(() => null);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
  }
  async function persistedMode(): Promise<string | undefined> {
    const raw = await readFile(join(data, 'config.json'), 'utf8').catch(() => null);
    if (raw === null) return undefined;
    return (JSON.parse(raw) as { hooks?: { searchMode?: string } }).hooks?.searchMode;
  }

  // A bare headless install is the one that most needs the hooks, and it is the
  // one that used to get the least.
  it('a non-interactive run wires every hook and writes every script', async () => {
    const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    const h = hooksOf(res.data);

    expect(h.skipped).toBeUndefined();
    expect(h.mode).toBe('auto');
    expect(h.added).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
    expect(h.scriptsDir).toBe(join(data, 'hooks'));
    expect(h.scripts).toHaveLength(4);
    for (const file of [
      'tenjin-websearch.mjs',
      'tenjin-dispatch.mjs',
      'tenjin-sessionstart.mjs',
      'tenjin-stop.mjs',
    ]) {
      expect(existsSync(join(data, 'hooks', file)), file).toBe(true);
    }

    const hooks = (await settings()).hooks as Record<string, { matcher?: string }[]>;
    expect(hooks.PreToolUse?.[0]?.matcher).toBe('WebSearch');
    expect(hooks.PreToolUse?.[1]?.matcher).toBe('Agent|Task');
    expect(hooks.SessionStart?.[0]?.matcher).toBe('startup|clear|compact');
    expect(hooks.Stop).toHaveLength(1);
    expect(await persistedMode()).toBe('auto');
  });

  // settings.json hooks load at session start, so an operator who does not
  // restart gets zero hook activity and nothing telling them why.
  it('tells the operator to restart, but only when hooks were actually wired', async () => {
    const human = (res: { humanLines?: string[] }): string =>
      (res.humanLines ?? []).join('\n').replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex

    // The flag settles the hooks without a prompt; isInteractive is only what
    // makes install return the walkthrough as humanLines at all.
    const wired = await runInstall(
      { harness: ['claude'], searchHooks: 'auto' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(human(wired)).toContain('Restart Claude Code');
    expect(human(wired)).toContain('read once at session start');

    const off = await runInstall(
      { harness: ['claude'], searchHooks: 'off' },
      makeCtx(),
      deps({ isInteractive: true }),
    );
    expect(human(off)).not.toContain('Restart Claude Code');
  });

  it('--search-hooks off registers nothing and persists the choice', async () => {
    const res = await runInstall(
      { harness: ['claude'], searchHooks: 'off' },
      makeCtx({ json: true }),
      deps(),
    );
    expect(hooksOf(res.data)).toMatchObject({ skipped: 'mode-off', mode: 'off', added: [] });
    expect((await settings()).hooks).toBeUndefined();
    expect(await persistedMode()).toBe('off');
    expect(hooksOf(res.data).fix).toContain('tenjin config set hooks.searchMode auto');
  });

  it('--search-hooks remind wires the hooks in remind mode', async () => {
    const res = await runInstall(
      { harness: ['claude'], searchHooks: 'remind' },
      makeCtx({ json: true }),
      deps(),
    );
    expect(hooksOf(res.data).mode).toBe('remind');
    expect(hooksOf(res.data).added).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
    expect(await persistedMode()).toBe('remind');
  });

  it('rejects an unknown --search-hooks value as USAGE, before anything is written', async () => {
    const err = await caught(() =>
      runInstall(
        { harness: ['claude'], searchHooks: 'sometimes' },
        makeCtx({ json: true }),
        deps(),
      ),
    );
    expect(err.code).toBe('USAGE');
    expect(err.fix).toContain('auto');
  });

  it('is idempotent: a second run registers nothing and reports already-present', async () => {
    await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    const h = hooksOf(res.data);
    expect(h.added).toEqual([]);
    expect(h.alreadyPresent).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
    expect(h.scripts).toEqual([]);
  });

  it('honors the interactive choice and persists it', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptSearchHooks: async () => 'remind' }),
    );
    expect(hooksOf(res.data).mode).toBe('remind');
    expect(await persistedMode()).toBe('remind');
  });

  // Escape at this prompt is the one cancel that used to WRITE: it resolved to
  // `auto`, registered both hooks and persisted the mode. Every other decision in
  // the walkthrough treats cancel as a decline, and so does this one now.
  it('a cancelled choice registers nothing and writes no config', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptSearchHooks: async () => null }),
    );
    expect(hooksOf(res.data).skipped).toBe('declined');
    expect(hooksOf(res.data).added).toEqual([]);
    expect(existsSync(join(data, 'hooks'))).toBe(false);
    expect((await settings()).hooks).toBeUndefined();
    expect(await persistedMode()).toBeUndefined();
  });

  it('a cancelled choice leaves an already-configured mode alone', async () => {
    await runInstall(
      { harness: ['claude'], searchHooks: 'remind' },
      makeCtx({ json: true }),
      deps(),
    );
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, promptSearchHooks: async () => null }),
    );
    expect(hooksOf(res.data).skipped).toBe('declined');
    expect(await persistedMode()).toBe('remind');
  });

  // Same treatment for an answer the schema does not recognize: a cancel, never a
  // write of something unknown.
  it('an unrecognized answer is a cancel, not a write', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({
        isInteractive: true,
        promptSearchHooks: async () => 'sometimes' as never,
      }),
    );
    expect(hooksOf(res.data).skipped).toBe('declined');
    expect(await persistedMode()).toBeUndefined();
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
    expect(await persistedMode()).toBeUndefined();
  });

  it('is not wired for a Codex-only install, and names no Claude settings file', async () => {
    const res = await runInstall({ harness: ['codex'] }, makeCtx({ json: true }), deps());
    const h = hooksOf(res.data);
    expect(h.skipped).toBe('harness-not-claude');
    expect(h.path).toBeUndefined();
    expect(existsSync(join(data, 'hooks'))).toBe(false);
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
      hooks: { added: string[] };
    };
    // The default mode is auto, so the publish rule rides along with the tier.
    expect(d.permissions.wired.added).toEqual([...FREE_VERB_RULES, ...MODE_GATED_RULES]);
    expect(d.hooks.added).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
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

  it('discloses the empty balance, the human funding step, and where the key lives', async () => {
    const res = await runInstall(
      { harness: ['claude'] },
      makeCtx(),
      deps({ isInteractive: true, confirmWallet: async () => true }),
    );
    const text = human(res);
    expect(text).toContain('It holds $0.');
    expect(text).toContain('Funding it is a human step');
    expect(text).toContain(join(data, 'wallet.json'));
    expect(text).toContain('encrypted at rest');
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
  const hooksOf = (d: unknown) => (d as { hooks: { skipped?: string; mode: string } }).hooks;

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

  // The difference from `--search-hooks off`, which IS a durable statement.
  it('leaves a later bare re-run free to wire them', async () => {
    await runInstall({ harness: ['claude'], noHooks: true }, makeCtx({ json: true }), deps());
    const res = await runInstall({ harness: ['claude'] }, makeCtx({ json: true }), deps());
    expect(hooksOf(res.data).skipped).toBeUndefined();
    expect(existsSync(join(data, 'hooks'))).toBe(true);
  });
});
