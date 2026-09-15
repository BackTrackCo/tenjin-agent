/**
 * Tenjin's own vitest reporter (tenjin-agent#350): one GitHub Actions `::error`
 * line per failure, printed after vitest's own summary.
 *
 * A LINE, NOT A FILE. The failure arm reads a Bash call's own output. A report
 * file had to be found (the hook's cwd does not follow a `cd` in the command),
 * dated (a timestamp window) and owned (a concurrent run overwrites it), and
 * the arm managed all three for none of 1,004 real vitest failures. A line in
 * the output is found, dated and owned by being there. It is also the last
 * thing the run prints, so `2>&1 | tail -30` keeps it even when the agent's own
 * pipe cut the assertion above it, which is a third of real vitest failures.
 *
 * THE ENVELOPE IS GITHUB'S workflow command, `::error title=<name>::<message>`
 * (docs.github.com, "Setting an error message"): vitest's built-in GitHub
 * reporter prints the same shape, GitHub renders it as an annotation in CI, and
 * the arm reads it without caring which tool wrote it. The payload is compact:
 * the test's name and its error's first line, never the stack or the diff, so a
 * failing run costs the agent one short line per failure, at most
 * {@link MAX_LINES} of them.
 *
 * THE NAME is `<relativeModuleId> > <fullName>`: the text vitest's own console
 * header prints after `FAIL`, less any project label. A key built from this line
 * and a key built from that header are therefore the same bytes, which is what
 * lets a teammate who ran unpiped and one who ran through `tail` meet on the
 * shelf. A file that failed to import has no test, so its line carries the file
 * alone; an error outside any test carries no title at all.
 *
 * ITS OWN BUNDLE, `dist/tenjin-vitest-reporter.mjs`, which `tenjin install`
 * copies beside the daemon and the shim: a repo's own `vitest.config.ts` names
 * that absolute path, so this module runs inside the USER's vitest process. It
 * imports nothing, and reads the vitest API through structural types, so it
 * depends neither on Tenjin being installed correctly nor on the vitest version
 * a repo happens to be on.
 */

export interface TenjinVitestReporterOptions {
  /** Unused since tenjin-agent#350, when the report file went: a config that
   *  still passes it keeps loading. */
  outputFile?: string;
}

interface ReportedError {
  name?: unknown;
  message?: unknown;
}
interface ReportedTestCase {
  fullName: string;
  result(): { errors?: readonly ReportedError[] };
}
interface ReportedTestModule {
  moduleId: string;
  relativeModuleId?: string;
  errors?(): readonly ReportedError[];
  children: { allTests(state: 'failed'): Iterable<ReportedTestCase> };
}
interface VitestLike {
  logger?: { log(message: string): void };
}

/** The last failures a run names, so 200 failing tests are not 200 lines in the
 *  agent's context. Ten is what one resolve request takes. */
const MAX_LINES = 10;
/** An error's first line is a sentence; past this it is a pasted value. */
const MESSAGE_MAX = 300;

function firstLine(error: ReportedError | undefined): string {
  const name = typeof error?.name === 'string' && error.name !== '' ? error.name : 'Error';
  const message =
    typeof error?.message === 'string' ? (error.message.split('\n')[0] ?? '').trim() : '';
  const line = message === '' ? name : name + ': ' + message;
  return line.length > MESSAGE_MAX ? line.slice(0, MESSAGE_MAX) : line;
}

/** The workflow-command escapes, as GitHub's own toolkit spells them. */
function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function annotation(title: string | null, message: string): string {
  const props = title === null ? '' : ' title=' + escapeProperty(title);
  return '::error' + props + '::' + escapeData(message);
}

/** The path vitest's header prints: `relativeModuleId`, or the absolute id
 *  made relative to the run's cwd on a vitest that predates it. */
function fileOf(module: ReportedTestModule): string {
  if (typeof module.relativeModuleId === 'string' && module.relativeModuleId !== '') {
    return module.relativeModuleId;
  }
  const cwd = process.cwd();
  const id = module.moduleId;
  return id.startsWith(cwd + '/') ? id.slice(cwd.length + 1) : id;
}

export default class TenjinVitestReporter {
  #log: (line: string) => void = (line) => {
    process.stdout.write(line + '\n');
  };

  constructor(options?: TenjinVitestReporterOptions) {
    void options;
  }

  /** vitest's own logger, when it hands one over: the same stream its summary
   *  went to, so the order on screen is the order of the calls. */
  onInit(ctx?: VitestLike): void {
    const logger = ctx?.logger;
    if (logger !== undefined && typeof logger.log === 'function') {
      this.#log = (line) => logger.log(line);
    }
  }

  onTestRunEnd(
    testModules: readonly ReportedTestModule[],
    unhandledErrors: readonly unknown[] = [],
  ): void {
    const lines: string[] = [];
    for (const testModule of testModules) {
      const file = fileOf(testModule);
      for (const error of testModule.errors?.() ?? [])
        lines.push(annotation(file, firstLine(error)));
      for (const testCase of testModule.children.allTests('failed')) {
        const error = testCase.result().errors?.[0];
        lines.push(annotation(file + ' > ' + testCase.fullName, firstLine(error)));
      }
    }
    for (const error of unhandledErrors)
      lines.push(annotation(null, firstLine(error as ReportedError)));
    if (lines.length === 0) return;
    try {
      this.#log(lines.slice(-MAX_LINES).join('\n'));
    } catch {
      // A reporter that throws breaks the very run it reports on.
    }
  }
}
