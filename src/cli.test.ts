import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
import { renderSkillMarkdown } from './lib/skill-materialize';
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
  // The sandbox's OWN default, not a second location: the skills heal stands
  // down when TENJIN_DATA_DIR points away from the machine default, so pointing
  // it somewhere else here would skip the heal and make the cases below pass for
  // the wrong reason. HOME is what bounds this file to the sandbox; this line
  // only makes the data dir explicit at the same place the default resolves to.
  process.env.TENJIN_DATA_DIR = join(sandbox, 'home', '.tenjin');
});
afterAll(async () => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(sandbox, { recursive: true, force: true });
});

function captureIo(isTTY = false, stdin?: { stream: NodeJS.ReadableStream; isTTY: boolean }) {
  const out: string[] = [];
  const err: string[] = [];
  const mk = (sink: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        sink.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const io: Io = {
    ...(stdin !== undefined ? { stdin } : {}),
    stdout: mk(out),
    stderr: mk(err),
    isTTY,
  };
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

  // The release ships two products and nothing else, so the root list is the
  // one place a stray shelf verb would show up.
  it('lists only the core and router commands', async () => {
    const cap = captureIo();
    const code = await main(['--help'], cap.io);
    expect(code).toBe(0);
    const help = cap.stdout();
    for (const command of ['install', 'uninstall', 'update', 'config', 'doctor', 'status'])
      expect(help).toContain(command);
    for (const command of ['wallet', 'pay', 'hook', 'mcp']) expect(help).toContain(command);
    for (const shelf of ['search <question>', 'publish [file]', 'discover', 'grade', 'daemon'])
      expect(help).not.toContain(shelf);
  });

  /**
   * The shape `tenjin --help` is expected to hold (clig.dev's "display the most
   * common flags and commands at the start", gh's grouped root list): five
   * headings, one line per command, the globals listed once, and examples plus
   * pointers at the end. A command that lands outside them falls into
   * commander's ungrouped `Commands:` bucket, which is what this catches.
   */
  it('files every command under its heading, in order', async () => {
    const cap = captureIo();
    expect(await main(['--help'], cap.io)).toBe(0);
    const help = cap.stdout();
    const groups = ['Setup:', 'Wallet:', 'Integration:'];
    const at = groups.map((group) => help.indexOf(group));
    expect(at.filter((i) => i === -1)).toEqual([]);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(help).not.toMatch(/^Commands:$/m);
  });

  /**
   * gh, git, cargo and docker all take both spellings, so this one does too.
   * The heading matters as much as the command: `help` is the one command
   * commander files itself, and an ungrouped one is exactly the stray
   * `Commands:` block the case above forbids. Exit 0, because the text was
   * asked for — a bare `tenjin` is the usage error, and stays one.
   */
  it('takes `tenjin help <command>` as well as `<command> --help`', async () => {
    const root = captureIo();
    expect(await main(['--help'], root.io)).toBe(0);
    expect(root.stdout()).toContain('help [command]');

    const cap = captureIo();
    expect(await main(['help', 'status'], cap.io)).toBe(0);
    expect(cap.stdout()).toContain('Usage: tenjin status');
  });

  // vercel's rule, applied here: a global flag is listed once, on the root. The
  // per-command copies still PARSE (`tenjin doctor --json`, covered below); they
  // are hidden so a command's own flags are what its help shows.
  it('lists the globals once, on the root, and not again under a command', async () => {
    const root = captureIo();
    expect(await main(['--help'], root.io)).toBe(0);
    expect(root.stdout()).toContain('Global options:');
    expect(root.stdout()).toContain('emit one machine JSON envelope on stdout');

    const leafHelp = captureIo();
    expect(await main(['doctor', '--help'], leafHelp.io)).toBe(0);
    expect(leafHelp.stdout()).toContain('--prune');
    expect(leafHelp.stdout()).not.toContain('--base-url');
  });

  it('ends with examples and the pointers, not a second copy of the docs', async () => {
    const cap = captureIo();
    expect(await main(['--help'], cap.io)).toBe(0);
    const help = cap.stdout();
    expect(help).toContain('Examples:');
    expect(help).toContain('$ tenjin install');
    expect(help).toContain('Run `tenjin <command> --help` for one command.');
    expect(help).toContain(PERMISSIONS_DOC_URL);
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
  });

  // The two things an operator chooses at install time, and nothing else: which
  // settings file, and whether this is a converge run for `tenjin update`.
  it('offers only the flags the router install actually has', async () => {
    const cap = captureIo();
    expect(await main(['install', '--help'], cap.io)).toBe(0);
    const help = cap.stdout();
    expect(help).toContain('--project');
    expect(help).toContain('--refresh');
    for (const gone of ['--harness', '--bazaar-pay', '--no-grant', '--publish-mode'])
      expect(help).not.toContain(gone);
  });

  // Removed pre-release flags are gone rather than hidden. Rejected at parse
  // time, so the action never runs and none remains as an alias.
  it('rejects removed install flags', async () => {
    for (const flag of [
      '--claude-md',
      '--no-claude-md',
      '--allow-free-verbs',
      '--no-allow-free-verbs',
    ]) {
      const cap = captureIo();
      expect(await main(['install', flag, '--json'], cap.io), flag).toBe(2);
      expect(cap.stdout(), flag).toContain(`unknown option '${flag}'`);
    }
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

describe('the update nudge and `install --refresh`', () => {
  const cachePath = (): string => join(process.env.TENJIN_DATA_DIR!, 'update-check.json');

  // CI is this file's blanket offline switch and would make every case below
  // pass for the wrong reason, so it is lifted here and the registry is a stub
  // that records whether the nudge reached for it at all.
  let fetched = 0;
  beforeEach(() => {
    process.env.CI = '';
    fetched = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetched += 1;
      return new Response(JSON.stringify({ latest: '99.0.0' }), { status: 200 });
    });
  });
  afterEach(async () => {
    process.env.CI = '1';
    vi.restoreAllMocks();
    await rm(cachePath(), { force: true });
  });

  it('writes no update-check cache and asks no registry', async () => {
    const cap = captureIo();
    // The refusal itself is beside the point here (this sandbox has nothing
    // materialized); what matters is that nothing appeared on the way out.
    await main(['install', '--refresh', '--json'], cap.io);
    expect(existsSync(cachePath())).toBe(false);
    expect(fetched).toBe(0);
  });

  // The other half: without it the case above would pass on a nudge that was
  // already off for some unrelated reason.
  it('still nudges for a command that is not a refresh', async () => {
    const cap = captureIo();
    expect(await main(['config', '--json'], cap.io)).toBe(0);
    expect(existsSync(cachePath())).toBe(true);
    expect(fetched).toBe(1);
  });
});

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
    // RENDERED for this machine's mode, not the raw packaged bytes: the heal
    // materializes what it writes (lib/skill-materialize), and this run has no
    // team shelf configured, so the public arm is what should have landed.
    expect(await readFile(wiredPath(), 'utf8')).toBe(
      renderSkillMarkdown(
        await readFile(join(skillsSrc.dir, 'tenjin-search', 'SKILL.md'), 'utf8'),
        { teamMode: false },
      ),
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

/**
 * The retraction verb the CLI simply did not have (#221): an agent asked to take
 * a publish back got `unknown command 'delete'`. These are dispatcher-level only
 * — routing and the edge check that fires before any wallet or network touch.
 */
