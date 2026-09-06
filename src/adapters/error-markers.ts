/**
 * What a Bash `PostToolUse` has to print to count as a failure
 * (13-pr-d-local-arms.md, decision 9). Claude Code raises `PostToolUseFailure`
 * only when the tool itself fails; a command that exits non-zero inside a pipe,
 * or a runner that prints its verdict and exits zero, arrives as a plain
 * `PostToolUse`. So the adapter scans stdout and stderr for a marker a real
 * toolchain emits, and `decode` sets `tool.ok` from it — the arm never reads
 * text to decide. Ported as data from the generated failure arm
 * (`push-scripts.ts` `ERROR_MARKERS`), unchanged.
 *
 * Case-sensitive where the case IS the signal: `FAIL` is a vitest/jest/pytest
 * verdict, `fail` and `failed` are prose. The anchored patterns carry `m` so
 * they work on a whole stdout blob, and leading indentation is allowed because
 * runners indent their own output.
 */
export const ERROR_MARKERS: readonly RegExp[] = [
  // Test-runner verdicts. Uppercase only, and a whole word.
  /\bFAIL\b/,
  /AssertionError/,
  /\b[1-9]\d* (?:failed|failing|errors?)\b/i,
  // `Error:`, `TypeError:`, `ReferenceError:`, `ModuleNotFoundError:` — the
  // JS and Python convention of naming the class before the colon — and the
  // lowercase `error:` that rustc, gcc, clang, esbuild and git open a
  // diagnostic line with. Line-start only: "an error: occurred" mid-sentence
  // is prose.
  /^[ \t]*(?:\w*Error|error):/m,
  /Traceback \(most recent call last\)/,
  /ModuleNotFoundError|ImportError:/,
  /Cannot find module/i,
  // A code the shell or a runner states outright. Never zero.
  /exit code [1-9]\d*/i,
  // libuv/POSIX codes: unambiguous, and the common real failures.
  /\b(?:ENOENT|EADDRINUSE|ECONNREFUSED|EACCES|EPERM)\b/,
  // Toolchain-specific prefixes: npm, pnpm, tsc, cargo, go, git.
  /^[ \t]*npm ERR!/m,
  /ERR_PNPM_/,
  /error TS\d+:/,
  /^[ \t]*error\[E\d+\]/m,
  /^[ \t]*panic:/m,
  /^[ \t]*fatal:/m,
  /Unhandled(?:PromiseRejection|Rejection)/,
  /segmentation fault/i,
];

/** Whether `text` carries any marker above. The whole output, no bound: the
 *  body is already bounded by the daemon's request cap and each pattern is one
 *  linear scan. */
export function hasErrorMarker(text: string): boolean {
  return ERROR_MARKERS.some((re) => re.test(text));
}
