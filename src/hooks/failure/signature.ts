import { hasErrorMarker } from '../../adapters/error-markers';

/**
 * The failure arm's pure half (13-pr-d-local-arms.md, "failure"): which
 * commands the arm fires behind, and which line of the output is the failure.
 * The test names it keys on are read in `test-identity.ts`; nothing here is a
 * key any more (tenjin-agent#350).
 */

// ---- which commands ----

/**
 * The heads this arm may fire behind: only a toolchain command is a failure
 * worth asking about. NOT GIT: every historical false positive (14 of 14,
 * tenjin-agent#212) was `git show … | grep ENOENT`, source that MENTIONS an
 * errno read through a pipe. A git failure that matters surfaces behind the
 * head that ran it.
 */
export const FAILURE_HEADS: ReadonlySet<string> = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'pipx',
  'cargo',
  'go',
  'gem',
  'bundle',
  'composer',
  'node',
  'deno',
  'python',
  'python3',
  'make',
  'cmake',
  'ninja',
  'mvn',
  'gradle',
  'gradlew',
  'dotnet',
  'swift',
  'xcodebuild',
  'tsc',
  'vitest',
  'jest',
  'mocha',
  'pytest',
  'unittest',
  'tox',
  'nox',
  'eslint',
  'prettier',
  'ruff',
  'mypy',
  'pyright',
  'flake8',
  'black',
  'biome',
  'oxlint',
  'next',
  'vite',
  'turbo',
  'nx',
  'webpack',
  'esbuild',
  'rollup',
  'drizzle-kit',
  'prisma',
  'alembic',
  'knex',
  'sequelize',
  'flyway',
  'liquibase',
  'docker',
  'docker-compose',
  'terraform',
  'pulumi',
  'rustc',
  'gcc',
  'clang',
  'cc',
  'g++',
  'clang++',
  'zig',
]);

/** Runtimes that are a build/test step only when they RUN A FILE: `node -e`
 *  and `python3 -c` are the agent evaluating an expression, whose "fix" is a
 *  different expression, not a change to the repo. */
const RUNTIME_HEADS = new Set(['node', 'deno', 'python', 'python3']);
const RUNTIME_TEST_SUBS = new Set(['--test', 'test']);
/** Interpreters whose `-m <module>` runs the module as the program, so
 *  `python3 -m pytest` keys on `pytest`, which a later bare `pytest` closes. */
const MODULE_RUNNERS = new Set(['python', 'python3']);
/** Package managers whose SUBCOMMAND decides: `pnpm build` can fail a build,
 *  `npm ls` reports a fact and exits 1 to mean "no". */
const PM_HEADS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_QUIET_SUBS = new Set([
  'ls',
  'list',
  'why',
  'view',
  'info',
  'outdated',
  'audit',
  'config',
  '-v',
  '--version',
]);
/** Wrappers in front of the real command, each with the options that TAKE A
 *  VALUE, so `sudo -u builder pnpm test` reads as `pnpm test` and never as
 *  `builder`. A table, not a word search: `sudo grep pnpm src` must not read
 *  as a pnpm failure. */
const WRAPPER_VALUE_OPTS: Record<string, ReadonlySet<string>> = {
  sudo: new Set([
    '-u',
    '-g',
    '-h',
    '-p',
    '-C',
    '-D',
    '-R',
    '-T',
    '-U',
    '--user',
    '--group',
    '--host',
    '--prompt',
    '--close-from',
    '--chdir',
    '--chroot',
    '--command-timeout',
    '--other-user',
  ]),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  time: new Set(['-f', '-o', '--format', '--output']),
  nohup: new Set([]),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  command: new Set([]),
  exec: new Set([]),
};
/** Runners whose next word IS the command: `npx tsc` is a tsc invocation. */
const HEAD_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx']);
const PM_RUN_SUBS = new Set(['exec', 'dlx', 'x']);
export const COMMAND_SEPARATOR_RE = /&&|\|\||[;|\n]/;

function runsAFile(sub: string): boolean {
  return sub.length > 0 && !sub.startsWith('-') && sub !== '<stdin>' && /\.[A-Za-z0-9]+$/.test(sub);
}

/** Step past one wrapper and its options to the word it runs. `--` ends the
 *  options; `timeout` then also owns one bare duration word (`30s`). */
function skipWrapper(
  words: string[],
  at: number,
  valueOpts: ReadonlySet<string>,
  name: string,
): number {
  let i = at + 1;
  while (i < words.length) {
    const w = words[i] ?? '';
    if (w === '--') return i + 1;
    if (!w.startsWith('-') || w === '-') break;
    if (w.startsWith('--')) {
      i += w.includes('=') || !valueOpts.has(w) ? 1 : 2;
      continue;
    }
    i += valueOpts.has(w.slice(0, 2)) && w.length === 2 ? 2 : 1;
  }
  if (name === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(words[i] ?? '')) i += 1;
  return i;
}

export interface CommandHead {
  head: string;
  sub: string;
}

/**
 * Every command in the line, as `{ head, sub }`: the program each segment runs
 * and its first argument. `cd /x && pnpm test` yields the `cd` nobody cares
 * about AND the `pnpm test` that matters; the head is a basename, so
 * `./node_modules/.bin/vitest` lands on `vitest`; leading `FOO=bar` and
 * wrappers are stepped over, however many stack.
 */
export function commandHeads(command: string): CommandHead[] {
  const out: CommandHead[] = [];
  for (const segment of command.split(COMMAND_SEPARATOR_RE)) {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    let i = 0;
    let head = '';
    while (i < words.length) {
      const word = words[i] ?? '';
      const name = word.split('/').pop() || word;
      if (/^[A-Za-z_]\w*=/.test(word)) {
        i += 1;
        continue;
      }
      const valueOpts = WRAPPER_VALUE_OPTS[name];
      if (valueOpts !== undefined) {
        i = skipWrapper(words, i, valueOpts, name);
        continue;
      }
      if (HEAD_RUNNERS.has(name)) {
        i += 1;
        continue;
      }
      if (PM_HEADS.has(name) && PM_RUN_SUBS.has(words[i + 1] ?? '')) {
        i += 2;
        continue;
      }
      if (MODULE_RUNNERS.has(name) && words[i + 1] === '-m' && i + 2 < words.length) {
        i += 2;
        continue;
      }
      head = name;
      break;
    }
    if (head.length === 0) continue;
    out.push({ head, sub: words[i + 1] ?? '' });
  }
  return out;
}

/** The heads in this line the arm may fire behind, in order. Any, not all: in
 *  `pnpm test && echo done` the failure belongs to the FIRST half, which is
 *  why the arm gates on an allowlisted head rather than on whichever segment
 *  ran last. */
export function allowedHeads(command: string): string[] {
  const out: string[] = [];
  for (const { head, sub } of commandHeads(command)) {
    if (!FAILURE_HEADS.has(head)) continue;
    if (PM_HEADS.has(head) && PM_QUIET_SUBS.has(sub)) continue;
    if (RUNTIME_HEADS.has(head) && !runsAFile(sub) && !RUNTIME_TEST_SUBS.has(sub)) continue;
    out.push(head);
  }
  return out;
}

// ---- which line ----

/** A stack frame or a code-frame gutter: `at fn (…)`, `File "…"`, `...`,
 *  vitest's `  12| code` and jest's `> 12 | code`. A gutter quotes source, and
 *  source that throws an `Error` is not the failure. */
const STACK_FRAME_RE = /^\s*(?:at\s|File\s+"|\.{3}|>?\s*\d+\s*\|)/;

/**
 * A runner's own TOTALS row — `Tests  2 failed | 5 passed (7)`, `3 failed, 10
 * passed in 0.42s`, `Found 3 errors in 2 files.` — is a COUNT of failures, not
 * a description of one. It is the last error-shaped line almost every runner
 * prints, so a last-marker-wins rule keyed every failure in a repo on it, and
 * the same row appears verbatim in every repo on earth. A count alone is not
 * enough to be aggregate: a line that also carries an errno-shaped token or a
 * frame describes one failure and merely mentions a number.
 *
 * rustc's `error: could not compile … due to 2 previous errors` opens with an
 * error class and is a totals row all the same, so it is named exactly and
 * decided before the class rule can rescue it.
 */
const AGGREGATE_COUNT_RE = /\b[1-9]\d* (?:failed|failing|errors?|problems?)\b/i;
const AGGREGATE_FOUND_RE = /\bFound [1-9]\d* errors?\b/i;
const AGGREGATE_RUSTC_RE =
  /^[ \t]*error: (?:could not compile\b.*\bdue to [1-9]\d* previous error|aborting due to [1-9]\d* previous error)/;
const AGGREGATE_SUMMARY_RE = /^(?:Tests|Test Suites|Snapshots|Time|Test files)\b/;
/** go's verdict rows: a bare `FAIL`, or the TAB-separated `FAIL\tpkg\t0.021s`.
 *  The tab is the whole discriminator: vitest's ` FAIL  file > test` uses
 *  spaces and NAMES the failure. */
const AGGREGATE_GO_RE = /^(?:FAIL|ok)(?:\t|[ \t]*$)/;
const AGGREGATE_CLASS_RE = /(?:^|[\s[(])(?:\w*Error|error)\s*:/;
const AGGREGATE_FRAME_RE =
  /([A-Za-z0-9_.+-]+(?:[/\\][A-Za-z0-9_.+-]+)*\.[A-Za-z]{1,5})[:(]\d+|File "([^"]+)", line \d+/;

export function isAggregateLine(line: string): boolean {
  if (AGGREGATE_RUSTC_RE.test(line)) return true;
  const counts =
    AGGREGATE_COUNT_RE.test(line) ||
    AGGREGATE_FOUND_RE.test(line) ||
    AGGREGATE_SUMMARY_RE.test(line) ||
    AGGREGATE_GO_RE.test(line);
  if (!counts) return false;
  if (AGGREGATE_CLASS_RE.test(line)) return false;
  if (errnoOf(line) !== '') return false;
  return !AGGREGATE_FRAME_RE.test(line) && !STACK_FRAME_RE.test(line);
}

/** How far up the output the line scan looks: the tail is where a runner puts
 *  its verdict. */
export const LINE_SCAN_MAX = 400;

/** A wrapper's verdict: a line that says a command failed and never why.
 *  `pnpm` closes every failing script with `ELIFECYCLE  Command failed with
 *  exit code 2.`, printed after the tool's own diagnostic. */
const WRAPPER_RE = /exit (?:code|status) \d+|\bELIFECYCLE\b|\bCommand failed\b/i;

/**
 * The failure's most informative line, or null: the LAST line that carries an
 * error marker (`ERROR_MARKERS`, the same list that decided the command failed)
 * and is not a totals row, a stack frame, a code-frame gutter or a machine
 * `::` line, preferring any such line to a wrapper's verdict.
 *
 * ONE LINE AT A TIME, WITH NO MODEL OF THE PAGE. The walker this replaces found
 * "the failure's block" by header glyphs (`FAIL`, `●`, `❯`, `×`, `---`), and
 * runners spend their glyphs twice: vitest's `❯` opens a file summary and also
 * points at every stack frame, which cut every vitest failure off from its
 * assertion (tenjin-agent#359). On 1,880 real failures from one machine's
 * transcripts this picker finds a line wherever the walker did, and 22 more.
 *
 * THE LAST, because a runner prints the cause after pages of progress. NOT THE
 * WRAPPER: picking pnpm's `ELIFECYCLE` line over tsc's `error TS2345:` above it
 * was 43% of real tsc failures.
 *
 * ONE COMMAND'S OUTPUT: the text is this Bash call's own streams, so the last
 * diagnostic in it is this call's, however far up it sits within the window.
 */
export function errorLine(text: string): string | null {
  const lines = text.split('\n');
  const floor = Math.max(0, lines.length - LINE_SCAN_MAX);
  let wrapper: string | null = null;
  for (let i = lines.length - 1; i >= floor; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0 || line.startsWith('::') || STACK_FRAME_RE.test(line)) continue;
    if (!hasErrorMarker(line) || isAggregateLine(line)) continue;
    if (!WRAPPER_RE.test(line)) return line;
    wrapper ??= line;
  }
  return wrapper;
}

// ---- errno ----

/** POSIX/libuv errno names, spelled out. A whitelist, not a shape:
 *  `/E[A-Z]{3,}/` matches ERROR, ESLINT and EXPECTED, and read a bare
 *  "2 failed" as specific on the strength of the word ERROR anywhere. */
const ERRNO_NAMES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EEXIST',
  'EISDIR',
  'ENOTDIR',
  'ENOTEMPTY',
  'ENAMETOOLONG',
  'ELOOP',
  'EXDEV',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'EDQUOT',
  'EFBIG',
  'EBUSY',
  'EAGAIN',
  'EPIPE',
  'ESPIPE',
  'EBADF',
  'EINVAL',
  'ERANGE',
  'ENOMEM',
  'ENOSYS',
  'EINTR',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTCONN',
  'EPROTO',
  'EPROTONOSUPPORT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECANCELED',
  'EDESTADDRREQ',
  'EMSGSIZE',
  'EOVERFLOW',
]);

/** The errno-shaped token a line names, or ''. A token qualifies with a digit
 *  or an underscore (`TS2345`, `E0412`, `ERR_PNPM_OUTDATED_LOCKFILE`) or as a
 *  real errno by name; everything else is English. `isAggregateLine` asks it:
 *  a count that also names an errno describes one failure. */
const ERRNO_RE = /\b(ERR_[A-Z0-9]+(?:_[A-Z0-9]+)*|TS\d{3,5}|E\d{3,4}|E[A-Z]{3,})\b/g;
export function errnoOf(text: string): string {
  for (const m of text.matchAll(ERRNO_RE)) {
    const token = m[1] ?? '';
    if (/[_\d]/.test(token) || ERRNO_NAMES.has(token)) return token;
  }
  return '';
}
