import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Tenjin's own vitest reporter (tenjin-agent#267, #278): the run stamps
 * ITSELF, the way Datadog Test Optimization, Buildkite Test Engine and
 * dorny/test-reporter all attribute a result to the run that produced it —
 * never by having the failure arm infer "was this a test run" from the
 * command's own text, which is neither soundly nor completely doable (an
 * argument can look like a runner's name; a chained command's earlier, failing
 * segment can look like a later one that never ran; the single most common test
 * invocation, `npm run test`, does not even mention a recognizable runner name
 * at all).
 *
 * ITS OWN BUNDLE, `dist/tenjin-vitest-reporter.mjs`, which `tenjin install`
 * copies beside the daemon and the shim: a repo's own `vitest.config.ts` names
 * that absolute path, so this module is loaded into the USER's vitest process.
 * That is why it imports `node:fs` and nothing else — not the config, not the
 * ledger, not one line of the rest of this package. A reporter must not depend
 * on Tenjin being installed correctly, and a hook must not run a repo's own
 * build config.
 *
 * DELETE ON INIT, ATOMIC WRITE ON FINISH. `onInit` fires before a single test
 * runs and removes any file already at `outputFile`: a stale artifact from an
 * earlier run — or from a run that crashed before writing its own — cannot
 * structurally survive into this one. `onTestRunEnd` then writes the WHOLE
 * report to a temp file and `rename`s it into place, so a reader can never
 * observe a half-written file: a same-filesystem `rename` is atomic, and
 * `outputFile` and its `.tmp-<pid>` sibling always share one.
 *
 * `startTime`/`endTime` are what `test-identity.ts` checks against the failure
 * arm's own PreToolUse stamp for the Bash call that just failed — CONTENT the
 * report carries about ITSELF, not a guess from the file's mtime or from what
 * the command line happened to say.
 */

export interface TenjinVitestReporterOptions {
  /** Where the report lands, relative to the vitest run's cwd. */
  outputFile?: string;
}

/**
 * The slice of vitest's reporter API this class reads, declared here rather
 * than imported from `vitest/node`: the built module must import nothing but
 * `node:fs`, and a structural type is also what keeps the reporter working
 * across the vitest version a user's repo happens to be on.
 */
interface ReportedTestCase {
  name: string;
  parent?: { type?: string; fullName?: string };
}
interface ReportedTestModule {
  moduleId: string;
  children: { allTests(state: 'failed'): Iterable<ReportedTestCase> };
}

/** One failure, as `test-identity.ts` reads it back. */
interface FailedTest {
  file: string;
  suite: string;
  test: string;
}

export default class TenjinVitestReporter {
  readonly #outputFile: string;
  #startTime = 0;

  constructor(options?: TenjinVitestReporterOptions) {
    this.#outputFile =
      options !== undefined &&
      typeof options.outputFile === 'string' &&
      options.outputFile.length > 0
        ? options.outputFile
        : '.vitest-report.json';
  }

  onInit(): void {
    this.#startTime = Date.now();
    try {
      unlinkSync(this.#outputFile);
    } catch {
      // No file yet, or a permissions issue this reporter cannot fix either
      // way: silence, because a reporter that throws breaks the very test
      // run it is supposed to be reporting on.
    }
  }

  onTestRunEnd(
    testModules: readonly ReportedTestModule[],
    unhandledErrors: readonly unknown[],
  ): void {
    const endTime = Date.now();
    const failed: FailedTest[] = [];
    for (const testModule of testModules) {
      // ALL TESTS, EVERY NESTED SUITE: `allTests` walks the whole tree under
      // this module, not just its direct children, so a deeply nested
      // `describe` block's failures are named exactly as vitest's own
      // console output names them.
      for (const testCase of testModule.children.allTests('failed')) {
        const parent = testCase.parent;
        failed.push({
          file: testModule.moduleId,
          suite: parent !== undefined && parent.type === 'suite' ? (parent.fullName ?? '') : '',
          test: testCase.name,
        });
      }
    }
    const report = {
      startTime: this.#startTime,
      endTime,
      failed,
      success: failed.length === 0 && unhandledErrors.length === 0,
    };
    const tmp = this.#outputFile + '.tmp-' + process.pid;
    try {
      writeFileSync(tmp, JSON.stringify(report));
      renameSync(tmp, this.#outputFile);
    } catch {
      // A write failure here (a read-only filesystem, a full disk) leaves no
      // artifact at all, which the failure arm already treats as "no
      // evidence" rather than as a wrong one.
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing left to clean up.
      }
    }
  }
}
