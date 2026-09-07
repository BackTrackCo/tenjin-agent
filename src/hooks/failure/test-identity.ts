import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { shortHash } from './keys';
import { COMMAND_SEPARATOR_RE, LINE_SCAN_MAX } from './signature';

/**
 * The `sig_v1_test` lane (tenjin-agent#267): a key on what the test runner
 * itself names — the file, the suite (its `describe` chain) and the test —
 * because two runs of the SAME test are the same key whatever the assertion
 * text says, which is exactly the variation `sig_v1`'s message hash cannot
 * survive.
 *
 * Artifact first, console second, a guess never: this lane exists because a
 * guess is worse than silence. Every read is `fs.promises`: this runs on the
 * hook path of a daemon that serves every session, and a stalled mount must
 * cost a `deadline` row, never a hung daemon.
 */

export interface TestIdentity {
  /** As the repo names it: relative to `cwd`, forward-slashed. */
  file: string;
  suite: string;
  test: string;
}

/** The path the doctor hint's reporter snippet writes to, relative to cwd. */
const TEST_ARTIFACT_DEFAULT_PATH = '.vitest-report.json';

/** A vitest/vite config this arm may read as TEXT — never imported, never
 *  executed: a hook must not run a repo's own build config. A project's own
 *  `vitest.config.*` wins over a shared `vite.config.*`. */
const TEST_CONFIG_FILES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
];

/** A `[<path to tenjin-vitest-reporter.mjs>, { outputFile: '…' }]` entry read
 *  off a config's raw text, anchored on the reporter's own filename so an
 *  unrelated reporter's output option cannot match. A config this cannot see
 *  into means "nothing configured", never a guess. */
const TEST_OUTPUT_FILE_RE =
  /reporters\s*:[\s\S]{0,600}?['"][^'"]*tenjin-vitest-reporter[^'"]*['"][\s\S]{0,300}?outputFile\s*:\s*['"]([^'"]+)['"]/;

/** How much of a config the regex sees. A real config is a few hundred bytes
 *  with `reporters` near the top; the regex's own gaps cost about 1 ms per KB
 *  on a config with no match, so the slice caps what a repo's own file can
 *  cost the hook (tenjin-agent#278). */
const CONFIG_SCAN_CHARS = 64_000;

/** The `outputFile` a repo's own config names for the tenjin reporter, or
 *  null. A repo WITH a recognized config but no match stops there: a project
 *  that has decided is not a reason to guess from a sibling config. */
async function configuredTestReportPath(cwd: string): Promise<string | null> {
  for (const name of TEST_CONFIG_FILES) {
    let text: string;
    try {
      text = await readFile(join(cwd, name), 'utf8');
    } catch {
      continue;
    }
    const m = TEST_OUTPUT_FILE_RE.exec(text.slice(0, CONFIG_SCAN_CHARS));
    const path = m?.[1] ?? '';
    return path.length > 0 ? path : null;
  }
  return null;
}

/** The artifact paths worth checking, most specific first, deduplicated. */
async function testReportCandidates(cwd: string): Promise<string[]> {
  const configured = await configuredTestReportPath(cwd);
  const out = configured === null ? [] : [configured];
  if (!out.includes(TEST_ARTIFACT_DEFAULT_PATH)) out.push(TEST_ARTIFACT_DEFAULT_PATH);
  return out;
}

/** A path AS THE REPO NAMES IT, so the same test file hashes the same across
 *  two clones at different absolute paths; the basename when the path is not
 *  under `cwd` at all (a monorepo run from a parent directory). */
function relTestFile(cwd: string, path: string): string {
  if (cwd.length > 0 && path.startsWith(cwd)) {
    const rest = path.slice(cwd.length).replace(/^[/\\]+/, '');
    if (rest.length > 0) return rest.split(/[/\\]/).join('/');
  }
  return path.split(/[/\\]/).pop() || path;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The LAST failed entry of the reporter's `failed` list, so the artifact leg
 *  and the console leg pick the same failure on a run with more than one. */
function identityFromReport(report: Record<string, unknown>, cwd: string): TestIdentity | null {
  if (!Array.isArray(report.failed)) return null;
  let found: TestIdentity | null = null;
  for (const entry of report.failed) {
    if (!isRecord(entry)) continue;
    const file = typeof entry.file === 'string' ? entry.file : '';
    const test = typeof entry.test === 'string' ? entry.test : '';
    if (file.length === 0 || test.length === 0) continue;
    const suite = typeof entry.suite === 'string' ? entry.suite : '';
    found = { file: relTestFile(cwd, file), suite, test };
  }
  return found;
}

/**
 * The artifact leg: read, window-check, extract, each failing closed to null.
 * THE WINDOW is the report's own `startTime` (stamped by the reporter before
 * a single test runs) at or after `sinceMs`, this agent's own `bashstart`
 * mark for the call that just failed. File mtime cannot tell "this run" from
 * "the run before it"; content can, once it carries its own clock. No mark,
 * no artifact leg: there is nothing to check the report against.
 */
async function identityFromArtifact(
  cwd: string,
  sinceMs: number | null,
): Promise<TestIdentity | null> {
  if (cwd.length === 0 || sinceMs === null) return null;
  for (const rel of await testReportCandidates(cwd)) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(isAbsolute(rel) ? rel : join(cwd, rel), 'utf8'));
    } catch {
      continue; // No file, or a torn write: as uninformative as no file at all.
    }
    if (!isRecord(raw)) continue;
    const { startTime, endTime } = raw;
    if (typeof startTime !== 'number' || typeof endTime !== 'number' || endTime < startTime)
      continue;
    if (startTime < sinceMs) continue;
    const identity = identityFromReport(raw, cwd);
    if (identity !== null) return identity;
  }
  return null;
}

/** vitest's own failure header, ` FAIL  src/a.test.ts > suite > test`. THE
 *  `>` IS REQUIRED: a bare `FAIL  some suite` is shaped like a verdict with
 *  nothing specific in it, and yields no identity rather than a guessed one. */
const TEST_FAIL_HEADER_RE = /^ {0,2}FAIL {1,4}(\S+) {0,4}>\s*(.+)$/;

/** The console fallback, for a repo with no reporter: the LAST header line. */
function identityFromConsole(text: string): TestIdentity | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - LINE_SCAN_MAX; i -= 1) {
    const m = TEST_FAIL_HEADER_RE.exec(lines[i] ?? '');
    if (m === null) continue;
    const file = m[1] ?? '';
    // `(.+)` stops at the `\n` the split removed and happily keeps a `\r`.
    const parts = (m[2] ?? '')
      .trim()
      .split(/\s*>\s*/)
      .filter((p) => p.length > 0);
    const test = parts[parts.length - 1] ?? '';
    if (file.length === 0 || test.length === 0) continue;
    return { file: file.split(/[/\\]/).join('/'), suite: parts.slice(0, -1).join(' > '), test };
  }
  return null;
}

/** A job-control `&` between two commands, and not `2>&1`, `&>file` or `&&`:
 *  an isolated `&` with plain text on both sides. */
const BACKGROUND_OP_RE = /(?<![&>])&(?!&|>)/;

/**
 * The artifact is trusted only when there is exactly one segment for it to
 * belong to: `pnpm test; pnpm build` can have a real, in-window test failure
 * in the report while the failure being processed is the build's. Rather than
 * parse which segment a report belongs to, a compound command keeps the
 * console breadcrumb, which is self-locating.
 */
function isSingleSegmentCommand(command: string): boolean {
  const segments = command.split(COMMAND_SEPARATOR_RE).filter((s) => s.trim().length > 0);
  return segments.length <= 1 && !BACKGROUND_OP_RE.test(command);
}

/** The failure's test identity, artifact first, or null. No gate on the
 *  command's words: `npm run test` names no runner and is the commonest test
 *  invocation there is; the run stamps itself. */
export async function testIdentityOf(
  text: string,
  cwd: string,
  sinceMs: number | null,
  command: string,
): Promise<TestIdentity | null> {
  const fromArtifact = isSingleSegmentCommand(command)
    ? await identityFromArtifact(cwd, sinceMs)
    : null;
  return fromArtifact ?? identityFromConsole(text);
}

export interface TestSignature {
  key: string;
  file: string;
}

/** The test-identity key: file + suite + test, as the runner named them. */
export function sigV1Test(identity: TestIdentity): TestSignature {
  return {
    key: shortHash('sig_v1_test|' + identity.file + '|' + identity.suite + '|' + identity.test),
    file: identity.file,
  };
}
