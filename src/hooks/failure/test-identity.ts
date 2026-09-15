/**
 * The tests a failed command's output says failed, and the line each one
 * failed on (tenjin-agent#350). Both sources are in the output itself, so there
 * is no file to find, date or own:
 *
 * 1. GitHub Actions `::error` lines. The tenjin vitest reporter prints one per
 *    failure after vitest's summary (`vitest-reporter.ts`), and vitest's own
 *    GitHub reporter prints the same shape wherever a repo configures it.
 *    Printed last, so an agent's `2>&1 | tail -30` keeps them even when the
 *    pipe cut the assertion above.
 * 2. vitest's console header, ` FAIL  <file> > <suite> > <test>`, for a repo
 *    without the reporter, with the project label (`|node| `, or the colour
 *    badge once the colour is off) taken off so both sources name one test the
 *    same way.
 *
 * A NAME ONLY WHEN IT IS ONE: a title or header whose head before ` > ` is a
 * file. A file that failed to import, an unhandled error, a lint rule's
 * annotation and jest's `● suite › test` give a line or nothing, never a name,
 * because a key made of them would be every failure of its kind in every repo.
 */

export interface TestFailure {
  /** `<file> > <suite> > <test>` as vitest prints it, or '' for an error no
   *  test owns. */
  name: string;
  /** The error's first line as the runner printed it, or '' when the source
   *  named the test and nothing else. */
  line: string;
}

/** `::error title=…,file=…::message`. Properties are escaped by every producer
 *  that follows GitHub's toolkit, so the first `::` after them is the split. */
const ANNOTATION_RE = /^\s*::(?:error|warning|notice)(?: (.*?))?::(.*)$/;
const FAIL_HEADER_RE = /^\s{0,2}FAIL\s+(.+)$/;
/** vitest's project label with colour off, `|node| `. */
const PROJECT_LABEL_RE = /^\|[^|]+\|\s+/;
/** The same label as a colour badge, ` node `, once the colour is stripped: a
 *  bare word with no path or extension in it, then a wider gap than a path
 *  with a space in it has. */
const PROJECT_BADGE_RE = /^[^\s/.]+\s{2,}(?=\S)/;
/** vitest's GitHub reporter titles a failure `[project] file > …`. */
const TITLE_PROJECT_RE = /^\[[^\]]+\] /;

function unescapeData(s: string): string {
  return s.replace(/%0D/gi, '\r').replace(/%0A/gi, '\n').replace(/%25/g, '%');
}
function unescapeProperty(s: string): string {
  return unescapeData(s.replace(/%3A/gi, ':').replace(/%2C/gi, ','));
}

function titleOf(props: string): string {
  for (const part of props.split(',')) {
    if (part.startsWith('title=')) return unescapeProperty(part.slice('title='.length));
  }
  return '';
}

/** The text as a test name, or '' when it is not one: `<file.ext> > <rest>`. */
function testNameOf(text: string): string {
  const name = text.trim();
  const at = name.indexOf(' > ');
  if (at <= 0 || name.length <= at + 3) return '';
  return /\.[A-Za-z0-9]+$/.test(name.slice(0, at)) ? name : '';
}

function firstLineOf(message: string): string {
  return (message.split('\n')[0] ?? '').trim();
}

/**
 * Every failure this output names, in print order, one entry per test: the
 * reporter's line and the console's header for one test merge, and whichever
 * carried a line gives it. An entry with no name is an error no test owns, kept
 * for its line.
 */
export function testFailuresOf(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const byName = new Map<string, TestFailure>();
  const add = (failure: TestFailure): void => {
    if (failure.name === '') {
      if (failure.line !== '') out.push(failure);
      return;
    }
    const seen = byName.get(failure.name);
    if (seen === undefined) {
      byName.set(failure.name, failure);
      out.push(failure);
    } else if (seen.line === '') {
      seen.line = failure.line;
    }
  };
  for (const raw of text.split('\n')) {
    const annotation = ANNOTATION_RE.exec(raw);
    if (annotation !== null) {
      const title = titleOf(annotation[1] ?? '').replace(TITLE_PROJECT_RE, '');
      add({ name: testNameOf(title), line: firstLineOf(unescapeData(annotation[2] ?? '')) });
      continue;
    }
    const header = FAIL_HEADER_RE.exec(raw);
    if (header === null) continue;
    const rest = (header[1] ?? '').replace(PROJECT_LABEL_RE, '').replace(PROJECT_BADGE_RE, '');
    const name = testNameOf(rest);
    if (name !== '') add({ name, line: '' });
  }
  return out;
}
