import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

/**
 * Where the self-heal resolves its packaged skills from. Empty means the real
 * resolution, which from a source checkout is a working tree the heal refuses;
 * the heal case below points it at a packaged LAYOUT instead, because that
 * refusal is by directory shape and nothing else here can produce one.
 */
const skillsSrc = vi.hoisted(() => ({ dir: '' }));
vi.mock('../lib/skills-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/skills-source')>();
  return {
    ...actual,
    resolveSkillsSource: (startDir: string) =>
      skillsSrc.dir === '' ? actual.resolveSkillsSource(startDir) : skillsSrc.dir,
  };
});
import { main as run, PRODUCTS } from '../cli';
import { registerShelf } from './shelf';
import type { Io } from '../lib/output';

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
/**
 * The shelf product is not in {@link PRODUCTS}, so these cases register it
 * explicitly. They stay until the follow-up deletes the product, and they are
 * the reason it is a registration module rather than dead code.
 */
const main = (argv: string[], io: Io) => run(argv, io, [...PRODUCTS, registerShelf]);

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

// `outcome`'s one selector, read back through a refusal that resolves before any
// request: an uncollected `--search-id` would keep the LAST id and drop the rest,
// and a report with no id at all must name the flag rather than guess a search.

describe('outcome selector (the dispatcher mapping)', () => {
  const ID = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('refuses a report with no --search-id, naming the flag', async () => {
    const cap = captureIo();
    const code = await main(['outcome', '--status', 'used', '--json'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.command).toBe('outcome');
    expect(parsed.error.fix).toContain('--search-id');
  });

  it('rejects --last, which no longer exists', async () => {
    const cap = captureIo();
    const code = await main(['outcome', '--last', '--status', 'used', '--json'], cap.io);
    expect(code).toBe(2);
    expect(cap.stdout() + cap.stderr()).toContain('--last');
  });

  it('--search-id repeats rather than replacing', async () => {
    const cap = captureIo();
    const code = await main(
      [
        'outcome',
        '--search-id',
        ID,
        '--search-id',
        'not-a-uuid',
        '--status',
        'regenerated',
        '--json',
      ],
      cap.io,
    );
    expect(code).toBe(2);
    expect(JSON.parse(cap.stdout()).error.message).toContain('not-a-uuid');
  });
});

/**
 * An option that did not collect would keep the LAST id and drop the rest, so it
 * is read back through the cap, which only eleven surviving ids can trip.
 */

describe('publish --search-id collects (the dispatcher mapping)', () => {
  it('repeats rather than replacing, and the cap counts every id given', async () => {
    const ids = Array.from(
      { length: 11 },
      (_, i) => `0197bbbb-cccc-7ddd-8eee-0000000000${String(i).padStart(2, '0')}`,
    );
    const cap = captureIo();
    const code = await main(
      ['publish', 'nope.md', ...ids.flatMap((id) => ['--search-id', id]), '--json'],
      cap.io,
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.command).toBe('publish');
    expect(parsed.error.message).toContain('at most 10 searches (got 11)');
  });
});

/**
 * The verbs decision 15 deleted, and the ones that replaced them. Dispatcher
 * level only: `wallet send` reaches a wallet and `hooks list` reaches loop.db,
 * so what is asserted here is what resolves BEFORE either — the command exists,
 * or it does not.
 */

describe('the deleted verbs and their replacements', () => {
  it.each(['push', 'state', 'session', 'send'])('`tenjin %s` is not a command', async (verb) => {
    const cap = captureIo();
    expect(await main([verb, '--json'], cap.io)).toBe(2);
    const parsed = JSON.parse(cap.stdout()) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('USAGE');
    expect(parsed.error.message).toContain(`unknown command '${verb}'`);
  });

  it('`tenjin wallet send` is registered under the wallet group', async () => {
    const cap = captureIo();
    expect(await main(['wallet', '--help'], cap.io)).toBe(0);
    expect(cap.stdout()).toContain('send [options] <amount> <token> <to>');
  });

  it('`tenjin hooks` carries list, enable and disable', async () => {
    const cap = captureIo();
    expect(await main(['hooks', '--help'], cap.io)).toBe(0);
    const help = cap.stdout();
    expect(help).toContain('list');
    expect(help).toContain('enable [options] <arm>');
    expect(help).toContain('disable [options] <arm>');
    // How to run it and how to switch an arm, with one example.
    expect(help).toContain('$ tenjin hooks disable web-fetch');
  });

  // The arm -> event -> counts table is two thirds live state, so it ships as the
  // command's OUTPUT and is never snapshotted into help, where it would rot.
  it('leaves the arms table to `tenjin hooks` itself, not its help', async () => {
    const cap = captureIo();
    expect(await main(['hooks', '--help'], cap.io)).toBe(0);
    const help = cap.stdout();
    for (const column of ['ARM', 'STATE', 'FIRED', 'HIT']) expect(help).not.toContain(column);
  });

  it('`tenjin hooks disable` on an unknown arm is USAGE naming the seven', async () => {
    const cap = captureIo();
    expect(await main(['hooks', 'disable', 'nope', '--json'], cap.io)).toBe(2);
    const parsed = JSON.parse(cap.stdout()) as { error: { code: string; fix?: string } };
    expect(parsed.error.code).toBe('USAGE');
    expect(parsed.error.fix).toContain('prompt, web-search, web-fetch, subagent, failure');
  });

  it('`tenjin grade` is a top-level verb carrying the four grading flags', async () => {
    const cap = captureIo();
    expect(await main(['grade', '--help'], cap.io)).toBe(0);
    const help = cap.stdout();
    for (const flag of ['--since', '--session', '--explain', '--label']) {
      expect(help).toContain(flag);
    }
  });
});

/**
 * ONE COMMAND, ONE SHAPE. `publish` takes a document and nothing else: the
 * source flags and the card-authoring flags are gone, and a caller reaching for
 * one gets commander's unknown-option refusal rather than a silent drop.
 */

describe('publish takes a document and nothing else', () => {
  it('carries no source, dry-run or card-authoring flags', async () => {
    const help = captureIo();
    expect(await main(['publish', '--help'], help.io)).toBe(0);
    const text = help.stdout();
    for (const gone of [
      '--finding',
      '--dry-run',
      '--discard',
      '--question',
      '--task',
      '--scope',
      '--exclusions',
      '--applies-to',
      '--as-of',
      '--valid-until',
      '--artifact-type',
      '--temporal-mode',
      '--provenance',
      '--methodology',
    ]) {
      expect(text, gone).not.toContain(gone);
    }
    // The flags that stay.
    for (const kept of ['--agent <id>', '--search-id <id>', '--draft', '--key <kind=value>']) {
      expect(text, kept).toContain(kept);
    }
  });

  it('refuses a removed flag rather than dropping it', async () => {
    for (const argv of [
      ['publish', 'post.md', '--finding', 'abc', '--json'],
      ['publish', 'post.md', '--dry-run', '--json'],
      ['publish', 'post.md', '--scope', 'x', '--json'],
    ]) {
      const cap = captureIo();
      expect(await main(argv, cap.io), argv.join(' ')).toBe(2);
    }
  });
});

describe('stdin command routing', () => {
  const POST_ID = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const markdown = '# Stdin probe\n\nA plain body from the pipe.\n';

  // Both stdin forms reach the same pipeline, and reach it far enough to be
  // refused for the document's shape: the card gate runs above every write, so
  // a piped body with no card never touches a wallet or a shelf.
  it('routes `publish -` and bare non-TTY publish through the same pipeline', async () => {
    for (const argv of [
      ['publish', '-', '--json'],
      ['publish', '--json'],
    ]) {
      const cap = captureIo(false, { stream: Readable.from([markdown]), isTTY: false });
      expect(await main(argv, cap.io), argv.join(' ')).toBe(2);
      const parsed = JSON.parse(cap.stdout());
      expect(parsed.command).toBe('publish');
      expect(parsed.error.code).toBe('USAGE');
      expect(parsed.error.message).toContain('answer card');
    }
  });

  it('a bare publish with TTY stdin returns usage without reading it', async () => {
    let reads = 0;
    const stream = new Readable({
      read() {
        reads += 1;
      },
    });
    const cap = captureIo(false, { stream, isTTY: true });
    expect(await main(['publish', '--json'], cap.io)).toBe(2);
    expect(JSON.parse(cap.stdout()).error.message).toBe('Nothing to publish.');
    expect(reads).toBe(0);
  });

  it('an injected Io with no stdin capability never borrows the test runner input', async () => {
    const cap = captureIo();
    expect(await main(['publish', '--json'], cap.io)).toBe(2);
    expect(JSON.parse(cap.stdout()).error.message).toBe('Nothing to publish.');
  });

  it('registers `edit <postId> -`, keeps trailing flags, and refuses two body sources', async () => {
    const accepted = captureIo(false, { stream: Readable.from([]), isTTY: false });
    expect(await main(['edit', POST_ID, '-', '--json'], accepted.io)).toBe(2);
    expect(JSON.parse(accepted.stdout()).error.message).toBe('No Markdown received on stdin.');

    const bodyFlag = captureIo(false, { stream: Readable.from([]), isTTY: false });
    expect(await main(['edit', POST_ID, '--body', '-', '--json'], bodyFlag.io)).toBe(2);
    expect(JSON.parse(bodyFlag.stdout()).error.message).toBe('No Markdown received on stdin.');

    const flags = captureIo(false, { stream: Readable.from([markdown]), isTTY: false });
    expect(await main(['edit', POST_ID, '-', '--mode', 'reveiw', '--json'], flags.io)).toBe(2);
    expect(JSON.parse(flags.stdout()).error.message).toContain('Invalid --mode');

    const conflict = captureIo();
    expect(await main(['edit', POST_ID, '-', '--body', 'post.md', '--json'], conflict.io)).toBe(2);
    expect(JSON.parse(conflict.stdout()).error.message).toBe('Pass stdin or --body, not both.');
  });

  it('keeps positional file paths out of edit; files still use --body', async () => {
    const cap = captureIo();
    expect(await main(['edit', POST_ID, 'post.md', '--json'], cap.io)).toBe(2);
    expect(JSON.parse(cap.stdout()).error.message).toContain('must be `-`');
  });
});

/**
 * The post-command skills self-heal, at the dispatcher. It runs after the
 * envelope, so what matters here is that a command's contract is untouched by it;
 * the heal's own behavior is covered in lib/skill-heal.test.ts, and the packed
 * binary actually healing a stale skill is covered in scripts/pack-smoke.sh.
 */
/**
 * The account verbs (#208). Dispatcher-level only: each reaches a wallet, so
 * the cases are the ones that resolve BEFORE it — the group and leaves exist,
 * and `profile set` with nothing to set is USAGE.
 */

describe('profile and stats', () => {
  it('registers `profile set` as a subcommand and `stats` as a bare verb', async () => {
    const cap = captureIo();
    expect(await main(['profile', '--help'], cap.io)).toBe(0);
    expect(cap.stdout()).toContain('set [options]');
    const cap2 = captureIo();
    expect(await main(['stats', '--help'], cap2.io)).toBe(0);
  });

  it('`profile set` with no flags is USAGE before any wallet work', async () => {
    const cap = captureIo();
    const code = await main(['profile', 'set', '--json'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout()) as { command: string; error: { code: string } };
    expect(parsed.command).toBe('profile.set');
    expect(parsed.error.code).toBe('USAGE');
  });

  it('the leaves take trailing global flags like every other command', async () => {
    const cap = captureIo();
    expect(await main(['profile', 'set', '--handle', 'x', '--timeout', 'abc'], cap.io)).toBe(2);
    const cap2 = captureIo();
    expect(await main(['stats', '--timeout', 'abc'], cap2.io)).toBe(2);
  });
});

/**
 * `install --refresh` states its no-op absolutely: it converges what exists and
 * creates nothing. The nudge runs AFTER the command body, from the dispatcher,
 * so it is outside anything that body can refuse — and left alone it writes
 * `update-check.json` into a data dir the refresh itself was not allowed to add
 * one file to. Under `tenjin update` the spawned child is held off by
 * TENJIN_NO_UPDATE_CHECK; a hand-run refresh arrives with nothing set.
 */

describe('the delete verb is registered', () => {
  it('is no longer an unknown command, and its --help names the every-mode confirm', async () => {
    const cap = captureIo();
    const code = await main(['delete', '--help'], cap.io);
    expect(code).toBe(0);
    const help = cap.stdout();
    expect(help).toContain('--yes');
    expect(help).toMatch(/confirms EVERY time/i);
    expect(help).toContain('--status draft');
  });

  it('routes a malformed post id to the delete command as USAGE, offline', async () => {
    const cap = captureIo();
    const code = await main(['delete', 'not-a-uuid', '--yes'], cap.io);
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.command).toBe('delete');
    expect(parsed.error.code).toBe('USAGE');
  });

  it('offers --status on edit, the reversible half', async () => {
    const cap = captureIo();
    const code = await main(['edit', '--help'], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout()).toContain('--status <status>');
  });
});
