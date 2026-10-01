import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readsAsEmptyPage } from './fetch-result';

interface Sample {
  url: string;
  tool_response: { bytes: number; code: number; result: string };
}

/** Real WebFetch results: what came back from a shell, and what came back fine. */
const samples = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/harness/claude-WebFetch-results.json', import.meta.url)),
    'utf8',
  ),
) as { shell: Sample[]; page: Sample[] };

describe('readsAsEmptyPage', () => {
  /**
   * A SHELL IS A 200 WITH TENS OF KILOBYTES. Every one of these passed the
   * size rule, and only the summary says nothing was there: a JavaScript app's
   * title (app.uniswap.org), a video page's footer (YouTube), docs a script
   * fills in, and PyPI's script-less fallback.
   */
  it.each(samples.shell.map((sample) => [sample.url, sample] as const))(
    'reads %s as empty',
    (_url, sample) => {
      expect(sample.tool_response.code).toBe(200);
      expect(sample.tool_response.bytes).toBeGreaterThan(1_000);
      expect(readsAsEmptyPage(sample.tool_response.result)).toBe(true);
    },
  );

  /**
   * "THE PAGE DOES NOT MENTION X" IS THE PAGE ANSWERING. These openings carry
   * the words a looser rule would trip on (cannot find, contains only,
   * navigation, shell commands, enabled, JavaScript, empty) and each read a
   * real page. Across 682 recorded 2xx WebFetch results, the eight shells above
   * are the only ones that match.
   */
  it.each(samples.page.map((sample) => [sample.url, sample] as const))(
    'reads %s as a page',
    (_url, sample) => {
      expect(readsAsEmptyPage(sample.tool_response.result)).toBe(false);
    },
  );

  it('reads only the opening, where the summary says what it was given', () => {
    const shell = samples.shell[0]!.tool_response.result;
    expect(readsAsEmptyPage(`${'Real content. '.repeat(60)}${shell}`)).toBe(false);
  });

  it.each([
    [
      "React's noscript line",
      'The page only says "You need to enable JavaScript to run this app."',
    ],
    ['a loading spinner', 'The page content only shows a loading spinner and the site logo.'],
    ['a skeleton', 'This appears to be an empty app shell with no rendered data.'],
  ])('reads %s as empty', (_label, result) => {
    expect(readsAsEmptyPage(result)).toBe(true);
  });

  it.each([
    ['a title among other things', 'The page only shows the title and abstract of the paper.'],
    ['a library that needs JavaScript', 'recheck is a ReDoS checker for JavaScript and Scala.'],
    ['nothing', ''],
  ])('reads %s as a page', (_label, result) => {
    expect(readsAsEmptyPage(result)).toBe(false);
  });
});
