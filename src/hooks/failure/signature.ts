import { homedir } from 'node:os';
import { hasErrorMarker } from '../../adapters/error-markers';
import { shortHash } from './keys';

/**
 * The failure arm's pure half (13-pr-d-local-arms.md, "failure"): which
 * commands the arm fires behind, which line of the output is the failure, and
 * the `sig_v1` keys built from it. The formulas are frozen: the team shelf's
 * `--key` publishes are `sig_v1` today, and a changed byte would strand every
 * one of them.
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

const STACK_FRAME_RE = /^\s*(at\s|File\s+"|\.{3}|\d+\s*\|)/;

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

/** A line that OPENS a runner's per-failure block: vitest's ` FAIL  file > …`,
 *  jest's `● suite › test`, go's `--- FAIL: TestX`. The block above one of
 *  these is a DIFFERENT failure, so a scan stops there. */
const RUNNER_HEADER_RE =
  /^\s{0,4}(?:FAIL\b|PASS\b|ok\b|not ok\b|●|✓|✔|✗|✘|×|✖|❯|---|===|failures:)/;
/** How far a block may extend either way from its marker line. */
const BLOCK_SCAN_MAX = 60;
/** How far up the output the marker scan looks: the tail is where a runner
 *  puts its verdict. `test-identity.ts` scans the same window for its header. */
export const LINE_SCAN_MAX = 400;

function isBlank(lines: string[], j: number): boolean {
  return (lines[j] ?? '').trim().length === 0;
}

/** The first line of the block that ends at `at`. ONE blank line does not end
 *  a block (every runner puts one between the failure and its totals); two
 *  do, and a runner header does, inclusively, because for jest and go the
 *  header IS the most specific line printed. A totals row is never a boundary,
 *  however header-shaped (go's bare `FAIL`). */
function blockStart(lines: string[], at: number): number {
  let start = at;
  for (let j = at - 1; j >= 0 && at - j <= BLOCK_SCAN_MAX; j -= 1) {
    const raw = lines[j] ?? '';
    if (RUNNER_HEADER_RE.test(raw) && !isAggregateLine(raw.trim())) return j;
    if (isBlank(lines, j) && (j === 0 || isBlank(lines, j - 1))) return start;
    start = j;
  }
  return start;
}

/** The last line of the block that contains `at`: downward too, because a
 *  stack trace follows its message and the top frame is what clears the
 *  specificity floor on the commonest failure shape there is. */
function blockEnd(lines: string[], at: number): number {
  let end = at;
  for (let j = at + 1; j < lines.length && j - at <= BLOCK_SCAN_MAX; j += 1) {
    const raw = lines[j] ?? '';
    if (RUNNER_HEADER_RE.test(raw) && !isAggregateLine(raw.trim())) return end;
    if (isBlank(lines, j) && (j + 1 >= lines.length || isBlank(lines, j + 1))) return end;
    end = j;
  }
  return end;
}

/** How many blank lines may sit between a failure block and the totals row of
 *  the same run. `blockStart` stops at two — correctly, two blanks are what
 *  keep two failures apart — but the arm's `failureText` joins `stdout`,
 *  `stderr`, `error` and `text` with a newline apiece, so a run of blanks in
 *  front of a totals row is a splice artifact, not structure. Four covers
 *  every splice plus the blank the runner printed itself. */
const TOTALS_GAP_MAX = 4;

/**
 * The failure block belonging to the run whose totals block starts at
 * `totalsStart`: the block directly above it, across nothing but blank lines,
 * and OPENED BY A RUNNER HEADER.
 *
 * The header is the bound, and it is the whole reason this is not a plain
 * `continue` in `errorLine`. Resuming the outer scan walks up to
 * `LINE_SCAN_MAX` lines of scrollback and keys a totals-only run on whatever
 * an earlier command left behind — exactly what the block machinery exists to
 * prevent. One hop, into a block a runner opened, keeps "the scanner stopped
 * one block short" apart from "this output really is totals only": free text
 * above a totals row is still nothing.
 */
function precedingFailureBlock(lines: string[], totalsStart: number): [number, number] | null {
  let j = totalsStart - 1;
  while (j >= 0 && isBlank(lines, j)) {
    if (totalsStart - j > TOTALS_GAP_MAX) return null;
    j -= 1;
  }
  if (j < 0) return null;
  const start = blockStart(lines, j);
  const header = lines[start] ?? '';
  if (!RUNNER_HEADER_RE.test(header) || isAggregateLine(header.trim())) return null;
  return [start, j];
}

export interface ErrorLine {
  line: string;
  /** The failure block the line sits in, which is what the top frame is read
   *  off: a frame from an unrelated failure hundreds of lines away must not
   *  clear the floor for a message that says nothing specific. */
  block: string;
}

/**
 * The most informative line: the LAST error-shaped, non-frame line, because
 * runners print the real cause after pages of summary — except when that line
 * is a bare TOTAL, in which case the nearest non-aggregate marker above it in
 * the same block is what the failure is about, and failing that, the same
 * search over the failure block the run printed DIRECTLY above its totals,
 * across nothing but blank lines. One hop, never a resumed scan: a totals
 * block with free text, or nothing, above it yields nothing, because a key
 * over "2 failed" is a key every repo shares and a key over an unrelated
 * error in the scrollback is worse than none.
 */
export function errorLine(text: string): ErrorLine | null {
  const lines = text.split('\n');
  const floor = Math.max(0, lines.length - LINE_SCAN_MAX);
  for (let i = lines.length - 1; i >= floor; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0 || STACK_FRAME_RE.test(line) || !hasErrorMarker(line)) continue;
    const start = blockStart(lines, i);
    const block = lines.slice(start, blockEnd(lines, i) + 1).join('\n');
    if (!isAggregateLine(line)) return { line, block };
    for (let j = i - 1; j >= start; j -= 1) {
      const candidate = (lines[j] ?? '').trim();
      if (candidate.length === 0 || STACK_FRAME_RE.test(candidate)) continue;
      if (!hasErrorMarker(candidate) || isAggregateLine(candidate)) continue;
      return { line: candidate, block };
    }
    const above = precedingFailureBlock(lines, start);
    if (above === null) return null;
    const [aboveStart, aboveEnd] = above;
    const aboveBlock = lines.slice(aboveStart, aboveEnd + 1).join('\n');
    for (let j = aboveEnd; j >= aboveStart; j -= 1) {
      const candidate = (lines[j] ?? '').trim();
      if (candidate.length === 0 || STACK_FRAME_RE.test(candidate)) continue;
      if (!hasErrorMarker(candidate) || isAggregateLine(candidate)) continue;
      return { line: candidate, block: aboveBlock };
    }
    return null;
  }
  return null;
}

// ---- sig_v1 ----

/** POSIX/libuv errno names, spelled out. A whitelist, not a shape:
 *  `/E[A-Z]{3,}/` matches ERROR, ESLINT and EXPECTED, and cleared the floor
 *  for a bare "2 failed" on the strength of the word ERROR anywhere. */
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

/** The errno-shaped token a line names, or ''. Read off the RAW line, before
 *  normalization eats `ERR_PNPM_OUTDATED_LOCKFILE` as an env-var name. A token
 *  qualifies with a digit or an underscore (`TS2345`, `E0412`) or as a real
 *  errno by name; everything else is English. */
const SIG_ERRNO_RE = /\b(ERR_[A-Z0-9]+(?:_[A-Z0-9]+)*|TS\d{3,5}|E\d{3,4}|E[A-Z]{3,})\b/g;
export function errnoOf(text: string): string {
  for (const m of text.matchAll(SIG_ERRNO_RE)) {
    const token = m[1] ?? '';
    if (/[_\d]/.test(token) || ERRNO_NAMES.has(token)) return token;
  }
  return '';
}

/** `at fn (/a/b/file.ts:12:3)`, `File "/a/b.py", line 3`, tsc's
 *  `src/x.ts(12,3):` and rustc's `--> src/main.rs:4:5` all reduce to one
 *  basename, so the same failure keys the same across two checkouts. */
const SIG_PY_FRAME_RE = /File "([^"]+)", line \d+/;
const SIG_FRAME_RE = /([A-Za-z0-9_.+-]+(?:[/\\][A-Za-z0-9_.+-]+)*\.[A-Za-z]{1,5})[:(]\d+/;
export function topFrameFile(text: string): string {
  const raw = SIG_PY_FRAME_RE.exec(text)?.[1] ?? SIG_FRAME_RE.exec(text)?.[1] ?? null;
  if (raw === null) return '';
  const base = raw.split(/[/\\]/).pop() ?? '';
  return base.length > 0 && base.length <= 80 ? base : '';
}

/**
 * The message half of the key, normalized so two runs on two machines produce
 * the same bytes: ANSI and CRLF stripped, `$HOME` to `~`, hosts to `H`, paths
 * to `@/`, env-var names to `E`, hex runs to `H`, digits to `N`, lowercased,
 * whitespace collapsed, 200 characters. Order matters: env-var names are
 * matched while the text is still cased, and paths before the digits a
 * line:column suffix would otherwise leave stranded.
 */
export function normalizeForSig(text: string): string {
  const home = homedir();
  // eslint-disable-next-line no-control-regex
  let out = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ' ').replace(/[\r\n]+/g, ' ');
  if (home.length > 1) out = out.split(home).join('~');
  return out
    .replace(/\b(?:[A-Za-z0-9-]+\.)+(?:com|org|net|io|dev|ai|co|internal|local)\b/g, 'H')
    .replace(/\b[A-Za-z]:\\[^\s'"]+/g, '@/')
    .replace(/(?:[/\\][\w.@+-]+){2,}/g, '@/')
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, 'E')
    .replace(/\b[0-9a-fA-F]{6,}\b/g, 'H')
    .replace(/\d+/g, 'N')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export interface Signature {
  key: string;
}

/**
 * The `sig_v1` key for one failure — message + errno + frame — or null below
 * the SPECIFICITY FLOOR: no errno and no top frame means "N tests failed"
 * normalizes to the same bytes in every repo on earth, and a key sent on it
 * would resolve somebody else's fix at everybody.
 *
 * THE FRAME GOES THROUGH THE SAME REDUCTION AS THE MESSAGE. A bundler builds
 * the file it points at, and names it after the content: a stack through
 * Vite's `chunk-4f2a91.js` keys the identical failure differently on every
 * rebuild, so the shelf never sees the same hash twice and the fingerprint
 * resolves nothing it was published under. `normalizeForSig` folds the hex run
 * and the digits out of the basename, which is the same trade the message
 * already makes: `main2.rs` and `main3.rs` collapse together, and erring
 * toward a match is the direction a fingerprint is for.
 */
export function sigV1(line: string, block: string): Signature | null {
  const message = normalizeForSig(line);
  const errno = errnoOf(line);
  const frame = topFrameFile(block);
  if (errno === '' && frame === '') return null;
  return { key: shortHash('sig_v1|' + message + '|' + errno + '|' + normalizeForSig(frame)) };
}
