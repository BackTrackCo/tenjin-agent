import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the self-heal resolves its packaged skills from. Empty means the real
 * resolution, which from a source checkout is a working tree the heal refuses;
 * the heal case below points it at a packaged LAYOUT instead, because that
 * refusal is by directory shape and nothing else here can produce one.
 */
const skillsSrc = vi.hoisted(() => ({ dir: '' }));
vi.mock('./lib/skills-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/skills-source')>();
  return {
    ...actual,
    resolveSkillsSource: (startDir: string) =>
      skillsSrc.dir === '' ? actual.resolveSkillsSource(startDir) : skillsSrc.dir,
  };
});
import { main } from './cli';
import { resolveSkillsSource } from './lib/skills-source';
import { PERMISSIONS_DOC_URL } from './lib/permissions';
import type { Io } from './lib/output';

// The dispatcher runs the update check and the skills self-heal after every
// command, and the cases below would otherwise let one reach the npm registry and
// the other rewrite the developer's own ~/.claude/skills. CI is the production
// skip signal for the check, so setting it keeps this file offline through the
// same door a build machine uses; the heal is bounded by pointing HOME and the
// data dir at a sandbox for the whole file.
let sandbox: string;
const prevEnv: Record<string, string | undefined> = {};
beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'tenjin-cli-sandbox-'));
  for (const key of ['CI', 'HOME', 'TENJIN_DATA_DIR']) prevEnv[key] = process.env[key];
  process.env.CI = '1';
  process.env.HOME = join(sandbox, 'home');
  process.env.TENJIN_DATA_DIR = join(sandbox, 'data');
});
afterAll(async () => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(sandbox, { recursive: true, force: true });
});

function captureIo(isTTY = false) {
  const out: string[] = [];
  const err: string[] = [];
  const mk = (sink: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        sink.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const io: Io = { stdout: mk(out), stderr: mk(err), isTTY };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}

// This file covers the DISPATCHER only — argument routing, the one-JSON-object
// contract, global-flag handling, and exit-code classes. It never invokes a
// feature command body (doctor/config/wallet, implemented separately): those do
// real I/O (network, filesystem, stdin), so every case here is driven to a
// deterministic, offline dispatcher-level outcome instead of a command result.
describe('main', () => {
  it('unknown command exits 2 with exactly one JSON error object', async () => {
    const cap = captureIo();
    const code = await main(['bogus'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('USAGE');
    // Not a TTY: no human decoration leaks to stderr.
    expect(cap.stderr()).toBe('');
  });

  it('bare invocation exits 2 with the usage contract', async () => {
    const cap = captureIo();
    const code = await main([], cap.io);
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
  });

  // The verb split (#42) is only useful if the free verb is the one you meet first:
  // `read` is registered, and listed ahead of the paying verb in help.
  it('lists `read` in help, ahead of `buy`', async () => {
    const cap = captureIo();
    const code = await main(['--help'], cap.io);
    expect(code).toBe(0);
    const help = cap.stdout();
    expect(help).toContain('read [options] <resource>');
    expect(help.indexOf('read [options] <resource>')).toBeLessThan(
      help.indexOf('buy [options] <resource>'),
    );
  });

  // A pointer in help has to work from wherever the reader is standing, which is
  // their own project and not this package. A repo-relative `docs/...` path reads
  // as a file they can open and is not one.
  it('points the allowlist help at the permissions URL, not a relative path', async () => {
    const cap = captureIo();
    expect(await main(['install', '--help'], cap.io)).toBe(0);
    const help = cap.stdout();
    expect(help).toContain(PERMISSIONS_DOC_URL);
    expect(help).not.toMatch(/(?<!\/)docs\/agent-permissions\.md/);
    // Same tier claim as every other surface, doctor's local check included.
    expect(help.replace(/\s+/g, ' ')).toContain('none can spend USDC or move your keys');
    expect(help.replace(/\s+/g, ' ')).toContain('doctor may check your wallet still opens');
  });

  it('bare invocation at a TTY: commander help on stderr, stdout empty (no envelope)', async () => {
    const cap = captureIo(true);
    const code = await main([], cap.io);
    expect(code).toBe(2);
    expect(cap.stdout()).toBe(''); // no JSON envelope, no duplicate human line
    expect(cap.stderr()).toContain('Usage:'); // commander's help text stands alone
  });

  // The output contract at the dispatcher level, driven by a command's offline
  // validation throw (`config set <unknown-key>` fails before any I/O).
  describe('output contract (human-first at a TTY)', () => {
    const bad = ['config', 'set', 'no-such-key', 'x'];

    it('at a TTY without --json, prints the human error to stdout and no envelope', async () => {
      const cap = captureIo(true);
      const code = await main(bad, cap.io);
      expect(code).toBe(2);
      expect(cap.stdout()).toContain('error:');
      expect(cap.stdout()).not.toContain('schemaVersion'); // no JSON envelope
      expect(cap.stderr()).toBe('');
    });

    it('when stdout is piped (not a TTY), prints the JSON envelope', async () => {
      const cap = captureIo(false);
      await main(bad, cap.io);
      expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
    });

    it('--json forces the envelope even at a TTY', async () => {
      const cap = captureIo(true);
      await main(['--json', ...bad], cap.io);
      expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
    });
  });

  // Same contract, but for a commander PARSE error (unknown command) rather than a
  // command's own validation throw. Here commander writes the usage text to stderr,
  // so human mode leaves stdout empty (no envelope, no duplicate) instead of
  // painting an error line to stdout — the inverse surface from the block above.
  describe('output contract (human-first for a parse error)', () => {
    it('unknown command at a TTY: usage on stderr, stdout empty (no envelope)', async () => {
      const cap = captureIo(true);
      const code = await main(['bogus'], cap.io);
      expect(code).toBe(2);
      expect(cap.stdout()).toBe(''); // no JSON envelope, no second human line
      expect(cap.stderr()).not.toBe(''); // commander's usage text stands alone
    });

    it('unknown command when piped: JSON envelope on stdout, stderr empty', async () => {
      const cap = captureIo(false);
      const code = await main(['bogus'], cap.io);
      expect(code).toBe(2);
      expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
      expect(cap.stderr()).toBe('');
    });
  });

  it('--version prints the version and exits 0', async () => {
    const cap = captureIo();
    const code = await main(['--version'], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('an invalid --timeout is a USAGE failure (exit 2)', async () => {
    const cap = captureIo();
    const code = await main(['--timeout', 'abc', 'doctor'], cap.io);
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
  });

  it('--json suppresses stderr on a TTY for a failing command', async () => {
    const cap = captureIo(true);
    // Deterministic offline failure (unknown command → USAGE), so this exercises
    // --json-on-TTY suppression without invoking any command body.
    const code = await main(['--json', 'bogus'], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr()).toBe('');
    expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
  });
});

// Global flags (--json / --base-url / --timeout) must parse in ANY position, not
// just before the subcommand (git-style). Each case drives a real leaf command to
// a dispatcher-level USAGE failure (a bad trailing --timeout, rejected before the
// body runs), which proves the leaf ACCEPTED the trailing flags: the envelope's
// `command` is the leaf itself, not the 'tenjin' parse-error envelope an unknown
// option would produce — with no network, filesystem, or command-body behavior.
describe('global flags are position-independent', () => {
  it('trailing --base-url and --timeout are accepted on the leaf (routes to the command)', async () => {
    const cap = captureIo();
    const code = await main(
      ['doctor', '--base-url', 'https://x.example', '--timeout', 'abc'],
      cap.io,
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.error.code).toBe('USAGE');
    // Unknown options would bail as a parse error with command 'tenjin'; routing to
    // 'doctor' proves both trailing flags were consumed by the leaf.
    expect(parsed.command).toBe('doctor');
  });

  it('trailing globals also work on a depth-2 subcommand (wallet show)', async () => {
    const cap = captureIo();
    const code = await main(['wallet', 'show', '--timeout', 'abc'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.error.code).toBe('USAGE');
    expect(parsed.command).toBe('wallet.show');
  });

  it('trailing --json suppresses stderr on a TTY, exactly like leading --json', async () => {
    const lead = captureIo(true);
    await main(['--json', 'doctor', '--timeout', 'abc'], lead.io);
    const trail = captureIo(true);
    await main(['doctor', '--timeout', 'abc', '--json'], trail.io);
    // --json is honored in either position: no stderr decoration on a TTY, and the
    // same USAGE envelope routed to 'doctor'.
    expect(lead.stderr()).toBe('');
    expect(trail.stderr()).toBe('');
    for (const cap of [lead, trail]) {
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.ok).toBe(false);
      expect(parsed.command).toBe('doctor');
      expect(parsed.error.code).toBe('USAGE');
    }
  });
});

// `edit` has nineteen flags, hand-mapped from commander's camelCase options into
// EditArgs. A swapped pair (--provenance landing on methodology) changes nothing
// about whether the command runs, so it needs a check that reads the flag NAME
// back out. Every set-flag rejects an explicit empty value and names itself doing
// it, which happens before any wallet or network work — so the error message is a
// hermetic probe of the mapping, one flag at a time.
describe('edit flag forwarding (the dispatcher mapping)', () => {
  const POST_ID = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const flags = [
    '--title',
    '--price',
    '--body',
    '--excerpt',
    '--question',
    '--task',
    '--add-question',
    '--add-task',
    '--scope',
    '--exclusions',
    '--applies-to',
    '--as-of',
    '--valid-until',
    '--artifact-type',
    '--temporal-mode',
    '--provenance',
    '--methodology',
  ];

  it.each(flags)('%s reaches the arg it names', async (flag) => {
    const cap = captureIo();
    const code = await main(['edit', POST_ID, flag, '', '--json'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.command).toBe('edit');
    expect(parsed.error.code).toBe('USAGE');
    // The message is derived from the ARG KEY the value landed on, so a swap in the
    // dispatcher renders some other flag's name here.
    expect(parsed.error.message).toBe(`${flag} cannot be empty.`);
  });

  it('--clear reaches the clear list and reports the valid field names', async () => {
    const cap = captureIo();
    const code = await main(['edit', POST_ID, '--clear', 'bodyMd', '--json'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.command).toBe('edit');
    expect(parsed.error.message).toContain('Cannot clear "bodyMd"');
    expect(parsed.error.fix).toContain('questionsAnswered');
  });

  it('--question and --add-question stay distinct args (not one aliased pair)', async () => {
    const cap = captureIo();
    const code = await main(
      ['edit', POST_ID, '--question', 'a', '--add-question', 'b', '--json'],
      cap.io,
    );
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout()).error.message).toBe(
      'Pass either --question or --add-question, not both.',
    );
  });

  it('--task and --add-task stay distinct args', async () => {
    const cap = captureIo();
    const code = await main(['edit', POST_ID, '--task', 'a', '--add-task', 'b', '--json'], cap.io);
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout()).error.message).toBe(
      'Pass either --task or --add-task, not both.',
    );
  });

  it('--mode is validated at the edge, before any wallet or network work', async () => {
    const cap = captureIo();
    const code = await main(['edit', POST_ID, '--mode', 'reveiw', '--json'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.command).toBe('edit');
    expect(parsed.error.code).toBe('USAGE');
  });

  it('the postId positional is validated, and a bad one costs nothing', async () => {
    const cap = captureIo();
    const code = await main(['edit', 'not-a-uuid', '--title', 'x', '--json'], cap.io);
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout()).error.message).toContain('Invalid post id');
  });
});

/**
 * The `session` group. Dispatcher-level only: `session start` reaches a wallet,
 * so the cases here are the ones that resolve BEFORE it — the group exists, the
 * leaf exists, and a bad `--scope` is USAGE.
 */
describe('session command group', () => {
  it('registers `session start` as a subcommand, not a bare verb', async () => {
    const cap = captureIo();
    expect(await main(['session', '--help'], cap.io)).toBe(0);
    expect(cap.stdout()).toContain('start [options]');
  });

  it('a bare `tenjin session` is USAGE, never a silent mint', async () => {
    const cap = captureIo();
    expect(await main(['session'], cap.io)).toBe(2);
    expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
  });

  it('--scope read+write is refused as USAGE, before any wallet work', async () => {
    const cap = captureIo();
    const code = await main(['session', 'start', '--scope', 'read+write', '--json'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout()) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('USAGE');
    expect(parsed.error.message).toContain('read+write');
  });

  it('the leaf takes trailing global flags like every other command', async () => {
    const cap = captureIo();
    // A bad --timeout is a dispatcher-level USAGE, which proves the leaf parsed
    // the global flag rather than passing it through as an unknown option.
    const code = await main(['session', 'start', '--timeout', 'abc'], cap.io);
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout()).error.code).toBe('USAGE');
  });
});

/**
 * The post-command skills self-heal, at the dispatcher. It runs after the
 * envelope, so what matters here is that a command's contract is untouched by it;
 * the heal's own behavior is covered in lib/skill-heal.test.ts, and the packed
 * binary actually healing a stale skill is covered in scripts/pack-smoke.sh.
 */
describe('skills self-heal', () => {
  const wiredPath = (): string =>
    join(process.env.HOME!, '.claude', 'skills', 'tenjin-search', 'SKILL.md');
  const STALE = '---\nname: tenjin-search\n---\n\nstale\n';

  // The file-level CI=1 would skip the heal outright and make both cases below
  // pass for the wrong reason, so this block clears it. Every case here stays off
  // a TTY, which is what keeps the update nudge (TTY-gated, unlike the heal) from
  // reaching the network once CI is out of the way.
  beforeEach(async () => {
    process.env.CI = '';
    await mkdir(join(process.env.HOME!, '.claude', 'skills', 'tenjin-search'), { recursive: true });
    await writeFile(wiredPath(), STALE);
  });
  afterEach(async () => {
    process.env.CI = '1';
    skillsSrc.dir = '';
    await rm(join(process.env.HOME!, '.claude'), { recursive: true, force: true });
  });

  /**
   * The packaged shape the heal insists on: a `skills/` whose parent holds no
   * `src/`. Copied out of the real one, so what lands is the bytes this build
   * ships.
   */
  async function packagedLayout(): Promise<string> {
    const real = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));
    const dir = join(sandbox, 'pkg', 'skills');
    await cp(real, dir, { recursive: true });
    return dir;
  }

  // A heal that RAN: the packaged-layout copy below passes the source-checkout
  // discriminator, so the file is genuinely rewritten while this asserts stdout.
  // Without it the case would pass on a heal that never happened.
  it('heals a stale skill and still emits exactly one JSON object, exit 0', async () => {
    skillsSrc.dir = await packagedLayout();
    const cap = captureIo();
    expect(await main(['config', '--json'], cap.io)).toBe(0);
    const parsed = JSON.parse(cap.stdout()) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(await readFile(wiredPath(), 'utf8')).toBe(
      await readFile(join(skillsSrc.dir, 'tenjin-search', 'SKILL.md'), 'utf8'),
    );
    expect(cap.stderr()).toContain('Updated');
  });

  // This suite runs from the source tree, which is exactly the case the heal
  // declines: a checkout's skills/ can be half-edited, and nobody installed it.
  it('does not heal from a source checkout', async () => {
    const cap = captureIo();
    expect(await main(['config'], cap.io)).toBe(0);
    expect(await readFile(wiredPath(), 'utf8')).toBe(STALE);
  });
});
